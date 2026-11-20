# PassPilot indicator prototype protocol v1

Hardware: Adafruit Circuit Playground Bluefruit #4333 with Adafruit #727 AAA
holder; Inland ESP32-WROOM-32D (original ESP32, not S3) as the USB-powered gateway.
The Chromebook supplies power only. The gateway independently uses Wi-Fi/HTTPS.

## HTTP

Staff setup creates a revocable, 30-day opaque credential for one school, one
author, and either one owned kiosk or one authorized class. The gateway stores
the pairing credential. Every state read rechecks school lifecycle, PassPilot
entitlement, active staff membership and authority for the target. Redis stores
the token hash and bounded pairing configuration. A Redis outage yields an
unavailable state.

`GET /api/passpilot/indicators/pairings/kiosks` (staff authentication) lists the
caller's eligible kiosks as `{kiosks: [{kioskSessionId, className, lastSeenAt}]}`.
The server resolves a session to the owned device and its binding generation.
`POST /api/passpilot/indicators/pairings` (normal staff auth/CSRF) accepts
`{kioskSessionId, waterCustomDestination?}` or `{classId, waterCustomDestination?}`.
`waterCustomDestination` is an exact configured
custom-destination string, not an ID or substring match. Returns
`{pairingId, token, expiresAt}` once. `DELETE /api/passpilot/indicators/pairings/:id`
revokes only the caller's same-school pairing. The token is `ppi_` followed by
43 base64url characters (32 random bytes). Store/revoke with a separately random
pairing UUID so deletion never places the bearer token in a URL.

`GET /api/passpilot/indicators/state` uses `Authorization: Bearer <token>` and
returns exactly `{version:1, mask:0..7, maxAgeSeconds:30}` with no-store.
Blue is bit 1, office/yellow bit 2, nurse/red bit 4. Only active passes issued by
the pairing's exact author for its configured target count. A kiosk pairing
uses the originating kiosk session across class changes and resumes. A class
pairing checks the exact class and its source. Overdue passes count until they
are returned or canceled. Loss of authority yields an unavailable state. The
response contains only the aggregate mask, protocol version and freshness limit.

Gateway polls every 5 seconds. An invalid response, non-200 status, TLS failure,
timeout or auth failure cannot extend a last-known clear/occupied state. It may
continue displaying the last valid state only until its original freshness
deadline, at most 30 seconds. Do not follow redirects carrying credentials.
HTTPS certificate and hostname validation are mandatory; no insecure TLS mode.

## Bluetooth

Use Nordic UART service (NUS): service
`6e400001-b5a3-f393-e0a9-e50e24dcca9e`, RX/write
`6e400002-b5a3-f393-e0a9-e50e24dcca9e`, TX/notify
`6e400003-b5a3-f393-e0a9-e50e24dcca9e`.
Advertisement name is `PP-Light-<short suffix>` and is explicitly configured in
the gateway. The light sends `H,<16 lowercase hex nonce digits>\n` (19 bytes),
repeating every two seconds until it receives a valid command. Generate a fresh
8-byte random nonce on every BLE connection; never reuse an earlier challenge.

The light and gateway share a locally generated 32-byte key, never sent over BLE.
A command is exactly 16 bytes (fits the default ATT MTU):

| Offset | Length | Field |
| --- | --- | --- |
| 0 | 1 | 0x50 |
| 1 | 1 | version 0x01 |
| 2 | 4 | sequence, unsigned big-endian, starts at 1 per connection |
| 6 | 1 | category mask 0..7 |
| 7 | 1 | remaining freshness TTL, 1..30 seconds |
| 8 | 8 | first 8 bytes of HMAC-SHA256(key, nonce + first 8 frame bytes) |

Authenticate before changing state; reject malformed, wrong-tag, repeated or
decreasing sequence, mask outside 0..7, TTL outside 1..30. Invalid traffic never
refreshes the timer. Buffer bounded fragmented UART writes; do not assume a
read is a complete frame. Gateway re-sends once per 5 seconds while HTTP state
remains fresh, using remaining TTL (not a new 30-second lease). New BLE challenge
resets the sequence but does not refresh HTTP state. Expiry or BLE disconnect
shows unavailable immediately or by the shorter existing freshness deadline.

The single prototype displays blue if bit 1 is set, off if bit 1 is clear, and a
slow white pulse at startup/disconnect/stale/unavailable. Brightness defaults
to 10%; do not claim measured runtime before a physical battery test. Category
selection supports yellow/bit 2 and red/bit 4 for later separate pucks.

No Wi-Fi credentials, API tokens, BLE keys or student identifiers may appear in
source control or serial logs. Configuration is created locally in ignored
files. Debug mode must not bypass authentication or certificate validation.
