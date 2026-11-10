# Clear Expanded Student Previews Implementation Plan

> **For agentic workers:** Execute the authorized work in coordinated backend, extension and frontend tasks. Use test-driven development for each task and a fresh independent whole-change review before merge.

**Goal:** Readable expanded student screenshots without increasing grid image traffic.

**Architecture:** Separate exact-binding, short-lived detail capture and storage from routine thumbnails. An additive server policy controls the extension; a visible dialog renews the authorized detail lease and displays decoded images with native-size zoom.

**Tech Stack:** Existing TypeScript/Express, Redis, React/Vite and Manifest V3 JavaScript; no new dependency.

**Spec:** `docs/superpowers/specs/2026-11-10-expanded-previews-design.md`

## Global Constraints

- Keep ClassPilot extension version 3.0.5; no Store submission.
- Detail JPEG90, native size capped at 1920 pixels, five-second minimum interval.
- Detail leases/images expire within 20 seconds; visible frontend polls every five seconds.
- Preserve routine JPEG50/640-pixel captures and image reference/delta behavior.
- Device IDs remain server/transport internal; never broaden missing targets.
- Preserve current authority, observation, retention, decoding and Windows source boundaries.
- Preserve unrelated work and archives; use clean task worktrees.

## Review Focus

- Delayed responses after sign-out, ownership, source or revision changes must never paint old pixels.
- Multiple viewers and reordered renew/release requests must not stop another valid viewer or resurrect an expired grant.
- Policy expiry/revocation during native capture, resize or upload must reject the detail image.
- Older extensions/backends and failed Redis reads must retain ordinary thumbnails without granting detail capture.
- Detail images, image references, payloads and caches must never enter grid or safety evidence paths.

### Task 1: Backend detail lease, storage and authorized routes

**Files:** `src/services/classpilotDetailPreview.ts`, `src/services/classpilotScreenshotPolicy.ts`, `src/routes/classpilot/devices.ts`, and focused backend tests.

**Interfaces:** Produce the student-scoped detail-preview renew/read and release routes, additive `screenshotPolicy.detailPreview`, and `captureKind: 'detail_preview'` upload branch specified in the design. Reuse existing exact screenshot authority checks and internal bindings.

- [ ] Add and run failing tests for lease expiry/replacement, actor/school isolation, exact authority, separate images, stale uploads, multiple viewers and fail-closed store behavior.
- [ ] Implement bounded shared-store detail leases/images without touching routine image/reference/delta storage.
- [ ] Run focused regressions, `npm run check`, `npm run build`, `npm run check:tests`, `npm run check:test-casts` and serial `npm test`; inspect results and `git diff --check`.

### Task 2: ClassPilot 3.0.5 detail capture

**Files:** Separate repository `extension/service-worker.js`, focused Vitest/native Chrome tests, `docs/CLASS_PILOT_3_0_5_CANDIDATE.md`, `extension/README.md`.

**Interfaces:** Consume Task 1's additive policy and send full-image detail uploads through the existing device-authenticated route. Preserve routine thumbnail generation exactly and keep detail out of reference/delta and safety paths.

- [ ] Write and run failing tests for policy parsing, capability/authority gates, expiry, asynchronous revocation, JPEG90 dimensions and detail throttle.
- [ ] Implement separate capture with native capture spacing, independent generation fencing and no persistent image storage.
- [ ] Run `npm run check`, `npm test`, `npm run build`, `npm run test:extension:chrome` and `git diff --check` using Node 24 or newer.
- [ ] Update candidate documentation with the additive contract and remaining separate Store/managed-device acceptance.

### Task 3: Expanded preview lifecycle and native zoom

**Files:** `schoolpilot-app/src/products/classpilot/components/ScreenshotPreviewDialog.jsx`, `pages/Dashboard.jsx`, a focused detail-preview hook, decoded-image support if needed, and existing browser regression scripts.

**Interfaces:** Consume Task 1's student-scoped routes only for the visible authorized browser dialog. Maintain detail-local state outside grid queries. Release on close/hide/context/source transitions.

- [ ] Write and run failing browser tests for native 100%/125% zoom using 640/1280-pixel images and isolated detail lifecycle.
- [ ] Implement decoded detail fallback, five-second visible polling, cleanup and exact context fencing.
- [ ] Verify delayed failures/revocation and source changes cannot leak detail images or affect grid requests.
- [ ] Run lint, build, student-tile browser and required tile-batching, session-lifecycle, realtime-cache, signal-loss, command-context and Radix browser gates. Run fixed-port browser suites serially.

### Task 4: Review, commit and CI

- [ ] Have a fresh reviewer inspect both repositories against the design and Review Focus, including cross-repository wire compatibility.
- [ ] Resolve important findings with regression evidence; verify current diff and required checks.
- [ ] Commit only task changes, push task branches and create PRs with exact validation evidence.
- [ ] Confirm all relevant checks green at the exact final PR heads, then merge both PRs and remove remote task branches.
- [ ] Wait for green SchoolPilot main CI at the actual deployment commit.

### Task 5: Deploy and verify

- [ ] Use a clean checkout on main matching origin/main; follow `CLAUDE.md` guarded backend deployment with the reviewed emergency-size posture and preserve live runtime flags.
- [ ] Verify API/worker convergence and public health, then deploy frontend and verify targeted CloudFront invalidation plus served asset identity.
- [ ] Package final clean merged ClassPilot 3.0.5 source with the canonical script; run full `npm run test:extension:package`, inspect inventory and record SHA-256/source revision.
- [ ] Archive previous unsubmitted 3.0.5 artifact/receipt by identity before delivering the new verified bytes and supersession receipt to primary `dist`.
- [ ] Verify both merges, deployment and artifact; remove only task-owned clean worktrees/local branches and report remaining separate Store publication.
