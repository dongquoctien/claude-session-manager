/**
 * Geometry of the desktop widget — pure functions, no Electron (tested in
 * test/widgetLayout.test.js). Everything is in Electron DIPs, relative to a
 * display's work area `{ x, y, width, height }`.
 *
 *  - the round button lives in a small transparent window: BUTTON px circle +
 *    PAD px of room around it for its shadow;
 *  - the list ("panel") is a transparent window holding a rounded card, also
 *    with PAD px of room for the shadow, next to the button;
 *  - terminals opened from the widget fill the work area, minus the button's
 *    column when the button sits at a left/right edge.
 */

export const BUTTON = 56;
export const PAD = 12;
/** The button window's size. */
export const BUTTON_WINDOW = BUTTON + 2 * PAD;

const EDGE_GAP = 8;        // screen edge → button window
const CARD_WIDTH = 440;
const CARD_GAP = 8;        // button ↔ card
const CARD_MARGIN = 8;     // screen edge → card
const MIN_CARD_HEIGHT = 260;
const NEAR_EDGE = 160;     // button this close to a side edge → keep its column free
const MIN_TERMINAL_WIDTH = 320;

/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Where the button window starts: the bottom-right corner (the circle 20px
 * from both edges).
 * @param {Rect} work
 */
export function defaultButtonPosition(work) {
  return {
    x: work.x + work.width - BUTTON_WINDOW - EDGE_GAP,
    y: work.y + work.height - BUTTON_WINDOW - EDGE_GAP,
  };
}

/**
 * Keep the button window inside the work area (e.g. after a drag, or a saved
 * position on a display that got smaller).
 * @param {{ x: number, y: number }} pos
 * @param {Rect} work
 */
export function clampButton(pos, work) {
  return {
    x: Math.round(clamp(pos.x, work.x, work.x + work.width - BUTTON_WINDOW)),
    y: Math.round(clamp(pos.y, work.y, work.y + work.height - BUTTON_WINDOW)),
  };
}

/** The circle inside the button window. @param {{ x: number, y: number }} btn */
function circleOf(btn) {
  return { x: btn.x + PAD, y: btn.y + PAD, width: BUTTON, height: BUTTON };
}

/**
 * The panel window next to the button: on the side of the screen the button
 * is on (aligned with its outer edge), above it when the button is in the
 * lower half — as tall as the work area allows — otherwise below it.
 * `origin` is the CSS transform-origin for the open/close animation (the
 * corner nearest the button).
 *
 * @param {{ x: number, y: number }} btn  the button window's position
 * @param {Rect} work
 * @returns {{ bounds: Rect, origin: string }}
 */
export function panelBounds(btn, work) {
  const c = circleOf(btn);
  const right = c.x + c.width / 2 >= work.x + work.width / 2;
  const below = c.y + c.height / 2 < work.y + work.height / 2;
  const cardW = Math.min(CARD_WIDTH, work.width - 2 * CARD_MARGIN);
  let x = right ? c.x + c.width - cardW : c.x;
  x = clamp(x, work.x + CARD_MARGIN, work.x + work.width - CARD_MARGIN - cardW);
  let top;
  let bottom;
  if (below) {
    top = c.y + c.height + CARD_GAP;
    bottom = work.y + work.height - CARD_MARGIN;
  } else {
    top = work.y + CARD_MARGIN;
    bottom = c.y - CARD_GAP;
  }
  if (bottom - top < MIN_CARD_HEIGHT) {
    // Not enough room on that side: use the full height, overlapping is fine.
    top = work.y + CARD_MARGIN;
    bottom = work.y + work.height - CARD_MARGIN;
  }
  return {
    bounds: {
      x: Math.round(x - PAD),
      y: Math.round(top - PAD),
      width: Math.round(cardW + 2 * PAD),
      height: Math.round(bottom - top + 2 * PAD),
    },
    origin: `${right ? 'right' : 'left'} ${below ? 'top' : 'bottom'}`,
  };
}

/**
 * Where a terminal opened from the widget goes: the work area — minus the
 * button's column when the button sits near the left or right edge, so it
 * never covers the terminal (claude's input line is at the bottom).
 *
 * @param {{ x: number, y: number }} btn
 * @param {Rect} work
 * @returns {Rect}
 */
export function terminalArea(btn, work) {
  const c = circleOf(btn);
  const right = work.x + work.width;
  let x0 = work.x;
  let x1 = right;
  if (right - (c.x + c.width) <= NEAR_EDGE) x1 = c.x - EDGE_GAP;
  else if (c.x - work.x <= NEAR_EDGE) x0 = c.x + c.width + EDGE_GAP;
  if (x1 - x0 < MIN_TERMINAL_WIDTH) { x0 = work.x; x1 = right; }
  return { x: x0, y: work.y, width: x1 - x0, height: work.height };
}
