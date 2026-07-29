'use strict';
/**
 * Globe / Fn hold-to-talk on macOS.
 *
 * macOS never emits a key press for Globe/Fn - it only sets the
 * `maskSecondaryFn` modifier flag on flagsChanged events, so the keyboard hook
 * cannot see it at all (libuiohook maps that keycode to VC_UNDEFINED). A small
 * signed Swift helper taps flagsChanged and reports transitions on stdout; this
 * module owns that child process and turns its output into press/release.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const KEY_NAME = 'GlobeFn';

/** Packaged: Resources/fn-monitor. Dev: build-assets/fn-monitor. */
function helperPath() {
  const packaged = path.join(process.resourcesPath || '', 'fn-monitor');
  if (process.resourcesPath && fs.existsSync(packaged)) return packaged;
  const dev = path.join(app.getAppPath(), 'build-assets', 'fn-monitor');
  return fs.existsSync(dev) ? dev : null;
}

/** Whether Globe/Fn can be offered at all on this install. */
function isAvailable() {
  return process.platform === 'darwin' && !!helperPath();
}

class FnMonitor {
  constructor({ onPress, onRelease, onError } = {}) {
    this.onPress = onPress;
    this.onRelease = onRelease;
    this.onError = onError;
    this.proc = null;
    this.ready = false;
    this.stopping = false;
  }

  start() {
    if (this.proc) return { ok: true };
    const bin = helperPath();
    if (!bin) return { ok: false, error: 'Globe/Fn helper is not bundled in this build.' };

    try {
      this.stopping = false;
      this.proc = spawn(bin, [], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      this.proc = null;
      return { ok: false, error: `Could not start the Globe/Fn helper: ${err.message}` };
    }

    let buf = '';
    this.proc.stdout.on('data', chunk => {
      buf += chunk.toString();
      // The helper is line-oriented; hold partial lines until they complete.
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        this._handle(line);
      }
    });

    this.proc.stderr.on('data', d => {
      const s = d.toString().trim();
      if (!s) return;
      console.warn('[fn-monitor]', s);
      if (s.includes('accessibility-denied')) {
        this.onError?.('macOS Accessibility access is required for the Globe/Fn key.');
      }
    });

    this.proc.on('exit', (code) => {
      const wasReady = this.ready;
      this.proc = null;
      this.ready = false;
      if (this.stopping) return;
      // Exit 2 is the helper's "no Accessibility" signal; anything else while we
      // were running means it died unexpectedly and Globe/Fn is now dead too.
      if (code === 2) this.onError?.('macOS Accessibility access is required for the Globe/Fn key.');
      else if (wasReady) this.onError?.('The Globe/Fn listener stopped unexpectedly.');
    });

    return { ok: true };
  }

  _handle(line) {
    switch (line) {
      case 'FN_READY': this.ready = true; break;
      case 'FN_DOWN': this.onPress?.(); break;
      case 'FN_UP': this.onRelease?.(); break;
      case 'FN_TAP_REENABLED': console.log('[fn-monitor] tap re-enabled by helper'); break;
      default: if (line) console.log('[fn-monitor]', line);
    }
  }

  stop() {
    this.stopping = true;
    if (!this.proc) return;
    try { this.proc.kill(); } catch {}
    this.proc = null;
    this.ready = false;
  }
}

module.exports = { FnMonitor, isAvailable, helperPath, KEY_NAME };
