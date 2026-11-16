import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { createServer } from '../src/server.js';
import { createLiveHub } from '../src/live.js';

// Fake ~/.claude with one conversation that is "open": its registry entry
// points at this test process's PID, which is alive for the whole run. No
// procStart, so the PID-reuse check (a PowerShell call) never runs.
const TOKEN = 'live-token-123';
const OPEN_ID = '22222222-aaaa-4bbb-8ccc-000000000001';
let cfg;
let sessionsDir;
let server;
let baseUrl;

function writeRegistry(file, rec) {
  fs.writeFileSync(path.join(sessionsDir, file), JSON.stringify(rec));
}

before(async () => {
  cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-live-cfg-'));
  process.env.CLAUDE_CONFIG_DIR = cfg;
  const folder = path.join(cfg, 'projects', 'D--proj');
  sessionsDir = path.join(cfg, 'sessions');
  fs.mkdirSync(folder, { recursive: true });
  fs.mkdirSync(sessionsDir);
  fs.writeFileSync(path.join(folder, `${OPEN_ID}.jsonl`), [
    { type: 'user', message: { content: 'hello' }, cwd: os.tmpdir(), gitBranch: 'main' },
    { type: 'ai-title', aiTitle: 'Open conversation' },
  ].map((o) => JSON.stringify(o)).join('\n'));
  writeRegistry(`${process.pid}.json`, { pid: process.pid, sessionId: OPEN_ID, status: 'busy', startedAt: Date.now() });

  ({ server } = createServer({ token: TOKEN, cacheMs: 0, live: { pollMs: 200, debounceMs: 20 } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  delete process.env.CLAUDE_CONFIG_DIR;
});

/**
 * Open /api/live and collect `live` events until `until(events)` is true.
 * @returns {Promise<object[]>}
 */
function readLive(until, { timeoutMs = 5000, onOpen } = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const events = [];
    const rq = http.request({ host: '127.0.0.1', port, path: `/api/live?token=${TOKEN}`, method: 'GET' }, (resp) => {
      assert.equal(resp.statusCode, 200);
      assert.match(resp.headers['content-type'], /text\/event-stream/);
      let buf = '';
      resp.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (!frame.startsWith('event: live')) continue;
          const data = frame.split('\n').find((l) => l.startsWith('data: '));
          events.push(JSON.parse(data.slice(6)));
          if (events.length === 1 && onOpen) onOpen();
          if (until(events)) { rq.destroy(); resolve(events); return; }
        }
      });
      resp.on('error', () => {});
    });
    rq.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    rq.end();
    setTimeout(() => { rq.destroy(); reject(new Error(`timeout; got ${events.length} event(s)`)); }, timeoutMs);
  });
}

test('/api/live requires a token (401)', async () => {
  const r = await fetch(`${baseUrl}/api/live`);
  assert.equal(r.status, 401);
});

test('/api/live sends the open conversations right away', async () => {
  const [first] = await readLive((ev) => ev.length >= 1);
  assert.deepEqual(Object.keys(first.sessions), [OPEN_ID]);
  assert.equal(first.sessions[OPEN_ID].pid, process.pid);
  assert.equal(first.sessions[OPEN_ID].status, 'busy');
});

test('/api/live pushes when a status flips and when a process registers', async () => {
  const SECOND = '22222222-aaaa-4bbb-8ccc-000000000002';
  const events = await readLive(
    (ev) => ev.some((e) => e.sessions[OPEN_ID] && e.sessions[OPEN_ID].status === 'idle' && e.sessions[SECOND]),
    {
      onOpen: () => {
        writeRegistry(`${process.pid}.json`, { pid: process.pid, sessionId: OPEN_ID, status: 'idle', startedAt: Date.now() });
        writeRegistry('second.json', { pid: process.pid, sessionId: SECOND, status: 'waiting', startedAt: Date.now() });
      },
    },
  );
  const last = events[events.length - 1];
  assert.equal(last.sessions[SECOND].status, 'waiting');
  fs.rmSync(path.join(sessionsDir, 'second.json'));
});

test('/api/sessions carries live and supports ?running=1', async () => {
  const all = await (await fetch(`${baseUrl}/api/sessions`, { headers: { 'x-csm-token': TOKEN } })).json();
  assert.equal(all.sessions.find((s) => s.id === OPEN_ID).live.pid, process.pid);
  const running = await (await fetch(`${baseUrl}/api/sessions?running=1`, { headers: { 'x-csm-token': TOKEN } })).json();
  assert.deepEqual(running.sessions.map((s) => s.id), [OPEN_ID]);
});

test('/api/open on a running conversation plans a switch, not a second launch (dryRun)', async () => {
  const r = await fetch(`${baseUrl}/api/open`, {
    method: 'POST',
    headers: { 'x-csm-token': TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ id: OPEN_ID, dryRun: true }),
  });
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.action, 'focus');
  assert.equal(data.pid, process.pid);
  assert.equal(data.args, undefined, 'no launch command');

  const fork = await (await fetch(`${baseUrl}/api/open`, {
    method: 'POST',
    headers: { 'x-csm-token': TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ id: OPEN_ID, dryRun: true, fork: true }),
  })).json();
  assert.equal(fork.action, 'launch', 'fork still opens a new terminal');
  assert.ok(fork.args.includes('--fork-session'));
});

test('live hub: watches only while someone listens, and a late subscriber gets a snapshot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-hub-'));
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ pid: process.pid, sessionId: 'hub-1', status: 'idle' }));
  const hub = createLiveHub({ dir, pollMs: 50, verify: false });

  const got = [];
  const unsubA = hub.subscribe((s) => got.push(Object.keys(s)));
  assert.deepEqual(got, [['hub-1']], 'first subscriber gets the snapshot immediately');
  const lateGot = [];
  const unsubB = hub.subscribe((s) => lateGot.push(Object.keys(s)));
  assert.deepEqual(lateGot, [['hub-1']], 'late subscriber gets the current snapshot');
  assert.equal(hub.size, 2);

  await new Promise((r) => setTimeout(r, 150));
  assert.equal(got.length, 1, 'no push while nothing changed');

  unsubA();
  unsubB();
  assert.equal(hub.size, 0);
  const again = [];
  const unsubC = hub.subscribe((s) => again.push(Object.keys(s)));
  assert.deepEqual(again, [['hub-1']], 'restarting after idle still delivers a snapshot');
  unsubC();
});
