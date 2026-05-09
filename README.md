# WisperTalk

> Hold a key. Speak. Release. Clean text appears wherever your cursor is.

A precise, fast, privacy-respecting voice-dictation desktop app for **Windows 10/11** and **macOS 11+**. One device at a time, $49 lifetime, no subscription.

[**wispertalk.com**](https://wispertalk.com) · [Buy a license](https://wispertalk.com/#pricing) · [Download](https://github.com/bensblueprints/wispertalk-app/releases/latest)

---

## What it does

You're typing in any app — email, IDE, browser, Slack, doc. You hold a key (default `RightAlt` on Windows, `RightOption` on macOS), speak naturally, release. WisperTalk records, sends the audio to a transcription service, optionally cleans the result with an LLM (using your foreground app's window title for spelling context), and pastes the cleaned text into the focused field. Your clipboard is restored within milliseconds.

No browser tab. No copy-paste shuffle. No noise. The app sits in your system tray; the only UI you see while dictating is a small floating bar at the bottom of your screen showing live audio.

---

## Features

- **Two activation modes**: hold-to-talk (default `RightAlt` / `RightOption`) for natural ad-hoc dictation, plus a tap-to-toggle shortcut (default `Ctrl+Shift+Space` / `⌘+Shift+Space`) for longer passages.
- **Cross-platform**: native Windows installer (NSIS) + portable `.exe`, plus unsigned macOS `.dmg` for both Apple Silicon and Intel.
- **Bring your own provider**: OpenAI-compatible API. Defaults to [Groq](https://groq.com) (Whisper Large V3 + Llama 3.3 70B) for speed; works with [Ollama](https://ollama.com), OpenAI proper, or any endpoint exposing `/audio/transcriptions` and `/chat/completions`.
- **LLM cleanup, optional**: removes filler words, fixes punctuation, corrects spelling for project-specific names you've added to a vocabulary list. Off-by-default for raw-transcription users.
- **Foreground-app context**: passes the active window title and process name to the cleanup LLM so proper nouns spell correctly. Disable in Settings if you want zero metadata leaving your machine.
- **Custom vocabulary**: comma- or newline-separated terms — names, jargon, project codenames — preserved across cleanup.
- **Floating overlay**: frameless transparent always-on-top recording indicator with live audio bars and elapsed-time counter. Toggleable.
- **Smart auto-paste**: writes cleaned text to the clipboard, simulates the OS-native paste shortcut, restores your previous clipboard contents. Configurable paste-delay for slower apps.
- **Local-only history**: last 50 dictations stored in your user-data folder. No sync. No cloud history. No analytics.
- **One-device-at-a-time licensing**: license keys bind to a device fingerprint. Move freely between machines via the in-app Settings → License tab; the previous device locks on its next periodic verify.
- **Open-source app code**: this repository contains the full client. Licensing server at [wispertalk.com](https://wispertalk.com) is what's commercial.

---

## What's planned

These are coming soon — the architecture supports them but there's no UI yet:

- **Microphone picker**: app currently uses the OS-default input. A dropdown is planned for `v0.2.0` (`navigator.mediaDevices.enumerateDevices()` is straightforward to wire).
- **Language selector**: Whisper supports 99 languages and currently auto-detects from audio on every utterance. A first-class language picker (with optional "force language" override) is planned for `v0.2.0` for users who want better accuracy on accented or short utterances.
- **Custom paste hotkey** for apps that don't accept synthetic `Ctrl+V`.
- **Multiple custom prompts**: switch cleanup styles per-app (formal email vs. casual chat vs. code).
- **In-app updater** wired to GitHub Releases.

See [`docs/ROADMAP.md`](docs/ROADMAP.md).

---

## Install

### Windows
Grab the latest `.exe` from [Releases](https://github.com/bensblueprints/wispertalk-app/releases/latest):

- **`WisperTalk-Setup-x.y.z.exe`** — NSIS installer (start-menu shortcut, proper uninstall)
- **`WisperTalk-x.y.z-portable.exe`** — single-file portable, no install

Requirements: Windows 10 (1809+) or 11 · x64 · microphone · internet (for first activation + Groq API calls).

### macOS

Grab the right `.dmg`:
- **Apple Silicon (M1/M2/M3/M4)**: `WisperTalk-x.y.z-arm64.dmg`
- **Intel**: `WisperTalk-x.y.z.dmg`

Drag WisperTalk into Applications, then **right-click → Open** the first time (we are not yet code-signed; this bypasses Gatekeeper). After that, double-clicking works.

You'll be prompted to grant **Accessibility** access in System Settings → Privacy & Security so WisperTalk can listen for your hotkey and paste transcribed text. **Microphone** access is also required.

Requirements: macOS 11 Big Sur or newer · Apple Silicon or Intel · microphone · internet.

### First-run setup

1. Paste your license key (you receive it by email immediately after [purchase](https://wispertalk.com)).
2. Open Settings (system-tray icon → Settings, or click the gear in the License screen).
3. Add a Groq API key (free tier is generous — get one at [console.groq.com](https://console.groq.com)). The key never leaves your machine; it's used to call Groq directly from the app.
4. Save. Hold your hotkey, speak, release.

---

## Configuration overview

Settings live in five tabs:

- **API** — Groq key, base URL, STT and cleanup model names.
- **Hotkeys** — choose hold key (RightAlt, RightOption, ScrollLock, CapsLock, F13–F20, RightCtrl, RightShift, RightWin/Cmd) and toggle accelerator (any Electron-format chord like `CommandOrControl+Shift+Space`).
- **Cleanup** — toggle LLM post-processing, app-context, custom vocabulary, system prompt.
- **Behavior** — overlay visibility, auto-paste on/off, paste delay (ms), reset-all-settings.
- **License** — view license key, bound device, last verified time; deactivate this device.
- **History** — last 50 dictations (raw + cleaned).

Full reference: [`docs/SETTINGS.md`](docs/SETTINGS.md).

---

## How it works

```
   ┌────────────────────────────────────────────────────────────────┐
   │  hold key pressed                                              │
   │      │                                                         │
   │      ▼                                                         │
   │  uiohook-napi → main process                                   │
   │      │                                                         │
   │      ▼                                                         │
   │  show overlay → render starts MediaRecorder (96kbps Opus)      │
   │      │                                                         │
   │      ▼                                                         │
   │  hold key released                                             │
   │      │                                                         │
   │      ▼                                                         │
   │  main collects audio buffer                                    │
   │      │                                                         │
   │      ├─→ POST /audio/transcriptions  (Groq Whisper Large V3)   │
   │      │      └─→ raw text                                       │
   │      │                                                         │
   │      ├─→ getForegroundContext()  (process name + window title) │
   │      │                                                         │
   │      ├─→ POST /chat/completions   (cleanup LLM, optional)      │
   │      │      └─→ cleaned text                                   │
   │      │                                                         │
   │      ▼                                                         │
   │  save current clipboard → write cleaned text → simulate paste  │
   │  → restore clipboard → push to history → hide overlay          │
   └────────────────────────────────────────────────────────────────┘
```

- **Hold-to-talk** uses `uiohook-napi` (low-level keyboard hook, key-down/key-up events). **Toggle** uses Electron's cross-platform `globalShortcut`. Both register only after a valid license is verified.
- **Audio capture** runs in a hidden renderer (the overlay window) using the standard Web `MediaRecorder` with `audio/webm;codecs=opus` (or platform fallback). 16-bit mono, 96kbps, with browser-native echo cancellation, noise suppression, and AGC.
- **Auto-paste** writes the result to the clipboard, then:
  - **Windows**: spawns PowerShell `[System.Windows.Forms.SendKeys]::SendWait('^v')`
  - **macOS**: spawns `osascript -e 'tell application "System Events" to keystroke "v" using command down'`
  - Falls back to clipboard-only if the OS-native simulator isn't available (e.g. macOS without Accessibility permission).
- **Foreground app context** (Windows: Win32 `GetForegroundWindow`/`GetWindowText`; macOS: AppleScript `name of first application process whose frontmost is true`) is sent to the cleanup LLM ONLY if you opt in (`Settings → Cleanup → Use foreground app + window title as context`). Audio bytes never leave your machine except to your configured STT endpoint.
- **License**: client posts `{key, deviceId, deviceName}` to `https://wispertalk.com/api/license/activate`, gets back a 7-day JWT, then re-verifies every 6 hours via `/api/license/verify`. Device fingerprint is `sha256(deviceId).slice(0,16)`; the per-install `deviceId` is a UUID stored in `app.getPath('userData')/device.id` and never leaves your machine in plaintext.

Architecture deep-dive: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Documentation

| Doc | What's in it |
|---|---|
| [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) | End-user walkthrough — install, license, settings, daily use |
| [`docs/SETTINGS.md`](docs/SETTINGS.md) | Every setting, what it does, defaults, recommended values |
| [`docs/BUILDING.md`](docs/BUILDING.md) | Building from source on Windows + macOS, GitHub Actions workflow, code-signing |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Process model, IPC channels, file layout, where to add features |
| [`docs/LICENSING.md`](docs/LICENSING.md) | License-server API contract (activate/verify/deactivate), JWT shape, refund flow |
| [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) | "It paste-failed", "no audio", "Gatekeeper blocks Mac launch", etc. |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Planned features, version targets, scope of each |
| [`docs/CHANGELOG.md`](docs/CHANGELOG.md) | Release notes |

---

## Development

```bash
git clone git@github.com:bensblueprints/wispertalk-app.git
cd wispertalk-app
npm install
npm start            # runs Electron in dev mode
```

Build local installers:

```bash
# Windows (run on Windows)
npm run dist

# macOS (run on macOS, or use the GitHub Actions workflow)
npm run dist:mac
```

CI: every push to `main` triggers `.github/workflows/build-mac.yml` on a `macos-latest` runner; on success it creates a draft GitHub release with arm64 + x64 DMG and ZIP artifacts. See [`docs/BUILDING.md`](docs/BUILDING.md) for full pipeline.

---

## Privacy

- **Audio bytes** leave your machine only to the STT endpoint you configure (default Groq). Set `llmApiBaseUrl` to a localhost Ollama instance to keep audio fully local.
- **Window title + process name** leave your machine only when LLM cleanup is on AND `useAppContext` is on. Both default-on but can be toggled off independently.
- **License key + device ID hash** are sent to `wispertalk.com` on activate / verify / deactivate. Nothing else.
- **No analytics, no telemetry, no crash reporting** sent off-device. Errors print to the local console.
- All settings, history, license metadata stored in:
  - Windows: `%APPDATA%\WisperTalk\`
  - macOS: `~/Library/Application Support/WisperTalk/`

---

## Tech stack

- [Electron](https://electronjs.org) 33 (Chromium 130 + Node 20)
- [uiohook-napi](https://github.com/SnosMe/uiohook-napi) — global keyboard hook for hold-to-talk semantics
- [electron-builder](https://www.electron.build) — installer + DMG packaging
- Web MediaRecorder API — audio capture
- Groq API (default) for transcription + cleanup; any OpenAI-compatible endpoint works
- Next.js + Drizzle + Postgres on the [licensing-server side](https://github.com/bensblueprints/whisper-talk-site) (separate repo)

---

## License

This repository — the desktop client — is **MIT-licensed**. You can fork, modify, and self-host the client.

To use the official binaries with the official licensing server at `wispertalk.com`, you need a [paid license](https://wispertalk.com). The license is per-device, lifetime, with all updates included. See [`docs/LICENSING.md`](docs/LICENSING.md) for the legal/commercial details.

If you want to self-host the licensing server too, the server code is at [bensblueprints/whisper-talk-site](https://github.com/bensblueprints/whisper-talk-site) (Next.js + Postgres + Stripe).

---

## Credits

Originally a port of [zachlatta/freeflow](https://github.com/zachlatta/freeflow) (macOS-only) to Windows, then expanded back to a cross-platform commercial product.

Built by [Advanced Marketing](https://advancedmarketing.co).
