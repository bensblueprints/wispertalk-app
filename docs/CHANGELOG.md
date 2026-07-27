# Changelog

All notable changes to WisperTalk. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

See [`ROADMAP.md`](ROADMAP.md) for plans.

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
