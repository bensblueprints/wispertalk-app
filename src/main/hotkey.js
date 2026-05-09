const { globalShortcut } = require('electron');

let uIOhook = null;
let UiohookKey = null;
let uioStarted = false;

try {
  ({ uIOhook, UiohookKey } = require('uiohook-napi'));
} catch (err) {
  console.error('uiohook-napi failed to load — falling back to globalShortcut only:', err.message);
}

const HOLD_KEY_MAP = {
  RightAlt: 'AltRight',
  ScrollLock: 'ScrollLock',
  CapsLock: 'CapsLock',
  F13: 'F13',
  F14: 'F14',
  F15: 'F15',
  F16: 'F16',
  F17: 'F17',
  F18: 'F18',
  F19: 'F19',
  F20: 'F20',
  RightCtrl: 'CtrlRight',
  RightShift: 'ShiftRight',
  RightWin: 'MetaRight'
};

function holdKeycode(name) {
  if (!UiohookKey) return null;
  const uioName = HOLD_KEY_MAP[name];
  if (!uioName) return null;
  return UiohookKey[uioName] ?? null;
}

class HotkeyManager {
  constructor(callbacks) {
    this.callbacks = callbacks;
    this.holdCode = null;
    this.holding = false;
    this.toggleAccel = null;
    this.lastDownAt = 0;
  }

  apply({ holdEnabled, holdHotkey, toggleEnabled, toggleHotkey }) {
    this.unregister();

    if (toggleEnabled && toggleHotkey) {
      this.toggleAccel = toggleHotkey;
      try {
        const ok = globalShortcut.register(toggleHotkey, () => this.callbacks.onToggle?.());
        if (!ok) console.warn('Failed to register toggle hotkey:', toggleHotkey);
      } catch (err) {
        console.warn('Toggle hotkey error:', err.message);
      }
    }

    if (holdEnabled && holdHotkey && uIOhook) {
      this.holdCode = holdKeycode(holdHotkey);
      if (this.holdCode == null) {
        console.warn('Unknown hold hotkey:', holdHotkey);
      } else {
        if (!uioStarted) {
          uIOhook.on('keydown', (e) => this._onKeydown(e));
          uIOhook.on('keyup', (e) => this._onKeyup(e));
          try {
            uIOhook.start();
            uioStarted = true;
          } catch (err) {
            console.error('uIOhook.start() failed:', err.message);
          }
        }
      }
    }
  }

  _onKeydown(e) {
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
    if (this.holdCode == null) return;
    if (e.keycode !== this.holdCode) return;
    if (!this.holding) return;
    this.holding = false;
    this.callbacks.onHoldRelease?.();
  }

  unregister() {
    try { globalShortcut.unregisterAll(); } catch {}
    this.toggleAccel = null;
    this.holdCode = null;
    this.holding = false;
  }

  shutdown() {
    this.unregister();
    if (uioStarted && uIOhook) {
      try { uIOhook.stop(); } catch {}
      uioStarted = false;
    }
  }
}

const HOLD_KEY_CHOICES = Object.keys(HOLD_KEY_MAP);

module.exports = { HotkeyManager, HOLD_KEY_CHOICES };
