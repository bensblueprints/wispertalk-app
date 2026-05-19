const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const DEFAULTS = {
  groqApiKey: '',
  llmApiBaseUrl: 'https://api.groq.com/openai/v1',
  sttModel: 'whisper-large-v3',
  llmModel: 'llama-3.3-70b-versatile',
  transcriptionLanguage: '',
  inputDeviceId: '',
  enableLlmCleanup: true,
  cleanupPrompt: `You are a dictation post-processor. You receive raw speech-to-text output and return clean text ready to be typed into an application.

Your job:
- Remove filler words (um, uh, you know, like) unless they carry meaning.
- Fix spelling, grammar, and punctuation errors.
- When the transcript already contains a word that is a close misspelling of a name or term from the context or custom vocabulary, correct the spelling. Never insert names or terms from context that the speaker did not say.
- Preserve the speaker's intent, tone, and meaning exactly.

Output rules:
- Return ONLY the cleaned transcript text, nothing else. So NEVER output words like "Here is the cleaned transcript text:"
- If the transcription is empty, return exactly: EMPTY
- Do not add words, names, or content that are not in the transcription. The context is only for correcting spelling of words already spoken.
- Do not change the meaning of what was said.`,
  vocabulary: '',
  useAppContext: true,
  holdHotkey: 'RightAlt',
  toggleHotkey: 'CommandOrControl+Shift+Space',
  holdEnabled: true,
  toggleEnabled: true,
  showOverlay: true,
  playSounds: true,
  autoPaste: true,
  pasteDelayMs: 60,
  history: [],
  monthlyWordCount: 0,
  usageMonth: ''
};

const HISTORY_LIMIT = 50;

let cache = null;
let filePath = null;

function getPath() {
  if (!filePath) filePath = path.join(app.getPath('userData'), 'config.json');
  return filePath;
}

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(getPath(), 'utf8');
    const parsed = JSON.parse(raw);
    cache = { ...DEFAULTS, ...parsed };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function save() {
  if (!cache) return;
  try {
    fs.mkdirSync(path.dirname(getPath()), { recursive: true });
    fs.writeFileSync(getPath(), JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save settings:', err);
  }
}

function get(key) {
  return load()[key];
}

function getAll() {
  return { ...load() };
}

function set(updates) {
  load();
  Object.assign(cache, updates);
  save();
  return { ...cache };
}

function reset() {
  cache = { ...DEFAULTS };
  save();
  return { ...cache };
}

function pushHistory(item) {
  load();
  cache.history = [item, ...(cache.history || [])].slice(0, HISTORY_LIMIT);
  save();
}

function getCurrentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function resetUsageIfNewMonth() {
  load();
  const current = getCurrentMonth();
  if (cache.usageMonth !== current) {
    cache.monthlyWordCount = 0;
    cache.usageMonth = current;
    save();
  }
}

function addWords(count) {
  load();
  resetUsageIfNewMonth();
  cache.monthlyWordCount = (cache.monthlyWordCount || 0) + count;
  save();
  return cache.monthlyWordCount;
}

function getMonthlyWordCount() {
  load();
  resetUsageIfNewMonth();
  return cache.monthlyWordCount || 0;
}

module.exports = { get, getAll, set, reset, pushHistory, addWords, getMonthlyWordCount, DEFAULTS };
