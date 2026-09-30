const card = document.getElementById('card');
const label = document.getElementById('label');
const bars = document.querySelectorAll('.bars span');

// Each callback owns a session: late microphone/decode callbacks cannot touch
// a newer recording or reply on behalf of a newer hotkey press.
let active = null;
const MIC_TIMEOUT_MS = 10000;
const STOP_TIMEOUT_MS = 10000;
function hide() { card.classList.add('hidden'); }
function setMode(mode) {
  card.classList.remove('hidden');
  card.classList.toggle('processing', mode === 'processing');
  label.textContent = mode === 'processing' ? 'Transcribing' : 'Opening microphone';
}
function dispose(session) {
  clearTimeout(session.timer);
  clearInterval(session.meter);
  if (session.recorder) {
    session.recorder.ondataavailable = null;
    session.recorder.onstop = null;
    session.recorder.onerror = null;
    if (session.recorder.state !== 'inactive') {
      try { session.recorder.stop(); } catch {}
    }
  }
  session.stream?.getTracks().forEach(track => track.stop());
  session.context?.close().catch(() => {});
}
function finish(session, kind, payload) {
  if (active !== session || session.done) return;
  session.done = true;
  dispose(session);
  active = null;
  if (kind === 'audio') window.flow.sendAudio({ sessionId: session.id, ...payload });
  if (kind === 'empty') window.flow.sendEmpty({ sessionId: session.id, reason: payload });
  if (kind === 'error') window.flow.reportError({ sessionId: session.id, message: payload });
}
function pickMimeType() {
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
    .find(type => MediaRecorder.isTypeSupported(type));
}
async function openMicrophone(opts, session) {
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
  if (opts.inputDeviceId && opts.inputDeviceId !== 'default') audio.deviceId = { exact: opts.inputDeviceId };
  try {
    return await navigator.mediaDevices.getUserMedia({ audio });
  } catch (err) {
    if (active === session && audio.deviceId && ['OverconstrainedError', 'NotFoundError'].includes(err.name)) {
      delete audio.deviceId;
      const stream = await navigator.mediaDevices.getUserMedia({ audio });
      if (active === session) window.flow.warning({ sessionId: session.id, message: 'Selected microphone is unavailable. Using the system default; choose a microphone in Settings.' });
      return stream;
    }
    throw err;
  }
}
function microphoneError(err) {
  if (err.name === 'NotAllowedError') return 'Microphone access was denied. Allow microphone access for WisperTalk in your system privacy settings.';
  if (err.name === 'NotFoundError') return 'No microphone is available. Connect a microphone and try again.';
  if (err.name === 'NotReadableError') return 'The microphone could not be opened. Check its connection and whether another app is using it exclusively.';
  return err.message || String(err);
}
async function startRecording(opts = {}) {
  if (active) abort();
  const session = { id: opts.sessionId, state: 'starting', chunks: [], done: false, wantPcm: !!opts.wantPcm };
  active = session;
  session.timer = setTimeout(() => finish(session, 'error', 'The microphone did not open within 10 seconds. Check microphone access and try again.'), MIC_TIMEOUT_MS);
  try {
    const stream = await openMicrophone(opts, session);
    if (active !== session) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    clearTimeout(session.timer);
    session.stream = stream;
    const tracks = stream.getAudioTracks();
    if (!tracks.length || tracks.every(track => track.readyState === 'ended')) throw new Error('The microphone disconnected. Reconnect it and try again.');
    tracks.forEach(track => track.addEventListener('ended', () => {
      if (active === session && session.state === 'recording') finish(session, 'error', 'The microphone disconnected during recording. Reconnect it and try again.');
    }));
    const mimeType = pickMimeType();
    session.recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 96000 } : {});
    session.mimeType = session.recorder.mimeType || mimeType || 'audio/webm';
    session.recorder.ondataavailable = event => {
      if (active === session && event.data?.size) session.chunks.push(event.data);
    };
    session.recorder.onerror = event => finish(session, 'error', event.error?.message || 'Audio recording failed. Try again.');
    session.recorder.onstop = () => onStopped(session);
    session.recorder.start(250);
    session.state = 'recording';
    window.flow.ready({ sessionId: session.id });
    const startedAt = Date.now();
    // Meter failure must not discard an otherwise valid recording.
    try {
      session.context = new AudioContext();
      await session.context.resume();
      if (active !== session || session.state !== 'recording') return;
      const source = session.context.createMediaStreamSource(stream);
      const analyser = session.context.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      session.meter = setInterval(() => {
        label.textContent = `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
        analyser.getByteFrequencyData(data);
        bars.forEach((bar, i) => { bar.style.height = `${Math.max(4, Math.round(data[i * 4] / 255 * 28))}px`; });
      }, 100);
    } catch (err) { console.warn('Audio meter unavailable:', err.message); }
  } catch (err) { finish(session, 'error', microphoneError(err)); }
}
function stopRecording(payload = {}) {
  const session = active;
  if (!session || payload.sessionId !== session.id) return;
  if (session.state === 'starting') {
    finish(session, 'empty', 'Released before the microphone opened. Wait for the recording timer before speaking.');
    return;
  }
  if (session.state !== 'recording') return;
  session.state = 'stopping';
  clearInterval(session.meter);
  session.timer = setTimeout(() => finish(session, 'error', 'Audio processing timed out. Ready to try again.'), STOP_TIMEOUT_MS);
  try { session.recorder.stop(); }
  catch (err) { finish(session, 'error', err.message); }
}
async function onStopped(session) {
  if (active !== session) return;
  session.state = 'decoding';
  clearInterval(session.meter);
  session.stream?.getTracks().forEach(track => track.stop());
  try {
    const blob = new Blob(session.chunks, { type: session.mimeType });
    session.chunks = [];
    if (!blob.size) return finish(session, 'empty', 'No audio was captured.');
    const audioBuffer = await blob.arrayBuffer();
    const pcm = session.wantPcm ? await decodeTo16kMono(audioBuffer) : null;
    finish(session, 'audio', { audioBuffer, mimeType: session.mimeType, pcm: pcm?.buffer || null });
  } catch (err) { finish(session, 'error', `Could not decode recorded audio: ${err.message || err}`); }
}
async function decodeTo16kMono(arrayBuffer) {
  const decoder = new OfflineAudioContext(1, 1, 16000);
  const decoded = await decoder.decodeAudioData(arrayBuffer.slice(0));
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * 16000)), 16000);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  return (await offline.startRendering()).getChannelData(0);
}
function abort() {
  const session = active;
  active = null;
  if (session) { session.done = true; dispose(session); }
  hide();
}
window.flow.onStart(startRecording);
window.flow.onStop(stopRecording);
window.flow.onShow(payload => setMode(payload?.mode || 'recording'));
window.flow.onHide(hide);
window.flow.onAbort(abort);
