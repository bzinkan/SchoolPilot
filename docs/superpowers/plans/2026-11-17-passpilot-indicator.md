# PassPilot Indicator Implementation Plan

> For agentic workers: execute the tasks against the shared protocol, with tests
> first and an independent whole-change review before completion.

**Goal:** Prepare one battery-powered blue indicator, standalone gateway and
PassPilot aggregate integration for hardware acceptance when the parts arrive.

**Architecture:** A teacher/class-scoped Redis pairing grants read-only aggregate
HTTPS access. The USB-powered ESP32 forwards authenticated, expiring BLE frames
to the battery-powered Bluefruit. A local configuration tool writes ignored
firmware settings without committing credentials.

**Tech Stack:** Express/TypeScript/Redis, React, CircuitPython, Arduino ESP32.

**Spec:** ../specs/2026-11-17-passpilot-indicator-design.md and
../../../firmware/passpilot-indicator/PROTOCOL.md.

## Global constraints

- No production deployment, migrations or changes to the user's busy checkout.
- Scoped author/class/source authority; no student data or kiosk/staff secrets
  on hardware; TLS verification and BLE authentication are required.
- Stale data never becomes clear; explicit returns control overdue occupancy.
- No hardware or battery runtime claims without physical acceptance.

## Review focus

- Cross-school/class or removed-author credentials must not read occupancy.
- An outstanding pass must remain occupied across overdue/time boundaries.
- HTTP failure, BLE reconnect, replay and restart must not extend stale clear.
- Empty/invalid config and public-CA failures must fail unavailable.
- Water mapping, class source and kiosk attribution must be explicit.

## Tasks

- [x] Backend: tests for mask/source/author scope, entitlement, token hashing,
  expiry/revocation, outages and route response minimization; implement service,
  routes and existing router/session boundaries. Run focused tests and tsc.
- [x] Light: pure protocol/state tests first; implement CircuitPython adapter,
  authenticated frames, bounded buffering, expiry and pulse behavior; syntax check.
- [x] Gateway: portable protocol/state tests first; implement original-ESP32
  Wi-Fi/TLS/BLE firmware without a demo/security bypass;
  compile a pinned dependency build for the selected board.
- [x] Setup: staff setup page, local configuration generator, matching firmware
  settings, secret ignores, and guide. Verify tests and frontend build.
- [x] Review: independent security/contract review of all changed files, fix
  material findings with regression tests, run required validation and package
  usable firmware/build instructions. Record physical and deployment limits.

## Progress

- Isolated branch codex/passpilot-light-prototype at
  C:/GitHub/SchoolPilot-passpilot-light; root checkout untouched.
- User explicitly requested preparation of the already-selected prototype;
  continuing without an additional approval round. No live rollout authorized.
- Firmware and API/web source prepared, pinned light bundle downloaded, original
  ESP32 build exported unconfigured, focused tests and independent review passed.
  See firmware/passpilot-indicator/VALIDATION.md for detailed evidence and the
  unavailable real database/hardware gates. Final canonical browser rerun passed
  3/3 after the initial timeout; the unchanged base also passed 3/3.
