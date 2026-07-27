const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('flow', {
  activate: (email) => ipcRenderer.invoke('license:activate', { email }),
  status: () => ipcRenderer.invoke('license:status'),
  buyUrl: () => ipcRenderer.invoke('license:buy-url'),
  openLink: (url) => ipcRenderer.invoke('shell:open', url),
  quit: () => ipcRenderer.invoke('app:quit')
});
