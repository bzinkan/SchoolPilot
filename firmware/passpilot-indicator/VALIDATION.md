# Prototype validation — November 17, 2026

Prepared in `C:/GitHub/SchoolPilot-passpilot-light`, branch
`codex/passpilot-light-prototype`, based on `c265a3ab`.
No deployment or live credential provisioning was performed.

## Verified software

| Check | Result |
| --- | --- |
| Backend `npm run check` and `npm run build` | Pass |
| Test typecheck (after building compiled test imports) | Pass; 436/534 allowed existing test-only diagnostics; zero application diagnostics |
| Unsafe test cast ratchet | Pass; no increase |
| Indicator backend tests | 11 passed |
| Combined indicator + existing session/CSRF/kiosk-schedule regressions | 29 passed |
| Frontend production build | Pass; existing Zod annotation/chunk-size warnings |
| Indicator pairing/download/revoke browser test | Pass |
| Changed frontend files ESLint | Pass |
| Existing legacy-class browser suite | 1 passed |
| Existing canonical-class browser suite | Final run 3 passed |
| Existing pass-data suite | 10 passed |
| Light protocol/state tests | 13 passed |
| Light/preparation Python syntax | Pass |
| Pinned light download preparation | Pass; UF2 and library SHA256 checks verified |
| Native gateway protocol/state tests | Pass |
| Actual original-ESP32 PlatformIO build | Pass; 759,613 bytes flash (58%), 33,680 bytes static RAM (10.3%) |
| Privileged-access and tenant-isolation evidence collectors | Pass; local ignored evidence generated |
| Independent security/contract code review | No critical or important findings; minor guide/export notes corrected |
| `git diff --check` | Pass |

Gateway binaries are in ignored `gateway/dist/`. They are deliberately
**unconfigured**, with no WiFi/password/pairing secrets; a classroom gateway
must be rebuilt after generating `gateway/include/config.h`.
Exported `firmware.bin` SHA256:
`ed25d8685ba6c01d3a2daffeefddd6d73c331cf7b93d489cf5e62f7626d03532`.

## Remaining gates

* The real PostgreSQL/RLS indicator integration suite is registered in the serial
  DB lane, but was not executed: no local PostgreSQL fixture was available and
  the Docker daemon was unavailable. It skips without `DATABASE_URL`. The full
  database-dependent backend test suite was therefore not run.
* No real Redis Lua execution or deployed gateway HTTP response was exercised.
  Store unit tests cover digest-only storage and failure behavior with a fake
  Redis adapter; SQL-shape tests verify the emitted scoped query.
* Approved school WiFi/NTP, classroom range, brightness, enclosure fit, battery
  runtime and Chromebook USB sleep behavior need physical acceptance. See the
  main guide's checklist.
* Live pairing requires reviewed deployment of both the API and web changes.
  The prototype represents one teacher/class/source and one gateway/light.

An initial run of the broader canonical-class browser suite timed out after
migration cutover. A separate unchanged-base checkout passed 3/3, and the final
fresh build/run on this branch also passed 3/3 (82.17 seconds). No unrelated
source changes were made to address the initial timeout. Local preview emitted
backend-proxy connection noise in both baseline and passing final runs.

## Bluefruit bench check

Installed CircuitPython 10.3.2 and the light program on the physical Bluefruit.
The on-device test exposed unsupported `bytearray` deletion. After replacing it
with bounded scanning and a slice, the known authenticated frame, fragmented
frame, replay rejection, and expiration checks passed on the board. NeoPixel
commands and BLE advertising initialization also passed. The application boots
in the unavailable state while awaiting a gateway pairing.

## Two board bench check

Windows recognized the gateway after installation of the Microsoft-signed
Silicon Labs CP210x driver. The programmer confirmed an original ESP32 with
4 MB of flash. A temporary offline test image passed the on-device mbedTLS
self-test, connected to the Bluefruit, and sent authenticated simulated occupied
and clear states. The Bluefruit reported occupied, clear, then unavailable when
the gateway disconnected. The regular classroom firmware was restored and
verified on both boards. The gateway awaits the live PassPilot pairing and
classroom WiFi configuration.
