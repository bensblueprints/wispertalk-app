const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID, randomBytes } = require('node:crypto');
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

async function activate(rawKey, { force = false } = {}) {
  const deviceId = getDeviceId();
  const deviceName = getDeviceName();
  const res = await fetch(`${LICENSE_API}/api/license/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: rawKey, deviceId, deviceName, force })
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) {
    return { ok: false, error: json.error || `http_${res.status}`, message: json.message, boundDeviceName: json.boundDeviceName };
  }

  const record = {
    key: json.licenseKey,
    deviceId,
    deviceName,
    email: json.email,
    token: json.token,
    lastVerifiedAt: Date.now()
  };
  save(record);
  return { ok: true, record };
}

async function verify() {
  const record = load();
  if (!record) return { ok: false, error: 'no_license' };

  const res = await fetch(`${LICENSE_API}/api/license/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: record.key, deviceId: record.deviceId })
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) {
    if (json.error === 'device_mismatch' || json.error === 'invalid_key' || json.error === 'license_refunded') {
      clear();
    }
    return { ok: false, error: json.error || `http_${res.status}` };
  }

  const next = { ...record, token: json.token, lastVerifiedAt: Date.now() };
  save(next);
  return { ok: true, record: next };
}

async function deactivate() {
  const record = load();
  if (!record) return { ok: true };
  try {
    await fetch(`${LICENSE_API}/api/license/deactivate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: record.key, deviceId: record.deviceId })
    });
  } catch (err) {
    console.warn('deactivate request failed:', err.message);
  }
  clear();
  return { ok: true };
}

function status() {
  const record = load();
  if (!record) return { hasLicense: false };
  return {
    hasLicense: true,
    licenseKey: record.key,
    email: record.email,
    deviceName: record.deviceName,
    lastVerifiedAt: record.lastVerifiedAt,
    fresh: isFresh(record)
  };
}

async function ensureValid({ requireFresh = false } = {}) {
  const record = load();
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
