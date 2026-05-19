const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('upgrade', {
  status: () => ipcRenderer.invoke('upgrade:status'),
  openLink: (url) => ipcRenderer.invoke('shell:open', url),
  openLicenseWindow: () => ipcRenderer.invoke('upgrade:open-license'),
  close: () => ipcRenderer.invoke('upgrade:close')
});
