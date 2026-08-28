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
permitted.

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
  class-A-to-class-B transitions.
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
