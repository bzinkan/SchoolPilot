# Restore safety tab closure

The operator explicitly requires the original detect-and-close behavior for harmful searches, including pornography. The September 5 review-first change removed the sender while retaining exact-tab targeting. This instruction supersedes the repository's alert-only behavior.

Use the existing school-policy `ai_safety` command and current-tab resolver. Revalidate school entitlement, the exact student/session/device tuple and heartbeat control revision immediately before sending. Keep the authority lock through local delivery and relay publication initiation. Never broaden a missing target, install a domain block, replay a transient command, or claim client-confirmed closure from publication alone. Preserve exact-URL approvals and administrator notifications. Closure does not depend on notification deduplication, evidence, or legacy hidden automatic-close settings.

This restores the monitored-heartbeat workflow. The separate after-hours safety-only collector has no tab snapshot; it continues reporting without inventing an exact target.

- [x] Add failing dispatch and route tests: sexual searches, repeated observations, reporting failure, stale tuple/revision, missing/ambiguous targets, suppressed and safe URLs, publication failure.
- [x] Add the narrow dispatch service and authority callback; connect it before alert/evidence work and record requested action accurately.
- [x] Update the safety guide and repository instructions to match the requested behavior and distinguish request from confirmation.
- [x] Run focused regressions, backend checks/build/test types/cast ratchet and the backend suite. Obtain independent review and resolve findings.

## Validation record

PR #715 merged the implementation as `aa49558414b83967dfd76151219f2a8718f66a33`. All executed PR checks passed (the rollout-safety job was skipped by the ordinary PR path filter), including ordinary and forced-RLS database tests and all four frontend release-test shards. Independent review findings about timeline metadata, approval serialization and expiry fences were resolved.

Local verification passed the backend build, application type check, test type/cast ratchets, 49 focused regressions and 10 real-heartbeat/database integration tests. The full serial suite ran 4,714 tests: 4,702 passed, 10 were explicitly skipped, and two local fixture setup failures occurred. `classpilot-rendered-load.test.ts` required exact LF checkout bytes for its pinned dependencies; its rerun passed 7/7. `health-monitor-round-trip.integration.test.ts` required its dedicated allowed database namespace; its rerun passed 6/6. No application failure remained. Disposable validation databases and the implementation branch/worktree were removed; logs were retained in the ignored operator evidence directory.

Merged-main CI run `41856513745` completed all executed steps of its rollout-safety job `126666516476` successfully, including the final cleanup step at `2026-11-04T15:50:15Z`, but GitHub continued exposing the job/run as in progress. Normal and force cancellation returned 409 while rerun requests returned 403. Preserve that run and its logs as an unresolved finalization failure; do not relabel it green or bypass the deployment gate. This documentation update changes no application code or CI policy. Production release still requires a fresh green push-CI result for the exact serving main commit.
