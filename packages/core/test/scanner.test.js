import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findSession, searchSessions, filterSessions, scanSessions } from '../src/scanner.js';

const now = Date.now();
const sessions = [
  { id: 'aaaa1111-0000', title: 'News tok video', projectLabel: 'D:\\Github\\news-tok', branch: 'main', mtime: now, cwdExists: true, favorite: true },
  { id: 'aaaa2222-0000', title: 'Dashboard build', projectLabel: 'C:\\Users\\me', branch: 'dev', mtime: now - 10 * 86400000, cwdExists: true, favorite: false },
  { id: 'bbbb3333-0000', title: 'Fix caption', projectLabel: 'D:\\Github\\news-tok', branch: 'fix-x', mtime: now - 1, cwdExists: false, favorite: false },
];

test('findSession: exact id', () => {
  const r = findSession(sessions, 'aaaa1111-0000');
  assert.equal(r.match.id, 'aaaa1111-0000');
});

test('findSession: unambiguous prefix', () => {
  const r = findSession(sessions, 'bbbb');
  assert.equal(r.match.id, 'bbbb3333-0000');
});

test('findSession: ambiguous prefix returns candidates', () => {
  const r = findSession(sessions, 'aaaa');
  assert.equal(r.match, null);
  assert.equal(r.ambiguous.length, 2);
});

test('findSession: no match', () => {
  const r = findSession(sessions, 'zzzz');
  assert.equal(r.match, null);
  assert.equal(r.ambiguous.length, 0);
});

// --- duplicate-UUID (worktree) handling -----------------------------------
// Claude Code leaves the same session UUID under both the worktree slug and
// the main-repo slug. id alone is not a unique key, so findSession must auto-
// prefer the live/real copy and only flag genuinely distinct ids as ambiguous.
const UUID = 'aa90bdc5-fcae-4e65-a50f-1756a9fdec62';
const dupes = [
  // worktree stub: 119 bytes, folder gone
  { id: UUID, title: 'Untitled', projectSlug: 'D--Code-oh-admin--worktrees-ELS-1423', projectLabel: '—', branch: null, mtime: now - 6 * 86400000, size: 119, cwdExists: false, favorite: false },
  // real transcript: 53MB, folder live
  { id: UUID, title: 'Implement exclusive dashboard', projectSlug: 'D--Code-oh-admin', projectLabel: 'D:\\Code\\oh-admin', branch: 'staging', mtime: now - 17 * 3600000, size: 53653119, cwdExists: true, favorite: false },
];

test('findSession: same UUID in two slugs auto-prefers the live/larger copy', () => {
  const r = findSession(dupes, UUID);
  assert.equal(r.ambiguous.length, 0, 'should not be ambiguous — same conversation');
  assert.equal(r.match.projectSlug, 'D--Code-oh-admin');
  assert.equal(r.match.cwdExists, true);
});

test('findSession: full-UUID open never silently lands on the dead stub', () => {
  // even if scan order puts the stub first, preferReal wins
  const r = findSession([...dupes].reverse(), UUID);
  assert.equal(r.match.size, 53653119);
});

test('findSession: prefix that hits one duplicated UUID still resolves', () => {
  const r = findSession(dupes, 'aa90bdc5');
  assert.equal(r.match.projectSlug, 'D--Code-oh-admin');
  assert.equal(r.ambiguous.length, 0);
});

test('findSession: slug pins a specific copy of a duplicated UUID', () => {
  const r = findSession(dupes, UUID, { slug: 'worktrees-ELS-1423' });
  assert.equal(r.match.projectSlug, 'D--Code-oh-admin--worktrees-ELS-1423');
  assert.equal(r.match.size, 119);
});

test('findSession: genuinely different ids sharing a prefix stay ambiguous', () => {
  const r = findSession(sessions, 'aaaa');
  assert.equal(r.match, null);
  assert.equal(r.ambiguous.length, 2);
});

test('findSession: tie-break by mtime when cwdExists and size are equal', () => {
  const tie = [
    { id: UUID, projectSlug: 'a', mtime: now - 1000, size: 500, cwdExists: true },
    { id: UUID, projectSlug: 'b', mtime: now, size: 500, cwdExists: true },
  ];
  assert.equal(findSession(tie, UUID).match.projectSlug, 'b');
});

test('searchSessions: matches title', () => {
  const r = searchSessions(sessions, 'dashboard');
  assert.equal(r.length, 1);
  assert.equal(r[0].id, 'aaaa2222-0000');
});

test('searchSessions: matches project label', () => {
  const r = searchSessions(sessions, 'news-tok');
  assert.equal(r.length, 2);
});

test('searchSessions: multi-term AND', () => {
  const r = searchSessions(sessions, 'news caption');
  assert.equal(r.length, 1);
  assert.equal(r[0].id, 'bbbb3333-0000');
});

test('searchSessions: empty query returns all', () => {
  assert.equal(searchSessions(sessions, '   ').length, 3);
});

test('filterSessions: favoritesOnly', () => {
  const r = filterSessions(sessions, { favoritesOnly: true });
  assert.equal(r.length, 1);
  assert.equal(r[0].id, 'aaaa1111-0000');
});

test('filterSessions: hideOrphans drops missing cwd', () => {
  const r = filterSessions(sessions, { hideOrphans: true });
  assert.ok(r.every((s) => s.cwdExists));
  assert.equal(r.length, 2);
});

test('filterSessions: branch exact match', () => {
  const r = filterSessions(sessions, { branch: 'dev' });
  assert.equal(r.length, 1);
  assert.equal(r[0].branch, 'dev');
});

test('filterSessions: recentDays cutoff', () => {
  const r = filterSessions(sessions, { recentDays: 7 });
  // the 10-day-old one is excluded
  assert.ok(!r.some((s) => s.id === 'aaaa2222-0000'));
});

test('filterSessions: no opts is identity', () => {
  assert.equal(filterSessions(sessions, {}).length, 3);
});

// --- /rename titles, end to end ------------------------------------------
// Mirrors the real bug: every live Claude Code process writes a `name` into
// ~/.claude/sessions/<pid>.json, but most are auto-generated ("oh-api-07",
// nameSource "derived"). Those replaced the user's real /rename title, which
// lives in the .jsonl as a `custom-title` record.
test('scanSessions: /rename title from the .jsonl beats a derived PID name', async (t) => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-scan-'));
  const prevCfg = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfg; // keep favorites state out of ~/.claude
  t.after(() => {
    if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevCfg;
  });

  const projects = path.join(cfg, 'projects');
  const sessionsDir = path.join(cfg, 'sessions');
  const folder = path.join(projects, 'D--Code-oh-api');
  fs.mkdirSync(folder, { recursive: true });
  fs.mkdirSync(sessionsDir);

  const RENAMED = '4bc4d2f7-f023-4889-80fa-b4f89bb5766b'; // custom-title + derived PID name
  const PLAIN = '88267676-daf7-45a9-aa94-2772b4d6b9f9'; // no rename, derived PID name
  const LIVE = 'e2cbb068-1520-47a5-a8d2-a7f6831a08d9'; // user PID name, not in the .jsonl windows

  /** @param {string} id @param {object[]} extra */
  const writeJsonl = (id, extra) => fs.writeFileSync(
    path.join(folder, `${id}.jsonl`),
    [
      { type: 'user', message: { content: 'hello' }, cwd: cfg, gitBranch: 'main' },
      { type: 'ai-title', aiTitle: `AI title ${id.slice(0, 4)}`, sessionId: id },
      ...extra,
    ].map((o) => JSON.stringify(o)).join('\n'),
  );
  writeJsonl(RENAMED, [
    { type: 'custom-title', customTitle: 'Allotment Increase Automation', sessionId: RENAMED },
  ]);
  writeJsonl(PLAIN, []);
  writeJsonl(LIVE, []);

  /** @param {number} pid @param {string} sessionId @param {string} name @param {string} nameSource */
  const writePid = (pid, sessionId, name, nameSource) => fs.writeFileSync(
    path.join(sessionsDir, `${pid}.json`),
    JSON.stringify({ pid, sessionId, name, nameSource, updatedAt: Date.now() }),
  );
  writePid(43676, RENAMED, 'oh-api-07', 'derived');
  writePid(20960, PLAIN, 'oh-api-08', 'derived');
  writePid(33108, LIVE, 'VOC', 'user');

  const found = await scanSessions({ dir: projects, sessionsDir });
  const byId = Object.fromEntries(found.map((s) => [s.id, s]));

  assert.equal(byId[RENAMED].title, 'Allotment Increase Automation');
  assert.equal(byId[RENAMED].titleSource, 'customName');
  assert.equal(byId[PLAIN].title, 'AI title 8826', 'derived name must not replace the AI title');
  assert.equal(byId[PLAIN].titleSource, 'aiTitle');
  assert.equal(byId[LIVE].title, 'VOC', 'a user-set PID name is still a fallback');
  assert.equal(byId[LIVE].titleSource, 'customName');
});
