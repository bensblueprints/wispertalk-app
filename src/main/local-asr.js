// ---------------------------------------------------------------------------
// Local (fully offline) speech-to-text.
//
// Runs Whisper via @huggingface/transformers on onnxruntime-node. NOTHING is
// downloaded at runtime: the ONNX weights ship inside the installer under
// models/ and are read out of app.asar.unpacked. `env.allowRemoteModels` is
// hard-off so a missing file fails loudly instead of silently hitting the
// network (the failure mode bg-remover hit with @imgly's publicPath).
//
// Audio arrives already decoded as 16 kHz mono float32 PCM — the overlay
// renderer does that with the Web Audio API, which is why WisperTalk does not
// need to ship ffmpeg the way BloomRecorder does.
// ---------------------------------------------------------------------------
const fs = require('node:fs');
const path = require('node:path');

const MODEL_ID = 'Xenova/whisper-base.en';
const SAMPLE_RATE = 16000;

let pipelinePromise = null;
let resolvedRoot = null;

/** Absolute path of the bundled models/ directory, or null if not present. */
function modelsRoot() {
  if (resolvedRoot !== null) return resolvedRoot;
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'models'));
    candidates.push(path.join(process.resourcesPath, 'models'));
  }
  candidates.push(path.join(__dirname, '..', '..', 'models'));
  resolvedRoot = candidates.find((dir) => {
    try {
      return fs.existsSync(path.join(dir, MODEL_ID, 'onnx', 'encoder_model_quantized.onnx'));
    } catch {
      return false;
    }
  }) || null;
  return resolvedRoot;
}

/** True when the offline engine can actually run on this install. */
function isAvailable() {
  return !!modelsRoot();
}

function modelPathHint() {
  const root = modelsRoot();
  return root ? path.join(root, MODEL_ID) : '(not bundled)';
}

async function getPipeline(onProgress) {
  if (!pipelinePromise) {
    const root = modelsRoot();
    if (!root) {
      throw new Error('Offline model files are missing from this install. Switch Transcription engine back to "Groq (cloud)" in Settings.');
    }
    pipelinePromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.localModelPath = root;
      env.allowLocalModels = true;
      env.allowRemoteModels = false; // never phone home
      if (env.backends?.onnx?.wasm) env.backends.onnx.wasm.numThreads = 1;
      return pipeline('automatic-speech-recognition', MODEL_ID, {
        dtype: 'q8',
        local_files_only: true,
        progress_callback: onProgress
      });
    })().catch((err) => {
      pipelinePromise = null; // let the next attempt retry rather than wedge
      throw err;
    });
  }
  return pipelinePromise;
}

/**
 * Transcribe 16 kHz mono float32 PCM.
 * @param {{pcm: Float32Array, language?: string, onProgress?: Function}} opts
 * @returns {Promise<string>}
 */
async function transcribeLocal({ pcm, onProgress } = {}) {
  if (!pcm || !pcm.length) return '';
  // Under ~0.25s of audio Whisper reliably hallucinates ("Thank you.", "you").
  if (pcm.length < SAMPLE_RATE * 0.25) return '';

  const transcriber = await getPipeline(onProgress);
  const result = await transcriber(pcm, {
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: false
  });
  const text = (Array.isArray(result) ? result[0]?.text : result?.text) || '';
  return text.trim();
}

/** Load the model now so the first dictation isn't slowed by a cold start. */
function warmUp() {
  if (!isAvailable()) return Promise.resolve(false);
  return getPipeline().then(() => true).catch((err) => {
    console.warn('[local-asr] warm-up failed:', err.message);
    return false;
  });
}

function dispose() {
  pipelinePromise = null;
}

module.exports = { transcribeLocal, isAvailable, warmUp, dispose, modelPathHint, MODEL_ID, SAMPLE_RATE };
