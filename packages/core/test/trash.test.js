import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { deleteSession, restoreSession, listTrash, emptyTrash, trashDir } from '../src/trash.js';

let cfg, projects;

function makeSession(slug, id, { withDir = false } = {}) {
  const folder = path.join(projects, slug);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, `${id}.jsonl`), `{"type":"user","sessionId":"${id}"}\n`);
  if (withDir) {
    fs.mkdirSync(path.join(folder, id, 'tool-results'), { recursive: true });
    fs.writeFileSync(path.join(folder, id, 'tool-results', 'out.txt'), 'big output');
  }
  return { id, projectSlug: slug, title: 'Test session' };
}

beforeEach(() => {
  cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-trash-'));
  process.env.CLAUDE_CONFIG_DIR = cfg;
  projects = path.join(cfg, 'projects');
  fs.mkdirSync(projects, { recursive: true });
});

after(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
});

test('deleteSession moves the .jsonl out of the project into trash', async () => {
  const s = makeSession('proj-a', 'aaaa1111-2222-3333-4444-555566667777');
  const jsonl = path.join(projects, 'proj-a', `${s.id}.jsonl`);
  assert.ok(fs.existsSync(jsonl));
  const r = await deleteSession(s);
  assert.ok(!fs.existsSync(jsonl), 'jsonl should be gone from project');
  assert.ok(fs.existsSync(r.trashPath), 'trash bucket should exist');
  assert.ok(fs.existsSync(path.join(r.trashPath, `${s.id}.jsonl`)));
});

test('deleteSession also moves the sibling dir', async () => {
  const s = makeSession('proj-b', 'bbbb1111-2222-3333-4444-555566667777', { withDir: true });
  const sib = path.join(projects, 'proj-b', s.id);
  assert.ok(fs.existsSync(sib));
  const r = await deleteSession(s);
  assert.equal(r.hadDir, true);
  assert.ok(!fs.existsSync(sib), 'sibling dir should be gone from project');
  assert.ok(fs.existsSync(path.join(r.trashPath, s.id, 'tool-results', 'out.txt')), 'sibling contents preserved in trash');
});

test('restoreSession brings back jsonl + sibling dir to the right project', async () => {
  const s = makeSession('proj-c', 'cccc1111-2222-3333-4444-555566667777', { withDir: true });
  await deleteSession(s);
  const r = await restoreSession(s.id);
  assert.ok(fs.existsSync(path.join(projects, 'proj-c', `${s.id}.jsonl`)), 'jsonl restored');
  assert.ok(fs.existsSync(path.join(projects, 'proj-c', s.id, 'tool-results', 'out.txt')), 'sibling restored');
  // bucket cleaned up
  assert.equal((await listTrash()).filter((t) => t.id === s.id).length, 0);
});

test('restoreSession refuses to overwrite an existing conversation', async () => {
  const s = makeSession('proj-d', 'dddd1111-2222-3333-4444-555566667777');
  await deleteSession(s);
  // recreate a conversation with the same id
  makeSession('proj-d', s.id);
  await assert.rejects(() => restoreSession(s.id), /already exists/);
});

test('listTrash reports deleted sessions newest-first', async () => {
  await deleteSession(makeSession('p', 'aaaa0000-0000-0000-0000-000000000001'));
  await deleteSession(makeSession('p', 'aaaa0000-0000-0000-0000-000000000002'));
  const t = await listTrash();
  assert.equal(t.length, 2);
  assert.ok(t[0].deletedAt >= t[1].deletedAt);
});

test('emptyTrash(0) removes everything', async () => {
  await deleteSession(makeSession('p', 'eeee1111-2222-3333-4444-555566667777'));
  const removed = await emptyTrash(0);
  assert.equal(removed, 1);
  assert.equal((await listTrash()).length, 0);
});

test('deleteSession rejects ids with path traversal', async () => {
  await assert.rejects(
    () => deleteSession({ id: '../../evil', projectSlug: 'p' }),
    /invalid session id/,
  );
});

test('deleteSession throws if the conversation file is missing', async () => {
  await assert.rejects(
    () => deleteSession({ id: 'ffff1111-2222-3333-4444-555566667777', projectSlug: 'nope' }),
    /not found/,
  );
});
