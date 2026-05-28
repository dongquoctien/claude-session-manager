import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSession, searchSessions, filterSessions } from '../src/scanner.js';

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
