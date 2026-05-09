# Architecture

## Process model

WisperTalk is a single Electron app with three windows + a tray icon:

```
┌─────────────────────────────────────────────────────────────────┐
│ MAIN PROCESS  (Node)                                            │
│   src/main/main.js — orchestrator                               │
│   src/main/hotkey.js — uiohook-napi + globalShortcut            │
│   src/main/license.js — activate/verify against wispertalk.com  │
│   src/main/transcribe.js — POST audio → STT endpoint            │
│   src/main/postprocess.js — POST text → cleanup LLM             │
│   src/main/paste.js — platform paste (PowerShell / osascript)   │
│   src/main/context.js — foreground window detection             │
│   src/main/store.js — JSON config + history persistence         │
└─────────────────────────────────────────────────────────────────┘
           │ IPC (channel: 'flow:*' via contextBridge)
           ▼
┌─────────────────────────────────────────────────────────────────┐
│ RENDERER PROCESSES                                              │
│   1. Overlay window — frameless, transparent, always-on-top.    │
│      Renders audio bars + elapsed timer. Hosts MediaRecorder    │
│      for audio capture (Web API).                               │
│   2. Settings window — tabbed config UI, opens on demand.       │
│   3. License window — first-run / re-auth.                      │
└─────────────────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────────┐
│ SYSTEM TRAY                                                     │
│   Status (active/idle), Settings, License, Quit                 │
└─────────────────────────────────────────────────────────────────┘
```

The overlay window doubles as the audio host because Electron's main process can't access the Web `MediaRecorder` API. We use a hidden renderer (the same one that draws the visible bars) to record, then `arrayBuffer.transfer()` the audio over IPC to main.

## File layout

```
freeflow-electron/
├── package.json              # electron-builder config + scripts
├── README.md
├── docs/                     # (you are here)
├── assets/
│   ├── icon.png              # 512×512 source icon
│   └── icon-128.png          # tray icon
├── build/
│   ├── icon.ico              # generated from icon.png by `npm run icon`
│   └── icon.png              # copy used by electron-builder for macOS icns gen
├── scripts/
│   └── make-icon.js          # png → ico converter
└── src/
    ├── main/                 # all main-process code (Node)
    │   ├── main.js
    │   ├── hotkey.js
    │   ├── transcribe.js
    │   ├── postprocess.js
    │   ├── context.js
    │   ├── paste.js
    │   ├── store.js
    │   └── license.js
    ├── preload/              # contextBridge per window
    │   ├── overlay-preload.js
    │   ├── settings-preload.js
    │   └── license-preload.js
    └── renderer/             # one folder per window
        ├── overlay.html / .css / .js
        ├── settings.html / .css / .js
        └── license.html / .css / .js
```

## End-to-end flow (one dictation)

1. **Hotkey down** → `hotkey.js` (uiohook-napi for hold, globalShortcut for toggle) → `main.js#handleHoldPress()` or `handleToggle()`.
2. **State machine** flips `state` to `recording`, calls `overlayWin.webContents.send('flow:start')` and `flow:show`.
3. **Overlay renderer** (`overlay.js`) calls `navigator.mediaDevices.getUserMedia({ audio: ... })`, starts `MediaRecorder`, draws bars from `AudioContext` analyser.
4. **Hotkey up** (or second toggle tap) → `main.js#handleHoldRelease()` → `overlayWin.webContents.send('flow:stop')`.
5. **Renderer** stops the recorder, blob → arrayBuffer, `window.flow.sendAudio(arrayBuf, mimeType)` over IPC.
6. **Main**:
   - `transcribe.js` POSTs audio as multipart to `${baseUrl}/audio/transcriptions`. Returns raw text.
   - `postprocess.js` (if cleanup enabled) POSTs to `${baseUrl}/chat/completions` with the cleanup prompt + raw text + optional foreground-window context.
   - `paste.js` writes cleaned text to clipboard, simulates platform-native paste, restores clipboard.
   - `store.pushHistory({ raw, final, at })`.
7. State flips back to `idle`, overlay hides.

## IPC channels

All channels are gated through preload scripts using `contextBridge` — renderer code never sees `ipcRenderer` directly.

| Channel | Direction | Payload | Purpose |
|---|---|---|---|
| `flow:start` | main→overlay | – | Start recording |
| `flow:stop` | main→overlay | – | Stop recording |
| `flow:show` | main→overlay | `{ mode: 'recording'\|'processing' }` | Show + set mode |
| `flow:hide` | main→overlay | – | Hide |
| `flow:audio` | overlay→main | `(arrayBuffer, mimeType)` | Recorded audio |
| `flow:error` | overlay→main | `{ message }` | Renderer error |
| `flow:getSettings` | settings→main | – | Read all settings |
| `flow:setSettings` | settings→main | `Partial<Settings>` | Write settings |
| `flow:resetSettings` | settings→main | – | Reset to defaults |
| `flow:getChoices` | settings→main | – | Hold-key options for dropdown |
| `flow:getHistory` | settings→main | – | Last 50 dictations |
| `flow:getLicense` | settings→main | – | License panel data |
| `flow:deactivateLicense` | settings→main | – | Unbind device |
| `flow:closeWindow` | settings→main | – | Hide settings window |
| `license:activate` | license→main | `{ key }` | First-run activation |
| `license:moveHere` | license→main | `{ key }` | Force-move from another device |
| `license:status` | license→main | – | Current license state |

## Where to add features

- **New setting**: append to `DEFAULTS` in `src/main/store.js`. Add the field to the `fields` array in `src/renderer/settings.js`. Add the input in `src/renderer/settings.html` (use the existing `data-pane="..."` panes or add a new tab).
- **New STT/LLM provider**: edit `src/main/transcribe.js` and/or `postprocess.js`. The endpoint is OpenAI-compatible; most providers Just Work by changing `llmApiBaseUrl`.
- **Mic picker** (planned): in `overlay.js`, replace the `getUserMedia({ audio: { ... } })` constraint with `audio: { deviceId: { exact: chosenId }, ... }`. Get `chosenId` via IPC from main, where it was set via Settings. The mic list comes from `navigator.mediaDevices.enumerateDevices()` filtered to `kind === 'audioinput'`.
- **Language picker** (planned): in `transcribe.js`, append `form.append('language', 'en')` (or whatever ISO-639-1 code). Plumb the value from settings.

## Native dependency: uiohook-napi

`uiohook-napi` is the only native dep. It rebuilds against the target Electron version on `npm install` (postinstall: `electron-builder install-app-deps`). On macOS it requires Accessibility permission to register key listeners; on Windows it works once for any user.

If `uiohook-napi` fails to load at runtime (rare, but happens on locked-down corporate Windows), the app falls back to globalShortcut-only (toggle works, hold-to-talk doesn't). See `hotkey.js` lines 7–11.

## Single-instance lock

`app.requestSingleInstanceLock()` ensures only one WisperTalk runs at a time. Re-launching the .exe just opens the Settings window of the running instance.

## Macros for development

Useful while debugging:

```bash
# Inspect store
node -e "console.log(require('./src/main/store').getAll())"

# Tail Electron's main-process logs (Windows)
%APPDATA%\WisperTalk\logs\main.log

# tail (macOS)
tail -F ~/Library/Application\ Support/WisperTalk/logs/main.log
```

(The app doesn't currently write log files; this is reminder-syntax for when we add structured logging.)
