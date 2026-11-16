import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  readSessionRecords,
  liveSessionMap,
  verifyLiveSessions,
  isPidAlive,
  resetLiveVerdicts,
} from '../src/liveSessions.js';

// A PID that is guaranteed dead: a process that already ran to completion.
const DEAD_PID = spawnSync(process.execPath, ['-e', '0']).pid;
const ALIVE_PID = process.pid;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'csm-live-'));
}
/** @param {string} dir @param {object} rec */
function writeRec(dir, rec) {
  fs.writeFileSync(path.join(dir, `${rec.pid}-${rec.sessionId}.json`), JSON.stringify(rec));
}

beforeEach(() => resetLiveVerdicts());

test('isPidAlive: own process yes, finished process no', () => {
  assert.equal(isPidAlive(ALIVE_PID), true);
  assert.equal(isPidAlive(DEAD_PID), false);
});

test('missing sessions dir -> no records, empty map', () => {
  const dir = path.join(os.tmpdir(), 'csm-live-does-not-exist-xyz');
  assert.deepEqual(readSessionRecords(dir), []);
  assert.equal(liveSessionMap({ dir }).size, 0);
});

test('only conversations whose process is alive are live', () => {
  const dir = tmpDir();
  writeRec(dir, { pid: ALIVE_PID, sessionId: 'alive-1', status: 'busy', startedAt: 1 });
  writeRec(dir, { pid: DEAD_PID, sessionId: 'dead-1', status: 'idle', startedAt: 1 });
  const map = liveSessionMap({ dir });
  assert.deepEqual([...map.keys()], ['alive-1']);
});

test('fields are normalized; since prefers statusUpdatedAt, then updatedAt', () => {
  const dir = tmpDir();
  writeRec(dir, {
    pid: ALIVE_PID, sessionId: 's1', status: 'waiting', waitingFor: 'permission',
    startedAt: 100, updatedAt: 200, statusUpdatedAt: 300,
    procStart: '134391018044130220', kind: 'interactive', entrypoint: 'cli',
    name: 'derived-name', nameSource: 'derived',
  });
  assert.deepEqual(liveSessionMap({ dir }).get('s1'), {
    pid: ALIVE_PID,
    procStart: '134391018044130220',
    status: 'waiting',
    waitingFor: 'permission',
    since: 300,
    startedAt: 100,
    kind: 'interactive',
    entrypoint: 'cli',
  });

  const dir2 = tmpDir();
  writeRec(dir2, { pid: ALIVE_PID, sessionId: 's2', status: 'brand-new-status', updatedAt: 250, waitingFor: { x: 1 } });
  const s2 = liveSessionMap({ dir: dir2 }).get('s2');
  assert.equal(s2.status, 'unknown', 'unknown status values are not passed through');
  assert.equal(s2.since, 250);
  assert.equal(s2.waitingFor, null, 'non-string waitingFor dropped');
});

test('garbage, partial writes and unusable records are skipped', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
  fs.writeFileSync(path.join(dir, 'note.txt'), 'hi');
  writeRec(dir, { pid: 0, sessionId: 'zero-pid' });
  fs.writeFileSync(path.join(dir, 'noid.json'), JSON.stringify({ pid: ALIVE_PID }));
  writeRec(dir, { pid: ALIVE_PID, sessionId: 'good' });
  assert.deepEqual([...liveSessionMap({ dir }).keys()], ['good']);
});

test('same conversation in two processes: the most recently started wins', () => {
  const records = [
    { pid: 111, sessionId: 'dup', status: 'idle', startedAt: 1000 },
    { pid: 222, sessionId: 'dup', status: 'busy', startedAt: 2000 },
  ];
  const map = liveSessionMap({ records, isAlive: () => true });
  assert.equal(map.get('dup').pid, 222);
});

test('verifyLiveSessions: a reused PID (creation time != procStart) is dropped', async () => {
  const records = [
    { pid: 111, sessionId: 'same', procStart: '134391018044130220' },
    { pid: 222, sessionId: 'reused', procStart: '134391018044130220' },
  ];
  const alive = () => true;
  const query = async () => new Map([
    [111, '134391018044130220'], // exact match
    [222, '134399999999999999'], // different process now owns PID 222
  ]);
  assert.equal(liveSessionMap({ records, isAlive: alive }).size, 2, 'before verify both look live');
  const rejected = await verifyLiveSessions({ records, isAlive: alive, query });
  assert.equal(rejected, 1);
  assert.deepEqual([...liveSessionMap({ records, isAlive: alive }).keys()], ['same']);
});

test('verifyLiveSessions: 1ms tolerance, cached, and only new processes are queried', async () => {
  const records = [{ pid: 111, sessionId: 's', procStart: '134391018044130220' }];
  let calls = 0;
  const query = async (pids) => { calls += 1; assert.deepEqual(pids, [111]); return new Map([[111, '134391018044135000']]); };
  assert.equal(await verifyLiveSessions({ records, isAlive: () => true, query }), 0);
  assert.equal(await verifyLiveSessions({ records, isAlive: () => true, query }), 0);
  assert.equal(calls, 1, 'second verify uses the cached verdict');
  assert.equal(liveSessionMap({ records, isAlive: () => true }).size, 1);
});

test('verifyLiveSessions: unreadable time or non-FILETIME procStart is not judged', async () => {
  const records = [
    { pid: 111, sessionId: 'elevated', procStart: '134391018044130220' },
    { pid: 222, sessionId: 'other-os', procStart: 'Tue Nov 3 10:00:00 2026' },
  ];
  const query = async () => new Map([[111, null], [222, '134391018044130220']]);
  assert.equal(await verifyLiveSessions({ records, isAlive: () => true, query }), 0);
  assert.equal(liveSessionMap({ records, isAlive: () => true }).size, 2, 'both kept on the PID check alone');
});

test('verifyLiveSessions: verdicts are forgotten once the registry file is gone', async () => {
  const rec = { pid: 333, sessionId: 'x', procStart: '134391018044130220' };
  const query = async () => new Map([[333, '134399999999999999']]);
  await verifyLiveSessions({ records: [rec], isAlive: () => true, query });
  assert.equal(liveSessionMap({ records: [rec], isAlive: () => true }).size, 0);
  // File removed, later a new Claude process happens to get PID 333 with its own procStart.
  await verifyLiveSessions({ records: [], isAlive: () => true, query });
  const fresh = { pid: 333, sessionId: 'y', procStart: '134399999999999999' };
  assert.equal(liveSessionMap({ records: [fresh], isAlive: () => true }).size, 1);
});

test('verifyLiveSessions: nothing to verify -> no query', async () => {
  let calls = 0;
  const query = async () => { calls += 1; return new Map(); };
  await verifyLiveSessions({ records: [{ pid: 1, sessionId: 'no-procstart' }], isAlive: () => true, query });
  await verifyLiveSessions({ records: [{ pid: DEAD_PID, sessionId: 'dead', procStart: '1' }], query });
  assert.equal(calls, 0);
});
