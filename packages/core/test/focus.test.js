import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFocusScript, focusParams, focusSessionWindow } from '../src/focus.js';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

test('params are validated and normalised', () => {
  assert.deepEqual(focusParams({ pid: 1234, procStart: '134391018044130220', titles: ['VOC', '', null, 'Lỗi tên'] }), {
    pid: 1234, procStart: '134391018044130220', titles: ['VOC', 'Lỗi tên'], place: false,
    launchedId: null, launchedAfter: 0, searchMs: 0,
  });
  // procStart must be a FILETIME (digits); anything else is dropped.
  assert.equal(focusParams({ pid: 5 }).procStart, null);
  assert.equal(focusParams({ pid: 5, procStart: "1'; calc; '" }).procStart, null);
  assert.equal(focusParams({ pid: -3 }).pid, 0);
});

test('the script carries the params as a literal: titles only as base64', () => {
  const script = buildFocusScript({ pid: 1234, procStart: '134391018044130220', titles: ['VOC', 'Lỗi tên'] });
  assert.ok(!/__CSM_[A-Z_]+__/.test(script), 'every placeholder is filled');
  assert.ok(script.includes(
    `$P = [pscustomobject]@{ pid = 1234; procStart = '134391018044130220'; titles = @((D '${b64('VOC')}'), (D '${b64('Lỗi tên')}')); place = $false;`,
  ));
});

test('a hostile title never reaches the script as code', () => {
  const evil = `x'); Remove-Item C:\\ -Recurse; $(calc) "\`n`;
  const script = buildFocusScript({ pid: 1, titles: [evil] });
  assert.ok(!script.includes('Remove-Item C:'), 'title text is only inside base64');
  assert.ok(!script.includes('$(calc)'));
  assert.ok(script.includes(`(D '${b64(evil)}')`));
});

test('place: the layout code is embedded but only loaded when asked for', () => {
  const script = buildFocusScript({ pid: 1, place: true });
  assert.ok(script.includes('place = $true;'));
  assert.ok(script.includes('public static class CsmLayout'));
  assert.match(script, /if \(\$P\.place\) \{\s+\$__src_CsmLayout = @'/);
  assert.match(script, /Use-CsmType 'CsmLayout' '[0-9a-f]{16}'/);
  assert.match(script, /PlaceBeside\(\$top, 'Claude Session Manager', \d+\)/);
});

test('C# types go through the compile-once loader, not a bare Add-Type', () => {
  const script = buildFocusScript({ pid: 1 });
  assert.ok(script.includes('function Use-CsmType'));
  assert.match(script, /Use-CsmType 'CsmW' '[0-9a-f]{16}'/);
  assert.ok(!/Add-Type @"/.test(script));
});

test('the hot path uses no cmdlet that auto-loads a module (each costs ~45-100ms)', () => {
  // Everything up to the rare "no console window" fallback.
  const script = buildFocusScript({ pid: 1, place: true });
  const hot = script.slice(0, script.indexOf('# No console window of its own'))
    + script.slice(script.indexOf("if ($top -eq [IntPtr]::Zero) { $r.result = 'no-window' }"));
  for (const cmd of ['ConvertFrom-Json', 'ConvertTo-Json', 'Get-Process', 'Start-Sleep', 'Get-Date', 'New-Object', 'Join-Path', 'Add-Type -AssemblyName', 'Get-CimInstance', 'Select-Object']) {
    assert.ok(!hot.includes(cmd), `${cmd} on the hot path`);
  }
});

test('launched mode: only a real session id reaches the process search', () => {
  const id = 'aaaa1111-2222-4333-8444-555566667777';
  const p = focusParams({ launchedId: id, launchedAfter: 1700000000000, searchMs: 5000, place: true });
  assert.deepEqual([p.pid, p.launchedId, p.launchedAfter, p.searchMs], [0, id, 1700000000000, 5000]);
  assert.ok(buildFocusScript({ launchedId: id }).includes(`launchedId = '${id}'`));
  // Anything else (e.g. a WQL injection attempt) is dropped.
  assert.equal(focusParams({ launchedId: "x' OR Name LIKE '%" }).launchedId, null);
});

test('launched mode needs a valid id when there is no pid', async () => {
  const r = await focusSessionWindow({ launchedId: 'not-a-uuid' });
  assert.equal(r.result, process.platform === 'win32' ? 'error' : 'unsupported');
});

test('rejects a non-positive pid without spawning (or reports unsupported off Windows)', async () => {
  const r = await focusSessionWindow({ pid: -1 });
  assert.equal(r.result, process.platform === 'win32' ? 'error' : 'unsupported');
});

test('a gone process is reported as gone — script runs end to end (Windows)', { skip: process.platform !== 'win32' }, async () => {
  // A PID that is not running: exercises params, type loading, JSON output.
  const r = await focusSessionWindow({ pid: 999_999, titles: ['Kiểm tra "lỗi" tên dài '.repeat(8)], place: true });
  assert.equal(r.result, 'gone');
});
