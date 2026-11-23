import { app } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from '@csm/agent';
import { createWidget } from './widget.js';

// The desktop app is the floating widget only: a round button that stays on
// top of everything and opens the Sessions list above it (widget.js). There
// is no main window — Monitor / Office live in the web UI (`npm run web`).
// Both widget windows load pages from the same local agent + web UI the
// browser uses (127.0.0.1, per-run token), so no Electron-specific UI path.

const PRELOAD = fileURLToPath(new URL('./preload.cjs', import.meta.url));

/**
 * The desktop agent's port. Fixed on purpose: the page's own settings (theme,
 * last folder, list layout) live in localStorage, which belongs to the
 * origin — on a random port every start they were forgotten. Busy (another
 * install, a dev run) → any free port.
 */
const PORT = 4778;

/** @type {import('http').Server | null} */
let agentServer = null;
/** @type {ReturnType<typeof createWidget> | null} */
let widget = null;

// One app at a time: starting it again opens the running one's list instead
// of a second agent and a second floating button.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else app.on('second-instance', () => { if (widget) widget.open(); });

async function startAgent() {
  try {
    return await start({ port: PORT });
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') return start({ port: 0 });
    throw err;
  }
}

app.whenReady().then(async () => {
  if (!gotLock) return;
  let info;
  try {
    info = await startAgent();
  } catch (err) {
    // If the agent can't start there's nothing to show; surface and quit.
    const { dialog } = await import('electron');
    dialog.showErrorBox('Claude Session Manager', `Failed to start: ${err.message}`);
    app.quit();
    return;
  }
  agentServer = info.server;
  const u = new URL(info.url);
  widget = createWidget({
    base: u.origin,
    token: u.searchParams.get('token') || '',
    preload: PRELOAD,
    stateFile: path.join(app.getPath('userData'), 'widget.json'),
    openOnStart: true, // show the list once, so starting the app visibly does something
    onQuit: () => app.quit(),
  });

  app.on('activate', () => { if (widget) widget.open(); });
});

// The widget's windows stay until Quit (from the button's menu).
app.on('window-all-closed', () => {
  if (agentServer) agentServer.close();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (widget) widget.destroy();
  widget = null;
  if (agentServer) agentServer.close();
});
