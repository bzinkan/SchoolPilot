# ClassPilot Recovery Implementation Plan

> **For agentic workers:** Implement the independent repository tasks with test-driven development and independent code review.

**Goal:** Repair the reproduced extension deadlock and stop diagnosing disconnected Chromebooks as outdated.

**Architecture:** Preserve existing authority boundaries and serialization, while eliminating the cleanup/FAB/overlay promise cycle. Add a reasoned server chat-readiness result and render its connection/update states in the existing chat hook.

**Tech Stack:** MV3 JavaScript, Node/Vitest/Playwright; Express/TypeScript/PostgreSQL/Redis; React/Vite.

**Spec:** `docs/superpowers/specs/2026-11-09-classpilot-recovery-design.md`

## Global Constraints

- Work only in the two isolated `20261109` worktrees; preserve other sessions' changes.
- Preserve exact binding, generation fencing, tenant isolation and private-chat lifecycle authorization.
- No device IDs in teacher APIs/UI, and no target broadening.
- No application deployment or Store submission is authorized by this repair request.
- Prove each regression fails before implementation and passes after repair.

## Review Focus

- Same-binding heartbeat overlapping a running FAB class transition must complete.
- Identity changes and delayed prior-identity writes must remain fenced.
- Stale, missing and unavailable Redis snapshots must never assert an update is required.
- Fresh clients that actually lack private chat capability must still be rejected accurately.
- Reconnection and lifecycle refresh must restore the composer without showing stale state from another student/context.

## Task 1: Extension queue recovery

**Worktree:** `C:/GitHub/ClassPilot-handoff-deadlock-20261109`

**Files:** `extension/service-worker.js`, focused `scripts/test-extension-*.mjs` or `server/__tests__/` regression, existing aggregate test registration, applicable candidate documentation.

**Interface:** Existing heartbeat binding adoption, storage cleanup, FAB update and overlay clear functions; no new wire protocol.

- [x] Add a deterministic actual-source regression for the reproduced FAB/cleanup/overlay overlap; verify it fails on baseline.
- [x] Repair queue ordering/cleanup lifecycle without weakening retired-binding cleanup or stale callback checks.
- [x] Exercise overlapping same-binding adoption, changed identity, repeated class transitions and post-transition heartbeat/auth progress.
- [x] Run focused recovery tests, `npm run check`, `npm test`, `npm run build`, source browser and package behavior gates. Record any environmental or baseline failures precisely.
- [x] Obtain independent review and resolve important findings.

## Task 2: SchoolPilot chat readiness

**Worktree:** `C:/GitHub/SchoolPilot-chat-readiness-20261109`

**Files:** `src/services/classpilotPrivateChatLifecycle.ts`, corresponding backend tests, `schoolpilot-app/src/products/classpilot/hooks/useClasspilotSessionChat.js`, relevant chat helper/browser tests.

**Interface:** Add reasoned readiness to the existing private lifecycle response while retaining conservative `supported`; distinguish reconnect/sync conditions from confirmed unsupported capability in send errors and UI.

- [x] Add failing backend tests for fresh capable, stale capable, absent/unavailable snapshot, signed-out and fresh unsupported cases.
- [x] Add a failing UI/browser regression for accurate warning copy, disabled sends during uncertainty and automatic recovery on a fresh lifecycle poll.
- [x] Implement explicit readiness in backend and existing UI hook; retain exact authority and revision checks.
- [x] Run backend type/build/test gates and frontend lint/build/release-focused suites, including browser behavior.
- [x] Obtain independent review and resolve important findings.

## Task 3: Final verification

- [x] Review both final diffs for scope, secrets and authority regressions.
- [x] Re-run the original deadlock scenario against the repaired source and verify readiness behavior across recovery.
- [x] Record commands/results and report tested artifacts, remaining acceptance limits and both worktree locations.

## Verification outcome

Completed November 9, 2026 in isolated worktrees. The extension change is commit `4f202712fa6a2f16cf9db935482eb5cba751e361`. Its Node 24 type/build/unit gates, full source and package browser gates, historical red-on-old proofs, and actual Chrome 156 / Edge 157 packaged tests passed. The new handoff regression passed on Chromium 151 and Chrome 156. The test ZIP remains version 3.0.3 and is not a separately numbered upload release.

SchoolPilot final verification uses the production/CI Node 22 runtime. Typecheck, cast ratchet, build and test-type ratchet passed. The final chat/cache/Windows/private-RLS selection passed 128 tests with one optional native-browser test skipped; screenshot publication passed all ten. The full frontend release inventory was exercised, including all remaining release stages after the first aggregate stopped. Its obsolete offline-update expectation was corrected and passed; an unrelated navigation timeout passed unchanged in an isolated rerun.

The first broad API run under Node 24 completed 4,720 tests: 4,693 passed, 17 failed and ten skipped. Every failure has a passing rerun: seven rendered-load cases after restoring pinned LF checkout bytes; ten screenshot cases after constructing a valid immutable manual-session fixture; 23 student-information cases on Node 22, whose parser supports the existing sandbox flag; and six health-sentinel cases in the required disposable namespace. No integrity, session-identity, parser-sandbox or tenant-permission guard was relaxed. Detailed command logs and initial-failure dispositions are retained in operator evidence outside the repository.

Final review reported no actionable findings. No production deployment, version tag or Store submission was performed. Managed Chromebook installation and acceptance remain separate from these disposable-browser checks.
