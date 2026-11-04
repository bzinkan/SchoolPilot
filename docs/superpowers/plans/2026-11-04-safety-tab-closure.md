# Restore safety tab closure

The operator explicitly requires the original detect-and-close behavior for harmful searches, including pornography. The September 5 review-first change removed the sender while retaining exact-tab targeting. This instruction supersedes the repository's alert-only behavior.

Use the existing school-policy `ai_safety` command and current-tab resolver. Revalidate school entitlement, the exact student/session/device tuple and heartbeat control revision immediately before sending. Keep the authority lock through local delivery and relay publication initiation. Never broaden a missing target, install a domain block, replay a transient command, or claim client-confirmed closure from publication alone. Preserve exact-URL approvals and administrator notifications. Closure does not depend on notification deduplication, evidence, or legacy hidden automatic-close settings.

This restores the monitored-heartbeat workflow. The separate after-hours safety-only collector has no tab snapshot; it continues reporting without inventing an exact target.

- [x] Add failing dispatch and route tests: sexual searches, repeated observations, reporting failure, stale tuple/revision, missing/ambiguous targets, suppressed and safe URLs, publication failure.
- [x] Add the narrow dispatch service and authority callback; connect it before alert/evidence work and record requested action accurately.
- [x] Update the safety guide and repository instructions to match the requested behavior and distinguish request from confirmation.
- [ ] Run focused regressions, backend checks/build/test types/cast ratchet and the backend suite. Obtain independent review and resolve findings.
