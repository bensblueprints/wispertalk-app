const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('flow', {
  activate: (key, force) => ipcRenderer.invoke('license:activate', { key, force }),
  status: () => ipcRenderer.invoke('license:status'),
  buyUrl: () => ipcRenderer.invoke('license:buy-url'),
  openLink: (url) => ipcRenderer.invoke('shell:open', url),
  quit: () => ipcRenderer.invoke('app:quit')
});
