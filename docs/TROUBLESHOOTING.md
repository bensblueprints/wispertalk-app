# Troubleshooting

Symptoms grouped by area. Fixes are ordered most-likely-first.

## Hotkey doesn't trigger

- **Symptom**: hold the hotkey, nothing happens; no overlay appears.
- **Check**: system-tray icon → is the status `Active` or `Idle`?
  - If `Idle (no API key)` — open Settings → API → paste your Groq key → Save.
  - If `Idle (license required)` — open Settings → License → check status.
- **macOS only**: System Settings → Privacy & Security → Accessibility → ensure WisperTalk is in the list and enabled. The toggle may not appear until you trigger the hotkey once and macOS adds it.
- **Windows only**: some keyboards intercept `RightAlt` for a secondary character (e.g., on EU layouts `RightAlt` = `AltGr`). Switch to `ScrollLock` or `CapsLock` in Settings → Hotkeys.
- **Toggle hotkey**: if `CommandOrControl+Shift+Space` is taken by another app (Spotlight on macOS uses `⌘+Space`, but `+Shift` should be free), change the chord. Click **Record** in Settings → Hotkeys and press the combination, or type it: `Ctrl+Alt+;`, `Shift+F19`, etc.
- **It worked, then stopped — often after the PC slept.** The OS can silently drop the low-level keyboard hook. WisperTalk re-arms automatically on resume/unlock and re-checks every minute, but you can force it: tray → **Re-arm hotkeys**, or Settings → Hotkeys → **Re-arm hotkeys now**. The banner on that tab says whether the hooks are currently armed.
- **The tray says `(NOT ACTIVE)` next to a hotkey.** Registration failed — for the toggle that almost always means another app owns the combination; pick a different one. For the hold key, re-record it in Settings → Hotkeys.

## Stuck on "Processing…" / hotkey stops responding after a short tap

Fixed in 1.1.4. Before that, tapping the key too quickly to record anything could leave the app permanently busy, ignoring every later press, until you force-quit.

- If you are on an older build, quit from the tray and reopen.
- On current builds the app self-recovers within ~5 seconds and shows "No audio came back from the recorder." If it ever looks wedged, tray → **Reset (if stuck)** clears the state immediately.

## Using WisperTalk offline

Settings → API → **Transcription engine** → *Local (offline)*.

- Runs Whisper on your own CPU. The model ships inside the installer — nothing is downloaded, and no audio leaves the machine.
- Expect roughly 4× real-time on a modern laptop CPU (≈1.7 s for 7 s of speech) and slightly weaker accuracy on unusual proper nouns than Groq's `whisper-large-v3`. Add those names to Settings → Cleanup → **Custom vocabulary**.
- LLM cleanup is a cloud call, so it is skipped in offline mode. To keep cleanup, point **API Base URL** at a local server (e.g. Ollama at `http://localhost:11434/v1`) and tick *Also run cleanup when using the offline engine*.

## Microphone doesn't pick up / silent recording

- The app uses your **OS default input**. Check OS sound settings to verify the right mic is the default.
- macOS: System Settings → Privacy & Security → Microphone → ensure WisperTalk is enabled.
- Windows: Settings → Privacy → Microphone → ensure desktop apps are allowed.
- Try unplugging and replugging USB mics — sometimes macOS forgets permission.
- (Mic picker is planned for v0.2.0; until then you can only change which input gets used by changing your OS default.)

## Auto-paste lands in the wrong field

- Increase **Settings → Behavior → Paste delay (ms)** from 60 to 120 or 200.
- Some apps (sandboxed Electron apps, certain games, password managers) refuse synthetic paste. Turn off **Auto-paste** — your text will still be on the clipboard for manual paste.

## Auto-paste pastes nothing

- **macOS**: missing Accessibility permission. The clipboard write succeeds but the synthetic Cmd+V doesn't fire. Grant Accessibility, restart WisperTalk.
- **Windows**: PowerShell may be locked down by group policy. Enable **Auto-paste** off; the text will still be on the clipboard.

## "License already active on another device"

You activated this license on a different machine. Two options:

1. **Move it here**: click "Move license here" in the License window. The other machine locks within 6 hours.
2. **Deactivate the other machine first**: open WisperTalk on the other machine → Settings → License → Deactivate this device. Then activate normally here.

If you can't access the other machine, just use option 1.

## "License not active" / "Refunded"

- Check email for a refund confirmation. Refunded licenses can't be reactivated; you'll need to repurchase.
- If you didn't request a refund, reply to your purchase confirmation email. Stripe disputes can also auto-mark licenses refunded.

## Mac: "WisperTalk can't be opened because Apple cannot check it for malicious software"

We're not yet code-signed. Workaround:

1. **Right-click** WisperTalk in Applications.
2. Click **Open**.
3. Confirm the dialog.
4. After the first time, double-clicking works normally.

This isn't a malware warning — Apple just hasn't been paid the $99/yr Developer Program fee. If you want a signed build, [email us](mailto:licenses@advancedmarketing.co).

## Mac: "WisperTalk is damaged and can't be opened"

This shows up when Gatekeeper has quarantined the .dmg. Strip the quarantine flag:

```bash
xattr -d com.apple.quarantine /Applications/WisperTalk.app
```

Then launch normally.

## Cleanup LLM gives weird output

- Check the **System prompt** in Settings → Cleanup. If you've edited it, revert with the **Reset all settings** button (or just paste the default back in — it's documented in [`SETTINGS.md`](SETTINGS.md)).
- Some LLM providers (especially small local models) struggle with the cleanup prompt. Try with cleanup off (Settings → Cleanup → uncheck **Run LLM cleanup after transcription**) — you'll get raw Whisper output, which is usually 95% there.

## Transcription is slow

- Network-bound — Groq is one of the fastest providers. Switching to OpenAI proper is usually slower.
- Audio over 60 seconds → STT call gets long. Use the toggle hotkey for paragraph-length, hold for short utterances.
- Cleanup adds 200–600ms. Disable for fastest dictation.

## Build errors

### `gyp ERR! find Python` / `ModuleNotFoundError: No module named 'distutils'`

`node-gyp` needs Python 3.11 (`distutils` removed in 3.12+). Install Python 3.11, set `PYTHON=/path/to/python3.11` in env, or in CI use `actions/setup-python@v5` with `python-version: '3.11'`.

### `electron-builder: error: Application entry file ... not found`

You probably ran `npm run dist` before `npm install`. Rerun `npm install` first.

### `Hardened runtime is enabled` errors on macOS unsigned build

Ensure `package.json` `build.mac.identity` is literal `null`, not the string `"null"`. Confirm `gatekeeperAssess: false` and `hardenedRuntime: false`.

### `appdmg failed` on macOS

`hdiutil` permission. In Terminal's Privacy & Security → Full Disk Access, add Terminal. Then rerun.

### CI workflow fails at "Publish draft release" with "Resource not accessible by integration"

The workflow needs `permissions: contents: write` at the top level. Already in our workflow; if you've forked, add it.

## App won't start

- Check logs:
  - Windows: `%LOCALAPPDATA%\WisperTalk\logs\` (if it exists)
  - macOS: `~/Library/Logs/WisperTalk/`
- Try deleting `config.json` (it'll be regenerated) — corrupt config can crash the loader.
- Try a clean install: uninstall, delete `%APPDATA%\WisperTalk\` (or `~/Library/Application Support/WisperTalk/`), reinstall.

## Still stuck

Email `licenses@advancedmarketing.co`. Include:
- OS + version
- WisperTalk version (Settings footer or `package.json#version`)
- What you did
- What happened (paste any error message)
