# Changelog

All notable changes to WisperTalk. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.2.1] — 2026-07-29

### Fixed
- **"Could not install the keyboard hook — failed to enable access for assistive devices" on macOS.** The hotkey needs Accessibility permission, and the app only ever showed a one-time instruction dialog. Three separate causes, all fixed:
  - Nothing ever called `isTrustedAccessibilityClient(true)`, which is what registers the app with macOS and shows Apple's own prompt. Until something asks, WisperTalk may not appear in the Accessibility list at all — so users were told to switch on a toggle that wasn't there.
  - The notice was gated behind a "shown once" flag, so on every later launch a missing permission produced no guidance at all, just a dead hotkey.
  - `uIOhook.start()` returns normally even when libuiohook is refused access (it only writes to its own stderr), so the app believed the hook was live while no key event ever arrived. macOS trust is now checked before starting, turning a silent failure into a reported one.
- The app polls for the permission and **re-arms the hotkey the moment it is granted — no restart needed**. macOS emits no event for this and does not re-trust a running process, which is why granting access previously appeared to do nothing.
- The dialog opens the exact Settings pane, and calls out that macOS keeps the permission against the *previous* build after an update: it looks enabled but isn't, and has to be toggled off and on again.
- A hook failure caused by the missing permission no longer shows the misleading "pick a different key" dialog — no key can work until access is granted.

## [1.2.0] — 2026-07-28

### Added
- **Offline transcription engine.** Settings → API → *Transcription engine* now offers **Local (offline)** alongside **Groq (cloud)**. Local runs `Xenova/whisper-base.en` (int8 ONNX) through `@huggingface/transformers` on `onnxruntime-node`, entirely on the user's CPU — no internet, no API key, no audio leaving the machine. The weights (76 MB) ship **inside the installer** under `resources/app.asar.unpacked/models/`; `env.allowRemoteModels` is hard-off so nothing is ever downloaded at runtime. Existing installs stay on Groq — the new setting defaults to the old behaviour.
  - The overlay renderer decodes the recording to 16 kHz mono PCM with the Web Audio API, so no ffmpeg is bundled.
  - LLM cleanup is a cloud call, so it is skipped in offline mode unless `llmCleanupWhenLocal` is turned on (for e.g. a local Ollama).
- **Press-to-map hotkeys.** The hold key is no longer a dropdown of 14 hard-coded choices — click the field and press any physical key. Function keys, right-hand modifiers, numpad, and keys with no name at all (stored as `Key<keycode>`) all bind. The toggle shortcut has a **Record** button that captures the whole chord. Esc cancels; **Reset** restores the default.
- **Hotkey resilience.** The keyboard hook is re-armed on system resume and screen unlock, a health check re-installs it if it dies while the user is active, and registration failures now raise a dialog + tray warning + Settings banner instead of a silent `console.warn`. Tray gained **Re-arm hotkeys** and **Reset (if stuck)**.
- Request timeouts on transcription (120 s) and cleanup (60 s).

### Fixed
- **Tapping the hotkey with no speech hung the app until force-quit.** A press-and-release faster than `getUserMedia()` reached `stopRecording()` while `mediaRecorder` was still `null`; that path cleaned up and returned without ever sending `recorder:audio`, so the main process stayed `busy = true` forever and every later press was swallowed by the `if (busy) return` guards. The renderer now replies exactly once on **every** path — released-before-mic-opened, zero chunks captured, `onstop` never firing, mic error, stop-while-idle — and the main process arms a 5 s watchdog when it asks for audio, so a silent renderer can no longer wedge it.
- Hotkey presses during startup are no longer lost: `recorder:start` / `recorder:stop` sent before the overlay window finished loading were dropped on the floor, leaving the same stuck state. Sends are now gated on the window being ready, and a crashed overlay renderer is rebuilt automatically.
- Existing `holdHotkey` values (`RightAlt`, `RightCtrl`, `RightShift`, `RightWin`) are aliased to their uiohook names, so upgrading does not break anyone's saved key.
- Errors raised while the Settings window is closed now show an OS notification instead of disappearing.

### Changed
- App icon and tray icon replaced with the WisperTalk mark.
- Windows build prunes `onnxruntime-web` (unused in Node), the DirectML/dxcompiler DLLs, and non-Windows ONNX Runtime binaries. Installer: 82 MB → 140 MB with the offline model included.

See [`ROADMAP.md`](ROADMAP.md) for plans.

## [1.1.3] — 2026-07-28

### Fixed
- **"client secret is required" at sign-in.** The cause was the OAuth client id, not the flow: `app_B2TMUEvC9aRUNZ` is a confidential, API-created app that demands a secret. The suite's `DESKTOP-BUILD-GUIDE.md` names `app_1alGIvT167sGCl` (public client, loopback redirect registered) as the one to use — both verified healthy with the guide's own probes. Token exchange is back to plain public PKCE with no secret anywhere, matching the canonical module.
- Owner accounts (`OWNER_USER_IDS`) short-circuit the access check, per the same guide.

## [1.1.2] — 2026-07-28

### Fixed
- **Sign-in failed with "client secret is required."** Whop treats the OneTimeSuite OAuth app as a confidential client, so the code exchange needs a client_secret — which must never ship inside the app. The exchange (and token refresh) now goes through the registry's `/oauth/token` and `/oauth/refresh` proxy, which holds the secret server-side, and the client id now matches the one that proxy is configured with (`app_1alGIvT167sGCl`).
- Sign-in errors now surface Whop's actual message instead of a generic failure.

> Note for other OneTimeSuite apps: the canonical `client/whop-license.js` still exchanges directly with Whop and will hit this same error. It should be updated to use the proxy the same way.

## [1.1.1] — 2026-07-28

### Fixed
- **Owners of "OneTimeSuite Complete" were denied access** and stuck on the purchase-required dialog (which blocks startup, so the tray and Settings never appeared). v1.1.0 gated on the WisperTalk experience id alone, on the assumption that a bundle grant would resolve through it; it doesn't. All granting product ids are now checked explicitly (Lifetime, Complete, Additional Device, the experience, and the legacy product).
- Access is now resolved authoritatively by the OneTimeSuite registry (`POST /access/check`), which matches the user's Whop memberships with the company key — bundle grants included. The per-experience user-token check remains as a fallback.
- The denial dialog now names the Whop account that was signed in, so a wrong-account sign-in is obvious.

## [1.1.0] — 2026-07-28

### Changed
- **Licensing is now Whop-native (OneTimeSuite pattern) — no license keys.** First launch opens "Sign in with Whop" (OAuth + PKCE, loopback); the app checks the signed-in user's own access to WisperTalk Lifetime, OneTimeSuite Complete, or the legacy WisperTalk product, registers the device with the central OneTimeSuite registry (license.onetimesuite.com, max 3 devices, self-serve deactivation), and caches locally — later launches are instant, re-validated daily in the background with a 10-day offline grace. Settings → License shows the Whop account and offers "Sign out on this device".

### Removed
- **2,000-word/month free trial.** Without a verified Whop purchase the app shows the purchase-required dialog and quits. Trial products don't grant access.
- License keys entirely: the key/email activation window, input formatter, device-conflict UI, `src/main/license.js`, the wispertalk.com license endpoints as a dependency, the upgrade prompt window, and all monthly word counting.

## [0.2.2] — 2026-05-10

### Fixed
- **Audio bars in the floating overlay didn't animate** during recording. Root cause was a race: the renderer received the `overlay:show` event (which kicks off the visualization loop) before `getUserMedia()` resolved and the AudioContext analyser was set up — by the time analyser existed, nothing was watching for it. Now the visualization loop is started at the end of `startRecording()` once the analyser is wired, and the AudioContext is resumed if it was created in a suspended state. Audio capture and transcription were unaffected — this was a visualization-only bug.

## [0.2.1] — 2026-05-10

### Fixed
- Activation window title now reads "Activate WisperTalk" (was "Activate Whisper Talk" — orphan from rebrand).

### Build / Release pipeline
- CI now produces both Windows (NSIS installer + portable .exe) and macOS (arm64 + x64 DMGs and ZIPs) artifacts in a single `Build & Release` workflow.
- Artifacts publish to the public [`wispertalk-releases`](https://github.com/bensblueprints/wispertalk-releases) repo (source stays private in `wispertalk-app`).

## [0.2.0] — 2026-05-09

### Added
- **Microphone picker** in Settings → Audio. Lists all input devices via `navigator.mediaDevices.enumerateDevices()`, plus a "Refresh" button that triggers a one-shot `getUserMedia` to unlock device labels. Falls back to system default if the saved deviceId is no longer attached.
- **Transcription language** selector with 30 common Whisper-supported languages plus auto-detect (default). Sends the `language` field to the Groq `/audio/transcriptions` endpoint when set.
- New "Audio" tab in Settings between API and Hotkeys.

### Changed
- `recorder:start` IPC event now carries an `{ inputDeviceId }` payload from main → overlay so audio capture honors the chosen mic.
- `transcribe()` accepts an optional `language` parameter.

## [0.1.0] — 2026-05-09

First public release. macOS support, both Apple Silicon and Intel.

### Added
- Cross-platform support — Windows + macOS share a single codebase with platform branches in `paste.js`, `context.js`, and `license.js`.
- macOS unsigned `.dmg` for arm64 + x64 (Apple Silicon prioritized).
- One-time Accessibility-permission prompt on first macOS launch.
- GitHub Actions workflow that builds the macOS DMGs on `macos-latest` runners and publishes draft releases automatically.
- `osascript` paste path for macOS (alternative to PowerShell SendKeys on Windows).
- AppleScript-based foreground-window detection on macOS.

### Documentation
- New README rewritten for cross-platform.
- New `docs/` folder: USER_GUIDE, BUILDING, ARCHITECTURE, SETTINGS, LICENSING, TROUBLESHOOTING, ROADMAP, CHANGELOG.

### Notes
- Mac builds are unsigned. First launch requires right-click → Open. We're not pursuing Apple Developer Program membership unless customer demand justifies the $99/yr.
- `uiohook-napi` works on macOS but requires Accessibility permission. globalShortcut (toggle) works without it.

## Earlier

The Windows-only history is preserved in `git log`. This changelog starts at the public release.
