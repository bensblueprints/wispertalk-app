# WisperTalk 1.3.1: Windows dictation reliability

User report: unreliable hotkey arming, intermittent microphone/speech recognition, and missing automatic paste.

Installed locally on 2026-10-01 (Asia/Saigon) at `C:\Program Files\WisperTalk`. Executable product version: 1.3.1.0. Startup survived the installation check. Existing user settings and license files were not edited.

## Changes

- Settings Re-arm now restarts the native keyboard hook, instead of only registering shortcuts again. Re-arming or changing bindings releases a held recording. Health checks run every ten seconds and avoid interrupting active holds or key mapping.
- Recorder callbacks belong to a specific session. Late microphone success/failure, old stop/decode callbacks, duplicate audio, and transcription completion after reset cannot interfere with a newer dictation.
- Microphone opening has a timeout and visible startup status. Disconnected saved devices can fall back to the default with a warning. Permission failures and device disconnects report actionable messages. Hidden recorder timers are not background-throttled.
- Reset, screen lock and suspend abort recorder resources. Offline decoding uses OfflineAudioContext; microphone tracks are released before decoding.
- Empty cleanup output preserves valid raw recognition. Missing audio or recognized speech produces a visible warning.
- Windows paste waits for physical modifier release. Helper spawn errors, nonzero exits and timeouts are reported. The transcript stays on the clipboard by default for manual recovery. Cancellation stops an active paste helper; changed clipboard contents before paste are not intentionally pasted.
- Foreground-context PowerShell no longer tries to overwrite the read-only `$PID` variable.

## Verification

- `npm test`: 11 regression tests passed, including delayed microphone success/failure, startup timeout, stale decoding, missing-device fallback, permission denial, failed/hung paste helpers, native-hook re-arm logic, reset during recognition and duplicate audio.
- Hidden Electron 33.4.11 runtime test: actual native keyboard hook start/stop/start/stop passed; Chromium recorded synthetic microphone input and decoded 103,680 frames at 16 kHz (6.48 seconds). The bundled offline model recognized exactly: “The quick brown fox jumps over the lazy dog. This is a microphone recording test.”
- Packaged all six changed runtime files and compared their bytes with source. Installed EXE and ASAR hashes matched the built artifacts.
- `git diff --check` passed.

Build used the dependency lockfile and bundled model files copied from the previous installation. `npm ci` fetched dependencies but its postinstall rebuild required unavailable Visual Studio C++ build tools. Packaging used `-c.npmRebuild=false` with the dependency's shipped N-API prebuild, which was successfully loaded and restarted in the Electron runtime test. No dependency versions were changed. The local build is unsigned; no public release was uploaded.

Remaining live checks: the user's physical microphone, their normal speech/accent and target application paste behavior. Synthetic speech and regression tests do not establish those outcomes. macOS operation remains unverified.

## Backup and tracking

Full pre-update installation backup: `C:\Users\DELL\wispertalk-app\local-backup-20261001-001048`.

Branch: `fix/dictation-reliability`, based on upstream `1e8c574`.

Existing Boardly tasks found by successful `find_cards`: card 181, “Identify Wisper Talk error and affected Mac build”; card 312, “105 · WisperTalk — Windows & Mac readiness”, both in workspace 2. The current Windows report belongs with card 181, preserving the separate Mac readiness scope.

Boardly get_board, get_card and update_card tool calls returned `MCP tool call requires approval, but approval policy is never`. This is a tool-integration approval error, not proof that Boardly's application rejected the operation. No successful Boardly update is claimed. The attempted update did not succeed; this document preserves the evidence for syncing to the existing task when that integration permits writes.
