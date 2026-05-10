# WisperTalk

> $49 lifetime voice dictation for Windows + macOS. Hold a key, speak, release; clean text appears wherever your cursor is.

[wispertalk.com](https://wispertalk.com) · public binaries: [`wispertalk-releases`](https://github.com/bensblueprints/wispertalk-releases) · site source: [`whisper-talk-site`](https://github.com/bensblueprints/whisper-talk-site)

---

This README is the canonical "how the whole thing works" document. If you (or a future contributor) walk into this cold, read this top to bottom. Per-area deep dives live in [`docs/`](./docs).

## TL;DR

**WisperTalk** records audio when you hold a hotkey, sends it to Groq Whisper for transcription, optionally cleans the result with Llama 3.3, and pastes the cleaned text into whatever app has focus. Sales + licensing live at `wispertalk.com` (Next.js + Postgres on Coolify). One device per license at a time, enforced server-side. Customers buy at $49 base + $10 per additional device, get keys by email, install the app on Windows or macOS, paste a key, and dictate.

Three Git repos:

| Repo | Visibility | Role |
|---|---|---|
| `bensblueprints/whisper-talk-site` | private | The Next.js site at `wispertalk.com` — landing page, /pricing, /account, /admin, Stripe checkout, license-server API, Groq proxy |
| `bensblueprints/wispertalk-app` | **private** | Electron source — this repo |
| `bensblueprints/wispertalk-releases` | **public** | Built binaries only (`.exe`, `.dmg`, `.zip`). CI publishes here so anonymous customers can download without seeing source |

## 1. What the customer experiences

```
visit wispertalk.com
     │
     │  pricing card has a 0–20 stepper for "additional licenses"
     │  total = $49 + N×$10
     │
     ▼
click "Buy lifetime → $X"
     │
     ▼
Stripe Checkout (cs_live_...)  ──────────►  card payment
     │                                            │
     │ ◄────  redirect /success?session_id=…      │
     │                                            ▼
     │                                  webhook checkout.session.completed
     │                                            │
     │                                            ▼
     │                              site generates 1+N keys (WT-XXXX-XXXX-XXXX-XXXX)
     │                              inserts rows into licenses table
     │                              emails customer via Resend
     │
     ▼
/success page polls DB for keys, displays them with Copy buttons.
Customer also gets the email with the same keys.
```

The customer then visits `/download`, picks Windows or Mac, installs, pastes their key, dictates.

## 2. The two long-running services

### `wispertalk.com` (Coolify app `p5l3w3lo357ehhznye2r8zqn`)

Next.js 15 (App Router) + Drizzle + Postgres, deployed via Coolify on Contabo VPS 2 (`212.28.184.24`). Source: `whisper-talk-site` repo (push to `main` auto-deploys).

Routes:

| Route | Purpose |
|---|---|
| `/` | Hero with typewriter `Windows ↔ Mac`, marquee, how-it-works, comparison, pricing card with stepper, FAQ |
| `/download` | Platform picker, Gatekeeper note for macOS first-run |
| `/account` | Email-based license lookup + "Buy more licenses" CTA |
| `/admin/login` + `/admin` | Operator dashboard. Password = `ADMIN_PASSWORD` env var. Shows gross/refunded/net, license count, last 30 days bar chart, recent licenses |
| `/success` | Post-checkout license reveal — polls DB until webhook has fired, displays keys |
| `/api/checkout` | POSTs to Stripe; accepts `{email?, extraLicenses?}` (0–20); builds 1- or 2-line-item Checkout session |
| `/api/webhook` | Stripe webhook receiver. On `checkout.session.completed` reads back line items, generates one key per unit, inserts in a transaction, emails the customer. On `charge.refunded` sets license status `refunded` and unbinds device |
| `/api/license/activate` | Bind device to license. Returns 7d JWT. 409 if already-active on a different device unless `force: true` |
| `/api/license/verify` | Periodic re-verify (called by app every 6 hours). Returns fresh JWT or 403 if device mismatch / refunded |
| `/api/license/deactivate` | Unbind from current device, freeing for activation elsewhere |
| `/api/license/status` | List licenses by email (used by /account) |
| `/api/groq/[...path]` | **Thin proxy** to `api.groq.com/openai/v1/<path>`. Whitelisted paths only. Used by clients whose IP is on Groq's blocklist (see §6) |

DB schema (Drizzle, `drizzle/0000_clever_vampiro.sql` in the site repo):
- `licenses` — one row per key. `key` is PK, `stripe_session_id` is non-unique (multi-license purchases share it), `amount_cents` is per-row unit price, `active_device_id` is `sha256(deviceId).slice(0,16)`
- `device_events` — append-only audit log of activate/verify/reassign/deactivate
- `stripe_events` — raw event log keyed by Stripe event ID, used for webhook idempotency

Postgres lives in Coolify container `c1yttd5n3sdpc7227q9y9u0p`. Connect via `ssh -i ~/.ssh/id_server212 root@212.28.184.24` then `docker exec c1yttd5n3sdpc7227q9y9u0p psql -U wt -d whispertalk`.

DNS: A `wispertalk.com → 212.28.184.24` (DNS-only / unproxied). CNAME `www → wispertalk.com`.

Site env vars on Coolify:

| Key | Value |
|---|---|
| `DATABASE_URL` | `postgres://wt:.../whispertalk` |
| `STRIPE_SECRET_KEY` | live `sk_live_...` |
| `STRIPE_PUBLISHABLE_KEY` | live `pk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` |
| `STRIPE_PRICE_ID` | `price_1TUqubHpPpTyNMi1U3U4G3sx` ($49 base) |
| `STRIPE_ADDITIONAL_PRICE_ID` | `price_1TUyr5HpPpTyNMi1K3Js9joK` ($10 add-on) |
| `RESEND_API_KEY` | `re_...` |
| `EMAIL_FROM` | `WisperTalk <licenses@advancedmarketing.co>` |
| `LICENSE_JWT_SECRET` | random 48 bytes |
| `ADMIN_PASSWORD` | operator password |
| `ADMIN_COOKIE_SECRET` | random 48 bytes |
| `NEXT_PUBLIC_SITE_URL` | `https://wispertalk.com` |
| `NEXT_PUBLIC_DOWNLOAD_URL` | `https://github.com/bensblueprints/wispertalk-releases/releases/latest` |

### The Electron app (this repo)

`productName: WisperTalk`, `appId: com.wispertalk.app`. App data folder is `app.getPath('userData')`:
- Windows: `%APPDATA%\WisperTalk\`
- macOS: `~/Library/Application Support/WisperTalk/`

What's in the user-data folder:
- `config.json` — every setting (see [`docs/SETTINGS.md`](./docs/SETTINGS.md))
- `device.id` — per-install UUID v4 generated on first run, hashed before sending to the server
- `license.json` — `{key, deviceId, deviceName, email, token, lastVerifiedAt}` after activation

Folder name `freeflow-electron` is historical — it was originally a Windows port of [zachlatta/freeflow](https://github.com/zachlatta/freeflow), a macOS-only original. Don't rename.

## 3. End-to-end dictation flow

```
[user holds hotkey on keyboard]
       │
       │   uiohook-napi raw key event (key-down) on the OS-level hook
       ▼
src/main/hotkey.js → callback → src/main/main.js#handleHoldPress
       │
       ▼
main.js#startRecording():
   - state := 'recording'
   - tray menu rebuilt
   - overlayWin.show() + send('overlay:show', {mode:'recording'})
   - send('recorder:start', {inputDeviceId})
       │
       ▼
src/renderer/overlay.js (the hidden / always-on-top frameless window):
   - getUserMedia({audio: {deviceId? echoCancellation, noiseSuppression, agc, mono}})
     - falls back without deviceId on OverconstrainedError
   - new MediaRecorder(stream, {mimeType:'audio/webm;codecs=opus', 96kbps})
   - new AudioContext() + analyser → bars animate from frequency data
   - chunks accumulate every 250ms

[user releases hotkey]
       │
       ▼
hotkey.js → handleHoldRelease → main.js#stopRecording()
   - state := 'idle', busy := true
   - send('overlay:show', {mode:'processing'})
   - send('recorder:stop')
       │
       ▼
overlay.js: mediaRecorder.stop() → onStopped:
   - blob = new Blob(chunks, {type})
   - arrayBuffer over IPC: send('recorder:audio', {audioBuffer, mimeType})
       │
       ▼
main.js#processAudio(buffer, mimeType):
   - if buffer < 1000 bytes → toast "No audio captured", abort
   - if useAppContext: getForegroundContext()
       (Windows: Win32 GetForegroundWindow + GetWindowText; macOS: AppleScript)
   - transcribe.js: POST multipart to {llmApiBaseUrl}/audio/transcriptions
       (default api.groq.com; for proxy users, wispertalk.com/api/groq)
   - if raw transcript empty → toast "Heard nothing", abort
   - if enableLlmCleanup: postprocess.js POSTs raw + context to /chat/completions
       - falls back to raw on cleanup failure (with a warn toast)
   - paste.js: writeClipboard(final) → simulate Ctrl+V (Windows) /
                                        Cmd+V (macOS via osascript) →
                                        restore previous clipboard after 150ms
   - store.pushHistory({raw, final, context, at})
   - hide overlay, busy := false
   - toast: success with the first 80 chars of the cleaned text
```

License is verified before any of that runs. If `ensureValid` returns invalid (or returns invalid on the periodic 6-hourly recheck), `hotkey.unregister()` runs and the License window opens — dictation is dead until reactivation.

## 4. License lifecycle

Server side:

```
buy → webhook → INSERT INTO licenses (key, email, status='active', stripe_session_id, ...)
         │
         ▼
client first-run → POST /api/license/activate {key, deviceId, deviceName}
         │
         ├── if active_device_id is null → bind, return JWT
         ├── if active_device_id matches sha256(deviceId).slice(0,16) → return JWT (re-up)
         └── if mismatch → 409 already_active
                  │
                  └── client offers "Move license here" → re-POST with force:true
                            → updates active_device_id, audit-logs reassign in device_events

every 6h while running → POST /api/license/verify {key, deviceId}
         │
         ├── if status != 'active' → 403 (refunded / revoked) → client locks
         ├── if active_device_id mismatch → 403 → client locks (you got moved)
         └── ok → fresh 7d JWT

charge.refunded webhook → status='refunded', clear active_device_id
         → next /verify on the bound device returns 403 → client locks within 6h
```

Client side caches a record `{key, deviceId, deviceName, email, token, lastVerifiedAt}` in `userData/license.json`. The `token` is the 7-day JWT (HS256, claims `{k, d, iat, exp}` where `d = sha256(deviceId).slice(0,16)`). Today the verify endpoint validates `(key, deviceId)` against the DB — not the JWT itself. Logged as a known gap in [`docs/LICENSING.md`](./docs/LICENSING.md); planned for a future server release.

`device.id` is a UUID v4 stored in plaintext in `userData/`. The server only ever sees `sha256(deviceId).slice(0, 16)` — short hex string, not reversible.

## 5. Build & release pipeline

`.github/workflows/build-and-release.yml` runs on every push to `main` and produces both Windows and macOS artifacts in parallel:

```
push to main
     │
     ├──► read-version (ubuntu)
     │       outputs version from package.json
     │
     ├──► build-mac (macos-latest)              ─┐
     │       npm install                         │
     │       npm run dist:mac -- --publish never │ both jobs run
     │       upload-artifact                     │ in parallel,
     │       softprops/action-gh-release:        │ ~3 min wall time
     │           tag = v{version}                │
     │           draft = true                    │
     │           repository = wispertalk-releases│
     │                                           │
     ├──► build-windows (windows-latest)        ─┘
     │       npm install
     │       npm run dist -- --publish never
     │       upload-artifact
     │       softprops/action-gh-release: same draft tag
```

Both jobs publish to the SAME draft tag on the public `wispertalk-releases` repo via `RELEASES_PAT` secret (cross-repo write needs a Personal Access Token, GITHUB_TOKEN can't reach another repo). After the build finishes, edit the draft → publish → it becomes `latest` and the site download page picks it up automatically.

To ship a new version:
1. Bump `version` in `package.json`
2. Update [`docs/CHANGELOG.md`](./docs/CHANGELOG.md)
3. Push to `main`
4. Wait ~3 min, edit draft release, publish

Pinned in the workflow:
- Node 22 (cached)
- **Python 3.11** — necessary because `node-gyp` still imports `distutils`, removed in Python 3.12+. The macOS / Windows runners default to Python 3.13. Without this, native module rebuild fails.
- `--publish never` — without this, electron-builder auto-detects CI, sees missing GH_TOKEN, fails. We use `softprops/action-gh-release` explicitly.

### Owner build mechanism

Separate workflow `build-owner-windows.yml` (workflow_dispatch only). Takes a `license_key` input and bakes it into `package.json` via `electron-builder --c.extraMetadata.embeddedLicenseKey=...`. The license module ([`src/main/license.js`](./src/main/license.js)) reads `package.json#embeddedLicenseKey` on first launch via `getEmbeddedKey()`; if set and no local license exists, calls `activate()` automatically. Public builds don't have the field, so this is a no-op for them.

Trigger:
```bash
gh workflow run "Build Owner Windows" --repo bensblueprints/wispertalk-app -f license_key=WT-XXXX-XXXX-XXXX-XXXX
```

Artifacts upload to the workflow run (not a release). Download via `gh run download`, attach to a private release on `wispertalk-app` (not the public mirror), give the URL to whoever needs the build.

## 6. The Groq IP-block proxy

**The problem.** Some residential ISP IPs get HTTP 403 from `api.groq.com` with body `{"error":{"message":"Access denied. Please check your network settings."}}`. Confirmed by probing the same key from two networks — blocked from one, fine from another. The block is at Groq's edge, not on the local machine, not the key. Most likely cause: Groq's abuse heuristics flagged the IP at some point.

**The fix.** `whisper-talk-site/src/app/api/groq/[...path]/route.ts` — a thin path-whitelisted proxy that forwards client requests to `api.groq.com`. Source IP for the upstream call is the VPS, which is allowed. The client's `Authorization: Bearer gsk_...` is forwarded verbatim, so Groq still authenticates as the customer's key (no shared secrets, no abuse from us).

**Client config to use the proxy:**
```json
{ "llmApiBaseUrl": "https://wispertalk.com/api/groq" }
```

The Electron app's `transcribe.js` and `postprocess.js` both build URLs as `${baseUrl}/audio/transcriptions` and `${baseUrl}/chat/completions`, so this works without code changes — they hit the proxy paths transparently.

Default for new installs is still direct `https://api.groq.com/openai/v1` — most users aren't blocked. If a customer reports 403s, point them at the proxy URL.

## 7. Hosting & operations

| Service | Where | Cost |
|---|---|---|
| Site + licensing API + proxy | Coolify on Contabo VPS 2 (212.28.184.24) | ~$13/mo (existing VPS) |
| Postgres | Coolify-managed container `c1yttd5n3sdpc7227q9y9u0p` on the same box | $0 |
| GitHub Actions (CI builds) | GitHub. 2,000 private-repo min/mo on free; we use ~10 min per release | $0 within limits |
| Stripe | 2.9% + $0.30 per transaction | per sale |
| Resend (license emails) | Free tier 3,000/mo | $0 |
| Groq API (paid by customer's key) | $0 to operator | per audio minute / token |
| Cloudflare DNS | Free | $0 |
| Apple Developer Program | NOT enrolled — Mac builds are unsigned, customers right-click → Open the first time | $0 |

### Operational dashboards

- **Admin** (operator): `https://wispertalk.com/admin/login` · sales metrics, license counts, last-30-days chart, recent licenses table.
- **Coolify**: `http://212.28.184.24:8000` — manage app, env vars, logs.
- **Stripe**: dashboard.stripe.com — view charges, customers, refund flow, webhook delivery logs.
- **GitHub Actions**: [Actions tab](https://github.com/bensblueprints/wispertalk-app/actions) — build status, artifact downloads, manual workflow runs.

### Customer dashboards / self-serve

- **/account** — email lookup. Lists every license on that email and which device each is bound to. "Buy more licenses ($10 each)" CTA at the bottom.
- The app's **Settings → License** tab — view license, deactivate this device.
- **30-day refund** — email `licenses@advancedmarketing.co` (or reply to purchase confirmation). Stripe refund auto-locks the license via the webhook.

## 8. Where to look when something breaks

| Symptom | First place to check |
|---|---|
| Site is down | Coolify dashboard `http://212.28.184.24:8000` — is the app container up? Look at deploy logs. |
| Customer paid but didn't get a key | Stripe dashboard → Webhooks → check delivery for that event. If failed, replay. If succeeded, query Postgres for licenses with their `stripe_session_id`. |
| Customer can't activate | `POST /api/license/status` with their email. If license shows `status:'refunded'`, that's why. Otherwise, check if `active_device_id` is set to something else. |
| App says "Missing API key" | Their Settings → API → Groq key is empty. Tell them to grab one at console.groq.com. |
| App says "Access denied. Please check your network settings" (403) | Groq IP-block. Have them set `llmApiBaseUrl` to `https://wispertalk.com/api/groq` (see §6). |
| Mac DMG won't open | Right-click → Open. We're not code-signed. Documented in `/download` page and [`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md). |
| Audio bars not moving (older version) | Pre-v0.2.2 had a race where the visualization loop started before the AudioContext analyser existed. v0.2.2 fixed it; tell them to update. |
| Customer hits Groq 429 (rate limit) | Their Groq tier is exhausted. Upgrade or wait. We don't pay for Groq — they do. |
| Need to grant a comp license | `docker exec c1yttd5n3sdpc7227q9y9u0p psql -U wt -d whispertalk -c "INSERT INTO licenses (key, email, stripe_session_id, amount_cents, currency, status) VALUES ('WT-XXXX-XXXX-XXXX-XXXX', 'user@example.com', 'cs_comp_<unique>', 0, 'usd', 'active');"` |

## 9. The audit trail of "things that broke during launch"

For posterity, what went wrong on 2026-05-09 / 10 and how it was fixed:

1. **DB migrations never ran in prod.** `drizzle/0000_clever_vampiro.sql` was never executed against the Coolify Postgres. Any real customer purchase would have failed at the webhook insert. Fixed by piping the SQL via `docker exec`. Future: run migrations as part of Coolify deploy.
2. **Mac DMG couldn't be built from Windows.** electron-builder's DMG target shells out to `hdiutil` which only exists on macOS. Workaround: GitHub Actions `macos-latest` runner.
3. **GitHub Actions Mac build failed at `node-gyp` rebuild.** Default Python on the runner was 3.13, which removed `distutils`. Pin Python 3.11 via `actions/setup-python@v5`.
4. **electron-builder tried to auto-publish to GitHub releases without GH_TOKEN.** Detected CI, attempted publish, exited non-zero even though build artifacts were correctly produced. Fix: `--publish never` — let our explicit `softprops/action-gh-release` step handle release creation.
5. **Customer downloads from a private repo 404 anonymously.** When `wispertalk-app` was made private, links to `releases/latest` broke for unauthenticated visitors. Created `wispertalk-releases` (public) and switched the cross-repo PAT-driven publishing target.
6. **Audio bars in overlay didn't animate (visualization-only bug).** `setMode('recording')` ran before `getUserMedia()` resolved, so the visualization loop never started — `analyser` was still null when `startMeter()` ran. Fix: explicitly call `loop()` at the end of `startRecording()` once the analyser is wired, and `audioCtx.resume()` if it lands suspended.
7. **Groq 403 from Ben's residential IP.** Solved with the proxy described in §6.

## 10. Per-area docs

| Doc | What's in it |
|---|---|
| [`docs/USER_GUIDE.md`](./docs/USER_GUIDE.md) | End-user walkthrough — install, license, settings, daily use |
| [`docs/SETTINGS.md`](./docs/SETTINGS.md) | Every setting field, what it does, defaults, recommended values |
| [`docs/BUILDING.md`](./docs/BUILDING.md) | Local build steps + the GitHub Actions pipeline + signing notes |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | Process model, IPC channels, file layout |
| [`docs/LICENSING.md`](./docs/LICENSING.md) | License-server API contract, JWT shape, refund flow, threat model |
| [`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md) | Common issues by symptom |
| [`docs/ROADMAP.md`](./docs/ROADMAP.md) | v0.3 / v0.4 plans + parked work |
| [`docs/CHANGELOG.md`](./docs/CHANGELOG.md) | Release notes |

## 11. Future work parked

See [`docs/ROADMAP.md`](./docs/ROADMAP.md). Highlights:
- Code-sign macOS builds (Apple Developer Program — $99/yr — only if customer demand justifies)
- Wire `electron-updater` to consume `latest.yml` / `latest-mac.yml` so users auto-update (the YAML is already produced, just not consumed)
- Server-side: validate JWT in `/api/license/verify` (currently only checks `(key, deviceId)` against DB)
- Server-side: wrap activate's read-modify-write in a `SELECT FOR UPDATE` transaction (closes a TOCTOU race on simultaneous first-time activations)
- Local-only mode bundling whisper.cpp (no API needed at all)
- Per-app prompt overrides (different cleanup persona per foreground app)
