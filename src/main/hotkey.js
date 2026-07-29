const { globalShortcut, powerMonitor } = require('electron');
const { isTrusted } = require('./mac-accessibility');
const { FnMonitor, isAvailable: fnAvailable, KEY_NAME: FN_KEY_NAME } = require('./fn-monitor');

let uIOhook = null;
let UiohookKey = null;
let uioLoadError = null;
let uioStarted = false;
let listenersAttached = false;

try {
  ({ uIOhook, UiohookKey } = require('uiohook-napi'));
} catch (err) {
  uioLoadError = err;
  console.error('uiohook-napi failed to load — hold-to-talk disabled, toggle still works:', err.message);
}

// ---------------------------------------------------------------------------
// Key naming
//
// The canonical stored name for a key is the uiohook-napi `UiohookKey` name
// ('AltRight', 'F13', 'ScrollLock', 'A', …). Anything uiohook reports that we
// don't have a name for round-trips as 'Key<keycode>' so *every* physical key
// on any keyboard is bindable, not just a hand-written shortlist.
//
// Older builds (<= v1.1.3) stored a small set of custom names. Those are
// aliased here so an existing config.json with {"holdHotkey":"RightAlt"} keeps
// working untouched after upgrade.
// ---------------------------------------------------------------------------
const LEGACY_HOLD_ALIASES = {
  RightAlt: 'AltRight',
  RightCtrl: 'CtrlRight',
  RightShift: 'ShiftRight',
  RightWin: 'MetaRight',
  LeftAlt: 'Alt',
  LeftCtrl: 'Ctrl',
  LeftShift: 'Shift',
  LeftWin: 'Meta',
  Windows: 'Meta',
  Command: 'Meta'
};

// Friendly labels for keys whose raw uiohook name is ambiguous about side.
const IS_MAC = process.platform === 'darwin';
const PRETTY_LABELS = {
  // Driven by the native helper, not uiohook - see fn-monitor.js.
  GlobeFn: 'Globe / Fn (🌐)',
  // Apple names these differently to the uiohook identifiers, and showing
  // "Alt" to a Mac user sends them hunting for a key that isn't on the keyboard.
  Alt: IS_MAC ? 'Left Option (⌥)' : 'Left Alt',
  AltRight: IS_MAC ? 'Right Option (⌥)' : 'Right Alt',
  Ctrl: IS_MAC ? 'Left Control (⌃)' : 'Left Ctrl',
  CtrlRight: IS_MAC ? 'Right Control (⌃)' : 'Right Ctrl',
  Shift: IS_MAC ? 'Left Shift (⇧)' : 'Left Shift',
  ShiftRight: IS_MAC ? 'Right Shift (⇧)' : 'Right Shift',
  Meta: IS_MAC ? 'Left Command (⌘)' : 'Left Win',
  MetaRight: IS_MAC ? 'Right Command (⌘)' : 'Right Win',
  Space: 'Space',
  Backquote: '` (backquote)',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Minus: '-',
  Equal: '='
};

// Keys that are only ever modifiers — a toggle chord needs a real key too.
const MODIFIER_NAMES = new Set(['Alt', 'AltRight', 'Ctrl', 'CtrlRight', 'Shift', 'ShiftRight', 'Meta', 'MetaRight']);

let CODE_TO_NAME = null;
function codeToName() {
  if (CODE_TO_NAME) return CODE_TO_NAME;
  CODE_TO_NAME = new Map();
  if (UiohookKey) {
    for (const [name, code] of Object.entries(UiohookKey)) {
      if (typeof code !== 'number') continue;
      // First name wins so plain keys beat Numpad* aliases on shared codes.
      if (!CODE_TO_NAME.has(code)) CODE_TO_NAME.set(code, name);
    }
  }
  return CODE_TO_NAME;
}

/** Canonical stored name for a raw uiohook keycode. */
function nameForKeycode(code) {
  const known = codeToName().get(code);
  return known || `Key${code}`;
}

/** Stored name (incl. legacy aliases and Key<n>) -> uiohook keycode, or null. */
function keycodeForName(name) {
  if (!name || typeof name !== 'string') return null;
  const canonical = LEGACY_HOLD_ALIASES[name] || name;
  if (UiohookKey && Object.prototype.hasOwnProperty.call(UiohookKey, canonical)) {
    const code = UiohookKey[canonical];
    if (typeof code === 'number') return code;
  }
  const raw = /^Key(\d+)$/.exec(canonical);
  if (raw) return Number(raw[1]);
  return null;
}

/** Human label shown in Settings and the tray. */
function labelForName(name) {
  if (!name) return 'None';
  const canonical = LEGACY_HOLD_ALIASES[name] || name;
  if (PRETTY_LABELS[canonical]) return PRETTY_LABELS[canonical];
  const raw = /^Key(\d+)$/.exec(canonical);
  if (raw) return `Key #${raw[1]}`;
  // Split CamelCase for readability: ArrowLeft -> Arrow Left
  return canonical.replace(/([a-z])([A-Z0-9])/g, '$1 $2');
}

// ---------------------------------------------------------------------------
// Electron accelerator building (used by the toggle chord capture)
// ---------------------------------------------------------------------------
const ACCEL_KEY_NAMES = {
  Enter: 'Return',
  NumpadEnter: 'Return',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  CapsLock: 'Capslock',
  NumLock: 'Numlock',
  ScrollLock: 'Scrolllock',
  Semicolon: ';',
  Equal: '=',
  Comma: ',',
  Minus: '-',
  Period: '.',
  Slash: '/',
  Backquote: '`',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Quote: "'",
  Numpad0: 'num0',
  Numpad1: 'num1',
  Numpad2: 'num2',
  Numpad3: 'num3',
  Numpad4: 'num4',
  Numpad5: 'num5',
  Numpad6: 'num6',
  Numpad7: 'num7',
  Numpad8: 'num8',
  Numpad9: 'num9',
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv',
  NumpadDecimal: 'numdec'
};

/**
 * Turn a raw uiohook keyboard event into an Electron accelerator string.
 * Returns null when the base key has no accelerator representation.
 */
function acceleratorFromEvent(e) {
  const name = nameForKeycode(e.keycode);
  if (MODIFIER_NAMES.has(name)) return null; // modifiers alone aren't a shortcut
  let key = ACCEL_KEY_NAMES[name];
  if (!key) {
    if (/^[A-Z]$/.test(name) || /^[0-9]$/.test(name) || /^F([1-9]|1[0-9]|2[0-4])$/.test(name)) key = name;
    else if (['Space', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'Escape', 'PrintScreen'].includes(name)) key = name;
  }
  if (!key) return null;

  const parts = [];
  if (e.ctrlKey) parts.push('Control');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push(process.platform === 'darwin' ? 'Command' : 'Super');
  parts.push(key);
  return parts.join('+');
}

// ---------------------------------------------------------------------------

const HEALTH_INTERVAL_MS = 60_000;
// If the user is demonstrably at the keyboard/mouse but uiohook has been silent
// this long, the OS almost certainly dropped our low-level hook.
const SILENCE_BEFORE_REARM_MS = 180_000;
const CAPTURE_TIMEOUT_MS = 15_000;

class HotkeyManager {
  constructor(callbacks) {
    this.callbacks = callbacks || {};
    this.holdCode = null;
    this.holding = false;
    this.toggleAccel = null;
    this.lastDownAt = 0;
    this.lastConfig = null;
    this.lastStatus = null;
    this.lastHookEventAt = 0;
    this.capture = null;
    this.captureTimer = null;
    this.healthTimer = null;
  }

  /** True when a global keyboard hook is even possible on this install. */
  get hookAvailable() {
    return !!uIOhook;
  }

  get hookLoadError() {
    return uioLoadError ? (uioLoadError.message || String(uioLoadError)) : null;
  }

  /**
   * Arm both hotkeys. Returns a status object so the caller can surface
   * failures instead of them dying in a console.warn nobody reads.
   */
  apply(config) {
    const { holdEnabled, holdHotkey, toggleEnabled, toggleHotkey } = config || {};
    this.lastConfig = { holdEnabled, holdHotkey, toggleEnabled, toggleHotkey };
    this.unregister();

    const status = {
      hold: { enabled: !!holdEnabled, ok: false, error: null, label: labelForName(holdHotkey) },
      toggle: { enabled: !!toggleEnabled, ok: false, error: null, label: toggleHotkey || '' }
    };

    if (toggleEnabled && toggleHotkey) {
      try {
        const ok = globalShortcut.register(toggleHotkey, () => this.callbacks.onToggle?.());
        status.toggle.ok = !!ok;
        if (ok) this.toggleAccel = toggleHotkey;
        else status.toggle.error = `Windows/macOS refused "${toggleHotkey}" — another app already owns it.`;
      } catch (err) {
        status.toggle.error = `"${toggleHotkey}" is not a valid shortcut (${err.message}).`;
      }
    } else {
      status.toggle.ok = true; // disabled on purpose
    }

    if (!holdEnabled) {
      status.hold.ok = true; // disabled on purpose
    } else if (holdHotkey === FN_KEY_NAME) {
      // Globe/Fn never reaches the keyboard hook - it is a modifier flag, not a
      // key - so it is driven by the native helper instead of uiohook.
      const res = this._startFnMonitor();
      status.hold.ok = res.ok;
      status.hold.error = res.ok ? null : res.error;
    } else if (!uIOhook) {
      status.hold.error = `Global key hook unavailable${this.hookLoadError ? ` (${this.hookLoadError})` : ''}. Hold-to-talk cannot run; use the toggle shortcut.`;
    } else if (!holdHotkey) {
      status.hold.error = 'No hold key assigned. Open Settings → Hotkeys and press one.';
    } else {
      const code = keycodeForName(holdHotkey);
      if (code == null) {
        status.hold.error = `Unrecognised hold key "${holdHotkey}". Open Settings → Hotkeys and re-record it.`;
      } else {
        this.holdCode = code;
        const started = this.ensureHookStarted();
        status.hold.ok = started.ok;
        if (!started.ok) status.hold.error = `Could not install the keyboard hook (${started.error}).`;
      }
    }

    this.lastStatus = status;
    this.startHealthMonitor();
    return status;
  }

  /**
   * Idempotently attach listeners + start the native hook.
   * Listeners are attached exactly once for the process lifetime; start/stop
   * may happen many times (re-arm after resume, health check, …).
   */
  ensureHookStarted() {
    if (!uIOhook) return { ok: false, error: this.hookLoadError || 'uiohook-napi not loaded' };
    // libuiohook reports "failed to enable access for assistive devices" on its
    // own stderr and start() still returns normally, so without this check the
    // app believes the hook is live while no key event ever arrives. Checking
    // the trust state up front turns that into a real, reportable failure.
    if (process.platform === 'darwin' && !isTrusted(false)) {
      uioStarted = false;
      return {
        ok: false,
        error: 'Could not install the keyboard hook — macOS Accessibility access is not enabled for WisperTalk.',
      };
    }
    if (!listenersAttached) {
      uIOhook.on('keydown', (e) => this._onKeydown(e));
      uIOhook.on('keyup', (e) => this._onKeyup(e));
      listenersAttached = true;
    }
    if (uioStarted) return { ok: true };
    try {
      uIOhook.start();
      uioStarted = true;
      this.lastHookEventAt = Date.now();
      return { ok: true };
    } catch (err) {
      uioStarted = false;
      console.error('uIOhook.start() failed:', err.message);
      return { ok: false, error: err.message };
    }
  }

  /**
   * Tear the hook down and put it back up, then re-register the toggle.
   * Called after sleep/resume, screen unlock, and by the health monitor when
   * the hook looks dead. Safe to call at any time.
   */
  rearm(reason = 'manual') {
    console.log(`[hotkey] re-arming (${reason})`);
    this.holding = false;
    if (uIOhook && uioStarted) {
      try { uIOhook.stop(); } catch (err) { console.warn('[hotkey] stop during re-arm failed:', err.message); }
      uioStarted = false;
    }
    const cfg = this.lastConfig;
    if (!cfg) return null;
    const status = this.apply(cfg);
    this.callbacks.onStatus?.(status, reason);
    return status;
  }

  /** Bring up the native Globe/Fn listener and route it to the hold callbacks. */
  _startFnMonitor() {
    if (!fnAvailable()) {
      return { ok: false, error: 'Globe/Fn is not available in this build. Pick another hold key.' };
    }
    if (this.fnMonitor) this.fnMonitor.stop();
    this.fnMonitor = new FnMonitor({
      onPress: () => { this.lastHookEventAt = Date.now(); this.holding = true; this.callbacks.onHoldPress?.(); },
      onRelease: () => { this.lastHookEventAt = Date.now(); this.holding = false; this.callbacks.onHoldRelease?.(); },
      onError: (msg) => this.callbacks.onStatus?.(
        { hold: { enabled: true, ok: false, error: msg, label: labelForName(FN_KEY_NAME) },
          toggle: { enabled: false, ok: true, error: null, label: '' } },
        'globe/fn'
      ),
    });
    return this.fnMonitor.start();
  }

  startHealthMonitor() {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => this._healthCheck(), HEALTH_INTERVAL_MS);
    if (this.healthTimer.unref) this.healthTimer.unref();
  }

  _healthCheck() {
    const cfg = this.lastConfig;
    if (!cfg || !cfg.holdEnabled || !uIOhook) return;
    // Globe/Fn doesn't use uiohook at all, so the "hook looks dead" heuristics
    // below would re-arm it forever. The helper re-enables its own tap.
    if (cfg.holdHotkey === FN_KEY_NAME) return;
    if (!uioStarted) {
      this.rearm('hook not running');
      return;
    }
    let idleSeconds = 999;
    try { idleSeconds = powerMonitor.getSystemIdleTime(); } catch {}
    const silentFor = Date.now() - this.lastHookEventAt;
    // User is clearly at the machine, yet the hook has seen nothing for minutes.
    if (idleSeconds <= 5 && silentFor > SILENCE_BEFORE_REARM_MS) {
      this.rearm('hook appears dead (no events while user active)');
    }
  }

  // -------------------------------------------------------------------------
  // Press-to-map capture
  // -------------------------------------------------------------------------
  /**
   * Listen for the next physical key press and hand it back.
   * mode 'hold'  -> resolves with a single key name.
   * mode 'toggle'-> resolves with an Electron accelerator (modifiers included).
   * Escape cancels. Auto-cancels after CAPTURE_TIMEOUT_MS.
   */
  startCapture(mode) {
    return new Promise((resolve) => {
      if (!uIOhook) {
        resolve({ ok: false, unavailable: true, error: this.hookLoadError || 'Global key hook unavailable' });
        return;
      }
      const started = this.ensureHookStarted();
      if (!started.ok) {
        resolve({ ok: false, unavailable: true, error: started.error });
        return;
      }
      this.cancelCapture('superseded');
      const done = (result) => {
        if (this.captureTimer) { clearTimeout(this.captureTimer); this.captureTimer = null; }
        this.capture = null;
        resolve(result);
      };
      this.capture = { mode, done };
      this.captureTimer = setTimeout(() => done({ ok: false, cancelled: true, reason: 'timeout' }), CAPTURE_TIMEOUT_MS);
    });
  }

  cancelCapture(reason = 'cancelled') {
    if (!this.capture) return;
    const { done } = this.capture;
    if (this.captureTimer) { clearTimeout(this.captureTimer); this.captureTimer = null; }
    this.capture = null;
    done({ ok: false, cancelled: true, reason });
  }

  _handleCapture(e) {
    const { mode, done } = this.capture;
    const name = nameForKeycode(e.keycode);

    if (name === 'Escape') {
      if (this.captureTimer) { clearTimeout(this.captureTimer); this.captureTimer = null; }
      this.capture = null;
      done({ ok: false, cancelled: true, reason: 'escape' });
      return;
    }

    if (mode === 'toggle') {
      // Wait for a non-modifier key so the chord is a real accelerator.
      if (MODIFIER_NAMES.has(name)) return;
      const accel = acceleratorFromEvent(e);
      if (!accel) return; // unsupported base key — keep listening
      if (this.captureTimer) { clearTimeout(this.captureTimer); this.captureTimer = null; }
      this.capture = null;
      done({ ok: true, value: accel, label: accel });
      return;
    }

    if (this.captureTimer) { clearTimeout(this.captureTimer); this.captureTimer = null; }
    this.capture = null;
    done({ ok: true, value: name, label: labelForName(name), keycode: e.keycode });
  }

  // -------------------------------------------------------------------------

  _onKeydown(e) {
    this.lastHookEventAt = Date.now();
    if (this.capture) { this._handleCapture(e); return; }
    if (this.holdCode == null) return;
    if (e.keycode !== this.holdCode) return;
    const now = Date.now();
    if (this.holding) return;
    if (now - this.lastDownAt < 50) return;
    this.lastDownAt = now;
    this.holding = true;
    this.callbacks.onHoldPress?.();
  }

  _onKeyup(e) {
    this.lastHookEventAt = Date.now();
    if (this.capture) return;
    if (this.holdCode == null) return;
    if (e.keycode !== this.holdCode) return;
    if (!this.holding) return;
    this.holding = false;
    this.callbacks.onHoldRelease?.();
  }

  /** Release a stuck hold (e.g. the key-up was swallowed by another app). */
  clearHolding() {
    this.holding = false;
  }

  unregister() {
    try { globalShortcut.unregisterAll(); } catch {}
    // The Fn helper is a child process - leaving it running would keep firing
    // hold events after the key has been reassigned.
    if (this.fnMonitor) { this.fnMonitor.stop(); this.fnMonitor = null; }
    this.toggleAccel = null;
    this.holdCode = null;
    this.holding = false;
  }

  shutdown() {
    this.cancelCapture('shutdown');
    if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null; }
    this.unregister();
    if (uioStarted && uIOhook) {
      try { uIOhook.stop(); } catch {}
      uioStarted = false;
    }
  }
}

// Kept for backwards compatibility with the old <select> in Settings; the UI
// now uses press-to-map, but this is still a useful "common keys" list.
/**
 * Keys offered in the hold-key picker, best-first for the platform.
 *
 * Mac keyboards have no Scroll Lock, and the Globe/Fn key is deliberately
 * absent: macOS reports it as a modifier flag rather than a key, so libuiohook
 * never emits an event for it and it can't be bound here at all. Listing it
 * would give a choice that silently never fires.
 */
const MAC_HOLD_KEYS = ['MetaRight', 'AltRight', 'CtrlRight', 'ShiftRight', 'CapsLock',
  'F13', 'F14', 'F15', 'F16', 'F17', 'F18', 'F19', 'F20'];

/**
 * Globe/Fn is only offered when its helper binary actually shipped in this
 * build - listing a key that cannot fire is worse than not listing it.
 */
function holdKeyChoices() {
  if (!IS_MAC) {
    return ['AltRight', 'CtrlRight', 'ShiftRight', 'MetaRight', 'CapsLock', 'ScrollLock',
      'F13', 'F14', 'F15', 'F16', 'F17', 'F18', 'F19', 'F20'];
  }
  return fnAvailable() ? [FN_KEY_NAME, ...MAC_HOLD_KEYS] : MAC_HOLD_KEYS;
}

// Kept for callers that want the static list; the function above is preferred.
const HOLD_KEY_CHOICES = IS_MAC ? MAC_HOLD_KEYS
  : ['AltRight', 'CtrlRight', 'ShiftRight', 'MetaRight', 'CapsLock', 'ScrollLock',
     'F13', 'F14', 'F15', 'F16', 'F17', 'F18', 'F19', 'F20'];

module.exports = {
  HotkeyManager,
  HOLD_KEY_CHOICES,
  holdKeyChoices,
  FN_KEY_NAME,
  LEGACY_HOLD_ALIASES,
  nameForKeycode,
  keycodeForName,
  labelForName,
  acceleratorFromEvent
};
