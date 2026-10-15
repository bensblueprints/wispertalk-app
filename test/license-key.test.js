const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { generateKey, generateResellerKey, generateMasterKey, parseKey, validateKey, isMasterKey, isResellerKey, MASTER_KEY, MASTER_HOLDER, MAX_NAME_BYTES } = require('../src/main/license-key');

test('generate → validate round-trips', () => {
  for (let i = 0; i < 20; i++) {
    const key = generateKey();
    assert.match(key, /^WT2-[0-9A-F]{6}-[0-9A-F]{8}-[0-9A-F]{7}$/);
    assert.equal(validateKey(key), true);
  }
});

test('tampered signature group is rejected', () => {
  const key = generateKey();
  const sig = key.split('-')[3];
  const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
  const tampered = key.replace(sig, flipped);
  assert.equal(validateKey(tampered), false);
});

test('tampered payload is rejected', () => {
  const key = generateKey();
  const parts = key.split('-');
  parts[1] = (parts[1][0] === 'A' ? 'B' : 'A') + parts[1].slice(1);
  assert.equal(validateKey(parts.join('-')), false);
});

test('master key validates and isMasterKey agrees', () => {
  assert.equal(validateKey(MASTER_KEY), true);
  assert.equal(isMasterKey(MASTER_KEY), true);
});

test('wrong master key is not the master key', () => {
  // One character off the real master — derived at runtime so no master-key
  // material lives in tracked source.
  const almostMaster = MASTER_KEY.slice(0, -1) + (MASTER_KEY.endsWith('W') ? 'X' : 'W');
  assert.equal(isMasterKey(almostMaster), false);
  assert.equal(isMasterKey(generateKey()), false);
  assert.equal(isMasterKey(''), false);
  assert.equal(isMasterKey(null), false);
});

test('normalization: lowercase and no-dash input validates', () => {
  const key = generateKey();
  assert.equal(validateKey(key.toLowerCase()), true);
  assert.equal(validateKey(key.replace(/-/g, '')), true);
  assert.equal(validateKey(`  ${key}  \n`), true);
  assert.equal(validateKey(MASTER_KEY.toLowerCase().replace(/-/g, '')), true);
});

test('garbage input is rejected', () => {
  for (const bad of ['', null, undefined, 'WT2-XXXXXX-XXXXXXXX-XXXXXXX', 'hello', 'WT2-AAAAAA-AAAAAAAA-AAAAAAA']) {
    assert.equal(validateKey(bad), false, JSON.stringify(bad));
  }
});

test('named key round-trips with decoded holder', () => {
  const key = generateKey('John Smith');
  assert.match(key, /^WT2-[0-9A-F]{6}-[0-9A-F]{8}-[0-9A-F]+-[0-9A-F]{7}$/);
  assert.equal(validateKey(key), true);
  assert.deepEqual(parseKey(key), { valid: true, tier: 'customer', isMaster: false, holder: 'John Smith' });
  // Normalization applies to named keys too.
  assert.deepEqual(parseKey(key.toLowerCase().replace(/-/g, '')).holder, 'John Smith');
});

test('flipping one char in the name group invalidates the key', () => {
  const key = generateKey('John Smith');
  const parts = key.split('-');
  const name = parts[2];
  parts[2] = (name[0] === 'A' ? 'B' : 'A') + name.slice(1);
  assert.equal(validateKey(parts.join('-')), false);
});

test('unnamed keys still validate and have holder null', () => {
  assert.deepEqual(parseKey(generateKey()), { valid: true, tier: 'customer', isMaster: false, holder: null });
  assert.deepEqual(parseKey(generateKey('')), { valid: true, tier: 'customer', isMaster: false, holder: null });
  assert.deepEqual(parseKey(generateKey('   ')), { valid: true, tier: 'customer', isMaster: false, holder: null });
});

test('the original unnamed signing scheme (HMAC over bare payload) still validates', () => {
  // The pre-name 2.0.0 format signed the payload alone — exactly what an
  // unnamed generateKey() produces today, so a fresh one proves old keys work.
  // (No hardcoded fixture: keys signed with the real secret stay out of git.)
  const legacy = generateKey();
  assert.match(legacy, /^WT2-[0-9A-F]{6}-[0-9A-F]{8}-[0-9A-F]{7}$/);
  assert.equal(validateKey(legacy), true);
  assert.deepEqual(parseKey(legacy), { valid: true, tier: 'customer', isMaster: false, holder: null });
});

test('customer named key is NOT the master key', () => {
  const key = generateKey(MASTER_HOLDER); // even the master's NAME doesn't grant reseller rights
  assert.equal(isMasterKey(key), false);
  assert.equal(parseKey(key).isMaster, false);
  assert.equal(parseKey(key).holder, MASTER_HOLDER);
});

test('master key parses with holder Alan Waddle', () => {
  assert.deepEqual(parseKey(MASTER_KEY), { valid: true, tier: 'master', isMaster: true, holder: MASTER_HOLDER });
});

test('reseller key round-trips with tier reseller and holder', () => {
  const key = generateResellerKey('Jane Doe');
  assert.match(key, /^WTR-[0-9A-F]{6}-[0-9A-F]{8}-[0-9A-F]+-[0-9A-F]{7}$/);
  assert.deepEqual(parseKey(key), { valid: true, tier: 'reseller', isMaster: false, holder: 'Jane Doe' });
  assert.equal(validateKey(key), true);
  assert.equal(isResellerKey(key), true);
  // Unnamed reseller keys have holder null.
  assert.deepEqual(parseKey(generateResellerKey()), { valid: true, tier: 'reseller', isMaster: false, holder: null });
});

test('tier checks: only reseller keys are reseller keys', () => {
  assert.equal(isResellerKey(generateKey()), false);       // customer
  assert.equal(isResellerKey(MASTER_KEY), false);          // master
  assert.equal(isResellerKey('garbage'), false);
});

test('domain separation: swapping WT2 ↔ WTR invalidates the key', () => {
  const customer = generateKey('John Smith');
  assert.equal(validateKey('WTR' + customer.slice(3)), false);
  const reseller = generateResellerKey('Jane Doe');
  assert.equal(validateKey('WT2' + reseller.slice(3)), false);
});

test('customer key with doctored reseller-ish name group fails', () => {
  const key = generateKey('John Smith');
  const parts = key.split('-');
  // Forge a name group that contains the ".reseller" marker as hex — the
  // signature no longer matches, so the key is dead.
  parts[2] = Buffer.from('x.reseller.y', 'utf8').toString('hex').toUpperCase();
  assert.equal(validateKey(parts.join('-')), false);
  assert.equal(parseKey(parts.join('-')).tier, null);
});

test('names over 40 UTF-8 bytes are truncated (whole characters only)', () => {
  const name = 'Jose María de la Cruz y Fernández del Río Santander';
  assert.ok(Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES);
  const parsed = parseKey(generateKey(name));
  assert.equal(parsed.valid, true);
  assert.ok(Buffer.byteLength(parsed.holder, 'utf8') <= MAX_NAME_BYTES);
  assert.ok(name.startsWith(parsed.holder)); // truncation, not mangling
});

test('generated master (WTM) round-trips with tier master and holder', () => {
  const key = generateMasterKey('Test Person');
  assert.match(key, /^WTM-[0-9A-F]{6}-[0-9A-F]{8}-[0-9A-F]+-[0-9A-F]{7}$/);
  assert.deepEqual(parseKey(key), { valid: true, tier: 'master', isMaster: true, holder: 'Test Person' });
  assert.equal(validateKey(key), true);
  // Unnamed generated master: holder null.
  assert.deepEqual(parseKey(generateMasterKey()), { valid: true, tier: 'master', isMaster: true, holder: null });
});

test('tier master covers both the hardcoded key and WTM keys', () => {
  assert.equal(parseKey(MASTER_KEY).tier, 'master');
  assert.equal(parseKey(generateMasterKey('Test Person')).tier, 'master');
});

test('prefix swap invalidates across all three formats', () => {
  const prefixes = ['WT2', 'WTR', 'WTM'];
  const keys = [generateKey('Test Person'), generateResellerKey('Test Person'), generateMasterKey('Test Person')];
  for (let i = 0; i < keys.length; i++) {
    assert.equal(validateKey(keys[i]), true);
    for (let j = 0; j < prefixes.length; j++) {
      if (i === j) continue;
      const swapped = prefixes[j] + keys[i].slice(3);
      assert.equal(validateKey(swapped), false, `${prefixes[i]} key re-prefixed as ${prefixes[j]}`);
    }
  }
});

test('isMasterKey is true ONLY for the hardcoded master key', () => {
  assert.equal(isMasterKey(MASTER_KEY), true);
  assert.equal(isMasterKey(generateMasterKey()), false);          // WTM: tier master, but not THE master key
  assert.equal(isMasterKey(generateMasterKey(MASTER_HOLDER)), false);
  assert.equal(isMasterKey(generateResellerKey()), false);
  assert.equal(isMasterKey(generateKey()), false);
});

test('keygen CLI mints and verifies a key per tier', () => {
  const cli = path.resolve(__dirname, '..', 'scripts', 'keygen.js');
  for (const tier of ['customer', 'reseller', 'master']) {
    const out = execFileSync(process.execPath, [cli, tier, 'Smoke', 'Test'], { encoding: 'utf8' });
    const key = out.split('\n')[0].trim();
    assert.equal(parseKey(key).tier, tier);
    assert.equal(parseKey(key).holder, 'Smoke Test');
    assert.match(out, /verified: tier=\w+, holder=Smoke Test, valid=true/);
  }
  // Bad tier exits non-zero with usage text.
  assert.throws(() => execFileSync(process.execPath, [cli, 'bogus'], { encoding: 'utf8', stdio: 'pipe' }));
});
