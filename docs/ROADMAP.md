# Roadmap

Public, rough, ordered by likely-ship-soon.

## v0.2.0 — quality of life

- [ ] **Microphone picker**. Settings → API tab gets a `<select>` of input devices via `navigator.mediaDevices.enumerateDevices()`. Selected `deviceId` plumbs to `getUserMedia()` constraint in `overlay.js`.
- [ ] **Language selector**. Whisper supports 99 languages; today we auto-detect every utterance. New setting `transcriptionLanguage` (default `"auto"`) appended as `language` field on the Groq form-data POST. Drop-down lists the top 20–30 languages with codes; "Other" lets you type any ISO-639-1 code.
- [ ] **Multiple cleanup prompts**, switchable per-app. Different prompt for Slack vs. Outlook vs. VS Code.
- [ ] **Recording start/stop sounds**. The `playSounds` setting exists; the audio files don't. Wire up two short tones.
- [ ] **In-app updater** via `electron-updater`, reading the `latest.yml` / `latest-mac.yml` we already publish to GitHub Releases.

## v0.3.0 — power features

- [ ] **Push-to-text replacement**: not just paste, but replace selected text with a dictated rewrite.
- [ ] **Per-app overrides**: detect foreground app, swap prompt/vocab/hotkey accordingly.
- [ ] **Keyboard shortcut for "edit last"**: re-process the last transcription with a different cleanup prompt.
- [ ] **Mac Tray menu**: better than the current minimal version. Include status, last dictation preview, quick toggle.

## v0.4.0 — fully local mode

- [ ] **Bundle whisper.cpp** as an optional background service the app spawns on launch. STT happens on-device with no network round-trip. Add `useLocalStt` boolean.
- [ ] **Bundle a small local cleanup model** (or use Apple's foundation models on macOS 26+, Windows Copilot+ on-device on supported chips).
- [ ] **Air-gapped mode**: skip license verification (after a one-time check). For users who run WisperTalk on a machine that's not internet-connected.

## Server-side (separate repo: `bensblueprints/whisper-talk-site`)

- [ ] `/api/license/verify` should validate the JWT, not just `(key, deviceId)`. Closes a small replay window.
- [ ] Wrap `/api/license/activate` reads + writes in a `SELECT FOR UPDATE` transaction to close the simultaneous-activation race.
- [ ] Auth on `/api/license/status` (currently anyone-with-an-email can list keys for that email).
- [ ] Handle `charge.dispute.created` and partial refunds in addition to `charge.refunded`.

## Long-term

- **Mobile companion** (iOS/Android) that streams audio to the desktop app, not for transcription but as a wireless mic.
- **Team licensing**: 5/10/25-pack with an admin console.
- **Custom domain support** for self-hosted licensing (white-label).

## Won't do

- Cloud sync of history. By design, history stays local.
- Keylogger-style "type as you speak" (intermediate Whisper streaming). Adds latency without quality benefit at the small audio sizes WisperTalk handles.
- Audio cloud-storage. We never store audio bytes; only what you've configured your STT provider to do.

---

If you want to influence priority, email `ben@advancedmarketing.co`.
