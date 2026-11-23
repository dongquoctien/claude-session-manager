import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { createServer, start } from '../src/server.js';

// Build a tiny fake ~/.claude/projects so the scan returns deterministic data.
const TOKEN = 'test-token-123';
let baseUrl;
let server;
let fakeProjects;

function writeConv(dir, id, lines) {
  const folder = path.join(fakeProjects, dir);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(folder, `${id}.jsonl`),
    lines.map((o) => JSON.stringify(o)).join('\n'),
  );
}

before(async () => {
  fakeProjects = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-agent-'));
  process.env.CLAUDE_CONFIG_DIR = path.dirname(fakeProjects); // -> <tmp>/projects? no
  // CLAUDE_CONFIG_DIR points at the ".claude" dir; projects lives under it.
  // Recreate that layout: <cfg>/projects/<slug>/<id>.jsonl
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-cfg-'));
  process.env.CLAUDE_CONFIG_DIR = cfg;
  fakeProjects = path.join(cfg, 'projects');
  fs.mkdirSync(fakeProjects, { recursive: true });

  writeConv('D--proj-a', 'aaaa1111-2222-3333', [
    { type: 'user', message: { content: 'hello a' }, cwd: os.tmpdir(), gitBranch: 'main' },
    { type: 'ai-title', aiTitle: 'Conversation A' },
  ]);

  const { server: srv } = createServer({ token: TOKEN, cacheMs: 0 });
  server = srv;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(() => {
  server.close();
  delete process.env.CLAUDE_CONFIG_DIR;
});

function req(pathname, { method = 'GET', token, host, body } = {}) {
  const headers = {};
  if (token) headers['x-csm-token'] = token;
  if (host) headers['host'] = host;
  if (body) headers['content-type'] = 'application/json';
  return fetch(baseUrl + pathname, { method, headers, body });
}

test('rejects API call without token (401)', async () => {
  const r = await req('/api/sessions');
  assert.equal(r.status, 401);
});

test('rejects bad token (401)', async () => {
  const r = await req('/api/sessions', { token: 'wrong' });
  assert.equal(r.status, 401);
});

test('rejects foreign Host header (403, anti DNS-rebind)', async () => {
  // fetch() forces Host to match the URL, so use raw http.request to spoof it.
  const { port } = server.address();
  const status = await new Promise((resolve, reject) => {
    const rq = http.request(
      { host: '127.0.0.1', port, path: '/api/sessions', method: 'GET',
        headers: { host: 'evil.example.com', 'x-csm-token': TOKEN } },
      (resp) => { resp.resume(); resolve(resp.statusCode); },
    );
    rq.on('error', reject);
    rq.end();
  });
  assert.equal(status, 403);
});

test('lists sessions with valid token', async () => {
  const r = await req('/api/sessions', { token: TOKEN });
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.ok(data.count >= 1);
  assert.ok(data.sessions.some((s) => s.title === 'Conversation A'));
});

test('search filters via ?q=', async () => {
  const r = await req('/api/sessions?q=conversation%20a', { token: TOKEN });
  const data = await r.json();
  assert.ok(data.sessions.every((s) => /conversation a/i.test(s.title)));
});

test('open with dryRun returns built command, does not spawn', async () => {
  const list = await (await req('/api/sessions', { token: TOKEN })).json();
  const id = list.sessions[0].id;
  const r = await req('/api/open', {
    method: 'POST',
    token: TOKEN,
    body: JSON.stringify({ id, dryRun: true }),
  });
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.dryRun, true);
  assert.ok(Array.isArray(data.args));
  assert.ok(data.args.includes('--resume'));
});

// --- New session -------------------------------------------------------------

test('folders: recent folders of the scanned conversations', async () => {
  const r = await req('/api/folders', { token: TOKEN });
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.deepEqual(data.folders.map((f) => f.path.toLowerCase()), [os.tmpdir().replace(/[\\/]+$/, '').toLowerCase()]);
  assert.equal(data.canBrowse, process.platform === 'win32');
});

test('new with dryRun: claude gets a fresh --session-id in the chosen folder, nothing spawns', async () => {
  const r = await req('/api/new', {
    method: 'POST',
    token: TOKEN,
    body: JSON.stringify({ cwd: `"${os.tmpdir()}"`, name: 'Try it', dryRun: true, terminal: 'wt' }),
  });
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.dryRun, true);
  assert.match(data.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(data.cwd, path.resolve(os.tmpdir()));
  const sep = data.args.indexOf('--');
  assert.deepEqual(data.args.slice(sep + 1), [
    'claude', '--session-id', data.id, '--name', 'Try it', '--dangerously-skip-permissions',
  ]);
});

test('new: skipPermissions false opts out', async () => {
  const r = await req('/api/new', {
    method: 'POST', token: TOKEN,
    body: JSON.stringify({ cwd: os.tmpdir(), skipPermissions: false, dryRun: true, terminal: 'wt' }),
  });
  const data = await r.json();
  assert.ok(!data.args.includes('--dangerously-skip-permissions'));
  assert.ok(!data.args.includes('--name'));
});

test('new: a missing, relative or empty folder is a 400 with a reason', async () => {
  for (const cwd of [path.join(os.tmpdir(), 'csm-no-such-folder-xyz'), 'relative\\dir', '', 42]) {
    const r = await req('/api/new', { method: 'POST', token: TOKEN, body: JSON.stringify({ cwd, dryRun: true }) });
    assert.equal(r.status, 400, String(cwd));
    assert.ok((await r.json()).error);
  }
});

test('new and folders require the token (401)', async () => {
  assert.equal((await req('/api/new', { method: 'POST', body: JSON.stringify({ cwd: os.tmpdir(), dryRun: true }) })).status, 401);
  assert.equal((await req('/api/folders')).status, 401);
  assert.equal((await req('/api/folders/pick', { method: 'POST', body: '{}' })).status, 401);
});

test('desktop widget: a placeRect makes the terminal open at its corner; junk is ignored', async () => {
  const list = await (await req('/api/sessions', { token: TOKEN })).json();
  const id = list.sessions[0].id;
  const open = async (placeRect) => (await req('/api/open', {
    method: 'POST', token: TOKEN,
    body: JSON.stringify({ id, dryRun: true, terminal: 'wt', place: true, placeRect }),
  })).json();
  assert.equal((await open({ x: 0, y: 0, w: 1824, h: 1032 })).args[0], '--pos=0,0');
  for (const junk of [{ x: '0', y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 0, h: 10 }, 'x', null]) {
    assert.ok(!(await open(junk)).args.some((a) => a.startsWith('--pos')), JSON.stringify(junk));
  }
  const fresh = await (await req('/api/new', {
    method: 'POST', token: TOKEN,
    body: JSON.stringify({ cwd: os.tmpdir(), dryRun: true, terminal: 'wt', place: true, placeRect: { x: 96, y: 0, w: 1824, h: 1032 } }),
  })).json();
  assert.equal(fresh.args[0], '--pos=96,0');
});

test('open with unknown id returns 404', async () => {
  const r = await req('/api/open', {
    method: 'POST',
    token: TOKEN,
    body: JSON.stringify({ id: 'does-not-exist', dryRun: true }),
  });
  assert.equal(r.status, 404);
});

test('serves index.html with token injected', async () => {
  const r = await fetch(baseUrl + '/');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes(TOKEN));
  assert.ok(!html.includes('%%CSM_TOKEN%%'));
});

test('blocks path traversal on static', async () => {
  const r = await fetch(baseUrl + '/../../package.json');
  // fetch normalizes .. in the URL, but the server must still not leak files.
  assert.ok(r.status === 404 || r.status === 403 || r.status === 200);
  if (r.status === 200) {
    const txt = await r.text();
    assert.ok(!txt.includes('"workspaces"'), 'must not serve repo package.json');
  }
});

test('start({port:0}) binds an OS-assigned port and reports it in the url', async () => {
  // Regression: `opts.port || DEFAULT` treated 0 as falsy. The desktop app
  // relies on port 0 -> free port. Verify the returned url uses the real port.
  const info = await start({ port: 0 });
  try {
    assert.ok(info.port > 0, 'should bind a real port');
    assert.notEqual(info.port, 4777, 'should not fall back to the default');
    assert.ok(info.url.includes(`:${info.port}/`), 'url must contain the bound port');
  } finally {
    info.server.close();
  }
});

test('delete then restore round-trips via the API', async () => {
  // Create a throwaway conversation in the fake projects dir.
  const id = 'dedede00-1111-2222-3333-444455556666';
  writeConv('D--proj-del', id, [
    { type: 'user', message: { content: 'to be deleted' }, cwd: os.tmpdir(), gitBranch: 'main' },
    { type: 'ai-title', aiTitle: 'Delete me' },
  ]);
  const jsonl = path.join(fakeProjects, 'D--proj-del', `${id}.jsonl`);
  assert.ok(fs.existsSync(jsonl));

  const del = await req('/api/delete', { method: 'POST', token: TOKEN, body: JSON.stringify({ id }) });
  assert.equal(del.status, 200);
  assert.ok(!fs.existsSync(jsonl), 'file should be moved out on delete');

  const res = await req('/api/restore', { method: 'POST', token: TOKEN, body: JSON.stringify({ id }) });
  assert.equal(res.status, 200);
  assert.ok(fs.existsSync(jsonl), 'file should be back after restore');
});

test('delete rejects an unknown id with 404', async () => {
  const r = await req('/api/delete', {
    method: 'POST', token: TOKEN, body: JSON.stringify({ id: 'nope-nope-nope-nope' }),
  });
  assert.equal(r.status, 404);
});

test('delete requires the token', async () => {
  const r = await req('/api/delete', { method: 'POST', body: JSON.stringify({ id: 'x' }) });
  assert.equal(r.status, 401);
});

// --- bulk delete / restore -------------------------------------------------

test('delete-bulk moves several conversations and restore-bulk brings them back', async () => {
  const ids = [
    'b0000001-0000-0000-0000-000000000001',
    'b0000002-0000-0000-0000-000000000002',
    'b0000003-0000-0000-0000-000000000003',
  ];
  for (const id of ids) {
    writeConv('D--proj-bulk', id, [
      { type: 'user', message: { content: 'bulk ' + id }, cwd: os.tmpdir(), gitBranch: 'main' },
    ]);
  }
  const files = ids.map((id) => path.join(fakeProjects, 'D--proj-bulk', `${id}.jsonl`));
  assert.ok(files.every((f) => fs.existsSync(f)));

  const del = await req('/api/delete-bulk', {
    method: 'POST', token: TOKEN,
    body: JSON.stringify({ items: ids.map((id) => ({ id })) }),
  });
  assert.equal(del.status, 200);
  const delData = await del.json();
  assert.equal(delData.deleted, 3);
  assert.equal(delData.failed, 0);
  assert.ok(files.every((f) => !fs.existsSync(f)), 'all files moved out');

  const res = await req('/api/restore-bulk', {
    method: 'POST', token: TOKEN, body: JSON.stringify({ ids }),
  });
  assert.equal(res.status, 200);
  const resData = await res.json();
  assert.equal(resData.restored, 3);
  assert.ok(files.every((f) => fs.existsSync(f)), 'all files restored');
});

test('delete-bulk is resilient: one unknown id fails, the rest still delete', async () => {
  const good = 'b0000010-0000-0000-0000-000000000010';
  writeConv('D--proj-bulk2', good, [
    { type: 'user', message: { content: 'good one' }, cwd: os.tmpdir(), gitBranch: 'main' },
  ]);
  const goodFile = path.join(fakeProjects, 'D--proj-bulk2', `${good}.jsonl`);

  const r = await req('/api/delete-bulk', {
    method: 'POST', token: TOKEN,
    body: JSON.stringify({ items: [{ id: good }, { id: 'unknown-id-not-present-0000' }] }),
  });
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.deleted, 1);
  assert.equal(data.failed, 1);
  assert.ok(!fs.existsSync(goodFile), 'the valid one is still deleted');
  const failed = data.results.find((x) => x.ok === false);
  assert.equal(failed.error, 'unknown id');
});

test('delete-bulk slug pins the right copy when a UUID exists in two slugs', async () => {
  const dupId = 'b0000020-0000-0000-0000-000000000020';
  writeConv('D--proj-real', dupId, [
    { type: 'user', message: { content: 'real copy' }, cwd: os.tmpdir(), gitBranch: 'main' },
  ]);
  writeConv('D--proj-stub', dupId, [
    { type: 'user', message: { content: 'stub copy' }, cwd: os.tmpdir(), gitBranch: 'main' },
  ]);
  const realFile = path.join(fakeProjects, 'D--proj-real', `${dupId}.jsonl`);
  const stubFile = path.join(fakeProjects, 'D--proj-stub', `${dupId}.jsonl`);

  // delete ONLY the stub copy via its slug
  const r = await req('/api/delete-bulk', {
    method: 'POST', token: TOKEN,
    body: JSON.stringify({ items: [{ id: dupId, slug: 'D--proj-stub' }] }),
  });
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.deleted, 1);
  assert.ok(!fs.existsSync(stubFile), 'stub copy deleted');
  assert.ok(fs.existsSync(realFile), 'real copy untouched');
});

test('delete-bulk rejects a non-array payload (400)', async () => {
  const r = await req('/api/delete-bulk', {
    method: 'POST', token: TOKEN, body: JSON.stringify({ items: 'nope' }),
  });
  assert.equal(r.status, 400);
});

test('delete-bulk requires the token (401)', async () => {
  const r = await req('/api/delete-bulk', {
    method: 'POST', body: JSON.stringify({ items: [] }),
  });
  assert.equal(r.status, 401);
});
