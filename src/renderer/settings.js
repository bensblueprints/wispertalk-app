const fields = [
  'groqApiKey', 'llmApiBaseUrl', 'sttModel', 'llmModel',
  'enableLlmCleanup', 'useAppContext', 'vocabulary', 'cleanupPrompt',
  'holdEnabled', 'holdHotkey', 'toggleEnabled', 'toggleHotkey',
  'showOverlay', 'autoPaste', 'pasteDelayMs'
];

const checkboxes = new Set(['enableLlmCleanup', 'useAppContext', 'holdEnabled', 'toggleEnabled', 'showOverlay', 'autoPaste']);
const numbers = new Set(['pasteDelayMs']);

let initial = null;
let dirty = false;

function el(id) { return document.getElementById(id); }

function setStatus(text) { el('status').textContent = text; }

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

async function init() {
  const choices = await window.flow.getChoices();
  const sel = el('holdHotkey');
  for (const k of choices.holdKeys) {
    const opt = document.createElement('option');
    opt.value = k; opt.textContent = k;
    sel.appendChild(opt);
  }

  const cfg = await window.flow.getSettings();
  initial = cfg;
  writeAll(cfg);
  setStatus('');

  for (const k of fields) {
    const node = el(k);
    if (!node) continue;
    const evt = (node.tagName === 'SELECT' || node.type === 'checkbox') ? 'change' : 'input';
    node.addEventListener(evt, markDirty);
  }

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
    if (!confirm('Deactivate this device? You will need to enter your license key again to use WisperTalk on this computer.')) return;
    await window.flow.deactivateLicense();
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
    writeAll(next);
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
  if (!updates.groqApiKey) {
    showToast({ kind: 'warn', message: 'Add a Groq API key before using WisperTalk.' });
  }
  const next = await window.flow.setSettings(updates);
  initial = next;
  showToast({ kind: 'success', message: 'Settings saved.' });
  clearDirty();
}

async function loadLicense() {
  const lic = await window.flow.getLicense();
  el('licKey').textContent = lic.licenseKey || '—';
  el('licEmail').textContent = lic.email || '—';
  el('licDevice').textContent = lic.deviceName || '—';
  el('licVerified').textContent = lic.lastVerifiedAt ? new Date(lic.lastVerifiedAt).toLocaleString() : '—';
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
