import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PIP_WINDOW_TITLE, LAYOUT_CS, psString, parseDockOutput } from '../src/dock.js';

test('parseDockOutput: side + where the free area starts', () => {
  assert.deepEqual(parseDockOutput('right 0,0'), { result: 'right', free: { x: 0, y: 0 } });
  assert.deepEqual(parseDockOutput('left 482,-8\r\n'), { result: 'left', free: { x: 482, y: -8 } });
  assert.deepEqual(parseDockOutput('right '), { result: 'right', free: null }); // no room beside it
  assert.deepEqual(parseDockOutput('no-pip '), { result: 'no-pip', free: null });
  assert.deepEqual(parseDockOutput('', 'exit code 1'), { result: 'error', error: 'exit code 1' });
});

// Chrome names a document-PiP window after the opener page's <title>; that is
// how the floating Sessions window is found natively. Renaming the page
// without updating PIP_WINDOW_TITLE would silently break docking/placement.
test('PIP_WINDOW_TITLE matches the web UI <title>', () => {
  const html = fs.readFileSync(
    fileURLToPath(new URL('../../ui/public/index.html', import.meta.url)),
    'utf8',
  );
  const m = html.match(/<title>([^<]*)<\/title>/);
  assert.ok(m, 'index.html has a <title>');
  assert.equal(m[1].trim(), PIP_WINDOW_TITLE);
});

test('the layout C# fits its verbatim here-string', () => {
  // Embedded in @' ... '@ (psUseType): a line starting with '@ would end it.
  assert.ok(!/^\s*'@/m.test(LAYOUT_CS));
});

test('psString quotes for PowerShell single-quoted literals', () => {
  assert.equal(psString("it's"), "'it''s'");
});
