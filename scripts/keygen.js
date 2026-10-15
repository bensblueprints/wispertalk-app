#!/usr/bin/env node
/*
 * keygen.js — WisperTalk 2.0 license-key generator (owner-only CLI).
 *
 *   node scripts/keygen.js <customer|reseller|master> [name] [count]
 *
 *   - tier:  customer | reseller | master   (required)
 *   - name:  optional holder name; multi-word names work without quotes
 *            (greeted by name on activation). Capped at 40 UTF-8 bytes.
 *   - count: number of keys to mint (default 1, max 100)
 *
 * Every printed key is immediately verified with parseKey so a bad mint is
 * impossible to miss.
 *
 * WARNING: this script holds signing power (it uses the same SECRET the app
 * verifies against). NEVER ship it to customers — it lives in scripts/, which
 * is deliberately absent from the electron-builder `files` list in
 * package.json (only src/, assets/, models/ and package.json ship).
 */
const { generateKey, generateResellerKey, generateMasterKey, parseKey } = require('../src/main/license-key');

const MAX_COUNT = 100;

const GENERATORS = {
  customer: generateKey,
  reseller: generateResellerKey,
  master: generateMasterKey
};

function usage() {
  console.log('Usage: node scripts/keygen.js <customer|reseller|master> [name] [count]');
  console.log('  name   optional holder name (multi-word OK without quotes)');
  console.log(`  count  1..${MAX_COUNT}, default 1`);
}

const args = process.argv.slice(2);
const tier = args[0];
if (!GENERATORS[tier]) {
  usage();
  process.exit(tier === '-h' || tier === '--help' ? 0 : 1);
}

// Trailing numeric arg is the count; everything between tier and count is the name.
let rest = args.slice(1);
let count = 1;
if (rest.length && /^\d+$/.test(rest[rest.length - 1])) {
  count = parseInt(rest.pop(), 10);
}
const name = rest.join(' ').trim();

if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
  console.error(`Count must be between 1 and ${MAX_COUNT}.`);
  usage();
  process.exit(1);
}

const generate = GENERATORS[tier];
for (let i = 0; i < count; i++) {
  const key = generate(name);
  const parsed = parseKey(key);
  console.log(key);
  console.log(`  → verified: tier=${parsed.tier}, holder=${parsed.holder === null ? '(none)' : parsed.holder}, valid=${parsed.valid}`);
  if (!parsed.valid || parsed.tier !== tier) {
    console.error('  !! minted key failed verification — do not hand it out');
    process.exit(1);
  }
}
