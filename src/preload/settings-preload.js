const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('flow', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  getChoices: () => ipcRenderer.invoke('settings:choices'),
  setSettings: (updates) => ipcRenderer.invoke('settings:set', updates),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),
  closeWindow: () => ipcRenderer.invoke('settings:close'),
  getHistory: () => ipcRenderer.invoke('history:list'),
  getLicense: () => ipcRenderer.invoke('license:status'),
  deactivateLicense: () => ipcRenderer.invoke('license:deactivate'),
  onToast: (cb) => ipcRenderer.on('toast', (_e, p) => cb(p))
});
