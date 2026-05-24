import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSession, searchSessions } from '../src/scanner.js';

const sessions = [
  { id: 'aaaa1111-0000', title: 'News tok video', projectLabel: 'D:\\Github\\news-tok', branch: 'main', mtime: 3 },
  { id: 'aaaa2222-0000', title: 'Dashboard build', projectLabel: 'C:\\Users\\me', branch: 'dev', mtime: 2 },
  { id: 'bbbb3333-0000', title: 'Fix caption', projectLabel: 'D:\\Github\\news-tok', branch: 'fix-x', mtime: 1 },
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
