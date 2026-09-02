# ClassPilot 2.7.3 Reliability Hardening

This document is the implementation and rollout contract for the additive
ClassPilot 2.7.3 screenshot reliability work. It does not authorize a deploy,
extension package, Chrome Web Store upload, capability activation, or database
migration.

## Reconciled baseline

The work started after the separate production deployment completed on August
27, 2026. The authoritative SchoolPilot baseline was commit
`3f015e37ae9fbeb514c316be2e08cbf1f350d234`. Production was running API task
definition `schoolpilot-production-api-emergency:85` and scheduler-worker task
definition `schoolpilot-production-scheduler-worker:100`, both from image
digest
`sha256:4d6a25153af366106caadc468ce16e881bd9e42ca1a7c9aa58a4e5f31a95a74d`.
The frontend entry object had ETag
`b462cdd44a96cc6cee80a444ae5484d2` and referenced
`index-DnoC82MS.js`, `vendor-react-LCuAeyym.js`,
`vendor-query-B6icocvx.js`, `vendor-radix-CxnZnDol.js`,
`vendor-charts-soHCpZUu.js`, and `index-Cpr8G0ro.css`. The deployed
session-recovery migration ledger contained
`20260827_classpilot_student_session_recovery_expand`,
`20260827_classpilot_student_session_recovery_validate`, and
`20260827_classpilot_student_session_recovery_indexes_online`. The ClassPilot
source baseline was commit
`30afe4dd172eeb1c936476fe51d97ef885b97b98` with manifest version `2.7.3`.
The operator confirmed Chrome Web Store version `2.7.2` was live on August 27,
2026; 2.7.3 had not been submitted.

Protocol v3 and the existing repaired capabilities were enabled. The deployed
rollout JSON had SHA-256
`058815bdbbc5b847d1cd51677f4d8246773c0637a665c512072514412690dd4f`.
`screenshotTrackingWindowLeaseV1` was absent from the task environment and
therefore off; this work must preserve that default until pilot approval.

No schema change is required by this hardening work.

## Negotiated protocol

Protocol version remains 3. The new capability is
`screenshotTrackingWindowLeaseV1`, depends on `scopedAuthorityChecksV1`, and is
controlled independently by
`CLASSPILOT_CAP_SCREENSHOT_TRACKING_WINDOW_LEASE_V1`. Its default is off.

For a negotiated client, heartbeat and WebSocket responses may include:

```json
{
  "screenshotPolicy": {
    "mode": "tracking_window_lease",
    "captureAllowed": true,
    "expiresInSeconds": 90,
    "serverTime": "2026-08-27T18:00:00.000Z",
    "authority": {
      "kind": "student_session",
      "controlRevision": 12
    }
  }
}
```

`teaching_session` authority additionally carries `teachingSessionId`. Uploads
carry the same authority and the actual pixel acquisition time in `capturedAt`.
The server revalidates authority immediately before accepting the upload and
returns `409 SCREENSHOT_AUTHORITY_SUPERSEDED` when the session, class, or
revision changed, or `409 SCREENSHOT_CAPTURE_PAUSED` when capture is no longer
permitted, or when `capturedAt` precedes the student session start, class
start, or frozen-roster completion (30 s slow-clock tolerance). Control-state
acknowledgements and unchanged re-pushes do not move this fence.

## Privacy and authority invariants

- `student_session` authority proves capture health only. The server discards
  the submitted image body and stores no teacher-readable pixels.
- `teaching_session` authority requires the exact school, student, active
  student session, device, entitlement, live teaching session, completed frozen
  roster, ownership, lack of supervision takeover, unexpired deadlines, and
  matching control revision.
- A class image is stored and read only through a key that includes its teaching
  session and control revision. There is no fallback from a negotiated 2.7.3
  class read to an older student/session or device-only image.
- A capture started under authority A cannot be uploaded under authority B.
  Authority changes trigger a new capture, including gap-to-class and
  class-A-to-class-B transitions. Authority identity is the exact claim (kind,
  teachingSessionId, controlRevision) plus the authenticated session/device
  binding; the capture-time fence is a race guard, not the identity check.
- Authorized previews are normal before 75 seconds, dim and age-labeled from 75
  seconds until 120 seconds, and unavailable at 120 seconds. Authorization loss
  removes pixels immediately regardless of age.
- Screenshots are independent evidence and never alter heartbeat-based
  Monitoring Coverage or conceal a genuine signal loss.

## Compatibility and rollback

The server and dashboard land first with the capability off. Live 2.7.2 clients
continue using the existing observation-lease contract. A 2.7.3 client retains
the old capability so disabling the new flag returns it to the current
observation-lease path.

Rollout is school-scoped: enable a pilot school, observe heartbeat and screenshot
receipt age, authority-denial reasons, class transitions, session-expiry backlog,
and managed-browser uptake, then expand deliberately. The first rollback action
is disabling the new capability. A deploy, package, or Chrome Web Store
submission still requires explicit operator approval.

## Guarded runtime activation profiles

Use `scripts/deploy-classpilot-runtime-config.ps1` for this capability. The
additive profiles use schema version 2 so they cannot be confused with the
original protocol-v3 activation sequence. Keep profile files, the canonical
school UUID, any required TURN evidence, plans, checkpoints, and results in
the existing owner-only external evidence directory.

The school-scoped pilot profile is:

```json
{
  "schemaVersion": 2,
  "mode": "tracking-window-pilot",
  "pilotSchoolId": "<canonical-school-uuid>"
}
```

This profile preserves every existing repaired capability globally, keeps
`screenshotObservationLeaseV1` available, sets
`CLASSPILOT_CAP_SCREENSHOT_TRACKING_WINDOW_LEASE_V1=true`, and scopes only
`screenshotTrackingWindowLeaseV1` to the pilot school. It is admitted only from
the completed `global-on` runtime state. The pilot must omit `turn`: it is a
screenshot-only capability transition, so the helper verifies API/worker
runtime parity and preserves their current TURN/STUN environment and secret
reference byte-for-byte. Supplying `turn` fails closed. This keeps Live View
unchanged and avoids requiring a fresh managed-device TURN test for a
capability that does not use TURN.

After the pilot and managed-browser smoke evidence pass, global expansion uses:

```json
{
  "schemaVersion": 2,
  "mode": "tracking-window-global-on",
  "turn": {
    "hosts": ["turn-a.school-pilot.net", "turn-b.school-pilot.net"],
    "secretArn": "<exact-production-turn-secret-arn>"
  }
}
```

Global expansion is admitted only from `tracking-window-pilot` and retains the
existing fresh TURN-evidence requirement. Both profiles require exact reviewed
API/worker image and task-definition inputs. The helper registers matching API
and worker revisions, preserves the image digest, TURN secret channel,
unrelated environment and secrets, service bounds, and autoscaling posture,
and never builds an image or deploys the frontend.

Runtime-tool identity and deployed-application identity are deliberately
separate. At Plan, the helper requires a clean `main` exactly equal to
`origin/main`, captures that commit as the reviewed `toolSha`, and stores it in
the schema-version-2 plan. `-ExpectedAppSha` continues to mean the immutable
application SHA tag already attached to the active backend image; it may differ
from `toolSha`. The helper independently proves that this deployed application
tag resolves to `-ExpectedImageDigest` and that both active task definitions
use that exact digest. Apply rechecks the repository against the captured
`toolSha` while preserving the deployed digest. This permits a reviewed
tool-only merge without rebuilding or replacing the backend image and fails
closed if either authority changes.

The helper accepts the exact active API task only from the normal production
family or its reviewed emergency twin, requires the same `512/2048` resource
contract, and registers the candidate in that same source family. It resolves
the deployed application through the normal deployment pipeline's immutable
12-character commit tag and still requires its digest to equal the complete
operator-supplied image digest; the full application SHA remains recorded in
the plan and result evidence. This avoids an extra family-only service rotation
before a runtime-only capability change.

Global planning also requires `-TrackingPilotEvidencePath` pointing to a fresh,
owner-only JSON receipt. The schema-version-2 receipt is hash-snapshotted into
the private run directory and revalidated at Apply. It binds the canonical
pilot school UUID, reviewed runtime-tool SHA, deployed SchoolPilot application
SHA and image digest, exact active pilot API and worker task-definition ARNs,
and the pilot managed-runtime configuration hash. It records exact
`validatedAt`, `observedFrom`, and
`observedThrough` timestamps covering at least 30 minutes and no more than 24
hours, ending no more than 30 minutes before validation. Every bounded check
must be the JSON boolean `true`:

- `fullSchoolActivityWindowObserved`
- `managedCapabilityNegotiated`
- `teacherTabSwitchingPassed`
- `adminObserveTabSwitchingPassed`
- `newScreenshotWithinThirtySecondsPassed`
- `authorizationPurgePassed`
- `zeroScreenshotStoreErrors`
- `screenshotLatencyWithinBudget`
- `noAuthorizationOrPrivacyDefects`

```json
{
  "schemaVersion": 2,
  "validatedAt": "<exact-ISO-8601>",
  "observedFrom": "<exact-ISO-8601>",
  "observedThrough": "<exact-ISO-8601>",
  "pilotSchoolId": "<canonical-school-uuid>",
  "schoolPilotToolSha": "<40-character-reviewed-tool-main-sha>",
  "schoolPilotAppSha": "<40-character-deployed-image-sha>",
  "schoolPilotImageDigest": "sha256:<64-hex-digest>",
  "pilotApiTaskDefinitionArn": "<exact-active-pilot-api-arn>",
  "pilotWorkerTaskDefinitionArn": "<exact-active-pilot-worker-arn>",
  "pilotRuntimeConfigurationSha256": "<64-hex-managed-runtime-hash>",
  "checks": {
    "fullSchoolActivityWindowObserved": true,
    "managedCapabilityNegotiated": true,
    "teacherTabSwitchingPassed": true,
    "adminObserveTabSwitchingPassed": true,
    "newScreenshotWithinThirtySecondsPassed": true,
    "authorizationPurgePassed": true,
    "zeroScreenshotStoreErrors": true,
    "screenshotLatencyWithinBudget": true,
    "noAuthorizationOrPrivacyDefects": true
  }
}
```

The plan and result expose only the receipt SHA-256, never the school or receipt
contents. Missing, stale, changed, partial, false, or differently bound evidence
fails before candidate registration or service mutation. Merely running the
pilot task-definition shape is not evidence that managed smoke and soak passed.

The schema-version-1 `global-on` profile remains the capability rollback. It
keeps the original repaired capabilities globally enabled but writes both the
tracking-window kill switch and rollout entry explicitly off. The helper also
recognizes the exact pre-additive production shape—where both the new flag and
rollout entry are absent—as this same tracking-off state; either half-present
configuration fails closed. Emergency protocol-wide containment remains the
separate schema-version-1 `off` profile.

This runtime activation does not require a database migration or another
extension package. Confirm client support from negotiated capabilities rather
than a displayed version number.
