const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, shell, dialog, powerMonitor, Notification } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const store = require('./store');
const { HotkeyManager, HOLD_KEY_CHOICES, holdKeyChoices, labelForName } = require('./hotkey');
const { transcribe } = require('./transcribe');
const localAsr = require('./local-asr');
const { cleanup } = require('./postprocess');
const { pasteText } = require('./paste');
const { getForegroundContext } = require('./context');
const { generateKey, generateResellerKey, parseKey, validateKey } = require('./license-key');
const keyState = require('./key-state');
const { compareVersions } = require('./version-compare');
const { spawn } = require('node:child_process');
const { isTrusted, ensureAccessibility } = require('./mac-accessibility');

const ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'icon-128.png');

// If the renderer hasn't handed back audio this long after we asked it to stop,
// something went wrong down there (crashed window, MediaRecorder that never
// fired onstop, IPC lost). Reset rather than sit in `busy` forever.
const AUDIO_HANDBACK_TIMEOUT_MS = 15000;

// Public releases repo for the in-app update check.
const RELEASES_REPO = 'bensblueprints/wispertalk-releases';

// Session-level stuck-recording guard (Windows). A hold-initiated session is
// watched against the PHYSICAL key state (key-state.js, GetAsyncKeyState):
// SESSION_KEY_WATCH_UP_POLLS consecutive physically-UP answers mean the
// key-up event was lost — the session ends via the normal release path.
// Physically DOWN never interrupts: no time cap on dictation, ever.
const SESSION_KEY_WATCH_DELAY_MS = 500;
const SESSION_KEY_WATCH_POLL_MS = 250;
const SESSION_KEY_WATCH_UP_POLLS = 2;
const SESSION_KEY_WATCH_MAX_FAILURES = 3;
// Hold-key names -> Windows virtual-key code (VK_RMENU = 0xA5 = right Alt).
const HOLD_KEY_VK = { AltRight: 0xA5, RightAlt: 0xA5 };

let tray = null;
let overlayWin = null;
let settingsWin = null;
let activateWin = null;
let resellerUnlockTier = null; // null | 'master' | 'reseller' — in-memory only, never persisted
let activationSucceeded = false;
let hotkey = null;
let state = 'idle';
let busy = false;
let overlayReady = false;
let audioWatchdog = null;
let keyWatchTimer = null;
let keyWatchUpPolls = 0;
let keyWatchFailures = 0;
let keyWatchBusy = false;
let lastHotkeyStatus = null;
let sessionSequence = 0;
let activeSession = null;

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

  // WisperTalk 2.0 — offline license-key gate (replaces the old Whop gate).
  registerLicenseKeyIpc();
  if (!(await gateLicenseKey())) return; // quit already requested

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
 * WisperTalk 2.0 license-key gate. Boot continues only with a valid stored
 * key; otherwise an always-on-top activation window is shown. Closing that
 * window without activating quits the app.
 */
function licenseStatePath() {
  return path.join(app.getPath('userData'), 'license-key.json');
}

function loadStoredKey() {
  try {
    const s = JSON.parse(fs.readFileSync(licenseStatePath(), 'utf8'));
    return typeof s.key === 'string' ? s.key : null;
  } catch { return null; }
}

function gateLicenseKey() {
  const stored = loadStoredKey();
  if (stored && validateKey(stored)) return Promise.resolve(true);
  return new Promise((resolve) => {
    activateWin = new BrowserWindow({
      width: 440,
      height: 340,
      title: 'WisperTalk — Activation',
      icon: ICON_PATH,
      backgroundColor: '#0f0f12',
      resizable: false,
      minimizable: false,
      maximizable: false,
      alwaysOnTop: true,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'activate-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });
    activateWin.setMenuBarVisibility(false);
    activateWin.loadFile(path.join(__dirname, '..', 'renderer', 'activate.html'));
    activateWin.on('closed', () => {
      activateWin = null;
      if (activationSucceeded) {
        activationSucceeded = false;
        resolve(true);
      } else {
        app.quit();
        resolve(false);
      }
    });
  });
}

/* License-key IPC: activation window + Settings → License pane. */
function registerLicenseKeyIpc() {
  ipcMain.handle('license-key:activate', (_e, key) => {
    const parsed = parseKey(key);
    if (!parsed.valid) return { ok: false, error: 'That license key is not valid. Check it and try again.' };
    fs.writeFileSync(licenseStatePath(), JSON.stringify({ key: String(key).trim().toUpperCase(), activatedAt: new Date().toISOString() }, null, 2));
    if (activateWin && !activateWin.isDestroyed()) {
      activationSucceeded = true;
      activateWin.close();
    }
    // Greet the key holder by name. Only the master key also gets the
    // reseller-tools line — customer keys must never hint at them.
    if (parsed.holder) {
      dialog.showMessageBox({
        type: 'info', title: 'WisperTalk 2.0',
        message: `Welcome, ${parsed.holder}!`,
        detail: parsed.tier === 'master'
          ? 'Reseller access unlocked — generate license keys anytime from Settings → License → Reseller tools.'
          : 'WisperTalk is activated on this device. Enjoy!'
      });
    }
    return { ok: true };
  });
  ipcMain.handle('license-key:status', () => {
    const key = loadStoredKey();
    if (!key || !validateKey(key)) return { activated: false };
    const parsed = parseKey(key);
    return { activated: true, key, isMaster: parsed.tier === 'master', tier: parsed.tier, holder: parsed.holder };
  });
  ipcMain.handle('license-key:deactivate', () => {
    try { fs.unlinkSync(licenseStatePath()); } catch {}
    app.quit();
    return { ok: true };
  });
  // Reseller tools: the unlock tier is in-memory only (never persisted) and the
  // generate handlers re-check it here in main — the renderer is never trusted.
  ipcMain.handle('license-key:unlockReseller', (_e, key) => {
    const parsed = parseKey(key);
    resellerUnlockTier = parsed.valid && (parsed.tier === 'master' || parsed.tier === 'reseller') ? parsed.tier : null;
    return { unlocked: resellerUnlockTier !== null, tier: resellerUnlockTier, canMintResellers: resellerUnlockTier === 'master' };
  });
  ipcMain.handle('license-key:generate', (_e, name) => {
    if (!resellerUnlockTier) return { ok: false, error: 'Reseller tools are locked.' };
    return { ok: true, key: generateKey(typeof name === 'string' ? name : '') };
  });
  // Minting reseller keys is master-only — resellers can mint customers, not peers.
  ipcMain.handle('license-key:generateReseller', (_e, name) => {
    if (resellerUnlockTier !== 'master') return { ok: false, error: 'Only the master key can generate reseller keys.' };
    return { ok: true, key: generateResellerKey(typeof name === 'string' ? name : '') };
  });
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
      sandbox: false,
      backgroundThrottling: false
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
    { label: 'Licensed (offline key)', enabled: false },
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
  if (state === 'starting') return 'Opening microphone…';
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
  clearSessionKeyWatch();
  activeSession?.controller.abort();
  activeSession = null;
  sendToOverlay('recorder:abort');
  hotkey?.clearHolding();
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
  if (state === 'recording' || state === 'starting') stopRecording();
  else startRecording();
}

function handleHoldPress() {
  if (busy) return;
  if (state !== 'idle') return;
  startRecording({ viaHold: true });
}

function handleHoldRelease() {
  if (state === 'recording' || state === 'starting') stopRecording();
}

function startRecording({ viaHold = false } = {}) {
  if (state !== 'idle' || busy) return;
  if (!overlayAlive()) {
    // Starting up, or the renderer died. Don't enter `recording` — that state
    // could never be left, because nothing downstream would ever reply.
    sendToast({ kind: 'warn', message: 'Recorder is still starting up. Try again in a second.' });
    hotkey?.clearHolding();
    return;
  }
  try { overlayWin.setIgnoreMouseEvents(true); } catch {} // transcript card's clickable window is over
  activeSession = { id: ++sessionSequence, config: store.getAll(), processing: false, controller: new AbortController() };
  setState('starting');
  clearAudioWatchdog();
  const startingSession = activeSession;
  audioWatchdog = setTimeout(() => {
    if (activeSession === startingSession && state === 'starting') {
      resetPipeline({ message: 'The microphone did not become ready. Check microphone access and try again.', kind: 'warn' });
    }
  }, 12000);
  if (store.get('showOverlay')) {
    // showInactive() — NOT show(). On macOS show() activates WisperTalk as the frontmost
    // app, stealing keyboard focus from the text field the user is dictating into (they'd
    // have to re-click it after every dictation). showInactive() displays the overlay
    // without activating the app, so the target field keeps its focus and caret.
    overlayWin.showInactive();
    sendToOverlay('overlay:show', { mode: 'recording' });
  }
  sendToOverlay('recorder:start', {
    sessionId: activeSession.id,
    inputDeviceId: store.get('inputDeviceId') || '',
    // The local engine needs decoded PCM; skip the work when using Groq.
    wantPcm: store.get('sttEngine') === 'local'
  });
  // Hold-initiated sessions get the physical-key watch — the guarantee that a
  // lost key-up can never leave the app recording. Covers every drop race at
  // once, because it hangs off the SESSION, not the hotkey's holding flag.
  if (viaHold) armSessionKeyWatch(store.get('holdHotkey'));
}

function stopRecording() {
  if (state !== 'recording' && state !== 'starting') return;
  clearSessionKeyWatch();
  setState('idle');
  setBusy(true);
  sendToOverlay('overlay:show', { mode: 'processing' });
  const delivered = sendToOverlay('recorder:stop', { sessionId: activeSession.id });
  if (!delivered) {
    resetPipeline({ message: 'Recorder was not reachable. Ready to try again.', kind: 'warn' });
    return;
  }
  armAudioWatchdog();
}

/**
 * While a hold-initiated session is live, verify the PHYSICAL hold key.
 * Two consecutive physically-UP polls => the key-up was lost: end the session
 * through handleHoldRelease(), the exact path a real key-up takes. Query
 * failures fail toward NOT cutting dictation (log, then stop watching).
 */
function armSessionKeyWatch(hotkeyName) {
  clearSessionKeyWatch();
  if (process.platform !== 'win32') return; // macOS keeps rearm-based recovery
  const vk = HOLD_KEY_VK[hotkeyName];
  if (vk == null) return; // un-pollable trigger key — the watch can't help
  keyWatchUpPolls = 0;
  keyWatchFailures = 0;
  keyWatchBusy = false;
  keyWatchTimer = setTimeout(() => {
    keyWatchTimer = setInterval(() => pollSessionKey(vk), SESSION_KEY_WATCH_POLL_MS);
    if (keyWatchTimer.unref) keyWatchTimer.unref();
    pollSessionKey(vk);
  }, SESSION_KEY_WATCH_DELAY_MS);
  if (keyWatchTimer.unref) keyWatchTimer.unref();
}

async function pollSessionKey(vk) {
  if (state !== 'recording' && state !== 'starting') { clearSessionKeyWatch(); return; }
  if (keyWatchBusy) return; // a slow query must not stack up
  keyWatchBusy = true;
  try {
    const down = await keyState.query(vk);
    if (state !== 'recording' && state !== 'starting') { clearSessionKeyWatch(); return; }
    keyWatchFailures = 0;
    if (down) { keyWatchUpPolls = 0; return; } // physically held — never interrupt
    keyWatchUpPolls++;
    if (keyWatchUpPolls >= SESSION_KEY_WATCH_UP_POLLS) {
      console.warn('[session] hold key is physically UP but a session is live — key-up was lost; ending via the normal release path');
      clearSessionKeyWatch();
      hotkey?.clearHolding(); // drop a stale flag so the next press works
      handleHoldRelease();    // exact same path a real key-up takes
    }
  } catch (err) {
    keyWatchFailures++;
    if (keyWatchFailures >= SESSION_KEY_WATCH_MAX_FAILURES) {
      console.warn('[session] key-state helper repeatedly unavailable — watch stopped; dictation is never cut:', err?.message || err);
      clearSessionKeyWatch();
    }
  } finally {
    keyWatchBusy = false;
  }
}

function clearSessionKeyWatch() {
  if (keyWatchTimer) { clearTimeout(keyWatchTimer); clearInterval(keyWatchTimer); keyWatchTimer = null; }
}

/**
 * After a successful paste, show the transcript on the overlay for a moment
 * so the user can copy it. Click-through is disabled while the card is up
 * (the Copy button needs real clicks); showInactive() — never show() — keeps
 * keyboard focus in the window the text was just pasted into, and the window
 * is focusable:false so it cannot grab focus at all.
 */
function showTranscriptCard(text) {
  if (!text || !overlayWin || overlayWin.isDestroyed()) return;
  try {
    overlayWin.setIgnoreMouseEvents(false);
    overlayWin.showInactive();
    sendToOverlay('overlay:transcript', { text });
  } catch {}
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

  ipcMain.handle('app:version', () => app.getVersion());

  // Update check against the public releases repo (no auth; GitHub requires a
  // User-Agent). Deliberately simple — no electron-updater, no new deps.
  ipcMain.handle('app:checkUpdates', async () => {
    try {
      const res = await fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, {
        headers: { 'User-Agent': 'WisperTalk-Update-Check', Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(10_000)
      });
      if (!res.ok) return { status: 'error' };
      const rel = await res.json();
      const latest = String(rel.tag_name || '').replace(/^v/i, '');
      if (!latest) return { status: 'error' };
      if (compareVersions(latest, app.getVersion()) <= 0) return { status: 'up-to-date' };
      // The installer, not the portable build; fall back to the release page.
      const asset = (rel.assets || []).find(a => /^WisperTalk[ .]Setup.*\.exe$/i.test(a?.name || ''));
      return { status: 'available', version: latest, url: asset?.browser_download_url || rel.html_url, name: rel.name || `WisperTalk ${latest}` };
    } catch {
      return { status: 'error' };
    }
  });

  ipcMain.handle('app:downloadUpdate', async (_e, url) => {
    try {
      // Only ever fetch from our own releases repo (redirects after this are
      // GitHub's own CDN, which fetch follows itself).
      if (typeof url !== 'string' || !url.startsWith(`https://github.com/${RELEASES_REPO}/`)) {
        return { ok: false, error: 'Refused: not a WisperTalk releases URL.' };
      }
      const res = await fetch(url, { headers: { 'User-Agent': 'WisperTalk-Update-Check' }, signal: AbortSignal.timeout(120_000) });
      if (!res.ok || !res.body) return { ok: false, error: `Download failed (HTTP ${res.status}).` };
      const dest = path.join(app.getPath('temp'), 'WisperTalk-Setup-update.exe');
      const { Readable } = require('node:stream');
      const { pipeline } = require('node:stream/promises');
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
      // Interactive installer — the user clicks through; the app quits so files can be replaced.
      spawn(dest, [], { detached: true, stdio: 'ignore' }).unref();
      app.quit();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

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
  ipcMain.handle('hotkey:rearm', () => hotkey?.rearm('settings'));

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

  const currentRecorder = (event, payload) => activeSession &&
    payload?.sessionId === activeSession.id && event.sender === overlayWin?.webContents;
  ipcMain.on('recorder:ready', (event, payload) => {
    if (!currentRecorder(event, payload) || state !== 'starting') return;
    clearAudioWatchdog();
    setState('recording');
  });
  ipcMain.on('recorder:warning', (event, payload) => {
    if (currentRecorder(event, payload)) sendToast({ kind: 'warn', message: payload.message });
  });
  ipcMain.on('recorder:audio', async (event, payload) => {
    if (!currentRecorder(event, payload) || !busy || activeSession.processing) return;
    const recordingSession = activeSession;
    recordingSession.processing = true;
    clearAudioWatchdog();
    const { audioBuffer, mimeType, pcm } = payload || {};
    try {
      await processAudio({
        recordingSession,
        buffer: audioBuffer ? Buffer.from(audioBuffer) : null,
        mimeType: mimeType || 'audio/webm',
        pcm: pcm ? new Float32Array(pcm instanceof ArrayBuffer ? pcm : pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength)) : null
      });
    } catch (err) {
      console.error('processAudio failed:', err);
      if (activeSession === recordingSession) sendToast({ kind: 'error', message: err.message || String(err) });
    } finally {
      // Whatever happened above — success, throw, empty buffer, empty
      // transcript — we always land back at idle with the overlay gone.
      if (activeSession === recordingSession) resetPipeline();
    }
  });

  // The renderer had nothing to give us (tap too short to even open the mic,
  // MediaRecorder produced zero chunks, decode failed). Previously this case
  // sent nothing at all and left the app stuck in `busy` forever.
  ipcMain.on('recorder:empty', (event, payload) => {
    if (!currentRecorder(event, payload) || activeSession.processing) return;
    clearAudioWatchdog();
    resetPipeline({ message: payload.reason || 'No audio captured.', kind: 'warn' });
  });

  ipcMain.on('recorder:cancel', (event, payload) => {
    if (!currentRecorder(event, payload)) return;
    resetPipeline();
  });

  // Transcript card dismissed (auto-timeout, Copy click, or a new recording)
  // — restore click-through and hide the overlay.
  ipcMain.on('overlay:transcript-done', (event) => {
    if (event.sender !== overlayWin?.webContents) return;
    try { overlayWin.setIgnoreMouseEvents(true); } catch {}
    hideOverlay();
  });

  ipcMain.on('recorder:error', (event, payload) => {
    if (!currentRecorder(event, payload) || activeSession.processing) return;
    resetPipeline({ message: `Recorder: ${payload.message}`, kind: 'error' });
  });
}

async function processAudio({ buffer, mimeType, pcm, recordingSession }) {
  const cfg = recordingSession.config;
  const isCurrent = () => activeSession === recordingSession;
  const useLocal = cfg.sttEngine === 'local';

  if (useLocal) {
    if (!pcm || pcm.length < localAsr.SAMPLE_RATE * 0.25) {
      sendToast({ kind: 'warn', message: 'Recording was too short. Wait for the recording timer before speaking.' });
      return;
    }
  } else if (!buffer || buffer.length < 1000) {
    sendToast({ kind: 'warn', message: 'No audio captured. Check your selected microphone in Settings.' });
    return;
  }

  let contextHint = '';
  if (cfg.useAppContext) {
    contextHint = await getForegroundContext().catch(() => '');
  }
  if (!isCurrent()) return;

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

  if (!isCurrent()) return;
  if (!raw) {
    sendToast({ kind: 'warn', message: 'No speech was recognized. Check your microphone and try again.' });
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
      if (!isCurrent()) return;
      console.warn('Cleanup failed, falling back to raw:', err.message);
      sendToast({ kind: 'warn', message: `Cleanup failed: ${err.message}` });
      final = raw;
    }
  }

  if (!isCurrent()) return;
  // A failed/empty cleanup response must not erase a valid transcription.
  if (!final.trim()) final = raw;

  store.pushHistory({
    at: new Date().toISOString(),
    raw,
    final,
    context: contextHint
  });

  let pasted = false;
  if (cfg.autoPaste) {
    const result = await pasteText(final, { delayMs: cfg.pasteDelayMs ?? 60, isCurrent, signal: recordingSession.controller.signal });
    if (!isCurrent()) return;
    if (!result.ok) {
      sendToast({ kind: 'warn', message: result.clipboardChanged
        ? 'Clipboard changed before pasting. Your transcription is saved in Settings history.'
        : 'Automatic paste failed. Your transcription is on the clipboard; press Ctrl+V (Cmd+V on Mac) to paste it.' });
      return;
    }
    pasted = true;
  }
  // The dictated text stays visible for a moment so the user can re-copy it.
  // This complements paste, never replaces it — failures keep the clipboard toast.
  if (pasted) showTranscriptCard(final);
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
