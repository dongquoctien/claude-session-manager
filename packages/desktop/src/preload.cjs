// Preload for the desktop app's windows (the widget's button and panel).
// Exposes only the widget controls — no Node, no Electron objects.
// The page code (packages/ui/public) checks for `window.csmDesktop`; in a
// browser it doesn't exist and nothing changes.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('csmDesktop', {
  widget: {
    // button
    press: () => ipcRenderer.send('widget:press'),
    release: () => ipcRenderer.send('widget:release'),
    menu: () => ipcRenderer.send('widget:menu'),
    onState: (fn) => { ipcRenderer.on('widget:state', (_e, s) => fn(s)); },
    // panel
    toggle: () => ipcRenderer.send('widget:toggle'),
    collapse: () => ipcRenderer.send('widget:collapse'),
    placeRect: () => ipcRenderer.invoke('widget:place-rect'),
    onPanel: (fn) => { ipcRenderer.on('widget:panel', (_e, s) => fn(s)); },
    onTheme: (fn) => { ipcRenderer.on('widget:theme', () => fn()); },
  },
});
