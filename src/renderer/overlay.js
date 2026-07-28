const card = document.getElementById('card');
const label = document.getElementById('label');
const bars = document.querySelectorAll('.bars span');

// ---------------------------------------------------------------------------
// Recorder state machine.
//
// The old code tracked nothing but `mediaRecorder`, so a quick tap (press +
// release before getUserMedia resolved) hit `stopRecording()` while
// mediaRecorder was still null, fell into the `else` branch, cleaned up, and
// sent NOTHING back to main — which sat in `busy = true` forever and the app
// was dead until force-quit. Every path below now replies exactly once.
// ---------------------------------------------------------------------------
const IDLE = 'idle';
const STARTING = 'starting';
const RECORDING = 'recording';
const STOPPING = 'stopping';

let recState = IDLE;
let sessionId = 0;
let replied = true;          // no outstanding stop request at boot
let stopRequested = false;
let wantPcm = false;
let stopSafetyTimer = null;

let mediaStream = null;
let mediaRecorder = null;
let chunks = [];
let audioCtx = null;
let analyser = null;
let rafId = null;
let mimeType = 'audio/webm';
let recordingStartedAt = 0;
let timerInterval = null;

// If MediaRecorder.onstop never fires (it can hang when the track died under
// it), give up and reply anyway.
const STOP_SAFETY_MS = 3000;

function pickMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const c of candidates) {
    if (window.MediaRecorder?.isTypeSupported?.(c)) return c;
  }
  return 'audio/webm';
}

function setMode(mode) {
  card.classList.remove('processing');
  card.classList.remove('hidden');
  if (mode === 'processing') {
    card.classList.add('processing');
    label.textContent = 'Cleaning up';
    stopMeter();
  } else {
    label.textContent = '0.0s';
    startMeter();
  }
}

function hide() {
  card.classList.add('hidden');
}

function startMeter() {
  recordingStartedAt = Date.now();
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const elapsed = (Date.now() - recordingStartedAt) / 1000;
    label.textContent = `${elapsed.toFixed(1)}s`;
  }, 100);
  if (analyser) loop();
}

function stopMeter() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
}

function loop() {
  rafId = requestAnimationFrame(loop);
  if (!analyser) return;
  const bufferLen = analyser.frequencyBinCount;
  const data = new Uint8Array(bufferLen);
  analyser.getByteFrequencyData(data);
  const step = Math.floor(bufferLen / bars.length);
  for (let i = 0; i < bars.length; i++) {
    let sum = 0;
    for (let j = 0; j < step; j++) sum += data[i * step + j];
    const avg = sum / step;
    const normalized = Math.min(1, avg / 200);
    const h = Math.max(4, Math.round(normalized * 28));
    bars[i].style.height = `${h}px`;
  }
}

// --- single-reply helpers ---------------------------------------------------

function clearStopSafety() {
  if (stopSafetyTimer) { clearTimeout(stopSafetyTimer); stopSafetyTimer = null; }
}

function replyEmpty(reason) {
  if (replied) return;
  replied = true;
  clearStopSafety();
  window.flow.sendEmpty(reason || '');
}

/**
 * Reply even if this renderer thinks it already answered. Only used when main
 * asked us to stop while nothing was running (e.g. this window reloaded
 * mid-session) — main is sitting in `busy` and nothing else will ever answer.
 */
function forceEmpty(reason) {
  replied = true;
  clearStopSafety();
  window.flow.sendEmpty(reason || '');
}

function replyAudio(arrayBuf, type, pcm) {
  if (replied) return;
  replied = true;
  clearStopSafety();
  window.flow.sendAudio(arrayBuf, type, pcm);
}

function replyError(message) {
  if (replied) { window.flow.reportError(message); return; }
  replied = true;
  clearStopSafety();
  window.flow.reportError(message);
}

// --- recording --------------------------------------------------------------

async function startRecording(opts = {}) {
  if (recState !== IDLE) return; // guard double-start
  const mySession = ++sessionId;
  recState = STARTING;
  stopRequested = false;
  replied = false;
  wantPcm = !!(opts && opts.wantPcm);

  try {
    chunks = [];
    const constraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      }
    };
    if (opts && opts.inputDeviceId) {
      constraints.audio.deviceId = { exact: opts.inputDeviceId };
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      if (err && err.name === 'OverconstrainedError' && constraints.audio.deviceId) {
        delete constraints.audio.deviceId;
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } else {
        throw err;
      }
    }

    // The user may have already let go while the mic was opening (a quick tap),
    // or a newer session may have started. Either way, this one is over.
    if (mySession !== sessionId || stopRequested) {
      stream.getTracks().forEach((t) => t.stop());
      recState = IDLE;
      cleanupStream();
      replyEmpty('released before the mic opened');
      return;
    }

    mediaStream = stream;
    mimeType = pickMimeType();
    mediaRecorder = new MediaRecorder(mediaStream, { mimeType, audioBitsPerSecond: 96000 });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    mediaRecorder.onstop = () => onStopped(mySession);
    mediaRecorder.onerror = (e) => {
      recState = IDLE;
      cleanupStream();
      replyError(`MediaRecorder error: ${e?.error?.message || e?.error?.name || 'unknown'}`);
    };
    mediaRecorder.start(250);
    recState = RECORDING;

    audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    const src = audioCtx.createMediaStreamSource(mediaStream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);

    if (!rafId) loop();
  } catch (err) {
    console.error('startRecording failed:', err);
    recState = IDLE;
    cleanupStream();
    replyError(err.message || String(err));
  }
}

async function stopRecording() {
  try {
    if (recState === STARTING) {
      // getUserMedia is still in flight; the resolver above will reply.
      stopRequested = true;
      clearStopSafety();
      stopSafetyTimer = setTimeout(() => replyEmpty('microphone never opened'), STOP_SAFETY_MS);
      return;
    }

    if (recState === RECORDING && mediaRecorder && mediaRecorder.state !== 'inactive') {
      recState = STOPPING;
      clearStopSafety();
      // Belt and braces: if onstop never lands, reply anyway.
      stopSafetyTimer = setTimeout(() => {
        console.warn('MediaRecorder.onstop never fired — replying empty.');
        cleanupStream();
        recState = IDLE;
        replyEmpty('recorder did not stop cleanly');
      }, STOP_SAFETY_MS);
      mediaRecorder.stop();
      return;
    }

    // Nothing was actually recording (already stopped, crashed, never started).
    cleanupStream();
    recState = IDLE;
    forceEmpty('nothing was recording');
  } catch (err) {
    console.error('stopRecording failed:', err);
    cleanupStream();
    recState = IDLE;
    replyError(err.message || String(err));
  }
}

async function onStopped(mySession) {
  const localChunks = chunks;
  chunks = [];
  try {
    if (mySession !== sessionId) { cleanupStream(); return; }
    recState = IDLE;
    const blob = new Blob(localChunks, { type: mimeType });
    if (!blob.size) {
      cleanupStream();
      replyEmpty('nothing was captured');
      return;
    }
    const arrayBuf = await blob.arrayBuffer();

    let pcm = null;
    if (wantPcm) {
      try {
        pcm = await decodeTo16kMono(arrayBuf);
      } catch (err) {
        console.error('PCM decode failed:', err);
        replyError(`Could not decode audio for offline transcription: ${err.message || err}`);
        cleanupStream();
        return;
      }
    }

    replyAudio(arrayBuf, mimeType, pcm ? pcm.buffer : null);
  } catch (err) {
    replyError(err.message || String(err));
  } finally {
    cleanupStream();
  }
}

/**
 * Decode the recorded webm/opus blob into 16 kHz mono float32 PCM — the format
 * Whisper wants. Doing it here with the Web Audio API is why the offline engine
 * doesn't need a bundled ffmpeg.
 */
async function decodeTo16kMono(arrayBuf) {
  const ctx = new AudioContext();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(arrayBuf.slice(0));
  } finally {
    ctx.close().catch(() => {});
  }
  const frames = Math.max(1, Math.ceil(decoded.duration * 16000));
  const offline = new OfflineAudioContext(1, frames, 16000);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

function cleanupStream() {
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  analyser = null;
  mediaRecorder = null;
  stopMeter();
}

/** Main gave up on us (watchdog fired). Drop everything, stay quiet. */
function abort() {
  sessionId++;
  replied = true;
  stopRequested = false;
  clearStopSafety();
  cleanupStream();
  recState = IDLE;
  chunks = [];
  hide();
}

window.flow.onStart((payload) => startRecording(payload));
window.flow.onStop(() => stopRecording());
window.flow.onShow((p) => setMode(p?.mode || 'recording'));
window.flow.onHide(() => hide());
window.flow.onAbort?.(() => abort());
