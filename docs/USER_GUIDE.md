# User Guide

Everything an end-user needs to actually use WisperTalk daily.

## 1. Install

### Windows
Download from [github.com/bensblueprints/wispertalk-app/releases/latest](https://github.com/bensblueprints/wispertalk-app/releases/latest):

- **`WisperTalk-Setup-x.y.z.exe`** if you want a normal install (start-menu shortcut, proper uninstall, settings persist after uninstall in `%APPDATA%`).
- **`WisperTalk-x.y.z-portable.exe`** if you want a single-file portable, e.g. on a thumb drive or a managed machine where you don't have install rights. Settings still persist in `%APPDATA%`.

### macOS
Pick the right `.dmg`:
- **Apple Silicon (any Mac with M1/M2/M3/M4 chip)**: `WisperTalk-x.y.z-arm64.dmg`
- **Intel**: `WisperTalk-x.y.z.dmg`

Open the DMG, drag the WisperTalk icon onto Applications. Eject the DMG.

**First launch on macOS**: don't double-click. Right-click WisperTalk in Applications → click **Open** → confirm the warning. macOS will open it. After this once, double-clicking works for all future launches.

You'll be prompted to:
1. Allow access to the **microphone** (needed for recording).
2. Add WisperTalk to **Accessibility** in System Settings → Privacy & Security (needed for the global hotkey and auto-paste). The toggle may not appear until you trigger it once — try the hotkey, macOS will offer to add it.

## 2. Activate your license

When you first run the app, a window asks for your license key (you got it by email when you bought it from [wispertalk.com](https://wispertalk.com)).

- Paste the key (looks like `WT-XXXX-XXXX-XXXX-XXXX`).
- Click **Activate this device**.
- The app binds the license to this machine and remembers it.

If you've already used the license on another device, you'll see a "license already active" message. Click **Move license here** to release the other device and bind to this one. The other machine will lock on its next periodic verify (~6 hours).

## 3. Add your Groq API key

Open **Settings** (system-tray icon → right-click → Settings on Windows; menu-bar icon on macOS) and go to the **API** tab.

- Get a free Groq API key at [console.groq.com](https://console.groq.com). The free tier is generous enough for personal use.
- Paste it into the **Groq API Key** field.
- Leave the rest at defaults: `https://api.groq.com/openai/v1`, model `whisper-large-v3` for STT, `llama-3.3-70b-versatile` for cleanup.
- Click **Save changes**.

The key is stored in your local user-data folder. It's never sent anywhere except Groq.

### Using a different provider

Any OpenAI-compatible endpoint works:

| Provider | Base URL | STT model | LLM model |
|---|---|---|---|
| Groq (default) | `https://api.groq.com/openai/v1` | `whisper-large-v3` | `llama-3.3-70b-versatile` |
| OpenAI | `https://api.openai.com/v1` | `whisper-1` | `gpt-4o-mini` |
| Ollama (local) | `http://localhost:11434/v1` | (none — disable cleanup or use `whisper.cpp` separately) | `llama3.1:8b` |
| OpenRouter | `https://openrouter.ai/api/v1` | n/a | any model |

For fully-local transcription, run [whisper.cpp](https://github.com/ggerganov/whisper.cpp) as a server and point WisperTalk at it.

## 4. Configure your hotkey

**Hotkeys** tab.

There are two activation modes — you can use either, both, or neither.

### Hold-to-talk (default on)
Hold a single key to record, release to transcribe and paste. Best for quick utterances.
- **Default**: `RightAlt` on Windows, `RightOption` on macOS.
- **Other choices**: `ScrollLock`, `CapsLock`, `F13`–`F20`, `RightCtrl`, `RightShift`, `RightWin` (Windows) / `RightCmd` (macOS).
- Pick a key you don't use otherwise. `CapsLock` works well if you've already remapped or disabled it. F13–F20 are great if you have a keyboard with extra macro keys.

### Toggle dictation (default on)
Tap a shortcut to start recording, tap again to stop. Best for longer passages.
- **Default**: `CommandOrControl+Shift+Space` (= `Ctrl+Shift+Space` on Windows, `⌘+Shift+Space` on macOS).
- Format: any Electron accelerator string — `Ctrl+Alt+Space`, `Shift+F19`, `Alt+;`, etc.

If a shortcut conflicts with another app's hotkey, pick something else. WisperTalk will warn you in the log if registration fails.

## 5. Tune cleanup

**Cleanup** tab.

- **Run LLM cleanup after transcription**: ON by default. Removes filler words, fixes punctuation, capitalizes properly. If you want raw Whisper output, turn OFF and skip this whole tab.
- **Use foreground app + window title as context**: helps the cleanup LLM spell project names, file names, person names correctly. The window title is the only metadata that leaves your machine, and only to your cleanup endpoint.
- **Custom vocabulary**: comma- or newline-separated terms you want preserved. Project codenames, jargon, your spouse's name spelled the way they actually spell it.
- **System prompt**: full editorial control. Default prompt removes filler and fixes errors but preserves intent. Edit it for different personas (formal email, casual chat, code comments).

## 6. Behavior

**Behavior** tab.

- **Floating recording indicator**: small bottom-of-screen overlay with audio bars while recording. Recommended on. Turn off for full-stealth.
- **Auto-paste**: writes to clipboard and simulates `Ctrl+V` / `⌘+V`. Turn off if you'd rather have text copied to the clipboard so you can paste manually wherever (some apps don't accept synthetic paste; see Troubleshooting).
- **Paste delay (ms)**: 60ms default. Increase to 120–200ms for slower apps where the paste sometimes lands in the wrong field.
- **Reset all settings to defaults** does what it says.

## 7. License panel

**License** tab. Shows:
- Your license key
- Email it's registered to
- Device name (auto-detected)
- Last verified time

**Deactivate this device** unbinds the license here so you can activate it elsewhere. The new device gets it instantly.

## 8. History

**History** tab. Last 50 dictations stored locally. Click any item to see raw vs. cleaned. Not synced. Cleared when you reset settings.

## 9. Daily use

After setup, your daily flow is:

1. Hold your hotkey (or tap the toggle).
2. Speak normally.
3. Release (or tap the toggle again).
4. ~1 second later, cleaned text is pasted into wherever your cursor was.

If you forget your cursor position, you can re-trigger anywhere — the app pastes into whatever has focus when you release.

## 10. Moving to a new computer

1. On the OLD machine: open Settings → License → **Deactivate this device**.
2. On the NEW machine: install, paste your license key, **Activate**.

If you no longer have access to the OLD machine, just activate on the new one and use **Move license here** when prompted. The old device locks on its next verify (~6 hours max).

## 11. Refunds

30-day no-questions refund. Email `licenses@advancedmarketing.co` (or just reply to your purchase confirmation). The refund webhook automatically marks your license refunded; the app locks on its next verify.

## 12. Privacy at a glance

- Audio: only to your configured STT endpoint.
- Window title: only to your configured LLM endpoint, only if `useAppContext` is on.
- License key + hashed device ID: only to `wispertalk.com`.
- Everything else (history, settings, raw transcripts): local, never leaves.
