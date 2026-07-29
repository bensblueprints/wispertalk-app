#!/usr/bin/env node
'use strict';
/**
 * Compile the Globe/Fn helper (native/fn-monitor.swift) into build-assets/.
 *
 * Runs as electron-builder's beforePack hook. It is a no-op off macOS, and a
 * soft failure if Swift is unavailable: the app falls back to "Globe/Fn not
 * offered" rather than failing the whole build, since every other hold key
 * still works without this binary.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'native', 'fn-monitor.swift');
const OUT_DIR = path.join(ROOT, 'build-assets');
const OUT = path.join(OUT_DIR, 'fn-monitor');

function build() {
  if (process.platform !== 'darwin') {
    console.log('[fn-monitor] not macOS - skipping');
    return;
  }
  if (!fs.existsSync(SRC)) {
    console.warn('[fn-monitor] source missing, skipping:', SRC);
    return;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  try {
    // macos11 target keeps it runnable on anything the Electron build supports.
    execFileSync('swiftc', ['-O', '-target', 'arm64-apple-macos11', '-o', OUT, SRC], {
      stdio: 'inherit',
    });
    fs.chmodSync(OUT, 0o755);
    console.log('[fn-monitor] built', OUT);

    // No codesign here on purpose: electron-builder signs Mach-O binaries it
    // finds in extraResources as part of packaging, and it applies the hardened
    // runtime. Verified on the packaged app - Contents/Resources/fn-monitor
    // carries the Developer ID signature with flags=0x10000(runtime). Signing it
    // again here just raced that and failed.
  } catch (err) {
    // Don't take the build down over an optional hold key.
    console.warn('[fn-monitor] compile failed - Globe/Fn will be unavailable:', err.message);
    try { fs.rmSync(OUT, { force: true }); } catch {}
  }
}

build();
module.exports = build;
