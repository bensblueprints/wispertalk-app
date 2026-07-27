/*
 * whop-license.js — shared Whop-native license validation for OneTimeSuite apps.
 * Vendored into each app (no npm dependency). Node 18+ (global fetch).
 *
 * WisperTalk variant: supports an `experienceIds` ARRAY in config — access is
 * granted if the signed-in Whop user has access to ANY of them (WisperTalk
 * Lifetime, OneTimeSuite Complete, or the legacy WisperTalk-business product).
 * The FIRST id in the list is the primary one used for the device registry.
 *
 * Config: whop-license.config.json next to this file, env vars override:
 *   { "experienceIds": ["prod_xxx", ...], "appName": "WisperTalk",
 *     "clientId": "app_xxx", "clientSecret": "", "port": 8734 }
 *
 * Security model: NO company API key ships in the app. The user authenticates
 * via Whop OAuth 2.1 + PKCE (loopback redirect) and their OWN access token is
 * used for GET /api/v1/users/{id}/access/{resourceId}.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const OAUTH_BASE = process.env.WHOP_OAUTH_BASE || 'https://api.whop.com/oauth';
const API_BASE = process.env.WHOP_API_BASE || 'https://api.whop.com/api/v1';
const REGISTRY_BASE = process.env.WHOP_DEVICE_REGISTRY || 'https://license.onetimesuite.com';
const RECHECK_MS = 24 * 60 * 60 * 1000;        // background re-validate daily
const GRACE_MS = 10 * 24 * 60 * 60 * 1000;     // offline grace: 10 days

function loadConfig(overrides = {}) {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(path.join(__dirname, 'whop-license.config.json'), 'utf8')); } catch {}
  const envIds = process.env.WHOP_EXPERIENCE_IDS
    ? process.env.WHOP_EXPERIENCE_IDS.split(',').map(s => s.trim()).filter(Boolean)
    : null;
  const fileIds = Array.isArray(file.experienceIds) && file.experienceIds.length
    ? file.experienceIds
    : (file.experienceId ? [file.experienceId] : null);
  const cfg = {
    experienceIds: envIds || fileIds,
    clientId: process.env.WHOP_CLIENT_ID || file.clientId,
    clientSecret: process.env.WHOP_CLIENT_SECRET || file.clientSecret || '',
    appName: file.appName || 'this app',
    buyUrl: file.buyUrl || 'https://onetimesuite.com/',
    port: Number(process.env.WHOP_OAUTH_PORT || file.port || 8734),
    ...overrides,
  };
  if (!cfg.experienceIds || !cfg.experienceIds.length || !cfg.clientId) {
    throw new Error('whop-license: experienceIds and clientId are required (whop-license.config.json)');
  }
  cfg.experienceId = cfg.experienceIds[0]; // primary — used for the device registry
  return cfg;
}

const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function deviceFingerprint() {
  return crypto.createHash('sha256')
    .update([os.hostname(), os.platform(), os.arch(), os.userInfo().username].join('|'))
    .digest('hex').slice(0, 32);
}

/* ---------- OAuth 2.1 + PKCE over a loopback redirect ---------- */
async function loginWithWhop(cfg, openUrl) {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const redirectUri = `http://127.0.0.1:${cfg.port}/callback`;

  const authUrl = `${OAUTH_BASE}/authorize?` + new URLSearchParams({
    client_id: cfg.clientId, redirect_uri: redirectUri, response_type: 'code',
    scope: 'openid profile', state, nonce: b64url(crypto.randomBytes(16)), // Whop requires nonce with openid scope
    code_challenge: challenge, code_challenge_method: 'S256',
  });

  const code = await new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, redirectUri);
      if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', 'text/html');
      res.end(`<body style="font-family:system-ui;padding:3rem;text-align:center"><h2>${u.searchParams.get('code') ? 'Signed in — you can close this tab and return to ' + cfg.appName + '.' : 'Sign-in failed: ' + (u.searchParams.get('error') || 'no code')}</h2></body>`);
      srv.close();
      if (u.searchParams.get('state') !== state) return reject(new Error('OAuth state mismatch'));
      u.searchParams.get('code') ? resolve(u.searchParams.get('code'))
        : reject(new Error(u.searchParams.get('error') || 'OAuth was cancelled'));
    });
    srv.on('error', reject);
    srv.listen(cfg.port, '127.0.0.1', () => Promise.resolve(openUrl(authUrl)).catch(reject));
    setTimeout(() => { try { srv.close(); } catch {} ; reject(new Error('Sign-in timed out (5 minutes)')); }, 5 * 60 * 1000).unref();
  });

  const body = { grant_type: 'authorization_code', client_id: cfg.clientId, code, redirect_uri: redirectUri, code_verifier: verifier };
  if (cfg.clientSecret) body.client_secret = cfg.clientSecret;
  const tokRes = await fetch(`${OAUTH_BASE}/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const tokens = await tokRes.json();
  if (!tokRes.ok || !tokens.access_token) throw new Error('Whop token exchange failed: ' + JSON.stringify(tokens).slice(0, 200));

  const uiRes = await fetch(`${OAUTH_BASE}/userinfo`, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  const userInfo = await uiRes.json();
  if (!uiRes.ok || !userInfo.sub) throw new Error('Whop userinfo failed: ' + JSON.stringify(userInfo).slice(0, 200));
  return { userId: userInfo.sub, tokens };
}

async function refreshTokens(cfg, refreshToken) {
  const body = { grant_type: 'refresh_token', client_id: cfg.clientId, refresh_token: refreshToken };
  if (cfg.clientSecret) body.client_secret = cfg.clientSecret;
  const res = await fetch(`${OAUTH_BASE}/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const j = await res.json();
  if (!res.ok || !j.access_token) throw new Error('refresh failed');
  return j;
}

/* Check the signed-in user's own access with their own token — any id grants. */
async function checkAccess(cfg, accessToken, userId) {
  let authExpired = false;
  for (const id of cfg.experienceIds) {
    const res = await fetch(`${API_BASE}/users/${encodeURIComponent(userId)}/access/${id}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 401) { authExpired = true; continue; }
    if (res.status === 403) continue;
    if (!res.ok) throw new Error(`access check HTTP ${res.status}`);
    const j = await res.json();
    if (j.has_access) return { hasAccess: true, accessLevel: j.access_level || 'customer', grantedId: id };
  }
  return { hasAccess: false, accessLevel: 'no_access', authExpired };
}

/* ---------- central device registry (desktop apps only) ---------- */
async function registerDevice(cfg, accessToken, deviceHash) {
  const res = await fetch(`${REGISTRY_BASE}/devices/register`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ experience_id: cfg.experienceId, device_hash: deviceHash, device_label: os.hostname() }),
  });
  if (res.status === 409) return { limitReached: true, devices: (await res.json()).devices };
  if (!res.ok) throw new Error(`device registry HTTP ${res.status}`);
  return { limitReached: false };
}
async function listDevices(cfg, accessToken) {
  const res = await fetch(`${REGISTRY_BASE}/devices?experience_id=${cfg.experienceId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`device registry HTTP ${res.status}`);
  return res.json();
}
async function deactivateRemoteDevice(cfg, accessToken, deviceIdOrOpts) {
  const body = typeof deviceIdOrOpts === 'string'
    ? { device_id: deviceIdOrOpts }
    : { device_hash: deviceIdOrOpts.deviceHash, experience_id: cfg.experienceId };
  const res = await fetch(`${REGISTRY_BASE}/devices/deactivate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`device registry HTTP ${res.status}`);
  return res.json();
}

/* ---------- state ---------- */
const loadState = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
function saveState(f, s) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(s, null, 2)); }

/* ---------- desktop mode ---------- */
/**
 * ensureLicensed({ stateDir, openUrl }) -> { ok, state } | throws on hard deny.
 * - stateDir: per-app writable dir (Electron: app.getPath('userData'))
 * - openUrl:  fn(url) opening the system browser (Electron: shell.openExternal)
 * Never blocks startup after first activation; re-validates in background.
 */
async function ensureLicensed({ stateDir, openUrl, config }) {
  const cfg = loadConfig(config);
  const stateFile = path.join(stateDir, 'whop-license.json');
  let state = loadState(stateFile);

  if (!state || state.deviceHash !== deviceFingerprint()) {
    const { userId, tokens } = await loginWithWhop(cfg, openUrl);
    const access = await checkAccess(cfg, tokens.access_token, userId);
    if (!access.hasAccess) { const e = new Error(`No active ${cfg.appName} license on this Whop account.`); e.code = 'NO_LICENSE'; throw e; }
    // enforce the device cap via the central registry (fail-open if unreachable)
    const reg = await registerDevice(cfg, tokens.access_token, deviceFingerprint()).catch(() => ({ limitReached: false }));
    if (reg.limitReached) {
      const e = new Error(`Device limit reached for ${cfg.appName}. Deactivate one of your other devices to activate this one.`);
      e.code = 'DEVICE_LIMIT'; e.devices = reg.devices;
      e.deactivate = deviceId => deactivateRemoteDevice(cfg, tokens.access_token, deviceId);
      throw e;
    }
    state = {
      userId, deviceHash: deviceFingerprint(), experienceId: cfg.experienceId,
      grantedId: access.grantedId || cfg.experienceId,
      refreshToken: tokens.refresh_token || null, accessLevel: access.accessLevel,
      lastCheck: Date.now(), lastGood: true, activatedAt: new Date().toISOString(),
    };
    saveState(stateFile, state);
    return { ok: true, state, firstActivation: true };
  }

  // Background re-validation (never blocks startup)
  if (Date.now() - state.lastCheck > RECHECK_MS && state.refreshToken) {
    (async () => {
      try {
        const t = await refreshTokens(cfg, state.refreshToken);
        if (t.refresh_token) state.refreshToken = t.refresh_token;
        const access = await checkAccess(cfg, t.access_token, state.userId);
        state.lastCheck = Date.now(); state.lastGood = access.hasAccess;
        saveState(stateFile, state);
        registerDevice(cfg, t.access_token, state.deviceHash).catch(() => {}); // bump last_seen

      } catch { /* transient network/auth errors — grace period covers us */ }
    })();
  }

  const expired = Date.now() - state.lastCheck > GRACE_MS;
  if (expired && !state.lastGood) {
    const e = new Error(`${cfg.appName} could not verify your license for over 10 days. Please sign in again.`);
    e.code = 'GRACE_EXPIRED';
    try { fs.unlinkSync(stateFile); } catch {}
    throw e;
  }
  if (!state.lastGood && !expired) return { ok: true, state, warning: 'license re-check failed — will retry' };
  return { ok: true, state };
}

/* Self-serve device deactivation: clears this device's activation. */
function deactivateDevice({ stateDir }) {
  try { fs.unlinkSync(path.join(stateDir, 'whop-license.json')); return true; } catch { return false; }
}

module.exports = {
  loadConfig, loginWithWhop, checkAccess, refreshTokens,
  ensureLicensed, deactivateDevice,
  registerDevice, listDevices, deactivateRemoteDevice,
  deviceFingerprint,
};
