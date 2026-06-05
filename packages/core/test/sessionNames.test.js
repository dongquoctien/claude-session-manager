import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sessionNameMap } from '../src/sessionNames.js';

/** Make a fresh temp sessions dir and return its path. */
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'csm-sessions-'));
}

/** @param {string} dir @param {string} file @param {object} obj */
function writeSession(dir, file, obj) {
  fs.writeFileSync(path.join(dir, file), JSON.stringify(obj));
}

test('missing sessions dir -> empty map', () => {
  const map = sessionNameMap({ dir: path.join(os.tmpdir(), 'csm-does-not-exist-xyz') });
  assert.equal(map.size, 0);
});

test('reads a custom name keyed by sessionId (not filename)', () => {
  const dir = tmpDir();
  // filename is the PID, the sessionId is INSIDE the file
  writeSession(dir, '33560.json', {
    pid: 33560,
    sessionId: 'aa90bdc5-fcae-4e65-a50f-1756a9fdec62',
    name: 'Exclusive Dashboard',
    updatedAt: 1780624316215,
  });
  const map = sessionNameMap({ dir });
  assert.equal(map.get('aa90bdc5-fcae-4e65-a50f-1756a9fdec62'), 'Exclusive Dashboard');
});

test('sessions without a name field are skipped', () => {
  const dir = tmpDir();
  writeSession(dir, '14828.json', {
    pid: 14828,
    sessionId: '9011dfaa-2c55-40e8-8241-b48c4ce09e7e',
    status: 'idle',
  });
  const map = sessionNameMap({ dir });
  assert.equal(map.size, 0);
});

test('blank/whitespace names are ignored', () => {
  const dir = tmpDir();
  writeSession(dir, '1.json', { sessionId: 'x', name: '   ' });
  const map = sessionNameMap({ dir });
  assert.equal(map.size, 0);
});

test('name is trimmed', () => {
  const dir = tmpDir();
  writeSession(dir, '1.json', { sessionId: 'x', name: '  Renamed  ' });
  assert.equal(sessionNameMap({ dir }).get('x'), 'Renamed');
});

test('garbage / partial-write JSON is skipped, others still read', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'bad.json'), '{not valid json');
  writeSession(dir, 'good.json', { sessionId: 'y', name: 'Good' });
  const map = sessionNameMap({ dir });
  assert.equal(map.size, 1);
  assert.equal(map.get('y'), 'Good');
});

test('non-.json files are ignored', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello');
  writeSession(dir, 'real.json', { sessionId: 'z', name: 'Real' });
  assert.equal(sessionNameMap({ dir }).size, 1);
});

test('PID reuse: most-recently-updated record per sessionId wins', () => {
  const dir = tmpDir();
  // Two PID files naming the SAME session; the newer updatedAt is the real name.
  writeSession(dir, 'old-pid.json', {
    sessionId: 'dup', name: 'Old Name', updatedAt: 1000,
  });
  writeSession(dir, 'new-pid.json', {
    sessionId: 'dup', name: 'New Name', updatedAt: 2000,
  });
  assert.equal(sessionNameMap({ dir }).get('dup'), 'New Name');
});

test('falls back to startedAt when updatedAt is absent', () => {
  const dir = tmpDir();
  writeSession(dir, 'a.json', { sessionId: 'dup', name: 'A', startedAt: 5000 });
  writeSession(dir, 'b.json', { sessionId: 'dup', name: 'B', startedAt: 9000 });
  assert.equal(sessionNameMap({ dir }).get('dup'), 'B');
});
