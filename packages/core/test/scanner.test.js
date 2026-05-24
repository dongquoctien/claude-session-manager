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
