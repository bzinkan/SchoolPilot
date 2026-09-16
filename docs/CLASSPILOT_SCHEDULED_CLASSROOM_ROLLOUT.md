# ClassPilot Scheduled Classroom Rollout

`scheduledClassroomV1` makes a scheduled testing block present as a Class workspace with live
student previews. It is an additive protocol-v3 capability, depends on `scopedAuthorityChecksV1`,
defaults off, and unlike every other capability in this tool it also drives **server-side authority**
through four environment values that the same profile writes:

- `CLASSPILOT_CAP_SCHEDULED_CLASSROOM_V1=true` and an `on` entry for `scheduledClassroomV1` in
  `CLASSPILOT_CAPABILITY_ROLLOUTS_JSON` — capability negotiation
- `CLASSPILOT_SCHEDULED_CLASSROOM_MODE` + `CLASSPILOT_SCHEDULED_CLASSROOM_SCHOOL_IDS` — server authority
- `CLASSPILOT_SUPERVISION_PREVIEW_MODE` + `CLASSPILOT_SUPERVISION_PREVIEW_SCHOOL_IDS` — preview retention

All six are written by `scripts/deploy-classpilot-runtime-config.ps1`. Keep profiles, plans,
checkpoints, results and the canonical pilot school UUID in the existing owner-only external evidence
directory.

**Do not hand-edit these values.** The school lists are *derived* from the profile's single
`pilotSchoolId`, which is what makes the rollout registry and server authority provably name the same
school. An empty list means **every school** to both readers.

## Guarded runtime profiles

```json
{ "schemaVersion": 7, "mode": "scheduled-classroom-observe", "pilotSchoolId": "<canonical-school-uuid>" }
```
```json
{ "schemaVersion": 7, "mode": "scheduled-classroom-retain", "pilotSchoolId": "<canonical-school-uuid>" }
```
```json
{ "schemaVersion": 7, "mode": "scheduled-classroom-off" }
```

`observe` admits the capability for one school and runs every preview authorization and lease path
while **retaining no pixel**. `retain` advances only the preview stage. `off` revokes both the
capability and server authority and is admissible from any state, so it also reconciles a drifted
runtime. There is deliberately no global or multiple-school profile.

Staging is one-directional: `off → observe → retain → off`. To de-escalate retention, run
`scheduled-classroom-off` and then `scheduled-classroom-observe` again.

Prerequisites, enforced when the plan is built and re-checked at Apply:

- The completed global repaired-capability runtime, exactly preserved, along with every other
  capability, school scope and TURN wiring.
- `scopedAuthorityChecksV1` on, with no school scope.
- `observe` must begin from off; `retain` requires an active `observe` for the **same** school.
- The rollout registry entry and both `_SCHOOL_IDS` values must name one identical canonical UUID.
  Empty, extra, different, mis-cased or whitespace-padded values are all refused, on the source
  runtime as well as the target.
- `CLASSPILOT_SCHEDULE_BOUNDARY_WORKER_MODE` must be absent or `off` on **both** services. That worker
  is fleet-wide and un-scopable; it is never written by this tool and is activated separately.
- Fresh extension-fleet evidence for `observe` (below).
- The usual `-ConfirmProductionMutation -PlanPath -ExpectedPlanSha256`, private-path/ACL rules, the
  04:45–05:59 ET protected window, and the DynamoDB lock item
  `schoolpilot/production/classpilot-runtime-config-v1`.

## Extension fleet evidence

Scheduled classroom is the only capability here whose failure mode is **subtractive**. A device that
cannot negotiate `scheduledClassroomV1` does not merely miss the new tools — it stops capturing and
the teacher's tiles go blank, because the server mints a supervision-context authority the extension
refuses. That risk is fully present at `observe`, which stages retention only, not the capability.

`-ScheduledClassroomPilotEvidencePath` is therefore required for `scheduled-classroom-observe` and
rejected for every other mode. The minimum is `$script:ScheduledClassroomRequiredExtensionVersion`
(**2.8.9**, the first release that negotiates the capability); versions are compared numerically per
component, so `2.8.10` is above the floor.

```json
{
  "schemaVersion": 1,
  "validatedAt": "<ISO-8601 round-trip, within two hours>",
  "pilotSchoolId": "<canonical-school-uuid>",
  "schoolPilotToolSha": "<40-hex>",
  "schoolPilotAppSha": "<40-hex>",
  "schoolPilotImageDigest": "sha256:<64-hex>",
  "minimumObservedExtensionVersion": "2.9.0",
  "observedDeviceCount": 24,
  "checks": {
    "everyManagedDeviceAtOrAboveMinimum": true,
    "capabilityNegotiationObserved": true,
    "noStaleDeviceReportedOlder": true,
    "pilotSchoolRosterReviewed": true
  }
}
```

The bytes are copied into the private run directory, hashed into `plan.json`, and re-verified
byte-identical at Apply.

## Deployment and rollback

1. Confirm no outstanding plan exists — a plan is bound to the runtime tool SHA, so merging any change
   to the script invalidates it.
2. Plan and Apply `scheduled-classroom-observe` with fleet evidence.
3. Soak. Confirm scheduled blocks present as Class, previews render, and no student screenshot is
   retained.
4. Plan and Apply `scheduled-classroom-retain` for the same school.
5. Rollback has three distinct layers. An in-operation failure reverts all six values with the task
   revision. `-Operation Rollback` against a prior successful plan reverts the capability **and** the
   server authority together. When the prior revision is stale, roll forward with
   `scheduled-classroom-off`.

None of these touch the application image. The one-way door described in
[CLASSPILOT_AUTOMATIC_CLASS.md](CLASSPILOT_AUTOMATIC_CLASS.md) — context-parented classroom records
versus software that assumes every record has a teaching session — lives outside this tool, which
provides no interlock against it.

Run the focused deployment contract before review:

```powershell
pwsh -NoProfile -File tests/classpilot-runtime-config-deploy.test.ps1
```

This runtime helper never builds an image, runs migrations, deploys the web frontend, or publishes the
ClassPilot extension.
