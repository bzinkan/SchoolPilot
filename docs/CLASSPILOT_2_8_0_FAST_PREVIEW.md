# ClassPilot 2.8.0 Fast Preview Rollout

## Outcome

`screenshotActiveObservationCadenceV1` makes the existing authorized still
preview refresh about every five seconds only while a teacher or administrator
is actively viewing the exact class. It does not enable remote-control Live
View and does not change screenshot retention, database schema, Chrome
permissions, or teacher-facing identifiers.

The existing tracking-window policy remains authoritative. Capable clients
receive the additive shape:

```json
{
  "captureCadence": {
    "mode": "active_view",
    "intervalSeconds": 5,
    "expiresInSeconds": 84
  }
}
```

The mode is `background` with `intervalSeconds: 30` unless every condition is
true: the new capability and `screenshotTrackingWindowLeaseV1` were both
negotiated, tracking capture is currently allowed, screenshot authority is a
teaching session, the claimed and authoritative teaching sessions match, and
the shared observation store has an unexpired lease covering the exact
student. `expiresInSeconds` is bounded by both the observation and tracking
leases and capped at 84 seconds, preserving a six-second margin below the
90-second observation lease. Observation-store errors, malformed state, mismatches, and expired
leases fail back to background cadence rather than granting five-second
capture.

## Reconciliation and privacy

An observation start, scope change, or release sends one cross-instance,
coalesced `screenshot-policy-refresh` frame to the current devices in the
frozen session roster. The non-authoritative frame contains only the teaching
session alias—no student, student-session, device, pixel, policy, or control
identifier. The extension accepts it only for its current exact session and
requests an immediate heartbeat; the normal ten-second heartbeat remains the
durable fallback. Routing uses one tenant-scoped active-session read and one
private Redis publication rather than per-student authority transactions.

Uploads still pass the existing exact school, student, student session,
device, teaching session, frozen roster, control revision, entitlement,
tracking-window, supervision, and capture-time checks. Redis keeps only the
current class/revision-bound screenshot for 120 seconds. Existing clients and
schools outside rollout continue at 30 seconds.

Identifier-free minute aggregates report active/background cadence decisions,
observation-store fallback, refresh targets, and refresh failures. Do not add
school, user, student, device, session, request, Redis-key, or URL dimensions.

## Guarded runtime profiles

Use `scripts/deploy-classpilot-runtime-config.ps1` schema version 5 only:

```json
{ "schemaVersion": 5, "mode": "fast-preview-pilot", "pilotSchoolId": "00000000-0000-4000-8000-000000000000" }
```

```json
{ "schemaVersion": 5, "mode": "fast-preview-global-on" }
```

```json
{ "schemaVersion": 5, "mode": "fast-preview-off" }
```

The tool preserves the deployed image digest, TURN values, unrelated
environment, deployment bounds, and every other additive rollout. It writes
identical runtime configuration to API and scheduler-worker. Activation
requires both
`CLASSPILOT_CAP_SCREENSHOT_ACTIVE_OBSERVATION_CADENCE_V1=true` and a matching
`screenshotActiveObservationCadenceV1` rollout. A pilot is admitted only inside
the existing tracking-window scope and only with a private
`-FastPreviewCandidateReceiptPath`. That version-1 receipt must be no more than
two hours old and must bind all of the following:

- the exact `v2.8.2` tag, 40-character ClassPilot merge SHA, 64-character ZIP
  SHA-256, and production extension ID
  `iggbfegfcjkfieoemeolfmfnapepalca`;
- the pilot school, current SchoolPilot runtime-tool SHA, deployed app SHA and
  immutable image digest, plus the exact source API/worker task-definition
  pair;
- 5–10 managed pilot devices and affirmative managed-adoption, exact-authority,
  five-second-cadence, 30-second-fallback, and privacy readiness checks.

The tool snapshots this private receipt into the protected run directory,
hashes it into the plan, and carries only its hash and non-sensitive extension
artifact identity in the plan. Apply re-reads the snapshot, checks its hash,
freshness, authority, and artifact identity before registering or mutating any
task. The merge and ZIP hashes are supplied by the private receipt after the
actual extension build; they are deliberately not hard-coded in the tool.

Global activation additionally requires global tracking-window coverage, the
same hash-bound candidate receipt, and separate fresh pilot soak/load evidence
bound to the exact tool SHA, app SHA, image digest, active pilot task
definitions, runtime fingerprint, pilot school, receipt hash, and ClassPilot
tag/merge/ZIP/extension identity. The admission receipt may age only through
the bounded pilot window (at most 26 hours); the global soak evidence itself
must still be fresh and must show that observation began within two hours of
the admission check.

The global evidence contract requires a recent observation window of at least
30 minutes and affirmative
checks for managed negotiation; exact five-second active and 30-second
background cadence; expiry fallback; the 120-second TTL; 40-, 500-, and
800-device profiles; WAF and ingress headroom; API/worker stability;
screenshot-store latency; and no authorization or privacy defect. Traffic
math and thresholds are in `docs/SCALE_READINESS.md`. These checks are gates,
not claims that capacity has already been demonstrated.

## Deployment and rollback

1. Merge backend and extension changes through green CI.
2. Deploy the backend/API and worker from one reviewed SHA with the new flag
   off. Verify old clients remain unchanged.
3. Release the capable extension separately from the ClassPilot repository.
4. Validate 5–10 managed devices, create the private artifact-bound candidate
   receipt, then plan, hash, and apply `fast-preview-pilot` for one school
   through the guarded runtime tool.
5. Verify teacher and Admin Observe parity, exact class changes, lease expiry,
   5/30-second cadence, 120-second TTL, and identifier-free metrics.
6. Complete the 40/500/800 load gates and pilot activity-window soak.
7. Apply `fast-preview-global-on` only with the same candidate receipt and
   exact fresh pilot soak/load evidence for that artifact.

At the first latency, error-rate, WAF, Redis, authorization, or privacy stop
condition, apply `fast-preview-off`. This disables only five-second active
cadence and restores the established 30-second tracking-window behavior; no
data rollback or extension rollback is required. Planning or executing
`fast-preview-off`, and rolling back an already applied plan, do not require a
new activation receipt or pilot evidence.
