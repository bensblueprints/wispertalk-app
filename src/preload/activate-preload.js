const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('flow', {
  activate: (key) => ipcRenderer.invoke('license-key:activate', key)
});
