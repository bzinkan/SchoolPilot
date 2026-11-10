# Student telemetry cost efficiency implementation plan

> **For agentic workers:** Use executing-plans for inline work and bounded independent assignments. User approved both repositories and implementation without further design approvals on November 9, 2026.

**Goal:** Preserve ClassPilot behavior while reducing the traffic and internal work required for 2,000 online devices; target $300/month before credits with explicit workload assumptions.

**Architecture:** Canonical HTTP device operations gain an additive authenticated WebSocket adapter, with bounded telemetry work independent of control ACK ordering. Stable operation IDs prevent duplicate heartbeat persistence on cross-transport recovery. Exact-image references and Redis script caching reduce bytes without changing capture quality or cadence.

**Tech stack:** Existing TypeScript/Express/pg/Redis/ws API; JavaScript Chrome MV3 extension/offscreen owner; Node tests and existing local Windows/Chrome tooling.

**Spec:** ../specs/2026-11-09-2000-student-cost-efficiency-design.md

## Global constraints

- No paid AWS/Linux load environment, production synthetic load or automatic deployment/subscription/apply.
- Preserve 10-second heartbeats, 30/5-second screenshots, image quality, retention, reports and all authorization/RLS/command boundaries.
- HTTP fallback and old clients remain compatible. New telemetry never uses passive cached authority for mutations.
- Keep 256 KiB WS frame limit, bounded admission and shutdown; telemetry may not delay command/chat ACK processing.
- SchoolPilot and ClassPilot changes live in isolated codex/2000-student-efficiency worktrees. Preserve unrelated user edits.
- Use current code, unit/contract tests, bounded local comparisons and real Chrome checks; do not label them AWS fleet acceptance.

## Review focus

1. Lost receipt after commit, followed by HTTP fallback: one heartbeat row/count, fresh current policy.
2. Session/class/control changes during capture or in-flight telemetry: no stale result or pixel reuse.
3. Slow telemetry, saturation or shutdown: command ACK processing remains independent and work drains safely.
4. Redis script cache loss or ambiguous timeout: one safe NOSCRIPT fallback, no retry of uncertain effects.
5. Moving pages and cache misses: unchanged-image optimization never reduces actual capture frequency, quality or freshness correctness.

## Task 1: Reproducible budget and observation model

Files: scripts/cost/classpilot-budget.mjs; tests/classpilot-budget.test.mjs; docs/AWS_2000_STUDENT_BUDGET.md.

- [x] Write and run failing tests for enrolled/online distinctions, 6/8-hour cases, 0/25/50/75% unchanged images, 30/5-second cadence, request and byte costs; invalid inputs fail explicitly.
- [x] Implement pure estimateClasspilotBudget(options) and CLI JSON/table output, no network or infrastructure mutations. Separate baseline, modeled usage, uncertain costs and optional Pro compatibility assumptions.
- [x] Verify hand-derived 95.04M heartbeats, 31.68M ordinary screenshots and 190.08M all-observed screenshots at 2,000 x6h x22d. Never hide the zero-dedup/high-observation case.

## Task 2: Redis script caching

Files: src/realtime/redisScriptCommand.ts; src/realtime/ws-redis.ts; tests/redis-script-command.test.ts; relevant existing Redis tests.

- [x] Write red tests for exact EVALSHA arguments, definite NOSCRIPT fallback, no timeout/disconnect retry, same overall bounded runtime and uncached arbitrary script bounds.
- [x] Implement EVALSHA with a single exact EVAL fallback inside the original publisher operation; preserve key/arg/script semantics and original timeout budget.
- [x] Run new tests, bounded publisher tests, TypeScript/build and existing local Redis integration where available.

## Task 3: Canonical device telemetry and server WebSocket adapter

Files: src/services/classpilotDeviceTelemetry.ts; src/routes/classpilot/devices.ts; src/services/classpilotProtocol.ts; src/realtime/websocket.ts; src/services/storage.ts; focused new/existing tests.

**Wire contract:** capability deviceTelemetryTransportV1; request {type:'device-telemetry', operationId:UUID, kind:'heartbeat'|'screenshot', studentToken:string, payload:object}; response {type:'device-telemetry-result', operationId, kind, status:number, body:object, exactBinding:{studentId,studentSessionId}}. HTTP recovery includes the same telemetryOperationId in payload. Unknown/new capabilities remain off until explicitly enabled and negotiated with scoped authority.

- [x] Write red tests for unchanged legacy HTTP behavior, negotiation, auth/entitlement/session/JWT failure, per-device admission and source-IP handling.
- [x] Reuse canonical route operation behavior through typed shared handlers/adapters; do not create a generic proxy or bypass middleware/tenant lifecycles. Retain every existing mutation and final publication authority check.
- [x] Add independently bounded heartbeat/screenshot lanes and correlated outcomes without awaiting them in the control-frame queue. Reject/HTTP-recover oversize operations.
- [x] Establish heartbeat operation idempotency, checking exact binding and payload identity before reuse. Cross-transport retries must re-derive policy/command responses under current authority, not replay old responses.
- [x] Verify lost-reply-after-commit, duplicate/mismatched IDs, takeover, revocation, queue saturation, delayed screenshots, command ACK independence and shutdown.

## Task 4: Extension WebSocket telemetry with HTTP recovery

Files in C:/GitHub/ClassPilot-2000-student-efficiency: extension/service-worker.js; extension/offscreen.js; extension/runtime-core.js or a focused telemetry module; scripts/test-extension-telemetry*.mjs; existing real Chrome suite.

Consumes Task 3's exact wire contract.

- [x] Write failing tests for unsupported/disabled negotiation, successful correlated result, timeout/HTTP recovery with same operation ID, oversized body, auth cancellation, connection replacement and MV3 restart.
- [x] Integrate existing offscreen owner and response context fences. Keep current capture/heartbeat scheduling, HTTP denial handling and backoff. Only canonical completed result acts as operation receipt.
- [x] Verify no extra periodic HTTP traffic in healthy negotiated operation, no stale reply side effects and immediate recovery for old/blocked WS environments.

## Task 5: Exact-image references

Files: new scoped image-reference helpers/cache operations plus ws-redis.ts/devices.ts, extension capture/upload path, teacher screenshot batch/cache handling and focused tests.

- [x] Write failing tests for genuine recapture, exact authority/privacy scope, server-computed content identity, same pixels/new metadata, stale timestamp rejection and full-frame recovery.
- [x] Add separately negotiated opaque image references. Continue every capture and encode unchanged. Update only small metadata for identical acknowledged pixels; never renew freshness from a heartbeat/hash lookup.
- [x] Keep hashes private and scope IDs to exact authority/control revision. Old clients receive compatible full images; misses recover the bytes from the same fresh capture.
- [x] Return metadata-only teacher results only for the exact known opaque image ID/privacy context; safely recover full bytes otherwise.
- [x] Compare moving/unchanged page behavior, metadata changes with identical pixels and no duplicated full cache blobs.

## Task 6: Integration, independent review and release preparation

- [x] Run required backend check/build/tests and applicable SOC 2 evidence; extension check/tests/real-Chrome/build; relevant frontend checks if changed; diff --check in both repositories. See the broad-run exception and targeted-rerun record below; no clean whole-suite rerun is claimed.
- [x] Run bounded Windows loopback comparisons of old HTTP and negotiated WS; record scope/resources/correctness without claiming production fleet proof.
- [x] Obtain fresh independent whole-change review; fix critical/important issues with regression tests.
- [x] Document rollout/rollback, compatibility/adoption, current cost estimates and unresolved Pro/security compatibility facts. Prepare code only; do not deploy/apply/subscribe/upload in this phase.

## Progress ledger

- November 9: User approved both repositories and opted out of further design approvals. Isolated worktrees created; existing dependencies reused by junction. No paid test infrastructure created.
- Ruling: independent Redis and extension work can be delegated in parallel; shared backend route/WS/storage files have one owner. Root owns the budget model and integration/review.
- Ruling: shared starting checkouts were stale. Isolated branches were moved to current reviewed main before tracked product edits: SchoolPilot 71c0352e and ClassPilot c0a21a4. Existing user checkouts remain untouched.
- Task 1: pure budget model and 8 behavior tests complete. Deliberately reports unknown overheads and hypothetical Pro compatibility; does not declare the budget accepted.
- Task 2: committed f50ac29f; 46 focused tests passed. Stateless EVALSHA, one definitive NOSCRIPT fallback inside the original budget; no ambiguous retries.
- Task 3: canonical operations, independent WS lanes and durable heartbeat replay committed. Actual registered-router HTTP-to-WS and WS-to-HTTP integration, payload conflict, entitlement revocation and session retirement pass against local PostgreSQL with clean process exit (07fb1e05).
- Task 4: frozen ClassPilot 659838f passes type check/build, 209/209 unit tests and the full Chrome suite, including 32 focused telemetry/reference cases, actual capture/recovery and all 20 historical counterfactual checks. Canonical ZIP contents verified; no Store upload or version bump.
- Task 5: native Redis cache checks and extension exact-reference checks pass; teacher image rehydration has 9 passing behavior cases and uses only the existing query cache. Frontend session lifecycle, realtime cache, signal loss, command context, tile batching and Radix browser checks pass. Lint/build pass with existing warnings.
- Local protocol comparison: 2,000 sockets / 4,000 reused WS operations passed in about 6 seconds, p95 ~20ms versus ~27ms HTTP. No database or AWS capacity claim.
- Ruling: dependency junction uses an identical lockfile's installed packages. ClassPilot uses Node 24.22.2; SchoolPilot production/CI functional reruns use Node 22.18.0. Local TypeScript needs --preserveSymlinks to avoid unrelated junction portability TS2742 diagnostics. Do not alter unrelated Google source to hide an environment issue.
- Independent reviews: extension/cache and backend/runtime/frontend reviews report no remaining critical/important finding. Fixed historical classification on replay, school-NAT admission and stale reference freshness before the final reviews. Budget arithmetic/loopback review also found no material defect.
- Local fixture repair: current-main tests exposed missing schema columns. Fourteen existing immutable expansion migrations were applied to verified localhost:5435, preserving existing contract adoption. No production migration or test-row/constraint weakening was performed. Admin analytics then passed 14/14. The historical unledgered bootstrap still hits a fixture check-constraint incompatibility; versioned convergence succeeded.
- Verification discipline: the first broad attempt used the stale fixture. A later partial attempt raced a rebuild and inherited the isolated API-only scheduler setting. Both local setup causes were removed; the final full suite uses a completed frozen build, normal scheduler-enabled test posture and serial DB execution. No product workaround was introduced.
- Cost review: the existing CloudFront configuration has confirmed Pro blockers (legacy forwarding, custom response headers and regex WAF classification). No subscription was created. Zero-image-reuse and eight-hour tables, additional teacher/API requests and unknown database/storage costs remain explicit in docs/AWS_2000_STUDENT_BUDGET.md. The existing five-second screenshot queue ceiling was traced through targeted and periodic reads. Neither 2,000-device AWS capacity nor the $300 target is claimed.
- Broad backend record: the 497-file serial run on Node 24/development fixtures reported 4,521 passed, 122 failed, one cancelled and ten skipped (4,654 tests). Every one of its 21 failed files subsequently passed a targeted rerun after the required local fixture/runtime or test-adapter correction. The original report remains failed; no fresh end-to-end whole-suite pass is claimed. The private backend-failure-reconciliation.json records each file, runtime and log.
- Final production-runtime evidence: Node 22 fresh-fixture proof 23/23 includes real HTTP/WS parity, durable idempotency and screenshot authority; Node 22 feature/native Redis checks 44/44; Office processing/evaluation 12/12; health 6/6; Windows fixture-tool lifecycle 25/25. Four uniquely owned empty databases on the existing localhost service were removed with ownership checks. No new service, Linux environment or AWS resource was created.
- Test-only maintenance retained immutable auth_kind, exact source-hash pins and all authority assertions. Canonical-context adapters, additive migration guards and the manual-session fixture received independent review with no important findings. Exact pinned rendering dependencies were restored to Git's LF bytes in this Windows worktree; hashes were not relaxed.
- Completion boundary: implementation and local correctness/review work are complete. Both capabilities remain off; no production deployment, WAF apply, CloudFront subscription, Store upload, completed activation receipt or fleet/budget acceptance was performed.
