const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('flow', {
  onStart: (cb) => ipcRenderer.on('recorder:start', (_e, payload) => cb(payload || {})),
  onStop: (cb) => ipcRenderer.on('recorder:stop', cb),
  onShow: (cb) => ipcRenderer.on('overlay:show', (_e, payload) => cb(payload)),
  onHide: (cb) => ipcRenderer.on('overlay:hide', cb),
  sendAudio: (audioBuffer, mimeType) => ipcRenderer.send('recorder:audio', { audioBuffer, mimeType }),
  cancel: () => ipcRenderer.send('recorder:cancel'),
  reportError: (msg) => ipcRenderer.send('recorder:error', msg)
});
