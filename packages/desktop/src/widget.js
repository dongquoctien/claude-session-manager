import { BrowserWindow, Menu, ipcMain, screen } from 'electron';
import fs from 'node:fs';
import {
  BUTTON_WINDOW,
  clampButton,
  defaultButtonPosition,
  panelBounds,
  terminalArea,
} from './widgetLayout.js';

/**
 * The floating widget: a round button that stays on top of everything (like a
 * chat widget) and opens the Sessions list above it.
 *
 * Two transparent, frameless, always-on-top windows, both showing pages the
 * local agent serves (127.0.0.1 + the per-run token, like the web UI):
 *  - button: `fab.html` — the circle with the running count and a dot when a
 *    session waits for input. Never takes focus (clicking it doesn't steal
 *    the keyboard from a terminal). Drag it anywhere; click toggles the list;
 *    right-click: menu (list, light/dark theme, back to the corner, quit).
 *    Its position is remembered.
 *  - panel: the regular web UI with `?view=widget` — a rounded card with a
 *    shadow. Created once and only shown / hidden, so opening is instant.
 *
 * Terminals opened from the panel are placed in `terminalArea` (asked for by
 * the page via IPC, converted to physical pixels here).
 *
 * @param {{ base: string, token: string, preload: string, stateFile: string,
 *           openOnStart?: boolean, onQuit: () => void }} opts
 *   openOnStart — open the list once its page has loaded
 */
export function createWidget(opts) {
  const common = {
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false, // the pages draw their own (inside the transparent margin)
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: opts.preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  };
  const token = encodeURIComponent(opts.token);

  const start = startPosition();
  const button = new BrowserWindow({
    ...common,
    width: BUTTON_WINDOW,
    height: BUTTON_WINDOW,
    x: start.x,
    y: start.y,
    focusable: false,
    title: 'Claude Session Manager — button',
  });
  button.setAlwaysOnTop(true, 'pop-up-menu'); // above the panel and other topmost windows
  button.loadURL(`${opts.base}/fab.html?token=${token}`);
  button.once('ready-to-show', () => button.showInactive());

  const panel = new BrowserWindow({
    ...common,
    width: 464,
    height: 640,
    title: 'Claude Session Manager',
  });
  panel.setAlwaysOnTop(true, 'floating');
  panel.loadURL(`${opts.base}/?token=${token}&view=widget`);

  let open = false;
  let origin = 'right bottom';
  let hideTimer = null;

  const pos = () => { const [x, y] = button.getPosition(); return { x, y }; };
  const work = () => screen.getDisplayMatching(button.getBounds()).workArea;
  const tellPanel = (isOpen) => panel.webContents.send('widget:panel', { open: isOpen, origin });
  const tellButton = () => button.webContents.send('widget:state', { open });

  function openPanel() {
    clearTimeout(hideTimer);
    const layout = panelBounds(pos(), work());
    origin = layout.origin;
    panel.setBounds(layout.bounds);
    tellPanel(false); // start from the closed look, then animate open
    panel.show();
    panel.focus();
    setTimeout(() => { if (open) tellPanel(true); }, 16);
    open = true;
    tellButton();
    button.moveTop();
  }

  function closePanel() {
    if (!open) return;
    open = false;
    tellPanel(false);
    tellButton();
    hideTimer = setTimeout(() => { if (!open) panel.hide(); }, 200); // after the fade
  }

  const toggle = () => (open ? closePanel() : openPanel());

  // A page that (re)loads while open starts closed-looking: open it again.
  let firstLoad = true;
  panel.webContents.on('did-finish-load', () => {
    if (firstLoad && opts.openOnStart && !open) openPanel();
    else if (open) tellPanel(true);
    firstLoad = false;
  });
  button.webContents.on('did-finish-load', tellButton);

  // --- drag: follow the cursor while the button is held -------------------
  let drag = null;
  ipcMain.on('widget:press', (e) => {
    if (e.sender !== button.webContents) return;
    const cur = screen.getCursorScreenPoint();
    const p = pos();
    drag = { cx: cur.x, cy: cur.y, x: p.x, y: p.y, moved: false, timer: null, started: Date.now() };
    drag.timer = setInterval(() => {
      if (!drag) return;
      const c = screen.getCursorScreenPoint();
      const dx = c.x - drag.cx;
      const dy = c.y - drag.cy;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 4) {
        drag.moved = true;
        closePanel();
      }
      if (drag.moved) {
        const area = screen.getDisplayNearestPoint(c).workArea;
        const next = clampButton({ x: drag.x + dx, y: drag.y + dy }, area);
        button.setPosition(next.x, next.y);
      }
      if (Date.now() - drag.started > 30_000) endDrag(); // a lost release can't keep it going
    }, 15);
  });

  function endDrag() {
    if (!drag) return null;
    clearInterval(drag.timer);
    const was = drag;
    drag = null;
    return was;
  }

  ipcMain.on('widget:release', (e) => {
    if (e.sender !== button.webContents) return;
    const was = endDrag();
    if (!was) return;
    if (was.moved) savePosition(pos());
    else toggle();
  });

  ipcMain.on('widget:toggle', (e) => {
    if (e.sender === button.webContents || e.sender === panel.webContents) toggle();
  });
  ipcMain.on('widget:collapse', (e) => {
    if (e.sender === panel.webContents) closePanel();
  });

  ipcMain.on('widget:menu', (e) => {
    if (e.sender !== button.webContents) return;
    Menu.buildFromTemplate([
      { label: open ? 'Close the list' : 'Open the list', click: toggle },
      // The list's own theme button is hidden in the widget; this is it.
      { label: 'Light / dark theme', click: () => panel.webContents.send('widget:theme') },
      { type: 'separator' },
      { label: 'Move the button back to the corner', click: () => {
        const p = defaultButtonPosition(screen.getPrimaryDisplay().workArea);
        closePanel();
        button.setPosition(p.x, p.y);
        savePosition(p);
      } },
      { type: 'separator' },
      { label: 'Quit Claude Session Manager', click: opts.onQuit },
    ]).popup({ window: button });
  });

  // Where terminals opened from the list go — in physical pixels, which is
  // what the switch helper works in.
  ipcMain.handle('widget:place-rect', (e) => {
    if (e.sender !== panel.webContents) return null;
    const area = terminalArea(pos(), work());
    const px = process.platform === 'win32' ? screen.dipToScreenRect(null, area) : area;
    return { x: Math.round(px.x), y: Math.round(px.y), w: Math.round(px.width), h: Math.round(px.height) };
  });

  // Screens change (resolution, a monitor unplugged): keep the button visible.
  const keepOnScreen = () => {
    const p = clampButton(pos(), work());
    button.setPosition(p.x, p.y);
    if (open) openPanel();
  };
  screen.on('display-metrics-changed', keepOnScreen);
  screen.on('display-removed', keepOnScreen);

  function startPosition() {
    try {
      const saved = JSON.parse(fs.readFileSync(opts.stateFile, 'utf8'));
      if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
        const area = screen.getDisplayNearestPoint({ x: saved.x, y: saved.y }).workArea;
        return clampButton(saved, area);
      }
    } catch (e) { /* first run, or an unreadable file: default corner */ }
    return defaultButtonPosition(screen.getPrimaryDisplay().workArea);
  }

  function savePosition(p) {
    try { fs.writeFileSync(opts.stateFile, JSON.stringify({ x: p.x, y: p.y })); } catch (e) { /* not fatal */ }
  }

  return {
    toggle,
    open: () => { if (!open) openPanel(); else panel.focus(); },
    close: closePanel,
    destroy() {
      endDrag();
      for (const ch of ['widget:press', 'widget:release', 'widget:toggle', 'widget:collapse', 'widget:menu']) ipcMain.removeAllListeners(ch);
      ipcMain.removeHandler('widget:place-rect');
      screen.removeListener('display-metrics-changed', keepOnScreen);
      screen.removeListener('display-removed', keepOnScreen);
      if (!panel.isDestroyed()) panel.destroy();
      if (!button.isDestroyed()) button.destroy();
    },
  };
}
