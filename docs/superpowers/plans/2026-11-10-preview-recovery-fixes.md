# Expanded Preview Recovery Fixes Implementation Plan

> **For agentic workers:** Implement the two independent fixes in their owning repositories with failing regressions first, then review both changes together before release.

**Goal:** Keep grid captures running through detail rate limits and automatically restore clearer previews after a temporary dashboard timeout.

**Architecture:** Give extension detail HTTP uploads their own existing-style backoff state. Restart a timed-out dashboard viewer after five seconds with a fresh actor-bound viewer instance; retain generation-fenced late lease cleanup.

**Tech Stack:** Existing Manifest V3 JavaScript, React, Node browser harnesses, S3 and CloudFront.

**Spec:** `docs/superpowers/specs/2026-11-10-expanded-previews-design.md`, plus the two confirmed review findings and the operator's November 10 authorization to fix, deploy, package and clean up.

## Global Constraints

- Preserve extension version 3.0.5, five-second detail cadence, JPEG90/native-width maximum 1920 and 20-second leases.
- Preserve routine JPEG50/640 thumbnails, existing reference/delta transport, features, authority and retention.
- No paid AWS tests, new test infrastructure, Store upload or runtime flag changes.
- Preserve primary checkouts, old candidate bytes and immutable release tags.
- The operator already authorized implementation and deployment without further design approval.

## Review Focus

- A detail-only 429 must not delay ordinary captures; detail requests must still respect their own backoff.
- A timeout must retry only while the same selected preview is visible, with a fresh viewer ID.
- A retired request's late completion must release its own lease and never revoke or paint its successor.
- Close, hide and context changes must cancel pending retries.
- Lease retirement during backoff must prevent a late upload.

### Task 1: Extension detail backoff

**Files:** ClassPilot `extension/service-worker.js`, existing detail preview unit/native browser harnesses, candidate release notes.

**Interface:** Existing authenticated detail upload payload and response stay unchanged; only its local backoff lane changes.

- [ ] Add a real production-path regression for detail 429 followed by an ordinary capture; run and inspect its expected failure.
- [ ] Isolate detail backoff and cover retry/retirement; verify focused tests, type/unit/build and native capture gates.
- [ ] Update candidate notes and commit only this fix and its tests.

### Task 2: Dashboard timeout recovery

**Files:** `schoolpilot-app/src/products/classpilot/hooks/useExpandedScreenshotDetail.js`, `schoolpilot-app/scripts/classpilot-dashboard-load-state.test.mjs`.

**Interface:** The visible viewer retries five seconds after its existing eight-second deadline using a new viewer ID. Its retired raw promise keeps exact late cleanup.

- [ ] Add browser regressions for timeout recovery, successor-safe late cleanup and cancellation on close/hide; inspect failures before implementation.
- [ ] Add an effect-owned retry timer, clear it with viewer cleanup and restart only the current visible selection.
- [ ] Verify focused detail/native zoom cases, required dashboard gates, frontend lint and build; commit.

### Task 3: Review and release

- [ ] Obtain a fresh whole-change review, resolve significant findings, and confirm exact-head CI before merging both PRs.
- [ ] Deploy the matching SchoolPilot frontend from clean merged main through the documented frontend procedure; verify public asset identity, targeted invalidation and stable API/worker health.
- [ ] Canonically package clean tagged ClassPilot main and run the full exact-ZIP gate; archive the prior 3.0.5 candidate, then deliver verified versioned/compatibility ZIPs and identity receipt to primary `dist`.
- [ ] Confirm final checks and remove only task branches after merge. Report adoption/capacity limits accurately.
