import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PIP_WINDOW_TITLE, LAYOUT_CS, psString } from '../src/dock.js';

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

test('the layout C# has no PowerShell-expandable characters', () => {
  // It is embedded in a double-quoted here-string: `$` or a backtick would be
  // expanded/escaped by PowerShell before C# ever sees it.
  assert.ok(!LAYOUT_CS.includes('$'));
  assert.ok(!LAYOUT_CS.includes('`'));
});

test('psString quotes for PowerShell single-quoted literals', () => {
  assert.equal(psString("it's"), "'it''s'");
});
