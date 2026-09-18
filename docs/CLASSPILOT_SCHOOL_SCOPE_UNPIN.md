# Releasing shipped capabilities from a single-school pin

## What this releases

Three capabilities shipped to the first school and stayed pinned to it in
`CLASSPILOT_CAPABILITY_ROLLOUTS_JSON`: `screenshotTrackingWindowLeaseV1` (the
screenshot lease that keeps tiles alive through the tracked window),
`screenshotActiveObservationCadenceV1` (the five-second refresh while a teacher
is watching) and `studentAuthGatePresenceV1` (the auth-gate presence signal).
Each entry read `{"mode":"on","schoolIds":["<one school>"]}`. A school onboarded
later never negotiated any of them, so its tiles went blank, its previews stayed
at the slow cadence and its gate showed no presence, with nothing in the product
to say why. The API boot log names the pins as a warning; this profile is what
removes them.

## Why it is one apply and not three promotions

Every one of these capabilities is already live and validated for the pinned
school. Releasing it changes **who reaches it**, never what it does, so there is
nothing new to pilot and no fresh evidence to bind. The existing promotion
profiles cannot express that: `fast-preview-global-on` is admitted only from a
runtime whose tracking window is already global, and `tracking-window-global-on`
is a wholesale base mode that writes every additive capability off and refuses
to run until student gate, fast preview and restriction auth have each been
switched off first. Reaching the same end state through them is roughly ten
applies with the live school losing features in between.

`school-scope-unpin` is the additive twin instead. It copies the live registry
byte for byte, removes the `schoolIds` key from exactly the three entries above,
and changes nothing else: no kill switch moves, no other entry changes, and the
enabled-capability count is the same before and after.

## Why the set is fixed

The unpinnable set is a reviewed constant in
`scripts/deploy-classpilot-runtime-config.ps1`
(`$script:UnpinnableCapabilities`), not a profile option. A profile that named
its own capabilities would be one typo away from releasing something that was
never meant to reach every school. Two pinned capabilities are deliberately
absent:

- `restrictionAuthPassThroughV1` shares a kill switch with
  `restrictionPortalFirstV1`, so releasing it would change **login delivery**
  fleet-wide as a side effect of a monitoring change. Its state reader admits
  exactly one school and no global arm exists. It stays pinned by decision.
- `lateSignInRestrictionSsoV1` has the same one-school reader and is off today.

The set is also strict in the other direction: if any member is not already on,
the whole apply is refused. "Release to every school" must never quietly become
"switch on for every school".

## Preconditions

1. The repository checkout is a clean `main` equal to `origin/main`; the helper
   records that commit as the tool SHA and refuses anything else.
2. Both live services run the same image digest and byte-identical ClassPilot
   runtime registries with every capability present as an entry (a flag without
   an entry blocks Plan, Apply and Rollback alike).
3. Each member of the set is `on` with its kill switch `true`, and every member
   that carries `schoolIds` names the same single canonical school. A runtime
   with nothing pinned is refused: applying twice is not a no-op, it is a lost
   rollback point.
4. The profile file and the evidence root are private (owner and SYSTEM only,
   inheritance disabled), exactly as for every other reviewed profile.
5. Apply runs outside the protected weekday 04:45–05:59 ET window and with the
   API at its scheduled desired count and minimum capacity. Any admitted count
   from one to three is fine; a mid-rollout rise to twice that many healthy ALB
   targets is expected under the `100/200` configuration and is not a failure.

## The profile

```json
{ "schemaVersion": 9, "mode": "school-scope-unpin" }
```

There are no options. `pilotSchoolId`, `turn` and every evidence path are
refused, and the mode name is matched case-sensitively. The plan records
`validationLevel=not_applicable` and `managedValidation=not_applicable` on
purpose: no evidence file is bound because none is required for a capability
that is already live. That is not a missed managed-validation gate.

## Plan and apply

```
pwsh -NoProfile -File scripts/deploy-classpilot-runtime-config.ps1 -Operation Plan `
  -ProfilePath <private>\school-scope-unpin.json `
  -ExternalEvidenceRoot <private evidence root> `
  -ExpectedAppSha <40-hex app SHA of the live image> `
  -ExpectedImageDigest sha256:<live digest> `
  -ExpectedApiTaskDefinitionArn <live API task definition ARN> `
  -ExpectedWorkerTaskDefinitionArn <live worker task definition ARN>
```

Inspect `plan.json` before applying: `profileMode` is `school-scope-unpin`,
`schoolScopeCount` is `0`, `enabledCapabilityCount` equals the live count (this
is the one activation where a change of zero is correct), both validation fields
are `not_applicable`, every evidence field is null, and the file contains no
school id.

```
pwsh -NoProfile -File scripts/deploy-classpilot-runtime-config.ps1 -Operation Apply `
  -PlanPath <run>\plan.json -ExpectedPlanSha256 <planSha256> -ConfirmProductionMutation
```

Plan and Apply belong to one sitting: a merge to `main` in between changes the
tool SHA and forces a new plan. Capacity rules, the terminal statuses, and the
manual recovery after `apply_failed_manual_intervention` are in
[CLASSPILOT_RUNTIME_CONFIG_OPERATIONS.md](CLASSPILOT_RUNTIME_CONFIG_OPERATIONS.md).

## Proof after apply

- `result.json` reports `status=applied` and `scalingRestored=true`.
- Both candidate task definitions show the three entries as `{"mode":"on"}`, the
  restriction-auth entry still carrying its single school, every
  `CLASSPILOT_CAP_*` value unchanged, and API and worker registries identical.
- The API boot log's `pins capabilities to explicit school lists` warning now
  names only `restrictionAuthPassThroughV1`.
- The previously pinned school is unchanged: its tracking window is still
  negotiated, its tiles still refresh at five seconds, its gate still reports
  presence. It is included in "every school".

## Rolling back

`-Operation Rollback` on the same plan restores the pre-apply API and worker
task definitions, which re-pins all three capabilities at once. There is no
per-capability re-pin profile. `student-gate-off` and `fast-preview-off` remain
the per-capability stop actions after the unpin, and the schema-version-1
`global-on` profile remains the tracking-window rollback.

## Shapes the helper refuses

- A member of the set that is `off` or whose kill switch is `false`.
- Members pinned to different schools, or a member pinned to more than one.
- A runtime where no member carries a school scope.
- A target that changes any entry outside the set, any kill switch, or any of
  the late-sign-in, restriction-auth or scheduled-classroom states.
- The mode under any schema version other than 9, or with a pilot school, TURN
  block or evidence path attached.
