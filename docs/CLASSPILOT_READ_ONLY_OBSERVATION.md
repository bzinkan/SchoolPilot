# Observe scheduled classes before the teacher connects

Administrators and IT staff with an existing administrator role can observe an active, frozen scheduled class occurrence without signing the teacher in or starting teacher control. The occurrence remains `scheduled_report` until the ordinary teacher-presence path promotes it. Observe never assigns the administrator as owner, applies classroom restrictions, permits classroom commands, or exposes student messages and individual Class tools responses.

Discovery, roster reads, observation leases, subscriptions, uploads and screenshot reads all enforce the school, frozen roster, current occurrence lifetime, entitlement and tracking policy. Explicit end, the scheduled deadline, transfer to another active authority, or loss of authorization retires access. Saved groups and future schedules are not current observable classes.

## Extension compatibility

The API supports the existing 2.9.2 and 2.9.3 `student_session` screenshot contract. Those clients can provide previews for a current reporting occurrence at their ordinary approximately 30-second cadence. Retention is an internal server decision; the extension is never told that observation grants teacher ownership.

An extension advertising `screenshotReadOnlyObservationV1` can additionally use a server-issued, bounded `active_view` screenshot policy for approximately five-second updates. The capability requires `scopedAuthorityChecksV1`, `screenshotTrackingWindowLeaseV1` and `screenshotActiveObservationCadenceV1`. The exact student/session authentication, current control revision and lease deadline still fence every capture. A refresh message only requests a new heartbeat; it cannot grant capture itself. No new Chrome permission or continuous Live View authority is introduced.

## School-scoped rapid-preview rollout

The capability defaults off. Use the existing guarded runtime-config Plan/Apply/Rollback workflow with a private schema-version-7 profile; no new schema is needed:

```json
{ "schemaVersion": 7, "mode": "read-only-observation-pilot", "pilotSchoolId": "00000000-0000-4000-8000-000000000000" }
```

Replace the example UUID with the authorized pilot school. The deployed tracking-window and active-preview rollouts must already include that school. The runtime tool refuses missing dependencies, a wider school scope, partial flag/registry pairs, and global or multiple-school activation. It preserves the existing image digest, unrelated runtime controls, other pilots and TURN wiring while applying matching controls to API and worker. A source task missing both new controls is treated as off and normalized to explicit off values.

Admission sets both `CLASSPILOT_CAP_SCREENSHOT_READ_ONLY_OBSERVATION_V1=true` and the matching `screenshotReadOnlyObservationV1` school-scoped rollout entry. Prepare the plan only after API acceptance and separately validate the released extension on managed devices. Record automated browser evidence and school Chromebook evidence separately.

To return only this feature to ordinary screenshot cadence, use:

```json
{ "schemaVersion": 7, "mode": "read-only-observation-off" }
```

This turns off both controls, preserving read-only Observe and older-client background screenshots, existing class/supervision previews, and unrelated capabilities. The previous hash-bound plan can restore the exact original API/worker task-definition pair. Runtime operations and recovery are described in [CLASSPILOT_RUNTIME_CONFIG_OPERATIONS.md](CLASSPILOT_RUNTIME_CONFIG_OPERATIONS.md).
