const fields = [
  'sttEngine', 'groqApiKey', 'llmApiBaseUrl', 'sttModel', 'llmModel',
  'transcriptionLanguage', 'inputDeviceId',
  'enableLlmCleanup', 'llmCleanupWhenLocal', 'useAppContext', 'vocabulary', 'cleanupPrompt',
  'holdEnabled', 'holdHotkey', 'toggleEnabled', 'toggleHotkey',
  'showOverlay', 'autoPaste', 'pasteDelayMs'
];

const checkboxes = new Set(['enableLlmCleanup', 'llmCleanupWhenLocal', 'useAppContext', 'holdEnabled', 'toggleEnabled', 'showOverlay', 'autoPaste']);
const numbers = new Set(['pasteDelayMs']);

const DEFAULT_HOLD_KEY = 'AltRight';

// Fallback only: used when the native key hook can't be loaded, so the user can
// still map a key from the focused Settings window. Maps DOM KeyboardEvent.code
// onto the same canonical names the main process stores.
function nameFromDomCode(code, key) {
  if (!code) return null;
  const direct = {
    ControlLeft: 'Ctrl', ControlRight: 'CtrlRight',
    AltLeft: 'Alt', AltRight: 'AltRight',
    ShiftLeft: 'Shift', ShiftRight: 'ShiftRight',
    MetaLeft: 'Meta', MetaRight: 'MetaRight',
    OSLeft: 'Meta', OSRight: 'MetaRight',
    Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace',
    CapsLock: 'CapsLock', NumLock: 'NumLock', ScrollLock: 'ScrollLock',
    PrintScreen: 'PrintScreen', Escape: 'Escape', Insert: 'Insert', Delete: 'Delete',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
    Minus: 'Minus', Equal: 'Equal', BracketLeft: 'BracketLeft', BracketRight: 'BracketRight',
    Backslash: 'Backslash', Semicolon: 'Semicolon', Quote: 'Quote', Backquote: 'Backquote',
    Comma: 'Comma', Period: 'Period', Slash: 'Slash',
    NumpadAdd: 'NumpadAdd', NumpadSubtract: 'NumpadSubtract', NumpadMultiply: 'NumpadMultiply',
    NumpadDivide: 'NumpadDivide', NumpadDecimal: 'NumpadDecimal', NumpadEnter: 'NumpadEnter'
  };
  if (direct[code]) return direct[code];
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1];
  m = /^Digit([0-9])$/.exec(code);
  if (m) return m[1];
  m = /^Numpad([0-9])$/.exec(code);
  if (m) return `Numpad${m[1]}`;
  m = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code);
  if (m) return code;
  return key ? key.toUpperCase() : null;
}

function acceleratorFromDom(e) {
  const name = nameFromDomCode(e.code, e.key);
  if (!name) return null;
  if (['Ctrl', 'CtrlRight', 'Alt', 'AltRight', 'Shift', 'ShiftRight', 'Meta', 'MetaRight'].includes(name)) return null;
  const table = {
    Enter: 'Return', NumpadEnter: 'Return', ArrowUp: 'Up', ArrowDown: 'Down',
    ArrowLeft: 'Left', ArrowRight: 'Right', CapsLock: 'Capslock', NumLock: 'Numlock',
    ScrollLock: 'Scrolllock', Semicolon: ';', Equal: '=', Comma: ',', Minus: '-',
    Period: '.', Slash: '/', Backquote: '`', BracketLeft: '[', BracketRight: ']',
    Backslash: '\\', Quote: "'", NumpadAdd: 'numadd', NumpadSubtract: 'numsub',
    NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec'
  };
  let base = table[name];
  if (!base) {
    if (/^Numpad[0-9]$/.test(name)) base = `num${name.slice(-1)}`;
    else base = name;
  }
  const parts = [];
  if (e.ctrlKey) parts.push('Control');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push(navigator.platform.startsWith('Mac') ? 'Command' : 'Super');
  parts.push(base);
  return parts.join('+');
}

const LANGUAGES = [
  ['', 'Auto-detect'],
  ['en', 'English'],
  ['es', 'Spanish · Español'],
  ['fr', 'French · Français'],
  ['de', 'German · Deutsch'],
  ['it', 'Italian · Italiano'],
  ['pt', 'Portuguese · Português'],
  ['nl', 'Dutch · Nederlands'],
  ['ja', 'Japanese · 日本語'],
  ['zh', 'Chinese · 中文'],
  ['ko', 'Korean · 한국어'],
  ['ar', 'Arabic · العربية'],
  ['hi', 'Hindi · हिन्दी'],
  ['ru', 'Russian · Русский'],
  ['pl', 'Polish · Polski'],
  ['tr', 'Turkish · Türkçe'],
  ['vi', 'Vietnamese · Tiếng Việt'],
  ['id', 'Indonesian · Bahasa Indonesia'],
  ['th', 'Thai · ไทย'],
  ['uk', 'Ukrainian · Українська'],
  ['sv', 'Swedish · Svenska'],
  ['no', 'Norwegian · Norsk'],
  ['da', 'Danish · Dansk'],
  ['fi', 'Finnish · Suomi'],
  ['cs', 'Czech · Čeština'],
  ['el', 'Greek · Ελληνικά'],
  ['he', 'Hebrew · עברית'],
  ['hu', 'Hungarian · Magyar'],
  ['ro', 'Romanian · Română'],
  ['ca', 'Catalan · Català']
];

let initial = null;
let dirty = false;

function el(id) { return document.getElementById(id); }

function setStatus(text) { el('status').textContent = text; }

function renderWordCounter(license) {
  const wrap = el('wordCounter');
  wrap.innerHTML = '';
  const isPaid = !!license?.activated;

  const badge = document.createElement('div');
  badge.className = `word-counter-badge ${isPaid ? 'paid' : 'free'}`;
  badge.textContent = isPaid ? '✦ Licensed' : 'Not activated';
  wrap.appendChild(badge);
}

function showToast(payload) {
  const t = el('toast');
  t.textContent = payload?.message ?? '';
  t.className = `toast ${payload?.kind || ''}`;
  setTimeout(() => t.classList.add('hidden'), 4000);
}

function readValue(key) {
  const node = el(key);
  if (!node) return null;
  if (checkboxes.has(key)) return node.checked;
  if (numbers.has(key)) return Number(node.value);
  return node.value;
}

function writeValue(key, value) {
  const node = el(key);
  if (!node) return;
  if (checkboxes.has(key)) node.checked = !!value;
  else node.value = value ?? '';
}

function readAll() {
  const out = {};
  for (const k of fields) out[k] = readValue(k);
  return out;
}

function writeAll(cfg) {
  for (const k of fields) writeValue(k, cfg[k]);
}

function markDirty() {
  dirty = true;
  setStatus('Unsaved changes');
}

function clearDirty() {
  dirty = false;
  setStatus('All changes saved');
  setTimeout(() => { if (!dirty) setStatus(''); }, 1600);
}

function populateLanguages() {
  const sel = el('transcriptionLanguage');
  for (const [code, label] of LANGUAGES) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = label;
    sel.appendChild(opt);
  }
}

async function populateMics({ saved, requestPermission = false } = {}) {
  const sel = el('inputDeviceId');
  const hint = el('micHint');
  sel.innerHTML = '';

  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = 'System default';
  sel.appendChild(defaultOpt);

  if (requestPermission) {
    try {
      const tmpStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      tmpStream.getTracks().forEach((t) => t.stop());
    } catch (err) {
      hint.textContent = `Could not access microphone (${err.name || 'permission'}). Grant mic access in your OS settings, then click Refresh.`;
      return;
    }
  }

  let devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch (err) {
    hint.textContent = `Could not list audio devices: ${err.message || err}`;
    return;
  }

  const inputs = devices.filter((d) => d.kind === 'audioinput');
  if (inputs.length === 0) {
    hint.textContent = 'No microphones detected.';
    return;
  }

  const labelsMissing = inputs.every((d) => !d.label);
  for (let i = 0; i < inputs.length; i++) {
    const d = inputs[i];
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `Audio input ${i + 1}`;
    sel.appendChild(opt);
  }

  if (labelsMissing) {
    hint.textContent = 'Microphone names hidden until permission is granted. Click Refresh, then allow microphone access.';
  } else {
    hint.textContent = 'Choose which microphone WisperTalk records from.';
  }

  if (saved && [...sel.options].some((o) => o.value === saved)) {
    sel.value = saved;
  } else if (saved) {
    sel.value = '';
  }
}

let choices = {};
let capturing = null;

/**
 * Fill the hold-key dropdown from the keys this platform offers. The picker and
 * the press-to-capture button must always agree: whichever the user touches,
 * the other has to show the same key or the UI is lying about what is bound.
 */
function populateHoldPicker() {
  const sel = el('holdPicker');
  if (!sel || !Array.isArray(choices.holdKeys)) return;
  const current = el('holdHotkey').value || '';
  sel.innerHTML = '<option value="">Choose a key…</option>';
  for (const k of choices.holdKeys) {
    const opt = document.createElement('option');
    opt.value = k.name;
    opt.textContent = k.label;
    sel.appendChild(opt);
  }
  // Capture allows ANY physical key, so the bound key may not be in the list.
  // Append it instead of leaving the dropdown showing the wrong selection.
  if (current && !choices.holdKeys.some(k => k.name === current)) {
    const opt = document.createElement('option');
    opt.value = current;
    opt.textContent = `${current} (captured)`;
    sel.appendChild(opt);
  }
  sel.value = current;
}

async function setHoldLabel(name) {
  const btn = el('holdCapture');
  const sel = el('holdPicker');
  if (sel) {
    if (name && !Array.from(sel.options).some(o => o.value === name)) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = `${name} (captured)`;
      sel.appendChild(opt);
    }
    sel.value = name || '';
  }
  if (!btn) return;
  if (!name) { btn.textContent = '…or click here and press any key'; return; }
  let label = name;
  try { label = await window.flow.labelForKey(name); } catch {}
  btn.textContent = `${label}  —  or click to capture a different key`;
}

function beginCaptureUi(btn, text) {
  btn.dataset.prev = btn.textContent;
  btn.textContent = text;
  btn.classList.add('capturing');
}

function endCaptureUi(btn) {
  btn.classList.remove('capturing');
}

/** Renderer-side fallback when the native hook isn't available. */
function domCapture(mode) {
  return new Promise((resolve) => {
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { finish({ ok: false, cancelled: true }); return; }
      if (mode === 'toggle') {
        const accel = acceleratorFromDom(e);
        if (!accel) return; // still waiting for a real key
        finish({ ok: true, value: accel, label: accel });
        return;
      }
      const name = nameFromDomCode(e.code, e.key);
      if (!name) return;
      finish({ ok: true, value: name, label: name });
    };
    const finish = (result) => {
      window.removeEventListener('keydown', onKey, true);
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, cancelled: true, reason: 'timeout' }), 15000);
    window.addEventListener('keydown', onKey, true);
  });
}

async function runCapture(mode) {
  const btn = mode === 'toggle' ? el('toggleCapture') : el('holdCapture');
  if (capturing) {
    try { await window.flow.cancelCapture(); } catch {}
  }
  capturing = mode;
  beginCaptureUi(btn, mode === 'toggle' ? 'Press the combination… (Esc to cancel)' : 'Press any key… (Esc to cancel)');

  let result;
  try {
    result = await window.flow.captureHotkey(mode);
    if (result && result.unavailable) result = await domCapture(mode);
  } catch (err) {
    result = { ok: false, error: err.message || String(err) };
  }

  capturing = null;
  endCaptureUi(btn);

  if (!result || !result.ok) {
    if (result && result.error) showToast({ kind: 'error', message: result.error });
    if (mode === 'toggle') {
      btn.textContent = btn.dataset.prev || 'Record';
    } else {
      await setHoldLabel(el('holdHotkey').value);
    }
    return;
  }

  if (mode === 'toggle') {
    el('toggleHotkey').value = result.value;
    btn.textContent = btn.dataset.prev || 'Record';
    el('toggleEnabled').checked = true;
  } else {
    el('holdHotkey').value = result.value;
    await setHoldLabel(result.value);
    el('holdEnabled').checked = true;
  }
  markDirty();
}

async function refreshHotkeyStatus() {
  const node = el('hotkeyStatus');
  if (!node) return;
  let status = null;
  try { status = await window.flow.getHotkeyStatus(); } catch {}
  if (!status) { node.textContent = ''; return; }
  const problems = [];
  if (status.hold?.enabled && !status.hold.ok && status.hold.error) problems.push(status.hold.error);
  if (status.toggle?.enabled && !status.toggle.ok && status.toggle.error) problems.push(status.toggle.error);
  if (problems.length) {
    node.textContent = `⚠ ${problems.join(' ')}`;
    node.style.color = '#ef4444';
  } else {
    node.textContent = '✓ Hotkeys are armed.';
    node.style.color = '';
  }
}

function updateEngineHint() {
  const engine = el('sttEngine').value;
  const hint = el('engineHint');
  if (engine === 'local') {
    hint.textContent = choices.localEngineAvailable
      ? `Offline: audio is transcribed on this computer with ${choices.localModelId} bundled in the app. No internet, no API key. Slower than Groq and a little less accurate on names.`
      : '⚠ Offline model files are missing from this install — this build cannot run the local engine. Switch back to Groq.';
  } else {
    hint.textContent = 'Groq sends your audio to api.groq.com using your own key. Fastest and most accurate.';
  }
}

async function init() {
  choices = await window.flow.getChoices();

  populateLanguages();

  const cfg = await window.flow.getSettings();
  initial = cfg;

  await populateMics({ saved: cfg.inputDeviceId });

  writeAll(cfg);
  populateHoldPicker();
  await setHoldLabel(cfg.holdHotkey);
  updateEngineHint();
  await refreshHotkeyStatus();
  renderWordCounter(await window.flow.getLicense());
  setStatus('');

  for (const k of fields) {
    const node = el(k);
    if (!node) continue;
    if (node.type === 'hidden') continue; // holdHotkey is set via press-to-map
    const evt = (node.tagName === 'SELECT' || node.type === 'checkbox') ? 'change' : 'input';
    node.addEventListener(evt, markDirty);
  }

  // Picking from the dropdown binds the key straight away - the hidden field is
  // what actually gets saved, so it has to be written here too.
  el('holdPicker')?.addEventListener('change', async (e) => {
    const name = e.target.value;
    if (!name) return;
    el('holdHotkey').value = name;
    await setHoldLabel(name);
    el('holdEnabled').checked = true;
    markDirty();
  });

  el('sttEngine').addEventListener('change', updateEngineHint);

  el('holdCapture').addEventListener('click', () => runCapture('hold'));
  el('toggleCapture').addEventListener('click', () => runCapture('toggle'));
  el('holdReset').addEventListener('click', async () => {
    el('holdHotkey').value = DEFAULT_HOLD_KEY;
    await setHoldLabel(DEFAULT_HOLD_KEY);
    markDirty();
  });
  el('rearmHotkeys').addEventListener('click', async () => {
    await window.flow.rearmHotkeys();
    await refreshHotkeyStatus();
    showToast({ kind: 'success', message: 'Hotkeys re-armed.' });
  });

  el('refreshMics').addEventListener('click', async () => {
    const current = el('inputDeviceId').value;
    el('micHint').textContent = 'Refreshing…';
    await populateMics({ saved: current, requestPermission: true });
    markDirty();
  });

  document.querySelectorAll('nav.tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('nav.tabs button').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('main section').forEach((s) => s.classList.remove('active'));
      btn.classList.add('active');
      document.querySelector(`main section[data-pane="${btn.dataset.tab}"]`).classList.add('active');
      if (btn.dataset.tab === 'history') loadHistory();
      if (btn.dataset.tab === 'license') loadLicense();
    });
  });

  el('deactivateBtn').addEventListener('click', async () => {
    if (!confirm('Sign out on this computer? WisperTalk will quit — sign back in with your Whop account on next launch.')) return;
    try { await window.flow.deactivateLicense(); } catch {}
    window.flow.quitApp();
  });

  el('toggleKey').addEventListener('click', () => {
    const k = el('groqApiKey');
    const visible = k.type === 'text';
    k.type = visible ? 'password' : 'text';
    el('toggleKey').textContent = visible ? 'Show' : 'Hide';
  });

  el('saveBtn').addEventListener('click', save);
  el('cancelBtn').addEventListener('click', () => window.flow.closeWindow());
  el('resetAll').addEventListener('click', async () => {
    if (!confirm('Reset all settings to defaults?')) return;
    const next = await window.flow.resetSettings();
    initial = next;
    await populateMics({ saved: next.inputDeviceId });
    writeAll(next);
    await setHoldLabel(next.holdHotkey);
    updateEngineHint();
    await refreshHotkeyStatus();
    showToast({ kind: 'success', message: 'Settings reset.' });
    clearDirty();
  });

  window.flow.onToast(showToast);
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      save();
    }
  });
}

async function save() {
  const updates = readAll();
  if (updates.sttEngine !== 'local' && !updates.groqApiKey) {
    showToast({ kind: 'warn', message: 'Add a Groq API key, or switch the engine to Local (offline).' });
  }
  const next = await window.flow.setSettings(updates);
  initial = next;
  await refreshHotkeyStatus();
  const status = next.__hotkeyStatus;
  const holdBad = status?.hold?.enabled && !status.hold.ok;
  const toggleBad = status?.toggle?.enabled && !status.toggle.ok;
  if (holdBad || toggleBad) {
    showToast({ kind: 'error', message: (holdBad ? status.hold.error : status.toggle.error) || 'Hotkey could not be registered.' });
  } else {
    showToast({ kind: 'success', message: 'Settings saved.' });
  }
  clearDirty();
}

async function loadLicense() {
  const lic = await window.flow.getLicense();
  el('licUser').textContent = lic.activated ? (lic.userId || 'Signed in') : 'Not signed in';
  el('licActivated').textContent = lic.activatedAt ? new Date(lic.activatedAt).toLocaleDateString() : '—';
  el('licVerified').textContent = lic.lastCheck ? new Date(lic.lastCheck).toLocaleString() : '—';
}

async function loadHistory() {
  const list = await window.flow.getHistory();
  const wrap = el('historyList');
  wrap.innerHTML = '';
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = 'No dictations yet. Hold your hotkey to start.';
    wrap.appendChild(empty);
    return;
  }
  for (const item of list) {
    const row = document.createElement('div');
    row.className = 'history-item';
    const at = document.createElement('div');
    at.className = 'at';
    at.textContent = new Date(item.at).toLocaleString();
    const final = document.createElement('div');
    final.className = 'final';
    final.textContent = item.final;
    row.append(at, final);
    if (item.raw && item.raw !== item.final) {
      const raw = document.createElement('div');
      raw.className = 'raw';
      raw.textContent = `raw: ${item.raw}`;
      row.append(raw);
    }
    wrap.append(row);
  }
}

init();
