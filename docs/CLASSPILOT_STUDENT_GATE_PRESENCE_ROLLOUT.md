# ClassPilot Student Auth-Gate Presence Rollout

`studentAuthGatePresenceV1` is an additive protocol-v3 capability. It depends
on `scopedAuthorityChecksV1`, defaults off, and must pass both runtime controls:

- `CLASSPILOT_CAP_STUDENT_AUTH_GATE_PRESENCE_V1=true`
- an `on` entry for `studentAuthGatePresenceV1` in
  `CLASSPILOT_CAPABILITY_ROLLOUTS_JSON`

Use `scripts/deploy-classpilot-runtime-config.ps1` for production activation.
Keep profiles, plans, checkpoints, results, and the canonical pilot school UUID
in the existing owner-only external evidence directory.

## Profiles

Start with one school:

```json
{
  "schemaVersion": 3,
  "mode": "student-gate-pilot",
  "pilotSchoolId": "<canonical-school-uuid>"
}
```

After the managed-device pilot and school-activity observation window are
clean, expand globally:

```json
{
  "schemaVersion": 3,
  "mode": "student-gate-global-on"
}
```

Global planning also requires `-StudentGatePilotEvidencePath` pointing to a
fresh, owner-only schema-version-1 receipt. The helper snapshots and hashes the
receipt into the private run directory, binds it to the pilot school, tool and
application SHAs, image digest, exact API/worker task definitions, and managed
runtime fingerprint, and revalidates it at Apply. The observation must cover at
least 30 minutes and end no more than 30 minutes before validation; validation
must remain within the helper's two-hour freshness bound.

Disable only auth-gate presence without changing the existing repaired or
screenshot capabilities:

```json
{
  "schemaVersion": 3,
  "mode": "student-gate-off"
}
```

These profiles are source-preserving overlays. The helper first requires exact
API/worker runtime parity, then changes only the student-gate kill switch and
rollout entry. It preserves the active `screenshotTrackingWindowLeaseV1`
kill switch and school/global scope, every other ClassPilot capability, TURN
and STUN environment, the TURN secret reference, unrelated environment and
secrets, task family and image digest, service deployment bounds, and
autoscaling posture.

The pilot is admitted only from a completed global repaired-capability runtime.
Global activation is admitted only from the school-scoped student-gate pilot.
The `student-gate-off` profile is admitted only while the capability is active.
The older schema-version-1 `global-on` profile remains a broader compatibility
rollback and explicitly keeps `studentAuthGatePresenceV1` off; use
`student-gate-off` when screenshot tracking must remain unchanged.

Do not include TURN inputs in schema-version-3 profiles. Supplying them fails
closed because this capability does not manage Live View infrastructure.

## Verification

The receipt's boolean `checks` object must verify:

- the managed extension negotiated `studentAuthGatePresenceV1`;
- a fresh, active student remained hidden on another Chromebook;
- the visible auth gate offered same-Chromebook resume and the plain student
  name on another Chromebook;
- correct-PIN transfer succeeded and wrong-PIN entry did not mutate a session;
- concurrent transfers produced one winner;
- API/worker health, roster latency, authorization, and privacy gates remained
  clean through the pilot window.

Use this exact receipt shape:

```json
{
  "schemaVersion": 1,
  "validatedAt": "<exact-ISO-8601>",
  "observedFrom": "<exact-ISO-8601>",
  "observedThrough": "<exact-ISO-8601>",
  "pilotSchoolId": "<canonical-school-uuid>",
  "schoolPilotToolSha": "<40-character-tool-sha>",
  "schoolPilotAppSha": "<40-character-deployed-app-sha>",
  "schoolPilotImageDigest": "sha256:<64-hex-digest>",
  "pilotApiTaskDefinitionArn": "<exact-api-task-definition-arn>",
  "pilotWorkerTaskDefinitionArn": "<exact-worker-task-definition-arn>",
  "pilotRuntimeConfigurationSha256": "<managed-runtime-fingerprint>",
  "checks": {
    "fullSchoolActivityWindowObserved": true,
    "managedCapabilityNegotiated": true,
    "freshActiveStudentHidden": true,
    "sameChromebookResumePassed": true,
    "crossChromebookPlainNamePassed": true,
    "correctPinTransferPassed": true,
    "wrongPinPreservedSession": true,
    "cancelSignOutHeartbeatRehides": true,
    "concurrentTransferSingleWinner": true,
    "runtimeAndRosterErrorsWithinBudget": true,
    "noAuthorizationOrPrivacyDefects": true
  }
}
```

Run the focused deployment contract before review:

```powershell
pwsh -NoProfile -File tests/classpilot-runtime-config-deploy.test.ps1
```

This runtime helper never builds an image, runs migrations, deploys the web
frontend, or publishes the ClassPilot extension.
