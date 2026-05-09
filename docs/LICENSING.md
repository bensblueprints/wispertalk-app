# Licensing

How the license module talks to the server, what data flows where, and how to mock it for local development.

## Server

Licenses are managed by the Next.js + Postgres server at [bensblueprints/whisper-talk-site](https://github.com/bensblueprints/whisper-talk-site), deployed at `https://wispertalk.com`. The client never talks to anything else for licensing.

## Endpoints

All endpoints are POST-only, JSON in / JSON out. CORS-open so the Electron client can hit them from any IP.

### `POST /api/license/activate`

Bind a license to this device.

**Request:**
```json
{
  "key": "WT-ABCD-1234-EFGH-5678",
  "deviceId": "<per-install UUID>",
  "deviceName": "Bens-MacBook-Pro",
  "force": false
}
```

**Response 200:**
```json
{
  "ok": true,
  "token": "<jwt, 7d expiry>",
  "license": {
    "key": "WT-...",
    "email": "ben@example.com",
    "status": "active",
    "activeDeviceName": "Bens-MacBook-Pro",
    "activatedAt": "2026-05-09T10:00:00Z"
  }
}
```

**Response 409 — already active on another device:**
```json
{ "ok": false, "code": "already_active", "activeDeviceName": "Other-Device" }
```

The client surfaces a "Move license here" button. Re-call with `force: true` to take over.

**Response 403 — license not active (refunded/revoked):**
```json
{ "ok": false, "code": "not_active", "status": "refunded" }
```

### `POST /api/license/verify`

Periodic re-verification. Called every 6 hours by the running app.

**Request:**
```json
{
  "key": "WT-...",
  "deviceId": "<per-install UUID>"
}
```

**Response 200:**
```json
{ "ok": true, "token": "<fresh jwt>" }
```

**Response 403:**
```json
{ "ok": false, "code": "device_mismatch" }
```

The client locks (`hotkey.unregister()` + reopens the License window) on any non-OK response other than network failures, which it treats as transient.

### `POST /api/license/deactivate`

Unbind from the current device, freeing the license for activation elsewhere.

**Request:**
```json
{ "key": "WT-...", "deviceId": "<uuid>" }
```

**Response 200:**
```json
{ "ok": true }
```

### `POST /api/license/status`

Look up licenses for an email (used by the Account page on the website, not by the client).

**Request:**
```json
{ "email": "ben@example.com" }
```

**Response 200:**
```json
{ "licenses": [{ "key": "WT-...", "status": "active", "activeDeviceName": "..." }] }
```

## Device fingerprint

The per-install `deviceId` is a UUID v4 generated on first run and stored at `app.getPath('userData')/device.id`. **The raw UUID never leaves the machine in plaintext.** The server stores `sha256(deviceId).slice(0, 16)` as `active_device_id`, which is enough to detect mismatch but not to reverse-engineer the source UUID.

Calling `/api/license/activate` always sends the raw `deviceId`; the server hashes server-side. For `/verify`, the client sends raw too, and the server hashes-and-compares.

## JWT shape

Server signs with HS256 using `LICENSE_JWT_SECRET`. Claims:

```json
{
  "k": "WT-...",        // license key
  "d": "<fingerprint>", // sha256(deviceId).slice(0,16)
  "iat": 1762000000,
  "exp": 1762604800     // +7 days
}
```

The client stores the token and treats it as opaque — never validates it locally. The server validates on every `/verify` response.

> **Note**: today the `/verify` endpoint validates `(key, deviceId)` against the DB, not the JWT. Anyone with the key + deviceId could mint a fresh token. This is a known gap; planned fix in v0.2.0 of the server is to require the JWT and check `claims.k === key && claims.d === fp` before issuing a fresh one.

## Refund flow

When a Stripe `charge.refunded` webhook arrives at `/api/webhook`, the server:

1. Looks up the license by `stripe_payment_intent_id`.
2. Sets `status = 'refunded'`, `refunded_at = now`, nulls `active_device_id` and `active_device_name`.
3. The client's next `/verify` call returns 403 (status check fails before device check).
4. Client locks within 6 hours.

For multi-license purchases (one base + N additional), the refund applies to ALL licenses in the same Stripe session — the webhook walks rows by `payment_intent_id`.

## Local dev without the licensing server

Two options:

### Option A: point at a localhost server

If you've cloned `whisper-talk-site` and have it running on port 3001:

```bash
LICENSE_API=http://localhost:3001 npm start
```

The client reads `process.env.LICENSE_API` if set, falling back to `https://wispertalk.com`.

### Option B: stub `license.js`

Patch `src/main/license.js` locally:

```js
async function ensureValid() {
  return { valid: true };
}
```

Don't commit this. The hotkey will register without server gating; you can dictate.

## Storage

All licensing state is in `app.getPath('userData')`:

```
%APPDATA%\WisperTalk\        (Windows)
~/Library/Application Support/WisperTalk/   (macOS)
├── config.json     # all settings (see SETTINGS.md)
├── device.id       # per-install UUID, generated once
├── license.json    # {key, email, token, lastVerifiedAt, deviceName}
└── history/        # (planned: log files, currently nothing)
```

Wiping the folder fully resets everything: settings, history, license binding. The license itself is still owned by you (the server still has the row); you just have to re-activate by entering the key.

## Threat model summary

| Surface | What we protect | What we don't |
|---|---|---|
| Audio in transit | TLS to your STT endpoint | Whatever your STT provider does with audio |
| License key | Stored locally, sent only to wispertalk.com | A local attacker could read it |
| Device sharing | One device active at a time, hashed fingerprint | A determined attacker who has both `deviceId` (in user-data) AND key can re-mint tokens |
| Server takedown | Client tolerates `fetch_failed` for ~6h before locking | Extended outage = extended lockout |

This is a low-cost commercial product with one full-time author. The licensing exists to prevent casual sharing, not to be DRM-uncrackable.
