const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function load(file, extras = {}) {
  const context = vm.createContext({ console, setTimeout, clearTimeout, setInterval, clearInterval,
    Buffer, Float32Array, Uint8Array, ArrayBuffer, AbortController, Blob, process, module: { exports: {} },
    __dirname: path.resolve('src/main'), ...extras });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return context;
}
function stream() {
  const track = { readyState: 'live', stopped: false, addEventListener(name, cb) { this[name] = cb; }, stop() { this.stopped = true; } };
  return { track, getTracks: () => [track], getAudioTracks: () => [track] };
}
function recorderHarness(getUserMedia) {
  const callbacks = {}, replies = [], timers = new Map(); let timerId = 0;
  const flow = {};
  for (const name of ['Start', 'Stop', 'Show', 'Hide', 'Abort']) flow[`on${name}`] = fn => { callbacks[name] = fn; };
  for (const name of ['sendAudio', 'sendEmpty', 'reportError', 'ready', 'warning']) flow[name] = payload => replies.push({ name, payload });
  class Recorder {
    static isTypeSupported() { return true; }
    constructor() { this.mimeType = 'audio/webm'; this.state = 'inactive'; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['audio']) }); this.onstop?.(); }
  }
  const context = load('src/renderer/overlay.js', {
    window: { flow }, navigator: { mediaDevices: { getUserMedia } }, MediaRecorder: Recorder,
    document: { getElementById: () => ({ classList: { add() {}, remove() {}, toggle() {} } }), querySelectorAll: () => [] },
    AudioContext: class { async resume() {} async close() {} createMediaStreamSource() { return { connect() {} }; } createAnalyser() { return { frequencyBinCount: 128 }; } },
    setTimeout: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; }, clearTimeout: id => timers.delete(id),
    setInterval: () => 0, clearInterval() {}
  });
  return { callbacks, replies, timers, context };
}

test('late microphone success cannot close or answer for the next session', async () => {
  const oldRequest = deferred(), newStream = stream(), oldStream = stream(); let count = 0;
  const h = recorderHarness(() => ++count === 1 ? oldRequest.promise : Promise.resolve(newStream));
  const oldStart = h.callbacks.Start({ sessionId: 1 });
  h.callbacks.Stop({ sessionId: 1 });
  await h.callbacks.Start({ sessionId: 2 });
  oldRequest.resolve(oldStream); await oldStart;
  assert.equal(oldStream.track.stopped, true);
  assert.equal(newStream.track.stopped, false);
  assert.equal(h.replies.filter(r => r.name === 'sendEmpty').length, 1);
  h.callbacks.Stop({ sessionId: 2 }); await tick();
  assert.equal(h.replies.find(r => r.name === 'sendAudio').payload.sessionId, 2);
});

test('late microphone failure after abort leaves the new recording intact', async () => {
  const oldRequest = deferred(), next = stream(); let count = 0;
  const h = recorderHarness(() => ++count === 1 ? oldRequest.promise : Promise.resolve(next));
  const first = h.callbacks.Start({ sessionId: 1 }); h.callbacks.Abort();
  await h.callbacks.Start({ sessionId: 2 }); oldRequest.reject(new Error('old failure')); await first;
  assert.equal(next.track.stopped, false);
  assert.equal(h.replies.some(r => r.name === 'reportError'), false);
  h.callbacks.Abort();
});

test('microphone timeout releases the session and closes a late stream', async () => {
  const request = deferred(), late = stream(); const h = recorderHarness(() => request.promise);
  const start = h.callbacks.Start({ sessionId: 3 });
  [...h.timers.values()].find(t => t.delay === 10000).fn();
  request.resolve(late); await start;
  assert.equal(late.track.stopped, true);
  assert.equal(h.replies.filter(r => r.name === 'reportError').length, 1);
  assert.equal(vm.runInContext('active', h.context), null);
});

test('disconnected saved device falls back; permission denial never retries', async () => {
  const calls = []; const h = recorderHarness(async constraints => {
    calls.push(JSON.parse(JSON.stringify(constraints)));
    if (calls.length === 1) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
    return stream();
  });
  await h.callbacks.Start({ sessionId: 1, inputDeviceId: 'old-usb-id' });
  assert.equal(calls.length, 2); assert.equal(calls[1].audio.deviceId, undefined);
  assert.equal(h.replies.some(r => r.name === 'warning'), true); h.callbacks.Abort();
  let requests = 0;
  const denied = recorderHarness(async () => { requests++; throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); });
  await denied.callbacks.Start({ sessionId: 2, inputDeviceId: 'device' });
  assert.equal(requests, 1); assert.match(denied.replies[0].payload.message, /access was denied/);
});

test('stale stop and decode callbacks cannot finish a new session', async () => {
  const decode = deferred(); const h = recorderHarness(async () => stream());
  h.context.pendingDecode = decode.promise;
  vm.runInContext('decodeTo16kMono = () => pendingDecode', h.context);
  await h.callbacks.Start({ sessionId: 1, wantPcm: true });
  h.callbacks.Stop({ sessionId: 1 }); await tick(); h.callbacks.Abort();
  await h.callbacks.Start({ sessionId: 2 }); h.callbacks.Stop({ sessionId: 1 });
  decode.resolve(new Float32Array(5000)); await tick();
  assert.equal(h.replies.filter(r => r.name === 'sendAudio').length, 0);
  assert.equal(vm.runInContext('active.id', h.context), 2); h.callbacks.Abort();
});

function pasteHarness(exitCode, error = false) {
  let clipboardText = 'previous'; const writes = []; let killed = false;
  const context = load('src/main/paste.js', {
    process: { platform: 'win32' },
    setTimeout: (fn, delay) => setTimeout(fn, delay >= 8000 ? 100 : 0),
    require: name => name === 'electron' ? { clipboard: { readText: () => clipboardText, writeText: text => { clipboardText = text; writes.push(text); } } } : {
      spawn: () => { const child = new EventEmitter(); child.kill = () => { killed = true; };
        if (exitCode !== null) setImmediate(() => error ? child.emit('error', new Error('spawn failure')) : child.emit('close', exitCode)); return child; }
    }
  });
  return { paste: context.module.exports.pasteText, writes, read: () => clipboardText, killed: () => killed };
}
test('failed paste and spawn failure retain the transcript even with restoration requested', async () => {
  for (const error of [false, true]) {
    const h = pasteHarness(1, error);
    assert.equal((await h.paste('transcript', { restoreClipboard: true })).ok, false);
    assert.equal(h.read(), 'transcript'); assert.deepEqual(h.writes, ['transcript']);
  }
});
test('successful paste leaves a manual fallback by default', async () => {
  const h = pasteHarness(0); assert.equal((await h.paste('transcript')).ok, true); assert.equal(h.read(), 'transcript');
});
test('hung paste helper is terminated and reports failure', async () => {
  const h = pasteHarness(null); assert.equal((await h.paste('transcript')).ok, false); assert.equal(h.killed(), true);
});

test('rearm restarts the hook and releases an active hold exactly once', () => {
  let starts = 0, stops = 0, releases = 0;
  const hook = new EventEmitter(); hook.start = () => starts++; hook.stop = () => stops++;
  const context = load('src/main/hotkey.js', { require: name => {
    if (name === 'electron') return { globalShortcut: { register: () => true, unregisterAll() {} }, powerMonitor: { getSystemIdleTime: () => 0 } };
    if (name === 'uiohook-napi') return { uIOhook: hook, UiohookKey: { AltRight: 56 } };
    if (name === './mac-accessibility') return { isTrusted: () => true };
    return { isAvailable: () => false, KEY_NAME: 'GlobeFn' };
  } });
  const manager = new context.module.exports.HotkeyManager({ onHoldRelease: () => releases++ });
  manager.apply({ holdEnabled: true, holdHotkey: 'AltRight' });
  hook.emit('keydown', { keycode: 56 }); manager.rearm('test');
  assert.equal(starts, 2); assert.equal(stops, 1); assert.equal(releases, 1); manager.shutdown();
});

function mainHarness(transcribeLocal) {
  const handlers = new Map(), events = new Map(), sent = [], pasted = [], history = [];
  const config = { sttEngine: 'local', showOverlay: false, useAppContext: false, autoPaste: true };
  const sender = { send: (channel, payload) => sent.push({ channel, payload }) };
  const context = load('src/main/main.js', { require: name => {
    if (name === 'electron') return { app: { requestSingleInstanceLock: () => true, on() {}, whenReady: () => ({ then() {} }) },
      ipcMain: { handle: (n, fn) => handlers.set(n, fn), on: (n, fn) => events.set(n, fn) } };
    if (name === 'node:path') return path;
    if (name === './store') return { getAll: () => ({ ...config }), get: n => config[n], pushHistory: row => history.push(row) };
    if (name === './local-asr') return { SAMPLE_RATE: 16000, isAvailable: () => true, transcribeLocal };
    if (name === './paste') return { pasteText: async text => { pasted.push(text); return { ok: true }; } };
    return {};
  } });
  context.sender = sender;
  vm.runInContext('overlayWin = { isDestroyed: () => false, webContents: sender, hide() {} }; overlayReady = true; registerIpc();', context);
  const run = code => vm.runInContext(code, context);
  const record = () => { run('startRecording(); stopRecording();'); return sent.filter(s => s.channel === 'recorder:start').at(-1).payload.sessionId; };
  const audio = id => events.get('recorder:audio')({ sender }, { sessionId: id, pcm: new Float32Array(5000) });
  return { run, record, audio, events, handlers, sender, history, pasted };
}
test('reset invalidates in-flight recognition without clearing or pasting over a newer session', async () => {
  const recognition = deferred(); const h = mainHarness(() => recognition.promise);
  const first = h.record(); const processing = h.audio(first);
  h.run('resetPipeline();'); const second = h.record();
  recognition.resolve('old transcript'); await processing;
  assert.equal(h.pasted.length, 0); assert.equal(h.history.length, 0);
  assert.equal(h.run('activeSession.id'), second); assert.equal(h.run('busy'), true);
  h.events.get('recorder:error')({ sender: h.sender }, { sessionId: first, message: 'stale' });
  assert.equal(h.run('activeSession.id'), second); h.run('resetPipeline();');
});
test('duplicate audio is processed once and normal recognition reaches paste', async () => {
  const recognition = deferred(); let calls = 0;
  const h = mainHarness(() => { calls++; return recognition.promise; });
  const id = h.record(); const first = h.audio(id); await h.audio(id);
  recognition.resolve('hello world'); await first;
  assert.equal(calls, 1); assert.deepEqual(h.pasted, ['hello world']); assert.equal(h.run('busy'), false);
});
