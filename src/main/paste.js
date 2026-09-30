const { clipboard } = require('electron');
const { spawn } = require('node:child_process');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function runPaste(command, args, { signal } = {}) {
  return new Promise(resolve => {
    let child;
    let timer;
    let done = false;
    const finish = result => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      resolve(result);
    };
    const cancel = () => {
      child?.kill();
      finish({ ok: false, cancelled: true });
    };
    if (signal?.aborted) return finish({ ok: false, cancelled: true });
    try {
      child = spawn(command, args, { windowsHide: true });
      // Drain pipes so a helper cannot stall on a full output buffer.
      child.stdout?.resume();
      child.stderr?.resume();
      child.on('error', err => finish({ ok: false, error: err.message }));
      child.on('close', code => finish({ ok: code === 0, code }));
      signal?.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => {
        child.kill();
        finish({ ok: false, error: 'Paste helper timed out' });
      }, 8000);
    } catch (err) { finish({ ok: false, error: err.message }); }
  });
}

// Wait for physical modifiers to be released: sending Ctrl+V while the user
// still holds Alt/Shift/Win can invoke another shortcut instead of pasting.
const WINDOWS_PASTE = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class WisperKeys { [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key); }'
Add-Type -AssemblyName System.Windows.Forms
$deadline = [DateTime]::UtcNow.AddSeconds(3)
do {
  $held = $false
  foreach ($keyCode in @(16,17,18,91,92)) {
    if (([WisperKeys]::GetAsyncKeyState($keyCode) -band 0x8000) -ne 0) { $held = $true }
  }
  if (-not $held) { break }
  Start-Sleep -Milliseconds 25
} while ([DateTime]::UtcNow -lt $deadline)
if ($held) { exit 2 }
[System.Windows.Forms.SendKeys]::SendWait('^v')
`;

async function pasteText(text, { delayMs = 60, restoreClipboard = false, isCurrent = () => true, signal } = {}) {
  if (!text || !isCurrent() || signal?.aborted) return { ok: false, cancelled: true };
  const previous = restoreClipboard ? clipboard.readText() : null;
  clipboard.writeText(text);
  await sleep(Math.min(2000, Math.max(60, Number(delayMs) || 60)));
  if (!isCurrent() || signal?.aborted) return { ok: false, cancelled: true };
  // Don't paste unrelated data if the user copied something during the delay.
  if (clipboard.readText() !== text) return { ok: false, clipboardChanged: true };
  let result;
  if (process.platform === 'win32') {
    result = await runPaste('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', WINDOWS_PASTE], { signal });
  } else if (process.platform === 'darwin') {
    result = await runPaste('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down'], { signal });
  } else {
    result = { ok: false, error: 'Automatic paste is not supported on this platform' };
  }
  // The default leaves the transcript available for manual paste. Optional
  // restoration is never allowed after a helper failure or a new user copy.
  if (restoreClipboard && result.ok) {
    await sleep(1000);
    if (isCurrent() && !signal?.aborted && clipboard.readText() === text) clipboard.writeText(previous);
  }
  return result;
}
module.exports = { pasteText };
