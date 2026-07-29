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

/**
 * macOS "App Translocation": an app launched from a DMG, or from Downloads while
 * still quarantined, is run from a randomised read-only path. Accessibility can
 * NEVER be granted to a translocated app - the toggle can be switched on and the
 * app stays denied forever, which is indistinguishable from a broken app.
 * The only fix is to move it to /Applications and clear the quarantine flag.
 */
function isTranslocated() {
  if (!isMac()) return false;
  const p = process.execPath || '';
  return p.includes('/AppTranslocation/') || p.startsWith('/private/var/folders/');
}

/** True when running from a disk image mount rather than an installed copy. */
function isRunningFromDmg() {
  if (!isMac()) return false;
  return (process.execPath || '').startsWith('/Volumes/');
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
    // Translocation / running from the DMG must be handled FIRST: in that state
    // granting Accessibility is impossible, so sending the user to the toggle
    // just makes them enable something that silently keeps failing.
    if (isTranslocated() || isRunningFromDmg()) {
      const fromDmg = isRunningFromDmg();
      await dialog.showMessageBox({
        type: 'warning',
        title: 'Move WisperTalk to Applications',
        message: 'WisperTalk must be installed before the hotkey can work',
        detail:
          (fromDmg
            ? 'WisperTalk is running from the disk image rather than from your Applications folder.'
            : 'macOS is running WisperTalk from a temporary, randomised location (App Translocation).') +
          '\n\nIn this state macOS will not let WisperTalk have Accessibility access, no matter how many ' +
          'times the toggle is switched on - which is why enabling it appears to do nothing.\n\n' +
          '1. Quit WisperTalk.\n' +
          '2. Drag WisperTalk into your Applications folder.\n' +
          '3. Eject the WisperTalk disk image.\n' +
          '4. Open WisperTalk from Applications and allow Accessibility when asked.',
        buttons: ['OK'],
      }).catch(() => {});
      return false;
    }

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
        'Already listed and switched ON but still not working? Select WisperTalk in that list, press the ' +
        'minus (-) button to REMOVE it, then add it again. macOS ties the permission to the app\'s code ' +
        'signature, so after an update the old entry looks enabled while actually being denied - and ' +
        'toggling it off and on is often not enough to clear that. Removing and re-adding is.',
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

module.exports = {
  isTrusted, ensureAccessibility, openSettings, waitForTrust,
  isTranslocated, isRunningFromDmg,
};
