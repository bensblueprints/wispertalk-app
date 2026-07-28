#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Fetch the offline Whisper model into models/ so electron-builder can bake it
// into the installer. Runs as part of `npm run dist` / `npm run pack`.
//
// The app itself NEVER downloads anything: local-asr.js sets
// env.allowRemoteModels = false. If this script hasn't run, the local engine
// simply reports itself unavailable and the app stays on Groq.
//
// Usage:
//   node scripts/fetch-models.js                 # download from Hugging Face
//   node scripts/fetch-models.js --from <dir>    # copy from an existing cache
// ---------------------------------------------------------------------------
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const MODEL_ID = 'Xenova/whisper-base.en';
const BASE = `https://huggingface.co/${MODEL_ID}/resolve/main`;
const OUT_DIR = path.join(__dirname, '..', 'models', MODEL_ID);

const FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx'
];

// Sanity floor so a truncated/HTML error page never passes as a model file.
const MIN_BYTES = {
  'onnx/encoder_model_quantized.onnx': 10 * 1024 * 1024,
  'onnx/decoder_model_merged_quantized.onnx': 20 * 1024 * 1024,
  'tokenizer.json': 500 * 1024
};

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
}

function ok(rel) {
  const dest = path.join(OUT_DIR, rel);
  if (!fs.existsSync(dest)) return false;
  const size = fs.statSync(dest).size;
  return size >= (MIN_BYTES[rel] || 100);
}

function download(rel) {
  const dest = path.join(OUT_DIR, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const url = `${BASE}/${rel}`;
  return new Promise((resolve, reject) => {
    const get = (target, redirects = 0) => {
      https.get(target, { headers: { 'User-Agent': 'wispertalk-build' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          if (redirects > 5) { reject(new Error(`Too many redirects for ${rel}`)); return; }
          res.resume();
          get(new URL(res.headers.location, target).href, redirects + 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const tmp = `${dest}.part`;
        const out = fs.createWriteStream(tmp);
        res.pipe(out);
        out.on('finish', () => {
          out.close(() => {
            fs.renameSync(tmp, dest);
            resolve();
          });
        });
        out.on('error', reject);
      }).on('error', reject);
    };
    get(url);
  });
}

function copyFrom(dir, rel) {
  const src = path.join(dir, MODEL_ID, rel);
  const alt = path.join(dir, rel);
  const chosen = fs.existsSync(src) ? src : (fs.existsSync(alt) ? alt : null);
  if (!chosen) return false;
  const dest = path.join(OUT_DIR, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(chosen, dest);
  return true;
}

(async () => {
  const from = argValue('--from') || process.env.WISPERTALK_MODEL_CACHE || null;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let fetched = 0;

  for (const rel of FILES) {
    if (ok(rel)) { console.log(`  ok      ${rel}`); continue; }
    if (from && copyFrom(from, rel)) {
      console.log(`  copied  ${rel}`);
      fetched++;
      continue;
    }
    process.stdout.write(`  fetch   ${rel} … `);
    await download(rel);
    console.log('done');
    fetched++;
  }

  const missing = FILES.filter((rel) => !ok(rel));
  if (missing.length) {
    console.error('\nModel files missing or too small:', missing.join(', '));
    process.exit(1);
  }
  const total = FILES.reduce((n, rel) => n + fs.statSync(path.join(OUT_DIR, rel)).size, 0);
  console.log(`Models ready in ${OUT_DIR} (${(total / 1024 / 1024).toFixed(1)} MB, ${fetched} newly fetched)`);
})().catch((err) => {
  console.error('fetch-models failed:', err.message);
  process.exit(1);
});
