const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, shell, dialog } = require('electron');
const path = require('node:path');
const store = require('./store');
const { HotkeyManager, HOLD_KEY_CHOICES } = require('./hotkey');
const { transcribe } = require('./transcribe');
const { cleanup } = require('./postprocess');
const { pasteText } = require('./paste');
const { getForegroundContext } = require('./context');
const license = require('./license');

const ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'icon-128.png');

let tray = null;
let overlayWin = null;
let settingsWin = null;
let licenseWin = null;
let hotkey = null;
let state = 'idle';
let busy = false;
let licensed = false;
let verifyTimer = null;
let upgradeWin = null;
const FREE_TRIAL_WORD_LIMIT = 2000;

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
  hotkey?.shutdown();
});

async function init() {
  app.setAppUserModelId('com.wispertalk.app');

  // On macOS, show a one-time notice about Accessibility permission needed for paste + global hotkeys.
  if (process.platform === 'darwin' && !store.get('macAccessibilityNoticeShown')) {
    try {
      await dialog.showMessageBox({
        type: 'info',
        title: 'WisperTalk needs Accessibility access',
        message: 'Grant Accessibility permission to WisperTalk',
        detail: 'macOS requires Accessibility access for WisperTalk to (1) paste your transcribed text into the focused app, and (2) detect global hotkeys.\n\nOpen System Settings → Privacy & Security → Accessibility, then enable WisperTalk.\n\nIf the toggle isn\'t there yet, try the hotkey once and macOS will offer to add it.',
        buttons: ['Got it']
      });
    } catch {}
    store.set({ macAccessibilityNoticeShown: true });
  }

  createOverlayWindow();
  createTray();

  hotkey = new HotkeyManager({
    onToggle: () => handleToggle(),
    onHoldPress: () => handleHoldPress(),
    onHoldRelease: () => handleHoldRelease()
  });

  registerIpc();

  await checkLicenseAndProceed();
}

async function checkLicenseAndProceed() {
  const result = await license.ensureValid().catch(() => ({ valid: false, reason: 'fetch_failed' }));
  if (result.valid) {
    licensed = result.record?.tier !== 'free';
    applyHotkeys();
    rebuildTrayMenu();
    schedulePeriodicVerify();
    if (!store.get('groqApiKey')) {
      openSettings();
    }
  } else {
    licensed = false;
    // Allow free trial — hotkeys stay active, usage is gated at FREE_TRIAL_WORD_LIMIT
    applyHotkeys();
    rebuildTrayMenu();
    if (!store.get('groqApiKey')) {
      openSettings();
    }
  }
}

function schedulePeriodicVerify() {
  if (verifyTimer) clearInterval(verifyTimer);
  verifyTimer = setInterval(async () => {
    const r = await license.ensureValid({ requireFresh: true }).catch(() => ({ valid: false, reason: 'fetch_failed' }));
    if (!r.valid && r.reason !== 'fetch_failed') {
      licensed = false;

      hotkey.unregister();
      rebuildTrayMenu();
      openLicenseWindow();
    }
  }, 6 * 60 * 60 * 1000);
}

function applyHotkeys() {
  const cfg = store.getAll();
  hotkey.apply({
    holdEnabled: cfg.holdEnabled,
    holdHotkey: cfg.holdHotkey,
    toggleEnabled: cfg.toggleEnabled,
    toggleHotkey: cfg.toggleHotkey
  });
}

function createOverlayWindow() {
  const display = screen.getPrimaryDisplay();
  const w = 320;
  const h = 96;
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
  overlayWin.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));
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
  const cfg = store.getAll();
  const licStatus = license.status();

  const items = [{ label: `WisperTalk — ${labelForState()}`, enabled: false }];
  items.push({ type: 'separator' });

  if (licensed && licStatus.hasLicense) {
    items.push(
      { label: cfg.holdEnabled ? `Hold: ${cfg.holdHotkey}` : 'Hold: off', enabled: false },
      { label: cfg.toggleEnabled ? `Toggle: ${cfg.toggleHotkey}` : 'Toggle: off', enabled: false },
      { type: 'separator' },
      { label: `Licensed: ${licStatus.licenseKey || ''}`, enabled: false },
      { type: 'separator' },
      { label: 'Settings…', click: () => openSettings() },
      { label: 'Open log folder', click: () => shell.openPath(app.getPath('userData')) }
    );
  } else {
    const wordCount = store.getMonthlyWordCount();
    items.push(
      { label: `Free trial: ${wordCount.toLocaleString()} / ${FREE_TRIAL_WORD_LIMIT.toLocaleString()} words`, enabled: false },
      { type: 'separator' },
      { label: cfg.holdEnabled ? `Hold: ${cfg.holdHotkey}` : 'Hold: off', enabled: false },
      { label: cfg.toggleEnabled ? `Toggle: ${cfg.toggleHotkey}` : 'Toggle: off', enabled: false },
      { type: 'separator' },
      { label: 'Settings…', click: () => openSettings() },
      { label: 'Upgrade — $49.99 lifetime →', click: () => shell.openExternal('https://whop.com/checkout/plan_Oh4HMckTmxXcE') },
      { label: 'Enter license key…', click: () => openLicenseWindow() },
      { label: 'Open log folder', click: () => shell.openPath(app.getPath('userData')) }
    );
  }

  items.push({ type: 'separator' }, { label: 'Quit WisperTalk', click: () => app.quit() });
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
  settingsWin.on('closed', () => { settingsWin = null; });
}

function openLicenseWindow() {
  if (licenseWin && !licenseWin.isDestroyed()) {
    licenseWin.show();
    licenseWin.focus();
    return;
  }
  licenseWin = new BrowserWindow({
    width: 600,
    height: 640,
    title: 'Activate WisperTalk',
    icon: ICON_PATH,
    backgroundColor: '#06070d',
    autoHideMenuBar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'license-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  licenseWin.setMenuBarVisibility(false);
  licenseWin.loadFile(path.join(__dirname, '..', 'renderer', 'license.html'));
  licenseWin.on('closed', () => { licenseWin = null; });
}

function openUpgradeWindow() {
  if (upgradeWin && !upgradeWin.isDestroyed()) {
    upgradeWin.show();
    upgradeWin.focus();
    return;
  }
  upgradeWin = new BrowserWindow({
    width: 500,
    height: 420,
    title: 'Upgrade WisperTalk',
    icon: ICON_PATH,
    backgroundColor: '#06070d',
    autoHideMenuBar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'upgrade-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  upgradeWin.setMenuBarVisibility(false);
  upgradeWin.loadFile(path.join(__dirname, '..', 'renderer', 'upgrade.html'));
  upgradeWin.on('closed', () => { upgradeWin = null; });
}

function handleToggle() {
  if (busy) return;
  if (!licensed && store.getMonthlyWordCount() >= FREE_TRIAL_WORD_LIMIT) {
    openUpgradeWindow();
    return;
  }
  if (state === 'recording') stopRecording();
  else startRecording();
}

function handleHoldPress() {
  if (busy) return;
  if (!licensed && store.getMonthlyWordCount() >= FREE_TRIAL_WORD_LIMIT) {
    openUpgradeWindow();
    return;
  }
  if (state !== 'idle') return;
  startRecording();
}

function handleHoldRelease() {
  if (state === 'recording') stopRecording();
}

function startRecording() {
  if (state === 'recording') return;
  setState('recording');
  if (store.get('showOverlay')) {
    overlayWin.show();
    overlayWin.webContents.send('overlay:show', { mode: 'recording' });
  }
  overlayWin.webContents.send('recorder:start', {
    inputDeviceId: store.get('inputDeviceId') || ''
  });
}

function stopRecording() {
  if (state !== 'recording') return;
  setState('idle');
  setBusy(true);
  overlayWin.webContents.send('overlay:show', { mode: 'processing' });
  overlayWin.webContents.send('recorder:stop');
}

function hideOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('overlay:hide');
    overlayWin.hide();
  }
}

function registerIpc() {
  ipcMain.handle('license:activate', async (_e, { key, force }) => {
    const res = await license.activate(key, { force }).catch((err) => ({ ok: false, error: 'fetch_failed', message: err.message }));
    if (res.ok) {
      licensed = res.record?.tier !== 'free';
      applyHotkeys();
      rebuildTrayMenu();
      if (licensed) schedulePeriodicVerify();
      if (licenseWin && !licenseWin.isDestroyed()) {
        licenseWin.close();
        licenseWin = null;
      }
      if (!store.get('groqApiKey')) openSettings();
    }
    return res;
  });
  ipcMain.handle('license:status', () => license.status());
  ipcMain.handle('license:buy-url', () => license.LICENSE_API);
  ipcMain.handle('license:deactivate', async () => {
    const res = await license.deactivate();
    licensed = false;
    hotkey.unregister();
    rebuildTrayMenu();
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
    openLicenseWindow();
    return res;
  });
  ipcMain.handle('shell:open', (_e, url) => shell.openExternal(url));
  ipcMain.handle('app:quit', () => app.quit());
  ipcMain.handle('upgrade:status', () => ({
    wordCount: store.getMonthlyWordCount(),
    limit: FREE_TRIAL_WORD_LIMIT,
    buyUrl: 'https://whop.com/checkout/plan_Oh4HMckTmxXcE'
  }));
  ipcMain.handle('upgrade:open-license', () => {
    if (upgradeWin && !upgradeWin.isDestroyed()) upgradeWin.close();
    openLicenseWindow();
  });
  ipcMain.handle('upgrade:close', () => {
    if (upgradeWin && !upgradeWin.isDestroyed()) upgradeWin.close();
  });

  ipcMain.handle('settings:get', () => ({
    ...store.getAll(),
    license: license.status(),
    wordUsage: { count: store.getMonthlyWordCount(), limit: FREE_TRIAL_WORD_LIMIT }
  }));
  ipcMain.handle('settings:choices', () => ({
    holdKeys: HOLD_KEY_CHOICES
  }));
  ipcMain.handle('settings:set', (_e, updates) => {
    const next = store.set(updates || {});
    applyHotkeys();
    rebuildTrayMenu();
    return next;
  });
  ipcMain.handle('settings:reset', () => {
    const next = store.reset();
    applyHotkeys();
    rebuildTrayMenu();
    return next;
  });
  ipcMain.handle('settings:test-hotkey', (_e, name) => {
    const cfg = store.getAll();
    return { holdEnabled: cfg.holdEnabled, holdHotkey: cfg.holdHotkey };
  });
  ipcMain.handle('settings:close', () => {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
  });
  ipcMain.handle('history:list', () => store.get('history') || []);

  ipcMain.on('recorder:audio', async (_e, { audioBuffer, mimeType }) => {
    try {
      await processAudio(Buffer.from(audioBuffer), mimeType);
    } catch (err) {
      console.error('processAudio failed:', err);
      sendToast({ kind: 'error', message: err.message || String(err) });
    } finally {
      setBusy(false);
      hideOverlay();
    }
  });

  ipcMain.on('recorder:cancel', () => {
    setState('idle');
    setBusy(false);
    hideOverlay();
  });

  ipcMain.on('recorder:error', (_e, msg) => {
    sendToast({ kind: 'error', message: `Recorder: ${msg}` });
    setState('idle');
    setBusy(false);
    hideOverlay();
  });
}

async function processAudio(buffer, mimeType) {
  const cfg = store.getAll();
  if (!buffer || buffer.length < 1000) {
    sendToast({ kind: 'info', message: 'No audio captured.' });
    return;
  }

  let contextHint = '';
  if (cfg.useAppContext) {
    contextHint = await getForegroundContext().catch(() => '');
  }

  const raw = await transcribe({
    audioBuffer: buffer,
    mimeType,
    apiKey: cfg.groqApiKey,
    baseUrl: cfg.llmApiBaseUrl,
    model: cfg.sttModel,
    language: cfg.transcriptionLanguage
  });

  if (!raw) {
    sendToast({ kind: 'info', message: 'Heard nothing.' });
    return;
  }

  let final = raw;
  if (cfg.enableLlmCleanup) {
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

  if (!licensed) {
    const words = final.trim().split(/\s+/).filter(Boolean).length;
    store.addWords(words);
    rebuildTrayMenu();
  }

  if (cfg.autoPaste) {
    await pasteText(final, { delayMs: cfg.pasteDelayMs ?? 60 });
  }
  sendToast({ kind: 'success', message: final.length > 80 ? final.slice(0, 80) + '…' : final });
}

function sendToast(payload) {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('toast', payload);
  }
}
