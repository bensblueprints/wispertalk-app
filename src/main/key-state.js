/*
 * key-state.js — persistent physical-key-state helper (Windows only).
 *
 * One PowerShell process with GetAsyncKeyState Add-Type'd, answering UP/DOWN
 * for each virtual-key code written as a line on stdin. Spawning powershell.exe
 * per query is far too heavy at a 250ms poll interval, so the helper is spawned
 * lazily on the first query and reused; if it dies or wedges it is killed and
 * respawned on the next query. Same spawn idiom as paste.js, no new deps.
 *
 * Failures are reported to the caller, never hidden — it is the caller's job to
 * fail toward NOT cutting dictation.
 */
const { spawn } = require('node:child_process');

// Answers are instant once the helper is up, but the FIRST query pays for
// powershell startup + Add-Type compilation (seconds on a cold machine). A
// wedged helper past this budget is killed; the next query respawns it.
const QUERY_TIMEOUT_MS = 5000;

const HELPER_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class WisperKeys { [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key); }'
while (($line = [Console]::In.ReadLine()) -ne $null) {
  try {
    if (([WisperKeys]::GetAsyncKeyState([int]$line) -band 0x8000) -ne 0) { [Console]::Out.WriteLine('DOWN') } else { [Console]::Out.WriteLine('UP') }
  } catch { [Console]::Out.WriteLine('ERR') }
}
`;

let child = null;
let stdoutBuf = '';
const pending = []; // FIFO — one entry per outstanding query line

function settle(entry, err, down) {
  const i = pending.indexOf(entry);
  if (i === -1) return;
  pending.splice(i, 1);
  clearTimeout(entry.timer);
  if (err) entry.reject(err);
  else entry.resolve(down);
}

function killHelper() {
  const c = child;
  child = null;
  if (c) {
    try { c.stdin.destroy(); } catch {}
    try { c.kill(); } catch {}
  }
}

function onHelperDead(reason) {
  killHelper();
  const err = new Error(`key-state helper died (${reason})`);
  while (pending.length) settle(pending[0], err);
  // Lazily respawned by the next query().
}

function ensureHelper() {
  if (child) return;
  stdoutBuf = '';
  child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', HELPER_SCRIPT], { windowsHide: true });
  child.stderr?.resume(); // drain so a noisy helper cannot stall on a full buffer
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    let nl;
    while ((nl = stdoutBuf.search(/\r?\n/)) !== -1) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl).replace(/^\r?\n/, '');
      if (!line || !pending.length) continue;
      const entry = pending[0];
      if (line === 'DOWN') settle(entry, null, true);
      else if (line === 'UP') settle(entry, null, false);
      else settle(entry, new Error(`key-state helper answered "${line}"`));
    }
  });
  child.on('error', (err) => onHelperDead(err.message));
  child.on('close', (code) => onHelperDead(`exit ${code}`));
}

/** Resolve true while virtual-key `vk` is physically held down. */
function query(vk) {
  if (process.platform !== 'win32') return Promise.reject(new Error('key-state helper is Windows-only'));
  try { ensureHelper(); } catch (err) { return Promise.reject(err); }
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject, timer: null };
    entry.timer = setTimeout(() => {
      killHelper(); // wedged — next query respawns
      settle(entry, new Error('key-state query timed out'));
    }, QUERY_TIMEOUT_MS);
    if (entry.timer.unref) entry.timer.unref();
    pending.push(entry);
    try {
      child.stdin.write(`${vk}\n`);
    } catch (err) {
      settle(entry, err);
    }
  });
}

/** App shutdown: kill the helper and fail anything outstanding. */
function shutdown() {
  onHelperDead('shutdown');
}

module.exports = { query, shutdown, QUERY_TIMEOUT_MS };
