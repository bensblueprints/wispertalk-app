const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('flow', {
  onStart: (cb) => ipcRenderer.on('recorder:start', (_e, payload) => cb(payload || {})),
  onStop: (cb) => ipcRenderer.on('recorder:stop', (_e, payload) => cb(payload || {})),
  onShow: (cb) => ipcRenderer.on('overlay:show', (_e, payload) => cb(payload)),
  onHide: (cb) => ipcRenderer.on('overlay:hide', cb),
  onTranscript: (cb) => ipcRenderer.on('overlay:transcript', (_e, payload) => cb(payload || {})),
  transcriptDone: () => ipcRenderer.send('overlay:transcript-done'),
  onAbort: (cb) => ipcRenderer.on('recorder:abort', cb),
  sendAudio: (payload) => ipcRenderer.send('recorder:audio', payload),
  ready: (payload) => ipcRenderer.send('recorder:ready', payload),
  warning: (payload) => ipcRenderer.send('recorder:warning', payload),
  // Nothing usable was captured — main must still be told, or it stays busy.
  sendEmpty: (reason) => ipcRenderer.send('recorder:empty', reason),
  cancel: () => ipcRenderer.send('recorder:cancel'),
  reportError: (msg) => ipcRenderer.send('recorder:error', msg)
});
