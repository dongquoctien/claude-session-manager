import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { readState, writeState, toggleFavorite, favoriteSet, statePath } from '../src/state.js';

let cfg;
before(() => {
  cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-state-'));
  process.env.CLAUDE_CONFIG_DIR = cfg;
});
after(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
});

test('readState returns empty default when file is missing', () => {
  const s = readState();
  assert.deepEqual(s.favorites, []);
});

test('statePath honors CLAUDE_CONFIG_DIR', () => {
  assert.equal(statePath(), path.join(cfg, 'csm-state.json'));
});

test('writeState then readState round-trips', async () => {
  await writeState({ favorites: ['a', 'b'] });
  assert.deepEqual(readState().favorites, ['a', 'b']);
});

test('toggleFavorite adds then removes', async () => {
  await writeState({ favorites: [] });
  const on = await toggleFavorite('x');
  assert.equal(on, true);
  assert.ok(favoriteSet().has('x'));
  const off = await toggleFavorite('x');
  assert.equal(off, false);
  assert.ok(!favoriteSet().has('x'));
});

test('corrupt state file degrades to empty, never throws', () => {
  fs.writeFileSync(statePath(), 'not json {{{');
  assert.deepEqual(readState().favorites, []);
});
