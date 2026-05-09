# WisperTalk for Windows

Voice dictation for Windows — sold at [wispertalk.com](https://wispertalk.com). Electron rebuild of the macOS-only [FreeFlow](https://github.com/zachlatta/freeflow).

Hold a key, speak, release — your cleaned-up text appears wherever your cursor is. No subscription, no server.

## Features

- **Hold-to-talk** (RightAlt by default) and **toggle** (Ctrl+Alt+Space) hotkeys, both customizable.
- **Groq Whisper Large V3** for transcription, **Llama 3.3 70B** for cleanup. OpenAI-compatible — point it at Ollama or any other endpoint.
- **Foreground-app context**: passes the active window title to the cleanup LLM so names spell correctly.
- **Custom vocabulary**: project terms / names that should be preserved.
- **Floating overlay**: shows live audio bars while recording, processing state on release.
- **Auto-paste**: simulates Ctrl+V into the focused field, then restores your clipboard.
- **Local-only**: all settings and history stored in `%APPDATA%/WisperTalk/`.

## Quick start (running from source)

```powershell
cd C:\Users\HP\freeflow-electron
npm install
npm start
```

Open the system tray icon, click **Settings**, paste your Groq API key, save. Hold **RightAlt** to dictate.

## Build a Windows installer

```powershell
npm run dist
```

Output:
- `dist/WisperTalk Setup x.y.z.exe` — NSIS installer
- `dist/WisperTalk-x.y.z-portable.exe` — single-file portable

## Architecture

- **Main process** (`src/main/`): tray icon, hotkey listener, API calls, paste, foreground window detection.
- **Overlay window** (`src/renderer/overlay.*`): frameless transparent always-on-top recording indicator, also hosts the `MediaRecorder` for audio capture.
- **Settings window** (`src/renderer/settings.*`): config UI with five tabs (API / Hotkeys / Cleanup / Behavior / History).
- **Hotkeys** via [`uiohook-napi`](https://github.com/SnosMe/uiohook-napi) for hold-to-talk semantics; Electron's `globalShortcut` for tap-to-toggle.
- **Auto-paste** spawns a one-shot PowerShell `[SendKeys]::SendWait('^v')` after writing to the clipboard.

## Notes vs the macOS original

- Hold key on Windows defaults to **RightAlt** (no Fn key trap on Windows). ScrollLock / CapsLock / F13–F20 / RightCtrl / RightShift also available.
- App context is just the foreground window title + process name (no AX tree on Windows). Good enough for emails / doc names / chat threads.
- Code-signing the installer is left to the user.
