'use strict';
/**
 * macOS Accessibility (assistive devices) permission.
 *
 * The global keyboard hook and the paste step both require the app to be a
 * "trusted accessibility client". Without it uiohook fails with
 * "failed to enable access for assistive devices" and the hotkey silently
 * never works.
 *
 * Two things matter here that a plain instruction dialog does NOT do:
 *  1. Calling isTrustedAccessibilityClient(true) is what actually registers the
 *     app with the system and shows Apple's own prompt - until something asks,
 *     the app may not even appear in the Accessibility list for the user to
 *     enable, which is the usual "there is no toggle for it" complaint.
 *  2. macOS emits no event when the permission is granted, and the running
 *     process is not re-trusted retroactively, so we poll and then re-arm the
 *     hook ourselves. Otherwise the user grants access and it still does not
 *     work until a manual restart.
 */
const { systemPreferences, shell, dialog } = require('electron');

const PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';

const isMac = () => process.platform === 'darwin';

/**
 * @param {boolean} prompt  true = ask macOS to show its permission prompt and
 *                          register this app in the Accessibility list.
 */
function isTrusted(prompt = false) {
  if (!isMac()) return true;
  try {
    return systemPreferences.isTrustedAccessibilityClient(prompt);
  } catch (err) {
    // Older Electron or a non-darwin build - don't block the app over it.
    console.warn('[a11y] trust check unavailable:', err.message);
    return true;
  }
}

function openSettings() {
  return shell.openExternal(PANE).catch(err =>
    console.warn('[a11y] could not open Settings pane:', err.message));
}

/**
 * Poll until the permission appears, because macOS gives us no notification.
 * Resolves false on timeout so callers can stop waiting rather than hang.
 */
function waitForTrust({ intervalMs = 1000, timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise(resolve => {
    if (isTrusted(false)) return resolve(true);
    const started = Date.now();
    const timer = setInterval(() => {
      if (isTrusted(false)) { clearInterval(timer); resolve(true); }
      else if (Date.now() - started > timeoutMs) { clearInterval(timer); resolve(false); }
    }, intervalMs);
    timer.unref?.();
  });
}

/**
 * Ask for Accessibility if we don't have it, guide the user to the right pane,
 * then run onGranted() once it lands. Safe to call repeatedly - it returns
 * immediately when already trusted, and won't stack multiple dialogs.
 *
 * @param {{reason?: string, onGranted?: () => void}} opts
 * @returns {Promise<boolean>} whether the app is trusted now
 */
let pending = null;
async function ensureAccessibility({ reason = '', onGranted } = {}) {
  if (!isMac()) return true;
  if (isTrusted(false)) return true;
  if (pending) return pending;

  pending = (async () => {
    // This call is the one that registers us with the system / shows Apple's
    // prompt. Do it before our own dialog so the toggle exists when they look.
    isTrusted(true);

    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: 'WisperTalk needs Accessibility access',
      message: 'Turn on Accessibility for WisperTalk',
      detail:
        (reason ? reason + '\n\n' : '') +
        'macOS blocks global hotkeys and pasting until WisperTalk is allowed as an assistive device.\n\n' +
        '1. Click "Open System Settings" below.\n' +
        '2. Find WisperTalk in the list and switch it ON.\n' +
        '3. Come back here - the hotkey starts working straight away, no restart needed.\n\n' +
        'If WisperTalk is already listed and switched on, switch it OFF and ON again. macOS keeps the old ' +
        'permission against the previous version of the app after an update, which looks enabled but is not.',
      buttons: ['Open System Settings', 'Later'],
      defaultId: 0,
      cancelId: 1,
    }).catch(() => ({ response: 1 }));

    if (response === 0) await openSettings();

    const granted = await waitForTrust();
    if (granted) {
      console.log('[a11y] Accessibility granted - re-arming hotkey');
      try { onGranted?.(); } catch (err) { console.warn('[a11y] onGranted failed:', err.message); }
    }
    return granted;
  })().finally(() => { pending = null; });

  return pending;
}

module.exports = { isTrusted, ensureAccessibility, openSettings, waitForTrust };
