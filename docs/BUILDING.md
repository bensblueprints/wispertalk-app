# Building from source

How to build WisperTalk yourself, on Windows, macOS, or via CI.

## Prerequisites

- Node.js 22 (other 20+ versions probably work; 22 is what CI uses)
- Python 3.11 (newer versions remove `distutils` which `node-gyp` still imports for native rebuilds)
- Git

### Platform-specific
- **Windows**: Visual Studio Build Tools 2022 with the "Desktop development with C++" workload (for native module compilation). Windows SDK 10.

- **macOS**: Xcode Command Line Tools — `xcode-select --install`. macOS 11+ to host the build.

## Local build

```bash
git clone git@github.com:bensblueprints/wispertalk-app.git
cd wispertalk-app
npm install
```

`npm install` runs `electron-builder install-app-deps` automatically (postinstall hook), which compiles the `uiohook-napi` native module against your Electron version. If that step fails, you're missing build tools — see Prerequisites above.

### Run in dev mode

```bash
npm start            # production-ish — minified renderer paths, no devtools
npm run dev          # opens DevTools on the overlay window
```

The app boots, asks for a license, then opens Settings if you don't have a Groq key. For dev work without a license server, see [`LICENSING.md`](LICENSING.md) → "Local dev without the licensing server".

### Build Windows installers

```bash
npm run dist
```

Output in `dist/`:
- `WisperTalk Setup x.y.z.exe` — NSIS installer with start-menu shortcut, desktop shortcut, proper uninstall.
- `WisperTalk-x.y.z-portable.exe` — single-file portable, no install needed.
- `latest.yml` — autoupdater feed (not yet wired into the app).

The build also generates `build/icon.ico` from the source PNG via the `npm run icon` step.

### Build macOS DMGs

**Must be run on a Mac.** electron-builder shells out to `hdiutil` and friends, which only exist on macOS.

```bash
npm run dist:mac
```

Output in `dist/`:
- `WisperTalk-x.y.z-arm64.dmg` — Apple Silicon
- `WisperTalk-x.y.z.dmg` — Intel
- `WisperTalk-x.y.z-arm64-mac.zip` — Apple Silicon zip (for autoupdater)
- `WisperTalk-x.y.z-mac.zip` — Intel zip
- `latest-mac.yml` — autoupdater feed
- Block maps for differential updates

Both DMGs are **unsigned**. To sign for Gatekeeper, set `mac.identity` in `package.json` to your Apple Developer Team ID and provide the cert via the `CSC_LINK` and `CSC_KEY_PASSWORD` env vars. We don't sign by default.

## CI: GitHub Actions

`.github/workflows/build-mac.yml` runs on every push to `main` (and on `workflow_dispatch`). It:

1. Checks out the repo on a `macos-latest` runner.
2. Installs Node 22 and Python 3.11.
3. `npm install` (rebuilds native deps for both arm64 and x64).
4. Runs `npm run dist:mac -- --publish never`.
5. Uploads `dist/*.dmg`, `dist/*.zip`, `dist/latest-mac.yml`, and block maps as workflow artifacts.
6. Creates a **draft** release tagged `v{run-number}-mac` with the same files attached.

To publish: open the draft release on GitHub, edit the tag to a real semver (`v0.2.0`), publish.

### Triggering a build manually
```bash
gh workflow run "Build Mac DMG" --repo bensblueprints/wispertalk-app --ref main
```

### Why GitHub Actions and not the Mac Mini directly
SSH from some networks is blocked by tailnet ACL. The runners are clean, free, and reproducible. The first run is ~3 min cold; subsequent runs cache `node_modules`.

## Code signing (optional)

### Windows
Add `signAndEditExecutable: true` and `certificateFile` / `certificatePassword` (or `signtoolOptions`) to `build.win` in `package.json`. We don't sign Windows builds either — SmartScreen will warn until the binary builds reputation, but installs work.

### macOS
- Get an Apple Developer Program membership ($99/yr).
- Generate a **Developer ID Application** cert in Apple's developer portal.
- Set in `build.mac`: `"identity": "Developer ID Application: Your Name (TEAMID)"`.
- Run with `CSC_LINK=<base64-encoded-p12>` and `CSC_KEY_PASSWORD=<p12-password>` in env.
- For App Store distribution: also configure `mas` target and use a Mac App Store Distribution cert.
- For notarization (so users don't see the right-click-Open warning): set `notarize.teamId`, plus env vars `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.

## Releasing a new version

1. Bump `version` in `package.json` (semver).
2. Update [`docs/CHANGELOG.md`](CHANGELOG.md).
3. Commit, push to `main`. CI builds Mac. (Windows you build locally and upload separately for now.)
4. Build Windows: on a Windows box, `npm run dist`.
5. Open the draft release the workflow created. Upload the Windows `.exe` files alongside the Mac artifacts. Re-tag from `v{run-number}-mac` to `v{semver}`. Publish.
6. The site at `wispertalk.com` links to `/releases/latest`, so the moment the release is published-not-draft, customers see the new download.

## Troubleshooting build issues

See [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) → "Build errors".
