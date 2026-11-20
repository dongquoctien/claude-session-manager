import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openSession, placeWhenLive } from '../src/open.js';

const session = { id: 'aaaa1111-2222-3333-4444-555566667777', title: 'My session', cwd: 'D:\\proj' };
const live = { pid: 4242, procStart: '134391018044130220', status: 'idle' };

/** Fakes that record calls. */
function fakes(focusResult) {
  const calls = { focus: [], launch: [] };
  return {
    calls,
    focus: async (p) => { calls.focus.push(p); return { result: focusResult }; },
    launch: (o) => { calls.launch.push(o); return { terminal: 'wt', cmd: 'wt.exe', args: ['--resume', o.sessionId] }; },
  };
}

test('not running -> resumes in a new terminal', async () => {
  const f = fakes('focused');
  const r = await openSession(session, { skipPermissions: true }, { live: null, focus: f.focus, launch: f.launch });
  assert.equal(r.action, 'launched');
  assert.equal(f.calls.focus.length, 0);
  assert.equal(f.calls.launch.length, 1);
  assert.equal(f.calls.launch[0].cwd, 'D:\\proj');
  assert.equal(f.calls.launch[0].sessionId, session.id);
  assert.equal(f.calls.launch[0].skipPermissions, true);
});

test('running -> switches to its window, never launches a second copy', async () => {
  const f = fakes('focused');
  const r = await openSession(session, {}, { live, focus: f.focus, launch: f.launch });
  assert.equal(r.action, 'focused');
  assert.equal(r.live.pid, 4242);
  assert.equal(f.calls.launch.length, 0);
  assert.deepEqual(f.calls.focus[0], { pid: 4242, procStart: live.procStart, titles: ['My session'], place: false });
});

test('place + running -> the switch also places the window beside the list', async () => {
  const f = fakes('focused');
  await openSession(session, { place: true }, { live, focus: f.focus, launch: f.launch });
  assert.equal(f.calls.focus[0].place, true);
});

test('place + not running -> launches now, places it once it has started', async () => {
  const f = fakes('focused');
  const placed = [];
  const r = await openSession(session, { place: true }, {
    live: null, focus: f.focus, launch: f.launch,
    placeWhenLive: async (s) => { placed.push(s.id); return { result: 'focused' }; },
  });
  assert.equal(r.action, 'launched');
  assert.equal(r.placing, true);
  assert.equal(f.calls.launch.length, 1);
  assert.deepEqual(placed, [session.id]);
});

test('no place -> nothing is placed after a launch', async () => {
  const f = fakes('focused');
  let called = false;
  const r = await openSession(session, {}, {
    live: null, focus: f.focus, launch: f.launch, placeWhenLive: async () => { called = true; },
  });
  assert.equal(r.placing, undefined);
  assert.equal(called, false);
});

// --- placeWhenLive -----------------------------------------------------------

test('placeWhenLive: waits for the new process to register, then places it', async () => {
  let reads = 0;
  const f = fakes('focused');
  const readLive = () => (++reads < 3 ? null : { pid: 77, procStart: '1', startedAt: Date.now() });
  const r = await placeWhenLive(session, { readLive, focus: f.focus }, { intervalMs: 5 });
  assert.equal(r.result, 'focused');
  assert.equal(reads, 3);
  assert.deepEqual(f.calls.focus[0], { pid: 77, procStart: '1', titles: ['My session'], place: true });
});

test('placeWhenLive: ignores a process that started before the launch', async () => {
  const f = fakes('focused');
  const old = { pid: 5, procStart: '1', startedAt: Date.now() - 60_000 };
  const r = await placeWhenLive(session, { readLive: () => old, focus: f.focus }, { intervalMs: 5, timeoutMs: 40 });
  assert.equal(r.result, 'timeout');
  assert.equal(f.calls.focus.length, 0);
});

test('placeWhenLive: never throws', async () => {
  const r = await placeWhenLive(session, { readLive: () => { throw new Error('boom'); } }, { intervalMs: 5 });
  assert.equal(r.result, 'timeout');
});

test('running but Windows refused focus -> flashed, no launch', async () => {
  const f = fakes('flashed');
  const r = await openSession(session, {}, { live, focus: f.focus, launch: f.launch });
  assert.equal(r.action, 'flashed');
  assert.equal(f.calls.launch.length, 0);
});

for (const result of ['no-window', 'unsupported', 'error']) {
  test(`running, window can't be raised (${result}) -> "running", still no launch`, async () => {
    const f = fakes(result);
    const r = await openSession(session, {}, { live, focus: f.focus, launch: f.launch });
    assert.equal(r.action, 'running');
    assert.equal(r.focus.result, result);
    assert.equal(f.calls.launch.length, 0);
  });
}

for (const result of ['gone', 'stale']) {
  test(`registry entry outlived its process (${result}) -> launches`, async () => {
    const f = fakes(result);
    const r = await openSession(session, {}, { live, focus: f.focus, launch: f.launch });
    assert.equal(r.action, 'launched');
    assert.equal(f.calls.launch.length, 1);
  });
}

test('fork always launches, even while running (new session id, no clash)', async () => {
  const f = fakes('focused');
  const r = await openSession(session, { fork: true }, { live, focus: f.focus, launch: f.launch });
  assert.equal(r.action, 'launched');
  assert.equal(f.calls.focus.length, 0);
  assert.equal(f.calls.launch[0].fork, true);
});

test('dryRun: running -> reports "focus" without touching any window', async () => {
  const f = fakes('focused');
  const r = await openSession(session, { dryRun: true }, { live, focus: f.focus, launch: f.launch });
  assert.deepEqual([r.action, r.dryRun, r.live.pid], ['focus', true, 4242]);
  assert.equal(f.calls.focus.length + f.calls.launch.length, 0);
});

test('dryRun: not running -> the launch command, nothing spawned', async () => {
  const f = fakes('focused');
  const r = await openSession(session, { dryRun: true, terminal: 'linux' }, { live: null, focus: f.focus, launch: f.launch });
  assert.equal(r.action, 'launch');
  assert.ok(r.args.join(' ').includes(`--resume`));
  assert.equal(f.calls.launch.length, 0);
});

test('reads the live registry itself when not given one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-open-'));
  fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify({
    pid: process.pid, sessionId: session.id, status: 'busy', startedAt: Date.now(),
  }));
  const f = fakes('focused');
  const r = await openSession(session, {}, { sessionsDir: dir, focus: f.focus, launch: f.launch });
  assert.equal(r.action, 'focused');
  assert.equal(f.calls.focus[0].pid, process.pid);
});
