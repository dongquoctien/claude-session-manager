import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFocusScript, focusSessionWindow } from '../src/focus.js';

/** Pull the embedded params back out of a built script. */
function paramsOf(script) {
  const m = script.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/);
  assert.ok(m, 'params are embedded as a base64 literal');
  return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
}

test('params round-trip through the base64 literal', () => {
  const script = buildFocusScript({ pid: 1234, procStart: '134391018044130220', titles: ['VOC', '', null, 'Lỗi tên'] });
  assert.ok(!/__CSM_[A-Z_]+__/.test(script), 'every placeholder is filled');
  assert.deepEqual(paramsOf(script), { pid: 1234, procStart: '134391018044130220', titles: ['VOC', 'Lỗi tên'], place: false });
});

test('place: the layout code is embedded but only compiled when asked for', () => {
  const script = buildFocusScript({ pid: 1, place: true });
  assert.equal(paramsOf(script).place, true);
  assert.ok(script.includes('public static class CsmLayout'));
  assert.match(script, /if \(\$P\.place\) \{\s+Add-Type/);
  assert.match(script, /PlaceBeside\(\$top, 'Claude Session Manager', \d+\)/);
});

test('a hostile title never reaches the script as code', () => {
  const evil = `x'); Remove-Item C:\\ -Recurse; $(calc) "\`n`;
  const script = buildFocusScript({ pid: 1, titles: [evil] });
  assert.ok(!script.includes('Remove-Item C:'), 'title text is only inside base64');
  assert.ok(!script.includes('$(calc)'));
  assert.deepEqual(paramsOf(script).titles, [evil]);
});

test('missing procStart is sent as null (no creation-time check)', () => {
  assert.equal(paramsOf(buildFocusScript({ pid: 5 })).procStart, null);
});

test('rejects a non-positive pid without spawning (or reports unsupported off Windows)', async () => {
  const r = await focusSessionWindow({ pid: -1 });
  assert.equal(r.result, process.platform === 'win32' ? 'error' : 'unsupported');
});
