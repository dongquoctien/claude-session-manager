import { app, BrowserWindow, shell } from 'electron';
import { start } from '@csm/agent';

// The desktop app is just a chrome around the exact same local agent + web UI
// the browser uses. The agent binds 127.0.0.1 with a per-run token, so loading
// its URL here is as safe as opening it in a browser — and we reuse all the
// tested UI/agent code without an Electron-specific code path.

/** @type {import('http').Server | null} */
let agentServer = null;
/** @type {BrowserWindow | null} */
let win = null;

async function startAgent() {
  // Port 0 -> OS picks a free port, so two installs / a running CLI agent
  // don't collide.
  const info = await start({ port: 0 });
  agentServer = info.server;
  return info.url;
}

function createWindow(url) {
  win = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#1a1815',
    title: 'Claude Session Manager',
    autoHideMenuBar: true,
    webPreferences: {
      // The page only talks to the agent over HTTP; it needs no Node access.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  win.loadURL(url);

  // Any link that would navigate away from the local app opens in the real
  // browser instead of hijacking the window.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    if (!target.startsWith('http://127.0.0.1')) {
      e.preventDefault();
      shell.openExternal(target);
    }
  });

  win.on('closed', () => {
    win = null;
  });
}

app.whenReady().then(async () => {
  let url;
  try {
    url = await startAgent();
  } catch (err) {
    // If the agent can't start there's nothing to show; surface and quit.
    const { dialog } = await import('electron');
    dialog.showErrorBox('Claude Session Manager', `Failed to start: ${err.message}`);
    app.quit();
    return;
  }
  createWindow(url);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(url);
  });
});

app.on('window-all-closed', () => {
  if (agentServer) agentServer.close();
  // Standard desktop behavior: quit on Windows/Linux when all windows close.
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (agentServer) agentServer.close();
});
