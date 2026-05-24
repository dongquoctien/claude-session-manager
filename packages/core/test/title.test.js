import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTitle, oneLine } from '../src/title.js';

const base = {
  aiTitle: null,
  cwd: null,
  gitBranch: null,
  lastPrompt: null,
  summary: null,
  firstUserText: null,
  version: null,
};

test('oneLine collapses whitespace and truncates', () => {
  assert.equal(oneLine('  a\n\n  b   c '), 'a b c');
  const long = 'x'.repeat(200);
  const out = oneLine(long, 20);
  assert.equal(out.length, 20);
  assert.ok(out.endsWith('…'));
});

test('tier 1: prefers aiTitle', () => {
  const r = resolveTitle({ ...base, aiTitle: 'My Title', lastPrompt: 'ignored' }, Date.now());
  assert.equal(r.source, 'aiTitle');
  assert.equal(r.title, 'My Title');
});

test('tier 2: falls back to lastPrompt', () => {
  const r = resolveTitle({ ...base, lastPrompt: 'do the thing' }, Date.now());
  assert.equal(r.source, 'lastPrompt');
  assert.equal(r.title, 'do the thing');
});

test('tier 3: falls back to first user text', () => {
  const r = resolveTitle({ ...base, firstUserText: 'hello there' }, Date.now());
  assert.equal(r.source, 'firstUser');
  assert.equal(r.title, 'hello there');
});

test('tier 4: Untitled with date', () => {
  const r = resolveTitle({ ...base }, new Date('2026-05-24T00:00:00Z'));
  assert.equal(r.source, 'fallback');
  assert.ok(r.title.startsWith('Untitled · 2026-05-24'));
});
