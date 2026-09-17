# Turning on the scheduled classroom for every school

## What this switches on

A teacher supervising a testing block, or holding claimed students, sees their
student tiles with live screenshots and a working toolbar — the same classroom a
normal class gets. Without this, those tiles are blank.

## Why it is one operation and not one per school

The capability reaches **every school or none**. There is deliberately no pilot
mode. A per-school scheduled classroom is the shape this replaced: a school that
was not named lost screen previews under a claim or a testing block, and nothing
in the product said why — it looked like a bug, not a missing config line. The
state reader refuses a `schoolIds` scope on this capability so it cannot be
reintroduced by hand.

## Preconditions

1. `src/config/classpilotScheduledClassroom.ts` and
   `classpilotSupervisionPreviewRollout.ts` default **on** (shipped in #439). Both
   env modes are absent in production, which now reads as on.
2. Production must not already carry `CLASSPILOT_CAP_SCHEDULED_CLASSROOM_V1`.
   Verified absent on task definition `:221`. **This matters**: the absent-flag
   tolerance keys on the flag name, so a flag present with no registry entry makes
   every source read throw `Active rollout registry is incomplete.` — which blocks
   Plan, Apply *and* Rollback alike. Re-verify before running:

   ```
   aws ecs describe-task-definition --task-definition schoolpilot-production-api \
     --region us-east-1 --query \
     'taskDefinition.containerDefinitions[0].environment[?name==`CLASSPILOT_CAP_SCHEDULED_CLASSROOM_V1`]'
   ```
   An empty array is the required answer.
3. Deploy the application first. The code defaults must be live before the
   capability is announced, or devices negotiate a capability the server then
   refuses to honour per school.

## The profile

```json
{ "schemaVersion": 8, "mode": "scheduled-classroom-global-on" }
```

No `pilotSchoolId`, no `turn` — both are refused. Plan, review, then Apply:

```
pwsh -File scripts/deploy-classpilot-runtime-config.ps1 -Operation Plan  -ProfilePath <profile.json>
pwsh -File scripts/deploy-classpilot-runtime-config.ps1 -Operation Apply -ProfilePath <profile.json>
```

## Rolling back

```json
{ "schemaVersion": 8, "mode": "scheduled-classroom-off" }
```

Activation is admitted only from `off`, and rollback only from `global-on`, so a
repeated apply is refused rather than quietly consuming the rollback point.

## Why the registry entry is the thing that matters

A configured `CLASSPILOT_CAPABILITY_ROLLOUTS_JSON` is **authoritative**: a
capability with no entry is off for every school no matter what its kill switch
says (`classpilotProtocol.ts`, `isClasspilotCapabilityActive`). Setting the flag
alone changes nothing. This profile writes both.

## What it deliberately does not touch

`restrictionAuthPassThroughV1` stays pinned to one school. It shares a kill switch
with `restrictionPortalFirstV1`, so globalising it would change **login delivery**
fleet-wide as a side effect of a monitoring change. That is a separate decision
with its own evidence, and it has no bearing on tiles or toolbars.

The other three pinned capabilities — `screenshotTrackingWindowLeaseV1`,
`screenshotActiveObservationCadenceV1`, `studentAuthGatePresenceV1` — still carry a
literal school id in production and still need unpinning before a second school is
onboarded. `student-gate-global-on` and `fast-preview-global-on` already exist for
two of them; the tracking window needs an additive twin, because
`tracking-window-global-on` is a wholesale base mode whose dependency gate would
force the live school through several applies with capabilities switched off.
