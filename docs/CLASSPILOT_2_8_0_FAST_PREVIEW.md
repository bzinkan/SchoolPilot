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
    "expiresInSeconds": 90
  }
}
```

The mode is `background` with `intervalSeconds: 30` unless every condition is
true: the new capability and `screenshotTrackingWindowLeaseV1` were both
negotiated, tracking capture is currently allowed, screenshot authority is a
teaching session, the claimed and authoritative teaching sessions match, and
the shared observation store has an unexpired lease covering the exact
student. `expiresInSeconds` is bounded by both the observation and tracking
leases. Observation-store errors, malformed state, mismatches, and expired
leases fail back to background cadence rather than granting five-second
capture.

## Reconciliation and privacy

An observation start, scope change, or release sends a best-effort
`screenshot-policy-refresh` frame through the exact current student binding.
It is delivered only to clients that negotiated the new capability. The frame
contains the already-authenticated student/session/teaching-session aliases,
but no device ID, pixel data, policy value, or authorization grant. The
extension revalidates the exact binding and requests an immediate heartbeat;
the normal ten-second heartbeat remains the durable fallback.

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
the existing tracking-window scope. Global activation additionally requires
global tracking-window coverage and fresh pilot evidence bound to the exact
tool SHA, app SHA, image digest, task definitions, runtime fingerprint, and
pilot school.

The evidence contract requires a recent observation window and affirmative
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
4. Plan, hash, and apply `fast-preview-pilot` for one school through the
   guarded runtime tool.
5. Verify teacher and Admin Observe parity, exact class changes, lease expiry,
   5/30-second cadence, 120-second TTL, and identifier-free metrics.
6. Complete the 40/500/800 load gates and pilot activity-window soak.
7. Apply `fast-preview-global-on` only with exact fresh evidence.

At the first latency, error-rate, WAF, Redis, authorization, or privacy stop
condition, apply `fast-preview-off`. This disables only five-second active
cadence and restores the established 30-second tracking-window behavior; no
data rollback or extension rollback is required.
