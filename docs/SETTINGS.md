# Settings reference

Every persisted setting, what it does, defaults, and recommended values.

Settings live in `app.getPath('userData')/config.json`:
- **Windows**: `%APPDATA%\WisperTalk\config.json`
- **macOS**: `~/Library/Application Support/WisperTalk/config.json`

The file is JSON, formatted, and safe to edit by hand if WisperTalk is closed.

## Schema

| Key | Type | Default | What it does |
|---|---|---|---|
| `groqApiKey` | string | `""` | Bearer token for STT + LLM endpoint. Required to dictate. Stored locally only. |
| `llmApiBaseUrl` | string | `"https://api.groq.com/openai/v1"` | Root of the OpenAI-compatible API. Change to point at OpenAI, Ollama, OpenRouter, etc. |
| `sttModel` | string | `"whisper-large-v3"` | Speech-to-text model name passed to `/audio/transcriptions`. |
| `llmModel` | string | `"llama-3.3-70b-versatile"` | Cleanup model name passed to `/chat/completions`. Only used if `enableLlmCleanup` is true. |
| `enableLlmCleanup` | boolean | `true` | Run a second LLM pass to fix punctuation, remove fillers, correct spelling. Disable for raw Whisper output. |
| `useAppContext` | boolean | `true` | Pass the foreground app's process name + window title to the cleanup LLM as context. Only window title leaves your machine. |
| `vocabulary` | string | `""` | Comma- or newline-separated terms (names, jargon) preserved through cleanup. |
| `cleanupPrompt` | string | (long default) | System prompt for the cleanup LLM. Edit for different personas (formal email vs. code comments vs. chat). |
| `holdEnabled` | boolean | `true` | Use the hold-to-talk hotkey. |
| `holdHotkey` | string | `"RightAlt"` | Which key. One of: `RightAlt`, `ScrollLock`, `CapsLock`, `F13`–`F20`, `RightCtrl`, `RightShift`, `RightWin` (Windows) / `RightCmd` (macOS). |
| `toggleEnabled` | boolean | `true` | Use the tap-to-toggle shortcut. |
| `toggleHotkey` | string | `"CommandOrControl+Shift+Space"` | Electron-format accelerator. `CommandOrControl` resolves to `Ctrl` on Windows, `⌘` on macOS. |
| `showOverlay` | boolean | `true` | Show the floating recording bar at the bottom of the screen. |
| `playSounds` | boolean | `true` | Play a soft tone on record-start and record-stop (currently a no-op placeholder; sounds wired in v0.2.0). |
| `autoPaste` | boolean | `true` | Simulate `Ctrl+V` / `⌘+V` after writing to clipboard. Off = clipboard only, you paste manually. |
| `pasteDelayMs` | number | `60` | Milliseconds between writing clipboard and simulating paste. Increase if paste sometimes lands wrong. |
| `history` | array | `[]` | Last 50 dictations, capped. Each entry: `{ at, raw, final }`. |
| `macAccessibilityNoticeShown` | boolean | `false` | Tracks whether the one-time macOS Accessibility prompt has fired. Internal. |

## Recommended profiles

### Default (Groq, free tier)
Drop in your Groq API key, leave everything else. Fast, accurate, English defaults work for ~99 languages thanks to Whisper auto-detection.

### Maximum privacy (local-only)
- `llmApiBaseUrl`: `http://localhost:11434/v1`
- `sttModel`: run [whisper.cpp server](https://github.com/ggerganov/whisper.cpp) on a different port; point a small reverse-proxy or use a local model name supported by your local server.
- `enableLlmCleanup`: false (or run Ollama with a local model and leave on).
- `useAppContext`: false.

Now nothing leaves your machine except the license check (key + hashed device ID) once on activate and once every 6 hours on verify.

### Heavy customization (writers, devs)
- Bump `vocabulary` with a substantial list of terms (your codebase identifiers, your characters' names, your client list).
- Edit `cleanupPrompt` to specify your tone (e.g., "Always preserve sentence fragments — do not merge fragments into complete sentences.").
- Set `pasteDelayMs` to 100ms if you've had paste-into-wrong-field issues.

### Latency-tight (rapid-fire short utterances)
- `enableLlmCleanup`: false. Cleanup adds ~200–600ms.
- `pasteDelayMs`: 30ms.
- Use `RightAlt` hold rather than the toggle (saves the second tap).

## Editing config.json by hand

Close WisperTalk first (system tray → Quit). Edit `config.json` with a JSON-aware editor. Reopen WisperTalk. Settings load on startup; the file is rewritten whenever you save in the Settings UI.

If you corrupt the file, WisperTalk falls back to defaults and overwrites on next save — losing only your edits since the last save.

## Resetting

Settings → Behavior → **Reset all settings to defaults** wipes everything except your license and history. To wipe license too, delete the entire `WisperTalk/` user-data folder while the app is closed.
