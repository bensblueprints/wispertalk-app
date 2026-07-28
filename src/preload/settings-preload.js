const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('flow', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  getChoices: () => ipcRenderer.invoke('settings:choices'),
  setSettings: (updates) => ipcRenderer.invoke('settings:set', updates),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),
  closeWindow: () => ipcRenderer.invoke('settings:close'),
  getHistory: () => ipcRenderer.invoke('history:list'),
  getLicense: () => ipcRenderer.invoke('license:status'),
  deactivateLicense: () => ipcRenderer.invoke('license:deactivateThisDevice'),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  // Press-to-map hotkey capture
  captureHotkey: (mode) => ipcRenderer.invoke('hotkey:capture', mode),
  cancelCapture: () => ipcRenderer.invoke('hotkey:capture-cancel'),
  getHotkeyStatus: () => ipcRenderer.invoke('hotkey:status'),
  rearmHotkeys: () => ipcRenderer.invoke('hotkey:rearm'),
  labelForKey: (name) => ipcRenderer.invoke('settings:label-for-key', name),
  onToast: (cb) => ipcRenderer.on('toast', (_e, p) => cb(p))
});
