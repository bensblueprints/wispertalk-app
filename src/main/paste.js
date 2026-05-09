const { clipboard } = require('electron');
const { spawn } = require('node:child_process');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Windows: PowerShell SendKeys for Ctrl+V
function sendCtrlV_win() {
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle', 'Hidden',
      '-Command',
      "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"
    ], { windowsHide: true });
    ps.on('exit', () => resolve());
    ps.on('error', () => resolve());
  });
}

// macOS: AppleScript via osascript for Cmd+V
function sendCmdV_mac() {
  return new Promise((resolve) => {
    const args = [
      '-e',
      'tell application "System Events" to keystroke "v" using command down'
    ];
    const proc = spawn('osascript', args);
    let errored = false;
    proc.on('error', () => { errored = true; resolve({ ok: false }); });
    proc.on('exit', (code) => {
      if (errored) return;
      resolve({ ok: code === 0, code });
    });
  });
}

async function pasteText(text, { delayMs = 60, restoreClipboard = true } = {}) {
  if (!text) return;
  let prev = null;
  if (restoreClipboard) {
    try { prev = clipboard.readText(); } catch { prev = null; }
  }
  clipboard.writeText(text);
  await sleep(delayMs);

  if (process.platform === 'win32') {
    await sendCtrlV_win();
  } else if (process.platform === 'darwin') {
    const r = await sendCmdV_mac();
    if (!r.ok) {
      // Fallback: text is already on clipboard. The user can paste manually.
      // (Most likely cause: Accessibility permission not granted to WisperTalk.)
      console.warn('osascript paste failed (likely missing Accessibility permission). Text left on clipboard.');
    }
  } else {
    // Linux / others: leave on clipboard. Implementing xdotool/wtype is out of scope.
    console.warn('Auto-paste not supported on this platform; text left on clipboard.');
  }

  if (restoreClipboard && prev !== null) {
    await sleep(150);
    try { clipboard.writeText(prev); } catch {}
  }
}

module.exports = { pasteText };
