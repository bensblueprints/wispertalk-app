const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, shell, dialog, powerMonitor, Notification } = require('electron');
const path = require('node:path');
const store = require('./store');
const { HotkeyManager, HOLD_KEY_CHOICES, holdKeyChoices, labelForName } = require('./hotkey');
const { transcribe } = require('./transcribe');
const localAsr = require('./local-asr');
const { cleanup } = require('./postprocess');
const { pasteText } = require('./paste');
const { getForegroundContext } = require('./context');
const { gateLicense, registerLicenseIpc } = require('./license-gate');
const { isTrusted, ensureAccessibility } = require('./mac-accessibility');

const ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'icon-128.png');

// If the renderer hasn't handed back audio this long after we asked it to stop,
// something went wrong down there (crashed window, MediaRecorder that never
// fired onstop, IPC lost). Reset rather than sit in `busy` forever.
const AUDIO_HANDBACK_TIMEOUT_MS = 5000;

let tray = null;
let overlayWin = null;
let settingsWin = null;
let hotkey = null;
let state = 'idle';
let busy = false;
let overlayReady = false;
let audioWatchdog = null;
let lastHotkeyStatus = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => openSettings());

app.whenReady().then(init);

app.on('window-all-closed', (e) => {
  e.preventDefault();
});

app.on('before-quit', () => {
  clearAudioWatchdog();
  hotkey?.shutdown();
});

async function init() {
  app.setAppUserModelId('com.wispertalk.app');

  // Whop purchase gate — "Sign in with Whop" verifies the purchase; no keys.
  if (!(await gateLicense())) return; // quit already requested
  registerLicenseIpc();

  // On macOS the hotkey cannot install without Accessibility ("failed to enable
  // access for assistive devices"). Ask for it properly - registering with the
  // system so the toggle exists, then re-arming once granted. Deliberately NOT
  // gated on a "shown once" flag: if the permission is missing the app is
  // broken, so it must keep asking rather than fail silently on later runs.
  if (process.platform === 'darwin' && !isTrusted(false)) {
    ensureAccessibility({
      reason: 'WisperTalk needs it to detect your hotkey and paste transcribed text.',
      onGranted: () => applyHotkeys({ announceFailures: false }),
    });
  }

  createOverlayWindow();
  createTray();

  hotkey = new HotkeyManager({
    onToggle: () => handleToggle(),
    onHoldPress: () => handleHoldPress(),
    onHoldRelease: () => handleHoldRelease(),
    onStatus: (status, reason) => onHotkeyStatus(status, reason)
  });

  registerIpc();
  registerPowerHandlers();
  applyHotkeys({ announceFailures: true });

  if (store.get('sttEngine') === 'local' && localAsr.isAvailable()) {
    // Cold-load the ONNX model in the background so the first dictation is fast.
    localAsr.warmUp();
  }

  if (store.get('sttEngine') !== 'local' && !store.get('groqApiKey')) {
    openSettings();
  }
}

/**
 * Arm the hotkeys and make any failure visible. Silent failure here was the
 * whole reason "sometimes pressing the key does nothing" was undiagnosable.
 */
function applyHotkeys({ announceFailures = false } = {}) {
  const cfg = store.getAll();
  const status = hotkey.apply({
    holdEnabled: cfg.holdEnabled,
    holdHotkey: cfg.holdHotkey,
    toggleEnabled: cfg.toggleEnabled,
    toggleHotkey: cfg.toggleHotkey
  });
  lastHotkeyStatus = status;
  rebuildTrayMenu();
  if (announceFailures) announceHotkeyProblems(status);
  return status;
}

function hotkeyProblems(status) {
  const out = [];
  if (status?.hold?.enabled && !status.hold.ok && status.hold.error) out.push(status.hold.error);
  if (status?.toggle?.enabled && !status.toggle.ok && status.toggle.error) out.push(status.toggle.error);
  return out;
}

/** uiohook's wording when macOS has not trusted us as an assistive device. */
function looksLikeAccessibilityDenial(problems) {
  return process.platform === 'darwin'
    && problems.some(p => /assistive|accessibility|keyboard hook/i.test(String(p)));
}

function announceHotkeyProblems(status) {
  const problems = hotkeyProblems(status);
  if (!problems.length) return;

  // Telling someone to "pick a different key" is useless when the real cause is
  // a missing OS permission - no key will ever work. Route to the fix instead.
  if (looksLikeAccessibilityDenial(problems)) {
    ensureAccessibility({
      reason: 'The keyboard hook could not be installed.',
      onGranted: () => applyHotkeys({ announceFailures: false }),
    });
    return;
  }

  for (const p of problems) sendToast({ kind: 'error', message: p });
  // Nothing else in the app would ever tell the user; a tray tooltip + a
  // one-shot dialog beats "the key just does nothing".
  try { tray?.setToolTip(`WisperTalk — hotkey problem: ${problems[0]}`); } catch {}
  dialog.showMessageBox({
    type: 'warning',
    title: 'WisperTalk — hotkey not registered',
    message: 'WisperTalk could not register one of your hotkeys.',
    detail: `${problems.join('\n\n')}\n\nOpen Settings → Hotkeys to pick a different key.`,
    buttons: ['Open Settings', 'Ignore'],
    defaultId: 0
  }).then((res) => { if (res.response === 0) openSettings(); }).catch(() => {});
}

function onHotkeyStatus(status, reason) {
  lastHotkeyStatus = status;
  rebuildTrayMenu();
  const problems = hotkeyProblems(status);
  if (problems.length) {
    sendToast({ kind: 'error', message: `Hotkeys (${reason}): ${problems[0]}` });
  } else {
    try { tray?.setToolTip('WisperTalk'); } catch {}
  }
}

/**
 * Re-arm after the OS has had a chance to eat our low-level keyboard hook.
 * Sleep/resume and screen lock/unlock are the common ways uiohook goes quiet
 * while the process stays alive.
 */
function registerPowerHandlers() {
  const rearm = (reason) => () => {
    resetPipeline({ silent: true });
    hotkey?.rearm(reason);
  };
  try {
    powerMonitor.on('resume', rearm('system resume'));
    powerMonitor.on('unlock-screen', rearm('screen unlock'));
    powerMonitor.on('suspend', () => { hotkey?.clearHolding(); resetPipeline({ silent: true }); });
    powerMonitor.on('lock-screen', () => { hotkey?.clearHolding(); resetPipeline({ silent: true }); });
  } catch (err) {
    console.warn('powerMonitor wiring failed:', err.message);
  }
}

function createOverlayWindow() {
  const display = screen.getPrimaryDisplay();
  const w = 320;
  const h = 96;
  overlayReady = false;
  overlayWin = new BrowserWindow({
    width: w,
    height: h,
    x: Math.round((display.workAreaSize.width - w) / 2) + display.workArea.x,
    y: display.workArea.y + display.workAreaSize.height - h - 48,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.setIgnoreMouseEvents(true);

  // Until this fires, every webContents.send() into the overlay is dropped on
  // the floor — which used to mean an early hotkey press started nothing and
  // then wedged the app in `busy`.
  overlayWin.webContents.on('did-finish-load', () => { overlayReady = true; });

  // If the recorder window dies we lose the mic AND the IPC partner. Rebuild it.
  overlayWin.webContents.on('render-process-gone', (_e, details) => {
    console.error('Overlay renderer gone:', details?.reason);
    overlayReady = false;
    resetPipeline({ message: 'Recorder restarted after a crash. Try again.' });
    try { overlayWin.destroy(); } catch {}
    overlayWin = null;
    setTimeout(() => { if (!overlayWin) createOverlayWindow(); }, 500);
  });

  overlayWin.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));
}

function overlayAlive() {
  return !!(overlayWin && !overlayWin.isDestroyed() && overlayReady);
}

function sendToOverlay(channel, payload) {
  if (!overlayAlive()) return false;
  try {
    overlayWin.webContents.send(channel, payload);
    return true;
  } catch (err) {
    console.error(`Failed to send ${channel} to overlay:`, err.message);
    return false;
  }
}

function createTray() {
  let img = nativeImage.createFromPath(ICON_PATH);
  if (img.isEmpty()) img = nativeImage.createEmpty();
  else img = img.resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('WisperTalk');
  rebuildTrayMenu();
  tray.on('click', () => openSettings());
  tray.on('double-click', () => openSettings());
}

function rebuildTrayMenu() {
  if (!tray) return;
  const cfg = store.getAll();
  const holdBad = lastHotkeyStatus?.hold?.enabled && !lastHotkeyStatus.hold.ok;
  const toggleBad = lastHotkeyStatus?.toggle?.enabled && !lastHotkeyStatus.toggle.ok;

  const items = [
    { label: `WisperTalk — ${labelForState()}`, enabled: false },
    { type: 'separator' },
    { label: cfg.holdEnabled ? `Hold: ${labelForName(cfg.holdHotkey)}${holdBad ? ' (NOT ACTIVE)' : ''}` : 'Hold: off', enabled: false },
    { label: cfg.toggleEnabled ? `Toggle: ${cfg.toggleHotkey}${toggleBad ? ' (NOT ACTIVE)' : ''}` : 'Toggle: off', enabled: false },
    { label: `Engine: ${cfg.sttEngine === 'local' ? 'Local (offline)' : 'Groq (cloud)'}`, enabled: false },
    { type: 'separator' },
    { label: 'Licensed via Whop', enabled: false },
    { type: 'separator' },
    { label: 'Settings…', click: () => openSettings() },
    { label: 'Re-arm hotkeys', click: () => { const s = hotkey?.rearm('tray menu'); if (s && !hotkeyProblems(s).length) sendToast({ kind: 'success', message: 'Hotkeys re-armed.' }); } },
    { label: 'Reset (if stuck)', click: () => resetPipeline({ message: 'Reset. Ready.' }) },
    { label: 'Open log folder', click: () => shell.openPath(app.getPath('userData')) },
    { type: 'separator' },
    { label: 'Quit WisperTalk', click: () => app.quit() }
  ];
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function labelForState() {
  if (busy) return 'Processing…';
  if (state === 'recording') return 'Recording…';
  return 'Ready';
}

function setState(next) {
  state = next;
  rebuildTrayMenu();
}

function setBusy(next) {
  busy = next;
  rebuildTrayMenu();
}

/** Single place that puts the app back to idle, whatever went wrong. */
function resetPipeline({ message = null, kind = 'info', silent = false } = {}) {
  clearAudioWatchdog();
  state = 'idle';
  busy = false;
  hideOverlay();
  rebuildTrayMenu();
  if (message && !silent) sendToast({ kind, message });
}

function clearAudioWatchdog() {
  if (audioWatchdog) { clearTimeout(audioWatchdog); audioWatchdog = null; }
}

function armAudioWatchdog() {
  clearAudioWatchdog();
  audioWatchdog = setTimeout(() => {
    audioWatchdog = null;
    if (!busy) return;
    console.warn('No audio handed back within timeout — resetting.');
    // Ask the renderer to drop everything too, so the mic doesn't stay hot.
    sendToOverlay('recorder:abort');
    resetPipeline({ message: 'No audio came back from the recorder. Ready to try again.', kind: 'warn' });
  }, AUDIO_HANDBACK_TIMEOUT_MS);
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 760,
    height: 720,
    title: 'WisperTalk Settings',
    icon: ICON_PATH,
    backgroundColor: '#0f0f12',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
  settingsWin.on('closed', () => {
    hotkey?.cancelCapture('settings closed');
    settingsWin = null;
  });
}

function handleToggle() {
  if (busy) return;
  if (state === 'recording') stopRecording();
  else startRecording();
}

function handleHoldPress() {
  if (busy) return;
  if (state !== 'idle') return;
  startRecording();
}

function handleHoldRelease() {
  if (state === 'recording') stopRecording();
}

function startRecording() {
  if (state === 'recording' || busy) return; // no double-start, no start-while-busy
  if (!overlayAlive()) {
    // Starting up, or the renderer died. Don't enter `recording` — that state
    // could never be left, because nothing downstream would ever reply.
    sendToast({ kind: 'warn', message: 'Recorder is still starting up. Try again in a second.' });
    hotkey?.clearHolding();
    return;
  }
  setState('recording');
  if (store.get('showOverlay')) {
    // showInactive() — NOT show(). On macOS show() activates WisperTalk as the frontmost
    // app, stealing keyboard focus from the text field the user is dictating into (they'd
    // have to re-click it after every dictation). showInactive() displays the overlay
    // without activating the app, so the target field keeps its focus and caret.
    overlayWin.showInactive();
    sendToOverlay('overlay:show', { mode: 'recording' });
  }
  sendToOverlay('recorder:start', {
    inputDeviceId: store.get('inputDeviceId') || '',
    // The local engine needs decoded PCM; skip the work when using Groq.
    wantPcm: store.get('sttEngine') === 'local'
  });
}

function stopRecording() {
  if (state !== 'recording') return;
  setState('idle');
  setBusy(true);
  sendToOverlay('overlay:show', { mode: 'processing' });
  const delivered = sendToOverlay('recorder:stop');
  if (!delivered) {
    resetPipeline({ message: 'Recorder was not reachable. Ready to try again.', kind: 'warn' });
    return;
  }
  armAudioWatchdog();
}

function hideOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) {
    try {
      overlayWin.webContents.send('overlay:hide');
      overlayWin.hide();
    } catch {}
  }
}

function registerIpc() {
  ipcMain.handle('shell:open', (_e, url) => shell.openExternal(url));
  ipcMain.handle('app:quit', () => app.quit());

  ipcMain.handle('settings:get', () => ({ ...store.getAll() }));
  ipcMain.handle('settings:choices', () => ({
    // name + display label together, so the picker can show "Right Option (⌥)"
    // rather than the raw uiohook identifier. holdKeyChoices() is used (not the
    // static list) because Globe/Fn only appears when its helper is present.
    holdKeys: holdKeyChoices().map(name => ({ name, label: labelForName(name) })),
    hookAvailable: !!hotkey?.hookAvailable,
    hookError: hotkey?.hookLoadError || null,
    localEngineAvailable: localAsr.isAvailable(),
    localModelPath: localAsr.modelPathHint(),
    localModelId: localAsr.MODEL_ID,
    holdLabel: labelForName(store.get('holdHotkey'))
  }));
  ipcMain.handle('settings:label-for-key', (_e, name) => labelForName(name));

  // Press-to-map: listen for the user's next physical key press.
  ipcMain.handle('hotkey:capture', async (_e, mode) => {
    if (!hotkey) return { ok: false, error: 'Hotkeys not initialised yet' };
    return hotkey.startCapture(mode === 'toggle' ? 'toggle' : 'hold');
  });
  ipcMain.handle('hotkey:capture-cancel', () => {
    hotkey?.cancelCapture('user cancelled');
    return true;
  });
  ipcMain.handle('hotkey:status', () => lastHotkeyStatus);
  ipcMain.handle('hotkey:rearm', () => applyHotkeys({ announceFailures: false }));

  ipcMain.handle('settings:set', (_e, updates) => {
    const next = store.set(updates || {});
    const status = applyHotkeys({ announceFailures: false });
    if (next.sttEngine === 'local' && localAsr.isAvailable()) localAsr.warmUp();
    return { ...next, __hotkeyStatus: status };
  });
  ipcMain.handle('settings:reset', () => {
    const next = store.reset();
    applyHotkeys({ announceFailures: false });
    return next;
  });
  ipcMain.handle('settings:test-hotkey', () => {
    const cfg = store.getAll();
    return { holdEnabled: cfg.holdEnabled, holdHotkey: cfg.holdHotkey, status: lastHotkeyStatus };
  });
  ipcMain.handle('settings:close', () => {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
  });
  ipcMain.handle('history:list', () => store.get('history') || []);

  ipcMain.on('recorder:audio', async (_e, payload) => {
    clearAudioWatchdog();
    const { audioBuffer, mimeType, pcm } = payload || {};
    try {
      await processAudio({
        buffer: audioBuffer ? Buffer.from(audioBuffer) : null,
        mimeType: mimeType || 'audio/webm',
        pcm: pcm ? new Float32Array(pcm instanceof ArrayBuffer ? pcm : pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength)) : null
      });
    } catch (err) {
      console.error('processAudio failed:', err);
      sendToast({ kind: 'error', message: err.message || String(err) });
    } finally {
      // Whatever happened above — success, throw, empty buffer, empty
      // transcript — we always land back at idle with the overlay gone.
      resetPipeline();
    }
  });

  // The renderer had nothing to give us (tap too short to even open the mic,
  // MediaRecorder produced zero chunks, decode failed). Previously this case
  // sent nothing at all and left the app stuck in `busy` forever.
  ipcMain.on('recorder:empty', (_e, reason) => {
    clearAudioWatchdog();
    resetPipeline({ message: reason ? `No audio captured (${reason}).` : 'No audio captured.', kind: 'info' });
  });

  ipcMain.on('recorder:cancel', () => {
    resetPipeline();
  });

  ipcMain.on('recorder:error', (_e, msg) => {
    resetPipeline({ message: `Recorder: ${msg}`, kind: 'error' });
  });
}

async function processAudio({ buffer, mimeType, pcm }) {
  const cfg = store.getAll();
  const useLocal = cfg.sttEngine === 'local';

  if (useLocal) {
    if (!pcm || pcm.length < localAsr.SAMPLE_RATE * 0.25) {
      sendToast({ kind: 'info', message: 'No audio captured.' });
      return;
    }
  } else if (!buffer || buffer.length < 1000) {
    sendToast({ kind: 'info', message: 'No audio captured.' });
    return;
  }

  let contextHint = '';
  if (cfg.useAppContext) {
    contextHint = await getForegroundContext().catch(() => '');
  }

  let raw = '';
  if (useLocal) {
    if (!localAsr.isAvailable()) {
      throw new Error('Offline model files are missing from this install. Switch the engine back to Groq in Settings.');
    }
    raw = await localAsr.transcribeLocal({ pcm });
  } else {
    raw = await transcribe({
      audioBuffer: buffer,
      mimeType,
      apiKey: cfg.groqApiKey,
      baseUrl: cfg.llmApiBaseUrl,
      model: cfg.sttModel,
      language: cfg.transcriptionLanguage
    });
  }

  if (!raw) {
    sendToast({ kind: 'info', message: 'Heard nothing.' });
    return;
  }

  let final = raw;
  // Cleanup is a cloud call. In offline mode it is skipped unless the user
  // pointed the base URL at something reachable (e.g. a local Ollama).
  const wantCleanup = cfg.enableLlmCleanup && (!useLocal || cfg.llmCleanupWhenLocal);
  if (wantCleanup) {
    try {
      final = await cleanup({
        rawText: raw,
        prompt: cfg.cleanupPrompt,
        vocabulary: cfg.vocabulary,
        contextHint,
        apiKey: cfg.groqApiKey,
        baseUrl: cfg.llmApiBaseUrl,
        model: cfg.llmModel
      });
    } catch (err) {
      console.warn('Cleanup failed, falling back to raw:', err.message);
      sendToast({ kind: 'warn', message: `Cleanup failed: ${err.message}` });
      final = raw;
    }
  }

  if (!final.trim()) {
    sendToast({ kind: 'info', message: 'Heard nothing.' });
    return;
  }

  store.pushHistory({
    at: new Date().toISOString(),
    raw,
    final,
    context: contextHint
  });

  if (cfg.autoPaste) {
    await pasteText(final, { delayMs: cfg.pasteDelayMs ?? 60 });
  }
  sendToast({ kind: 'success', message: final.length > 80 ? final.slice(0, 80) + '…' : final });
}

function sendToast(payload) {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('toast', payload);
    return;
  }
  // Settings window closed — errors used to vanish silently, which is exactly
  // why "it just stops working" was so hard to diagnose. Surface them.
  if (payload?.kind === 'error' || payload?.kind === 'warn') {
    try {
      if (Notification.isSupported()) {
        new Notification({ title: 'WisperTalk', body: String(payload.message || '') }).show();
      }
    } catch {}
  }
}
