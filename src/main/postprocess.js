async function cleanup({ rawText, prompt, vocabulary, contextHint, apiKey, baseUrl, model }) {
  if (!rawText.trim()) return '';
  if (!apiKey) throw new Error('Missing API key.');

  const systemParts = [prompt];
  if (vocabulary && vocabulary.trim()) {
    systemParts.push(`\nCustom vocabulary (proper spellings to preserve when the user says them): ${vocabulary.trim()}`);
  }
  if (contextHint && contextHint.trim()) {
    systemParts.push(`\nContext from the user's foreground app (use only for spelling correction of words actually spoken — do NOT inject these terms): ${contextHint.trim()}`);
  }

  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: systemParts.join('\n') },
        { role: 'user', content: `RAW_TRANSCRIPTION: "${rawText.replace(/"/g, '\\"')}"` }
      ]
    })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Cleanup failed (${res.status}): ${text || res.statusText}`);
  }
  const json = await res.json();
  const out = (json.choices?.[0]?.message?.content || '').trim();
  if (out === 'EMPTY') return '';
  return out;
}

module.exports = { cleanup };
