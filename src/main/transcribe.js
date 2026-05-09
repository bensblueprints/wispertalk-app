async function transcribe({ audioBuffer, mimeType, apiKey, baseUrl, model, language }) {
  if (!apiKey) throw new Error('Missing API key. Open Settings to add your Groq API key.');
  const url = `${baseUrl.replace(/\/$/, '')}/audio/transcriptions`;
  const ext = mimeType.includes('wav') ? 'wav'
    : mimeType.includes('mp4') ? 'mp4'
    : mimeType.includes('ogg') ? 'ogg'
    : 'webm';

  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: mimeType }), `audio.${ext}`);
  form.append('model', model);
  form.append('response_format', 'json');
  form.append('temperature', '0');
  if (language && typeof language === 'string' && language.trim()) {
    form.append('language', language.trim());
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Transcription failed (${res.status}): ${text || res.statusText}`);
  }
  const json = await res.json();
  return (json.text || '').trim();
}

module.exports = { transcribe };
