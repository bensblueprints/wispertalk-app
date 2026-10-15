/*
 * license-key.js — WisperTalk 2.0 offline license keys.
 *
 * Pure Node (no Electron imports) so it can be unit-tested directly.
 *
 * Three tiers:
 *   master   — the hardcoded MASTER_KEY below (holder MASTER_HOLDER), plus
 *              generated WTM- keys. Activates the app, unlocks reseller tools,
 *              can mint customer AND reseller keys. Generated masters are minted
 *              ONLY by scripts/keygen.js — never in-app.
 *   reseller — generated, prefix WTR-. Activates the app with a personalized
 *              welcome, unlocks reseller tools, can mint CUSTOMER keys only.
 *   customer — generated, prefix WT2-. Activates the app with a personalized
 *              welcome, no reseller tools.
 *
 * `isMasterKey()` matches ONLY the literal hardcoded MASTER_KEY (kept specific
 * for the Alan-Waddle greeting). Privileges are decided by `parseKey().tier` —
 * tier 'master' covers both the hardcoded key and generated WTM- keys.
 *
 * Key formats:
 *   Customer:         WT2-<6hex>-<8hex>-<7sig>
 *   Customer, named:  WT2-<6hex>-<8hex>-<NAMEHEX>-<7sig>
 *   Reseller:         WTR-<6hex>-<8hex>-<7sig>
 *   Reseller, named:  WTR-<6hex>-<8hex>-<NAMEHEX>-<7sig>
 *   Master:           WTM-<6hex>-<8hex>-<7sig>
 *   Master, named:    WTM-<6hex>-<8hex>-<NAMEHEX>-<7sig>
 *   - groups 1+2: 14 random uppercase-hex chars (6 + 8), the payload
 *   - NAMEHEX:    holder name as uppercase hex of its UTF-8 bytes. Names are
 *                 capped at 40 UTF-8 bytes; longer names are truncated to fit,
 *                 whole characters only.
 *   - sig:        first 7 chars of uppercase HMAC-SHA256(SECRET, signed):
 *                   customer: payload            / payload + '.' + NAMEHEX
 *                   reseller: payload + '.reseller' / payload + '.reseller' + '.' + NAMEHEX
 *                   master:   payload + '.master'   / payload + '.master'   + '.' + NAMEHEX
 *                 The per-tier domain separator means a key of one tier can
 *                 never be re-parsed as another — swapping prefixes invalidates.
 *
 * Validation is fully offline: recompute the HMAC and compare with
 * timingSafeEqual. Secrets (HMAC secret, master key) live in
 * license-secrets.json next to this file — gitignored, so the public repo
 * carries no secrets. The packaged app still embeds them (electron-builder
 * packs src/**) — that trade-off is accepted by design (simple offline keys).
 */
const crypto = require('node:crypto');

let SECRET, MASTER_KEY, MASTER_HOLDER;
try {
  ({ secret: SECRET, masterKey: MASTER_KEY, masterHolder: MASTER_HOLDER } = require('./license-secrets.json'));
} catch {
  throw new Error(
    'license-secrets.json is missing. It is gitignored by design — create ' +
    'src/main/license-secrets.json with { "secret": "<64-hex HMAC secret>", ' +
    '"masterKey": "...", "masterHolder": "..." }.'
  );
}

const MAX_NAME_BYTES = 40;

const HEX = '0123456789ABCDEF';

function randomHex(n) {
  // Two hex chars per byte — generate ceil(n/2) bytes and trim.
  return Array.from(crypto.randomBytes(Math.ceil(n / 2)), (b) => HEX[b >> 4] + HEX[b & 15]).join('').slice(0, n);
}

/** Trim, uppercase, drop dashes/whitespace — accept keys typed any old way. */
function normalize(key) {
  return String(key || '').trim().toUpperCase().replace(/[-\s]/g, '');
}

function sign(signed) {
  return crypto.createHmac('sha256', SECRET).update(signed).digest('hex').toUpperCase().slice(0, 7);
}

function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** Name → uppercase hex of its UTF-8 bytes, truncated to MAX_NAME_BYTES. */
function encodeName(name) {
  let s = String(name).trim();
  while (Buffer.byteLength(s, 'utf8') > MAX_NAME_BYTES) s = s.slice(0, -1);
  return Buffer.from(s, 'utf8').toString('hex').toUpperCase();
}

function decodeName(nameHex) {
  return Buffer.from(nameHex, 'hex').toString('utf8');
}

function generateTieredKey(prefix, domainSuffix, name) {
  const payload = randomHex(6) + randomHex(8);
  const base = `${prefix}-${payload.slice(0, 6)}-${payload.slice(6)}`;
  const domain = domainSuffix ? `${payload}.${domainSuffix}` : payload;
  if (!String(name || '').trim()) return `${base}-${sign(domain)}`;
  const nameHex = encodeName(name);
  return `${base}-${nameHex}-${sign(`${domain}.${nameHex}`)}`;
}

/** Customer-tier key — what resellers hand out. */
function generateKey(name) {
  return generateTieredKey('WT2', null, name);
}

/** Reseller-tier key — only the master key may mint these. */
function generateResellerKey(name) {
  return generateTieredKey('WTR', 'reseller', name);
}

/** Master-tier key — minted only by scripts/keygen.js, never in-app. */
function generateMasterKey(name) {
  return generateTieredKey('WTM', 'master', name);
}

function isMasterKey(key) {
  return safeEqual(normalize(key), normalize(MASTER_KEY));
}

function isResellerKey(key) {
  return parseKey(key).tier === 'reseller';
}

const INVALID = { valid: false, tier: null, isMaster: false, holder: null };

const TIER_BY_PREFIX = { WT2: 'customer', WTR: 'reseller', WTM: 'master' };

function parseKey(key) {
  if (isMasterKey(key)) return { valid: true, tier: 'master', isMaster: true, holder: MASTER_HOLDER };
  const m = /^(WT2|WTR|WTM)([0-9A-F]{6})([0-9A-F]{8})([0-9A-F]{7,})$/.exec(normalize(key));
  if (!m) return INVALID;
  const tier = TIER_BY_PREFIX[m[1]];
  const payload = m[2] + m[3];
  const rest = m[4];
  const domain = tier === 'customer' ? payload : `${payload}.${tier}`;
  const ok = (holder) => ({ valid: true, tier, isMaster: tier === 'master', holder });
  // Unnamed key: group 3 IS the signature (customer format unchanged since 2.0.0).
  if (rest.length === 7) {
    return safeEqual(rest, sign(domain)) ? ok(null) : INVALID;
  }
  // Named key: the last 7 chars are the signature, the rest is NAMEHEX.
  const nameHex = rest.slice(0, -7);
  const sig = rest.slice(-7);
  if (nameHex.length % 2 !== 0) return INVALID;
  if (!safeEqual(sig, sign(`${domain}.${nameHex}`))) return INVALID;
  return ok(decodeName(nameHex));
}

function validateKey(key) {
  return parseKey(key).valid;
}

module.exports = {
  generateKey, generateResellerKey, generateMasterKey, parseKey, validateKey, isMasterKey, isResellerKey,
  MASTER_KEY, MASTER_HOLDER, MAX_NAME_BYTES
};
