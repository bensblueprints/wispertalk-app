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

Both DMGs are **unsigned unless the CI Apple secrets are set** (see below). To sign locally, provide the cert via the `CSC_LINK` and `CSC_KEY_PASSWORD` env vars and pass `-c.mac.notarize=true` with `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` set.

## CI: GitHub Actions

`.github/workflows/build-and-release.yml` runs on every push to `main` (and on `workflow_dispatch`). The `build-mac` job:

1. Checks out the repo on a `macos-latest` runner.
2. Installs Node 22 and Python 3.11.
3. `npm install` (rebuilds native deps for both arm64 and x64).
4. Builds the DMGs. If the Apple secrets below are set it signs with the Developer ID cert and notarizes with Apple (`-c.mac.notarize=true`); otherwise it builds unsigned.
5. Publishes `dist/*.dmg`, `dist/*.zip`, `dist/latest-mac.yml` to the public `bensblueprints/wispertalk-releases` repo under tag `v{version}`.

### Triggering a build manually
```bash
gh workflow run "Build & Release" --repo bensblueprints/wispertalk-app --ref main
```

### Why GitHub Actions and not the Mac Mini directly
SSH from some networks is blocked by tailnet ACL. The runners are clean, free, and reproducible. The first run is ~3 min cold; subsequent runs cache `node_modules`.

## Code signing

### Windows
We don't sign Windows builds — SmartScreen will warn until the binary builds reputation, but installs work.

### macOS (signed + notarized via CI)
Repo secrets needed on `bensblueprints/wispertalk-app`:

| Secret | What |
| --- | --- |
| `MAC_CERTS_P12` | base64 of the **Developer ID Application** cert + private key exported as `.p12` (Keychain Access → My Certificates → right-click → Export) |
| `MAC_CERTS_PASSWORD` | password chosen at `.p12` export |
| `APPLE_ID` | Apple Developer account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | 10-char Team ID from developer.apple.com → Membership |

Requires an active Apple Developer Program membership ($99/yr). With those set, CI output passes Gatekeeper with no warning — users just drag to Applications and open.

## Releasing a new version

1. Bump `version` in `package.json` (semver).
2. Update [`docs/CHANGELOG.md`](CHANGELOG.md).
3. Commit, push to `main`. CI builds Mac. (Windows you build locally and upload separately for now.)
4. Build Windows: on a Windows box, `npm run dist`.
5. Open the draft release the workflow created. Upload the Windows `.exe` files alongside the Mac artifacts. Re-tag from `v{run-number}-mac` to `v{semver}`. Publish.
6. The site at `wispertalk.com` links to `/releases/latest`, so the moment the release is published-not-draft, customers see the new download.

## Troubleshooting build issues

See [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) → "Build errors".
