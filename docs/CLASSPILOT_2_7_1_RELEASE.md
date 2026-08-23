# ClassPilot 2.7.1 Coordinated Release

This runbook is the operator contract for the paired SchoolPilot and ClassPilot
2.7.1 release. Feature flags are temporary deployment and emergency controls;
the successful final state has every repaired 2.7.1 capability globally on.
`kioskLaunchTicketV1` remains off because V2 replaces it.

## Immutable release inputs

Record these before deployment:

- SchoolPilot merge SHA and green workflow URLs.
- ClassPilot 2.7.1 tag and merge SHA.
- SHA-256 of the inspected `ClassPilot-v2.7.1.zip` that is uploaded.
- Previous API and worker ECS task-definition ARNs.
- Managed test OU and exact test school ID.
- Chrome Web Store listing version immediately before upload.

Production OUs remain pinned to 2.7.0 until the managed test OU completes all
validation below. Do not rely on a Chrome Web Store downgrade for rollback.

## Backend-first deployment posture

Deploy the SchoolPilot backend and frontend with protocol capability acceptance
off. This interval exists only to make the new additive contracts available
before a 2.7.1 client can use them. No RLS activation or application-schema
migration belongs to this release.

TURN infrastructure is a separate reviewed operational gate. If the existing
two-node module is not already provisioned, set its canonical production profile
to enabled and apply that infrastructure before validating
`liveViewIceServersV1`; do not combine the Terraform mutation with the backend
application deployment. Verify both nodes, DNS, certificate renewal, secret
wiring, aggregate telemetry, TURN/TCP, and TURNS/443 before accepting the
capability. Keep the capability off if that live gate is not green.

Verify the existing 2.7.0 path before publishing the extension:

- public `/health`, ECS desired/running counts, target health, restarts, and DB
  pool acquisition;
- ordinary teacher commands and ACK ingestion;
- 10-second heartbeats and the legacy screenshot policy;
- PIN/token kiosk access, both kiosk layouts, resume, and snapshot polling;
- no internal device/session identifiers in teacher responses, URLs, logs, or
  telemetry.

## Test-school capability posture

Set `CLASSPILOT_PROTOCOL_V3_ENABLED=true` and set all repaired per-capability
kill switches to `true`. Keep
`CLASSPILOT_CAP_KIOSK_LAUNCH_TICKET_V1=false`. During diagnosis,
`CLASSPILOT_CAPABILITY_ROLLOUTS_JSON` must name every capability because an
omitted entry fails closed. Start with only `scopedAuthorityChecksV1` on for the
exact test school and move each capability from `off` to `on` in this order:

1. `exactBindingAckV2`
2. `exactTabCloseV2`
3. `authBoundTelemetryV1`
4. `studentChatIdempotencyV1`
5. `screenshotObservationLeaseV1`
6. `safetyEvidenceCaptureV1`
7. `liveViewIceServersV1`
8. `kioskLaunchTicketV2`

Example shape (replace the placeholder with the exact test school ID and keep
the JSON in one environment-variable value):

```json
{
  "scopedAuthorityChecksV1":{"mode":"on","schoolIds":["<TEST_SCHOOL_ID>"]},
  "authBoundTelemetryV1":{"mode":"off"},
  "exactBindingAckV2":{"mode":"off"},
  "exactTabCloseV2":{"mode":"off"},
  "studentChatIdempotencyV1":{"mode":"off"},
  "screenshotObservationLeaseV1":{"mode":"off"},
  "safetyEvidenceCaptureV1":{"mode":"off"},
  "liveViewIceServersV1":{"mode":"off"},
  "kioskLaunchTicketV1":{"mode":"off"},
  "kioskLaunchTicketV2":{"mode":"off"}
}
```

After each change, require a fresh exact-bound heartbeat whose
`acceptedCapabilities` contains the expected intersection. A version string is
never capability evidence.

## Managed test acceptance

Use the unpacked release ZIP and the exact Store artifact on managed test
Chromebooks. Complete all of the following:

- identity A to B changes cannot transmit, persist, upload, or ACK A data under
  B authority;
- ordinary commands remain functional while each high-risk capability is
  enabled independently;
- selected-tab close targets one opaque reference when duplicate URLs exist;
- stale tab/control revisions and incomplete bindings fail unavailable;
- applied, idempotent, and allowlisted terminal ACK receipts drain only their
  exact outbox entries; retryable or mismatched receipts remain;
- chat retry is idempotent and never crosses student/session authority;
- ambient screenshots start only for an active observation lease and stop
  within the documented bound; safety capture remains exact-bound;
- Live View works directly and through TURN/TCP or TURNS/443 with UDP blocked;
- kiosk resume wins over delayed polling and stale `304` responses in both
  layouts;
- ticket V2 works after 61 seconds and before 600 seconds, is one-use, rejects
  wrong-school/replay/expiry, and falls back to ordinary PIN access on Redis
  failure;
- a 2.6.9 legacy kiosk association migrates without overwriting a valid new-ID
  association; raw directory IDs appear nowhere in Redis, URLs, logs, or
  telemetry.

Any wrong-student, cross-tenant, stale-binding, broadened-target, evidence, or
privacy violation stops the release immediately. Also stop for a 0.5 percentage
point error increase, endpoint p95 regression above 20%, DB-pool breach, or
service-worker regression.

## Required final global posture

Only after the complete managed test suite is green, replace the test-school
registry with this global rollout registry and deploy it to every API task:

```json
{
  "scopedAuthorityChecksV1":{"mode":"on"},
  "authBoundTelemetryV1":{"mode":"on"},
  "exactBindingAckV2":{"mode":"on"},
  "exactTabCloseV2":{"mode":"on"},
  "studentChatIdempotencyV1":{"mode":"on"},
  "screenshotObservationLeaseV1":{"mode":"on"},
  "safetyEvidenceCaptureV1":{"mode":"on"},
  "liveViewIceServersV1":{"mode":"on"},
  "kioskLaunchTicketV1":{"mode":"off"},
  "kioskLaunchTicketV2":{"mode":"on"}
}
```

Unpin one pilot-school OU, observe one complete school day, then unpin the
remaining production OUs. A healthy 2.7.1 heartbeat automatically receives the
full accepted set; there is no remaining per-school enablement step.

Do not call the release complete until all nine repaired capabilities are
globally accepted for healthy 2.7.1 devices, TURN and Redis live tests are green,
and the expected fleet capability telemetry is healthy.

## Rollback and retained evidence

Rollback first changes the affected rollout entries to `off` and pauses OU
unpinning. The flags-off 2.7.1 path remains compatible with 2.7.0/protocol 2.
Repair forward if a device already running 2.7.1 is defective.

Delete merged branches only after backend/frontend smoke and managed test-OU
validation. Retain the release tag, paired SHAs, uploaded ZIP, SHA-256, CI and
package evidence, rollout record, and previous ECS task definitions. Preserve
protocol 2, legacy ACK fields, ticket V1 code, and legacy kiosk bindings until
99% of the fleet advertises `scopedAuthorityChecksV1` for 30 consecutive days.
