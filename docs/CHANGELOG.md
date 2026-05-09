# Changelog

All notable changes to WisperTalk. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

Planned for v0.2.0 — see [`ROADMAP.md`](ROADMAP.md).

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
