import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUTTON,
  PAD,
  BUTTON_WINDOW,
  defaultButtonPosition,
  clampButton,
  panelBounds,
  terminalArea,
} from '../src/widgetLayout.js';

// A 1920x1080 screen with a 48px taskbar at the bottom.
const work = { x: 0, y: 0, width: 1920, height: 1032 };

test('the button starts in the bottom-right corner, circle 20px from the edges', () => {
  const p = defaultButtonPosition(work);
  assert.equal(p.x + PAD + BUTTON, work.width - 20);
  assert.equal(p.y + PAD + BUTTON, work.height - 20);
});

test('clampButton keeps the whole button window on the work area', () => {
  assert.deepEqual(clampButton({ x: 5000, y: -40 }, work), { x: work.width - BUTTON_WINDOW, y: 0 });
  assert.deepEqual(clampButton({ x: -10.6, y: 500.4 }, work), { x: 0, y: 500 });
  // A second monitor to the left (negative x).
  const left = { x: -1920, y: 0, width: 1920, height: 1040 };
  assert.deepEqual(clampButton({ x: -100, y: 2000 }, left), { x: -100, y: 1040 - BUTTON_WINDOW });
});

test('panel: button bottom-right -> card above it, right edges aligned, full height', () => {
  const btn = defaultButtonPosition(work);
  const { bounds, origin } = panelBounds(btn, work);
  const card = { x: bounds.x + PAD, y: bounds.y + PAD, right: bounds.x + bounds.width - PAD, bottom: bounds.y + bounds.height - PAD };
  assert.equal(origin, 'right bottom');
  assert.equal(card.right, btn.x + PAD + BUTTON); // aligned with the circle's right edge
  assert.equal(card.right - card.x, 440);
  assert.equal(card.y, 8); // from the top of the work area
  assert.equal(card.bottom, btn.y + PAD - 8); // just above the circle
});

test('panel: button top-left -> card below it, left-aligned', () => {
  const btn = { x: 40, y: 40 };
  const { bounds, origin } = panelBounds(btn, work);
  assert.equal(origin, 'left top');
  assert.equal(bounds.x + PAD, btn.x + PAD);
  assert.equal(bounds.y + PAD, btn.y + PAD + BUTTON + 8);
  assert.equal(bounds.y + bounds.height - PAD, work.height - 8);
});

test('panel: no room on that side -> full height; never off the screen sideways', () => {
  const btn = { x: 1800, y: 120 }; // upper half, right edge — below would be fine, so force a tiny screen
  const small = { x: 0, y: 0, width: 400, height: 300 };
  const { bounds } = panelBounds(btn, small);
  assert.ok(bounds.x + PAD >= small.x + 8);
  assert.ok(bounds.x + bounds.width - PAD <= small.x + small.width - 8);
  assert.equal(bounds.y + PAD, 8);
  assert.equal(bounds.y + bounds.height - PAD, 300 - 8);
});

test('terminalArea: button at the right edge -> keep its column free', () => {
  const btn = defaultButtonPosition(work);
  const a = terminalArea(btn, work);
  assert.deepEqual(a, { x: 0, y: 0, width: btn.x + PAD - 8, height: 1032 });
});

test('terminalArea: button at the left edge -> start after it', () => {
  const btn = { x: 8, y: 900 };
  const a = terminalArea(btn, work);
  assert.equal(a.x, btn.x + PAD + BUTTON + 8);
  assert.equal(a.x + a.width, 1920);
});

test('terminalArea: button in the middle -> the whole work area', () => {
  assert.deepEqual(terminalArea({ x: 900, y: 500 }, work), { x: 0, y: 0, width: 1920, height: 1032 });
});
