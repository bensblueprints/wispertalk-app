const card = document.getElementById('card');
const label = document.getElementById('label');
const bars = document.querySelectorAll('.bars span');

let mediaStream = null;
let mediaRecorder = null;
let chunks = [];
let audioCtx = null;
let analyser = null;
let rafId = null;
let mimeType = 'audio/webm';
let recordingStartedAt = 0;
let timerInterval = null;

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

async function startRecording(opts = {}) {
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
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      if (err && err.name === 'OverconstrainedError' && constraints.audio.deviceId) {
        delete constraints.audio.deviceId;
        mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      } else {
        throw err;
      }
    }
    mimeType = pickMimeType();
    mediaRecorder = new MediaRecorder(mediaStream, { mimeType, audioBitsPerSecond: 96000 });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    mediaRecorder.onstop = onStopped;
    mediaRecorder.start(250);

    audioCtx = new AudioContext();
    const src = audioCtx.createMediaStreamSource(mediaStream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
  } catch (err) {
    console.error('startRecording failed:', err);
    window.flow.reportError(err.message || String(err));
    cleanupStream();
  }
}

async function stopRecording() {
  try {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    } else {
      cleanupStream();
    }
  } catch (err) {
    console.error('stopRecording failed:', err);
    window.flow.reportError(err.message || String(err));
    cleanupStream();
  }
}

async function onStopped() {
  try {
    const blob = new Blob(chunks, { type: mimeType });
    chunks = [];
    const arrayBuf = await blob.arrayBuffer();
    window.flow.sendAudio(arrayBuf, mimeType);
  } catch (err) {
    window.flow.reportError(err.message || String(err));
  } finally {
    cleanupStream();
  }
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

window.flow.onStart((payload) => startRecording(payload));
window.flow.onStop(() => stopRecording());
window.flow.onShow((p) => setMode(p?.mode || 'recording'));
window.flow.onHide(() => hide());
