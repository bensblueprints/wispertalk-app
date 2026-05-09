const { spawn } = require('node:child_process');

function getForegroundContext(timeoutMs = 600) {
  if (process.platform === 'darwin') return getForegroundContextMac(timeoutMs);
  if (process.platform === 'win32') return getForegroundContextWin(timeoutMs);
  return Promise.resolve('');
}

function getForegroundContextWin(timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      resolve(val);
    };

    const script = `
$sig = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Win {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
Add-Type $sig -ErrorAction SilentlyContinue
$h = [Win]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[void][Win]::GetWindowText($h, $sb, 512)
$pid = 0
[void][Win]::GetWindowThreadProcessId($h, [ref]$pid)
$proc = ''
try { $proc = (Get-Process -Id $pid -ErrorAction SilentlyContinue).ProcessName } catch {}
"$proc | $($sb.ToString())"
`;

    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script
    ], { windowsHide: true });

    let out = '';
    ps.stdout.on('data', (d) => { out += d.toString(); });
    ps.on('exit', () => finish(out.trim()));
    ps.on('error', () => finish(''));
    setTimeout(() => { try { ps.kill(); } catch {} finish(out.trim()); }, timeoutMs);
  });
}

function getForegroundContextMac(timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      resolve(val);
    };

    // Returns "<AppName> | <Window Title>"
    const script = `
tell application "System Events"
  set frontApp to name of first application process whose frontmost is true
  set winTitle to ""
  try
    tell process frontApp
      set winTitle to name of front window
    end tell
  end try
end tell
return frontApp & " | " & winTitle
`;

    const proc = spawn('osascript', ['-e', script]);
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('exit', () => finish(out.trim()));
    proc.on('error', () => finish(''));
    setTimeout(() => { try { proc.kill(); } catch {} finish(out.trim()); }, timeoutMs);
  });
}

module.exports = { getForegroundContext };
