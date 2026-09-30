// Run with Electron and a generated 16 kHz WAV at test/fixtures/dictation.wav.
// Uses synthetic microphone input and a separate profile; no user audio/data.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
app.setPath('userData', path.join(root, 'test', 'runtime-profile'));
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-file-for-fake-audio-capture', path.join(__dirname, 'fixtures', 'dictation.wav'));
const resultPath = path.join(__dirname, 'runtime-result.json');
const results = {};
let finished = false;
function finish(error) {
  if (finished) return;
  finished = true;
  if (error) results.error = error.stack || String(error);
  fs.writeFileSync(resultPath, JSON.stringify(results, null, 2));
  app.exit(error ? 1 : 0);
}
setTimeout(() => finish(new Error('Runtime smoke timed out')), 120000);
app.whenReady().then(async () => {
  const { uIOhook } = require('uiohook-napi');
  uIOhook.start(); uIOhook.stop(); uIOhook.start(); uIOhook.stop();
  results.hookRestart = true;
  session.defaultSession.setPermissionRequestHandler((_web, permission, cb) => cb(permission === 'media'));
  const win = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(root, 'src/preload/overlay-preload.js'),
    contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false
  } });
  ipcMain.on('recorder:error', (_event, payload) => finish(new Error(JSON.stringify(payload))));
  ipcMain.on('recorder:empty', (_event, payload) => finish(new Error(JSON.stringify(payload))));
  ipcMain.on('recorder:ready', (_event, payload) => {
    results.microphoneReady = payload.sessionId === 1;
    setTimeout(() => win.webContents.send('recorder:stop', { sessionId: 1 }), 6500);
  });
  ipcMain.on('recorder:audio', async (_event, payload) => {
    try {
      const pcm = new Float32Array(payload.pcm);
      results.frames = pcm.length;
      results.seconds = pcm.length / 16000;
      results.peak = pcm.reduce((peak, v) => Math.max(peak, Math.abs(v)), 0);
      if (pcm.length < 16000 || results.peak < 0.001) throw new Error('Recorded PCM is missing or silent');
      const asr = require('../src/main/local-asr');
      results.transcript = await asr.transcribeLocal({ pcm });
      if (!/quick brown fox/i.test(results.transcript)) throw new Error('Expected speech not recognized');
      results.passed = true;
      finish();
    } catch (err) { finish(err); }
  });
  await win.loadFile(path.join(root, 'src/renderer/overlay.html'));
  win.webContents.send('recorder:start', { sessionId: 1, wantPcm: true, inputDeviceId: 'default' });
}).catch(finish);
