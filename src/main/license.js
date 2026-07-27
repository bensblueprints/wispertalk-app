const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const { app } = require('electron');

const LICENSE_API = process.env.WISPERTALK_LICENSE_API || process.env.WHISPER_TALK_LICENSE_API || 'https://wispertalk.com';
const VERIFY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

let cache = null;
let licenseFile = null;
let deviceFile = null;

function paths() {
  if (!licenseFile) {
    const dir = app.getPath('userData');
    licenseFile = path.join(dir, 'license.json');
    deviceFile = path.join(dir, 'device.id');
  }
  return { licenseFile, deviceFile };
}

function getDeviceId() {
  const { deviceFile } = paths();
  try {
    return fs.readFileSync(deviceFile, 'utf8').trim();
  } catch {
    const id = `${os.hostname().slice(0, 32)}-${randomBytes(16).toString('hex')}`;
    try {
      fs.mkdirSync(path.dirname(deviceFile), { recursive: true });
      fs.writeFileSync(deviceFile, id, 'utf8');
    } catch (err) {
      console.error('Failed to write device id:', err.message);
    }
    return id;
  }
}

function getDeviceName() {
  if (os.hostname()) return os.hostname();
  if (process.platform === 'darwin') return 'Mac';
  if (process.platform === 'win32') return 'Windows PC';
  return 'Computer';
}

function load() {
  if (cache) return cache;
  const { licenseFile } = paths();
  try {
    cache = JSON.parse(fs.readFileSync(licenseFile, 'utf8'));
  } catch {
    cache = null;
  }
  return cache;
}

function save(data) {
  cache = data;
  const { licenseFile } = paths();
  try {
    fs.mkdirSync(path.dirname(licenseFile), { recursive: true });
    fs.writeFileSync(licenseFile, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save license:', err.message);
  }
}

function clear() {
  cache = null;
  const { licenseFile } = paths();
  try { fs.unlinkSync(licenseFile); } catch {}
}

function isFresh(record) {
  if (!record) return false;
  if (!record.lastVerifiedAt) return false;
  return Date.now() - record.lastVerifiedAt < VERIFY_INTERVAL_MS;
}

// Verify a Whop purchase by the email it was bought with. No license keys.
async function activate(email) {
  const deviceId = getDeviceId();
  const deviceName = getDeviceName();
  const res = await fetch(`${LICENSE_API}/api/purchase/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: String(email).trim(), deviceId, deviceName })
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) {
    return { ok: false, error: json.error || `http_${res.status}`, message: json.message };
  }

  const record = {
    email: json.email,
    deviceId,
    deviceName,
    token: json.token,
    tier: json.tier || 'paid',
    lastVerifiedAt: Date.now()
  };
  save(record);
  return { ok: true, record };
}

async function verify() {
  const record = load();
  if (!record || !record.email) return { ok: false, error: 'no_license' };

  const res = await fetch(`${LICENSE_API}/api/purchase/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: record.email, deviceId: record.deviceId, deviceName: record.deviceName })
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) {
    if (json.error === 'not_found' || json.error === 'license_refunded') {
      clear();
    }
    return { ok: false, error: json.error || `http_${res.status}` };
  }

  const next = { ...record, token: json.token, tier: json.tier || record.tier || 'paid', lastVerifiedAt: Date.now() };
  save(next);
  return { ok: true, record: next };
}

async function deactivate() {
  clear();
  return { ok: true };
}

function status() {
  const record = load();
  if (!record) return { hasLicense: false, tier: null };
  return {
    hasLicense: true,
    email: record.email,
    deviceName: record.deviceName,
    lastVerifiedAt: record.lastVerifiedAt,
    fresh: isFresh(record),
    tier: record.tier || 'paid'
  };
}

// Owner builds bake the purchase email into package.json (embeddedLicenseKey
// kept as the field name for CI compatibility) so first launch auto-activates.
function getEmbeddedKey() {
  try {
    return require('../../package.json').embeddedLicenseKey || null;
  } catch {
    return null;
  }
}

async function ensureValid({ requireFresh = false } = {}) {
  let record = load();

  if (!record) {
    const embedded = getEmbeddedKey();
    if (embedded && embedded.includes('@')) {
      const result = await activate(embedded).catch(() => null);
      if (result && result.ok) record = result.record;
    }
  }

  if (!record) return { valid: false, reason: 'no_license' };
  if (!requireFresh && isFresh(record)) return { valid: true, record };
  const result = await verify();
  if (result.ok) return { valid: true, record: result.record };
  return { valid: false, reason: result.error };
}

module.exports = {
  activate,
  verify,
  deactivate,
  status,
  ensureValid,
  load,
  clear,
  getDeviceId,
  getDeviceName,
  LICENSE_API
};
