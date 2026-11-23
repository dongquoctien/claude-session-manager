import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PIP_WINDOW_TITLE, LAYOUT_CS, psString, parseDockOutput, floatMetrics, pipHint, FLOAT_DEFAULTS } from '../src/dock.js';

test('parseDockOutput: docked side + the free area beside it', () => {
  assert.deepEqual(parseDockOutput('right 0,0,1438,1032'), { result: 'right', side: 'right', free: { x: 0, y: 0, w: 1438, h: 1032 } });
  assert.deepEqual(parseDockOutput('left 482,-8,1438,1040\r\n'), { result: 'left', side: 'left', free: { x: 482, y: -8, w: 1438, h: 1040 } });
  assert.deepEqual(parseDockOutput('right '), { result: 'right', side: 'right', free: null }); // no room beside it
});

test('parseDockOutput: floating mode + side + the terminals area', () => {
  assert.deepEqual(parseDockOutput('fab right 0,0,1824,1032'), { result: 'fab', side: 'right', free: { x: 0, y: 0, w: 1824, h: 1032 } });
  assert.deepEqual(parseDockOutput('panel left 96,0,1824,1032'), { result: 'panel', side: 'left', free: { x: 96, y: 0, w: 1824, h: 1032 } });
  assert.equal(parseDockOutput('fab up 1,2,3,4').result, 'error');
});

test('parseDockOutput: nothing to lay out / errors', () => {
  assert.deepEqual(parseDockOutput('no-pip '), { result: 'no-pip', free: null });
  assert.deepEqual(parseDockOutput('ambiguous '), { result: 'ambiguous', free: null });
  assert.deepEqual(parseDockOutput('', 'exit code 1'), { result: 'error', error: 'exit code 1' });
});

test('floatMetrics: integers within bounds, defaults for the rest', () => {
  assert.deepEqual(floatMetrics(), { ...FLOAT_DEFAULTS });
  assert.deepEqual(floatMetrics({ fab: 1, gap: '8', margin: 999, panel: 300.6, radius: 'x' }), {
    fab: 32, gap: 8, margin: 200, panel: 301, radius: FLOAT_DEFAULTS.radius,
  });
});

test('pipHint: the page window rect, or zeros when it is not usable', () => {
  assert.deepEqual(pipHint({ x: 1430.4, y: 0, w: 496, h: 1039 }), [1430, 0, 496, 1039]);
  assert.deepEqual(pipHint({ x: 1, y: 2, w: 0, h: 5 }), [0, 0, 0, 0]);
  assert.deepEqual(pipHint(null), [0, 0, 0, 0]);
  assert.deepEqual(pipHint({ x: 'a', y: 0, w: 10, h: 10 }), [0, 0, 0, 0]);
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
