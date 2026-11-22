import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPickerScript, parsePickerOutput, pickFolder, PICKER_CS } from '../src/folderPicker.js';

const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');

function paramsOf(script) {
  const m = script.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/);
  assert.ok(m, 'params are embedded as a base64 literal');
  return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
}

test('buildPickerScript: params travel as base64, every placeholder is filled', () => {
  const evil = `C:\\x'); Remove-Item C:\\ -Recurse; $(calc) "`;
  const script = buildPickerScript({ title: 'Pick', initial: evil });
  assert.ok(!/__CSM_[A-Z_]+__/.test(script));
  assert.ok(!script.includes('Remove-Item C:'), 'the folder is only inside base64');
  assert.deepEqual(paramsOf(script), { title: 'Pick', initial: evil });
  assert.ok(script.includes('public static class CsmPick'));
});

test('the C# survives its verbatim here-string', () => {
  // A line starting with '@ would end the @' ... '@ block early.
  assert.ok(!/^\s*'@/m.test(PICKER_CS));
});

test('parsePickerOutput: decodes base64 JSON, any script in the path', () => {
  assert.deepEqual(parsePickerOutput(b64({ result: 'picked', path: 'D:\\Thư mục', error: null })), { result: 'picked', path: 'D:\\Thư mục' });
  assert.deepEqual(parsePickerOutput(`${b64({ result: 'cancelled' })}\r\n`), { result: 'cancelled' });
  assert.equal(parsePickerOutput(''), null);
  assert.equal(parsePickerOutput('not base64 json'), null);
});

test('pickFolder: unsupported off Windows, without spawning', async () => {
  let ran = false;
  const r = await pickFolder({}, { platform: 'linux', run: async () => { ran = true; return { ok: true, stdout: '' }; } });
  assert.deepEqual(r, { result: 'unsupported' });
  assert.equal(ran, false);
});

test('pickFolder: one dialog at a time — a second call answers busy', async () => {
  let release;
  const run = () => new Promise((resolve) => { release = () => resolve({ ok: true, stdout: b64({ result: 'picked', path: 'D:\\x' }) }); });
  const first = pickFolder({}, { platform: 'win32', run });
  const second = await pickFolder({}, { platform: 'win32', run });
  assert.deepEqual(second, { result: 'busy' });
  release();
  assert.deepEqual(await first, { result: 'picked', path: 'D:\\x' });
  // Free again once the first one is done.
  const third = pickFolder({}, { platform: 'win32', run });
  release();
  assert.equal((await third).result, 'picked');
});

test('pickFolder: no usable output -> error with the runner message', async () => {
  const r = await pickFolder({}, { platform: 'win32', run: async () => ({ ok: false, stdout: '', error: 'timed out after 5ms' }) });
  assert.deepEqual(r, { result: 'error', error: 'timed out after 5ms' });
});
