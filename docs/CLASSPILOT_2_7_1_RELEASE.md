# ClassPilot 2.7.1 Coordinated Release

This runbook is the operator contract for the paired SchoolPilot and ClassPilot
2.7.1 release. Feature flags are temporary deployment and emergency controls;
the successful final state has `scopedAuthorityChecksV1` and all eight dependent
repaired capabilities globally on. `kioskLaunchTicketV1` remains off because V2
replaces it.

Chrome Web Store listing `iggbfegfcjkfieoemeolfmfnapepalca` was
operator-confirmed live at `2.7.1` on August 24, 2026. This is Store-publication
evidence only. Managed-Chromebook validation was not passed and must not be
claimed; the approved completion path below is explicitly synthetic-only with a
separate managed-test waiver.

## Immutable release inputs

Record these before deployment:

- SchoolPilot merge SHA and green workflow URLs.
- ClassPilot 2.7.1 tag and merge SHA.
- SHA-256 of the inspected `ClassPilot-v2.7.1.zip` that was uploaded.
- Previous API and worker ECS task-definition ARNs.
- Managed test OU and exact test school ID for the strict path, or the explicit
  `waived_not_passed` record for the synthetic-only path.
- Chrome Web Store listing observation (`2.7.1` live on August 24, 2026).
- Exact synthetic-validation, TURN-evidence, and managed-test-waiver hashes when
  using the approved synthetic-only completion path.

Store publication does not prove that any managed OU installed, adopted, or
validated the release. Preserve independent Google Admin adoption controls and
do not rely on a Chrome Web Store downgrade for rollback.

## Backend-first deployment posture

Deploy the SchoolPilot backend and frontend with protocol capability acceptance
off. This interval exists only to make the new additive contracts available
before accepting them from a 2.7.1 client. No RLS activation or
application-schema migration belongs to this release.

TURN infrastructure is a separate reviewed operational gate. If the existing
two-node module is not already provisioned, set its canonical production profile
to enabled and apply that infrastructure before validating
`liveViewIceServersV1`; do not combine the Terraform mutation with the backend
application deployment. Verify both nodes, DNS, certificate renewal, secret
wiring, aggregate telemetry, TURN/TCP, and TURNS/443 before accepting the
capability. Keep the capability off if that live gate is not green.

One narrow August 24, 2026 Terraform repair exception is authorized but remains
pending execution. Its saved plan must replace only the two TURN instances and
their two EIP associations, update only the two node-status alarms, and show
exactly `4 to create, 2 to update, 4 to destroy` with no unrelated changes.
EIPs, DNS, the TURN secret, IAM, security groups, the dashboard, and ECS are
outside the exception. Use verified external state backups before plan, before
apply, and after apply. The exact addresses and post-apply gates are in
`CLASSPILOT_TURN_OPERATIONS.md`; authorization becomes completed and
non-reusable only after the exact apply, live validation, and a fresh no-op plan
all pass.

If the exact SchoolPilot backend image must be deployed during the protected
window, the only authorized deploy-script shape is:

```bash
./scripts/deploy.sh production --backend --activate-emergency \
  --tag <full-40-character-main-sha> \
  --confirm-protected-window-production-mutation
```

The flag is admitted only when the process starts during the weekday
04:45–10:14 Eastern window. It rejects frontend, RLS, skip-wait, immutable-image, same-image,
capacity, observation, rehearsal, and receipt modes. It accepts only a stable
API desired count from one through six, installs the same 1–6 bounds documented
below before API mutation, converges the API before the singleton worker, and
validates and hash-binds the exact 05:45/10:00 scheduled actions, and restores
the exact prior deployment and scheduled-scaling configuration. If restoration
must raise the arrival minimum to six, completion waits for six desired,
running, and healthy API targets. If a candidate may already have served and a
safe terminal cannot be proven, the controller preserves its recovery files and
retains no-growth/scaling containment for explicit roll-forward recovery rather
than forcing an unproven old-code downgrade. It is
not implied by `--activate-emergency` and must not be retained for an ordinary
deploy.

### Required same-digest runtime configuration path

Do not hand-edit ECS task definitions and do not select the Terraform-generated
`:latest` task definitions for capability activation. Use
`scripts/deploy-classpilot-runtime-config.ps1` after the backend release is
serving from clean `main`. The helper clones the exact active API **and** worker
revisions, preserves the immutable image digest and emergency API `512/2048`
CPU/memory profile, and changes only the reviewed ClassPilot environment and
TURN-secret allowlist. Updating both services is required because the ordinary
worker renderer inherits API environment and then applies worker values; an old
worker-only value could otherwise reintroduce stale flags on a later deploy.

The helper has three fixed private-profile modes:

- `test-school`: one canonical school UUID and one cumulative prefix of the
  activation order below;
- `global-on`: all nine repaired capabilities globally on, V1 off, and no
  school scope; and
- `off`: protocol/capability acceptance off for emergency containment while
  leaving already provisioned TURN wiring unchanged.

`off` is the deliberately constrained incident exception. It still requires
the exact active API/worker ARNs, their shared digest, emergency API memory,
worker singleton, matching managed configuration, production AWS identity, and
the reviewed 1–6 autoscaling ceiling. It does not require current `main`, an ECR
SHA-tag lookup, TURN evidence, or an out-of-arrival-window start, because those
checks could delay containment after code advances or during the school day.
It can only turn every capability off; it cannot enable or partially activate
features.

Feature-enabling mutation inside the weekday 04:45–10:14 Eastern protected
window is a separate explicit exception; only that admitted protected run may
also use an API desired count above two.
Both Plan and Apply must include `-ConfirmProductionMutation` and
`-ConfirmProtectedWindowProductionMutation`. The approved synthetic-only
global activation additionally requires
`-ConfirmSyntheticOnlyGlobalActivation`; omitting any one of the three fails
before mutation. Ordinary feature-enabling plans remain outside the protected
window and accept only one or two stable API tasks.

Both `off` and an explicitly protected feature-enabling plan use these exact
temporary API `minimumHealthyPercent/maximumPercent` bounds:

| Frozen desired count | API bounds | Permitted replacement behavior |
|---:|---:|---|
| 1 | `100/200` | One availability-preserving replacement slot |
| 2 | `50/100` | Exactly one stop; no capacity growth |
| 3 | `66/100` | Exactly one stop; no capacity growth |
| 4 | `75/100` | Exactly one stop; no capacity growth |
| 5 | `80/100` | Exactly one stop; no capacity growth |
| 6 | `83/100` | Exactly one stop; no capacity growth |

The singleton worker uses `0/100`. The helper preserves the complete reviewed
ROLLING deployment configuration, including the enabled rollback circuit
breaker and alarm fields, while changing only those percentages. It suspends
dynamic and scheduled scaling during mutation, restores the exact deployment
configuration, and reconciles the current weekday 05:45–10:00 Eastern scheduled
minimum (`6` in-window, `1` otherwise) with a two-phase, boundary-checked release
before removing the hold. If desired capacity drifts after hold acquisition,
service mutation stops immediately; recovery re-derives the bounds from the
current frozen count rather than a stale pre-hold count. The bounded convergence
budget is one hour because a six-task rollout can require sequential 300-second
ALB drains.

Store profiles, TURN proof, plans, checkpoints, and results outside the
repository in one dedicated private evidence root. The helper protects
generated material for the operator account and SYSTEM only on Windows
(owner-only permissions on Unix), prints counts and hashes rather than profile
contents, and rejects repository-local, broad, shared-readable, or
reparse-point inputs. During planning it reads each operator input once and
copies the exact bytes into the new private run directory under the neutral
names `profile.json` and, when supplied, `turn-evidence.json`,
`synthetic-validation.json`, and `managed-test-waiver.json`. Apply and rollback
use only those hash-bound copies; they do not reopen the original input paths.
Neither operator-supplied source paths nor school, TURN, approver, or waiver
values are written to the plan or stdout. The plan names only the neutral files,
and the final stdout value is the identifier-free `PlanRelativePath` after the
summary; join it to the exact `-ExternalEvidenceRoot` supplied to `Plan` before
hashing or applying it.

Example private test-school profile before the Live View step:

```json
{
  "schemaVersion": 1,
  "mode": "test-school",
  "testSchoolId": "<TEST_SCHOOL_UUID>",
  "enabledCapabilities": [
    "exactBindingAckV2",
    "exactTabCloseV2",
    "authBoundTelemetryV1"
  ]
}
```

Add the exact reviewed `turn` object once the prefix includes
`liveViewIceServersV1`. `global-on` always requires it:

```json
{
  "schemaVersion": 1,
  "mode": "global-on",
  "turn": {
    "hosts": ["turn-a.school-pilot.net", "turn-b.school-pilot.net"],
    "secretArn": "<EXACT_PRODUCTION_TURN_SECRET_ARN>"
  }
}
```

The separate private TURN evidence file uses hashes rather than repeating the
hosts or secret ARN and must be no more than two hours old:

```json
{
  "schemaVersion": 2,
  "validatedAt": "<UTC_ISO_TIMESTAMP>",
  "hostsSha256": "<SHA256_OF_SORTED_COMMA_SEPARATED_HOSTS>",
  "secretArnSha256": "<SHA256_OF_EXACT_SECRET_ARN>",
  "checks": {
    "twoHealthyNodes": true,
    "distinctAvailabilityZones": true,
    "dnsMatchesElasticIps": true,
    "turnUdp3478": true,
    "turnTcp3478": true,
    "turnsTcp443": true,
    "tlsCertificatesCurrent": true,
    "relayRangeValidated": true,
    "aggregateTelemetryHealthy": true,
    "syntheticUdpBlockedFallbackPassed": true,
    "managedUdpBlockedLiveViewPassed": true
  }
}
```

The split TURN fields are deliberate. The ordinary strict path requires both
synthetic and managed UDP-blocked checks to be `true`. Only the approved
synthetic-only global path accepts
`managedUdpBlockedLiveViewPassed: false`, and it accepts that value only when
the hash-bound waiver below records that managed validation was not passed.

For `test-school` and `global-on`, start from clean `main`. For every mode,
record the exact active task-definition ARNs, full deployed SchoolPilot SHA,
and ECR digest. Plan first, review the identifier-free summary, then apply the
exact hashed plan:

```powershell
$evidenceRoot = 'C:\private\schoolpilot-runtime-evidence'

$planRelativePath = & pwsh -NoProfile -File scripts/deploy-classpilot-runtime-config.ps1 `
  -Operation Plan `
  -ProfilePath C:\private\classpilot-profile.json `
  -TurnEvidencePath C:\private\classpilot-turn-evidence.json `
  -ExternalEvidenceRoot $evidenceRoot `
  -ExpectedAppSha <FULL_40_CHARACTER_SCHOOLPILOT_SHA> `
  -ExpectedImageDigest <SHA256_IMAGE_DIGEST> `
  -ExpectedApiTaskDefinitionArn <EXACT_ACTIVE_API_EMERGENCY_TASK_ARN> `
  -ExpectedWorkerTaskDefinitionArn <EXACT_ACTIVE_SINGLETON_WORKER_TASK_ARN> |
  Select-Object -Last 1

$planPath = Join-Path -Path $evidenceRoot -ChildPath $planRelativePath
$planSha256 = (Get-FileHash -LiteralPath $planPath -Algorithm SHA256).Hash.ToLowerInvariant()

pwsh -NoProfile -File scripts/deploy-classpilot-runtime-config.ps1 `
  -Operation Apply `
  -PlanPath $planPath `
  -ExpectedPlanSha256 $planSha256 `
  -ConfirmProductionMutation
```

### Approved synthetic-only completion waiver

Managed-Chromebook validation has not passed. The approved exception may go
directly from `baseline`, `off`, or a test-school prefix to `global-on` only
when all three private evidence files are no more than two hours old and bind
the exact release, image, and one another. The synthetic evidence has this
strict shape. Its bound TURN evidence uses schema version 2 above with
`syntheticUdpBlockedFallbackPassed: true` and
`managedUdpBlockedLiveViewPassed: false`:

```json
{
  "schemaVersion": 1,
  "validatedAt": "<UTC_ISO_TIMESTAMP>",
  "schoolPilotAppSha": "<FULL_40_CHARACTER_SCHOOLPILOT_SHA>",
  "schoolPilotImageDigest": "sha256:<64_HEX>",
  "classPilotTag": "v2.7.1",
  "classPilotMergeSha": "a3b096d6a74ab6979f4e4c656d75e2397eb8648f",
  "classPilotZipSha256": "40fed2c455d5c50fe3a947d23e3798a0c81832a67e717a2767b62970c024307c",
  "turnEvidenceSha256": "<SHA256_OF_EXACT_TURN_EVIDENCE_FILE>",
  "checks": {
    "crossRepositoryContractPassed": true,
    "unpackedZipPassed": true,
    "identityTransitions10000Passed": true,
    "redisCrossProcessPassed": true,
    "allCapabilitiesSimultaneousPassed": true,
    "protocol2CompatibilityPassed": true,
    "markerless270LegacyPassed": true
  }
}
```

The separate approval file must bind both evidence hashes and state the waiver
without implying a managed pass:

```json
{
  "schemaVersion": 1,
  "approvedAt": "<UTC_ISO_TIMESTAMP>",
  "approvedBy": "bzinkan@school-pilot.net",
  "reason": "<BOUNDED_NONEMPTY_APPROVAL_REASON>",
  "syntheticValidationSha256": "<SHA256_OF_EXACT_SYNTHETIC_VALIDATION_FILE>",
  "turnEvidenceSha256": "<SHA256_OF_EXACT_TURN_EVIDENCE_FILE>",
  "managedValidation": "waived_not_passed",
  "validationLevel": "synthetic_only"
}
```

Supply the two additional paths and all three confirmations to Plan:

```powershell
$planRelativePath = & pwsh -NoProfile -File scripts/deploy-classpilot-runtime-config.ps1 `
  -Operation Plan `
  -ProfilePath C:\private\classpilot-global-on-profile.json `
  -TurnEvidencePath C:\private\classpilot-turn-evidence.json `
  -SyntheticValidationPath C:\private\classpilot-synthetic-validation.json `
  -ManagedTestWaiverPath C:\private\classpilot-managed-test-waiver.json `
  -ExternalEvidenceRoot $evidenceRoot `
  -ExpectedAppSha <FULL_40_CHARACTER_SCHOOLPILOT_SHA> `
  -ExpectedImageDigest <SHA256_IMAGE_DIGEST> `
  -ExpectedApiTaskDefinitionArn <EXACT_ACTIVE_API_EMERGENCY_TASK_ARN> `
  -ExpectedWorkerTaskDefinitionArn <EXACT_ACTIVE_SINGLETON_WORKER_TASK_ARN> `
  -ConfirmProductionMutation `
  -ConfirmSyntheticOnlyGlobalActivation `
  -ConfirmProtectedWindowProductionMutation |
  Select-Object -Last 1
```

Hash the returned plan exactly as above. Apply must repeat all three
confirmations:

```powershell
pwsh -NoProfile -File scripts/deploy-classpilot-runtime-config.ps1 `
  -Operation Apply `
  -PlanPath $planPath `
  -ExpectedPlanSha256 $planSha256 `
  -ConfirmProductionMutation `
  -ConfirmSyntheticOnlyGlobalActivation `
  -ConfirmProtectedWindowProductionMutation
```

The plan, checkpoint, and result must retain
`validationLevel: "synthetic_only"`,
`managedValidation: "waived_not_passed"`, the two evidence hashes, and
`protectedWindowProductionMutation: true`. Apply rereads only the captured
copies and revalidates their hashes and freshness before acquiring the
production mutation lease. Never rewrite those fields as `managed` or `passed`.

For a profile that does not yet activate Live View, omit
`-TurnEvidencePath`. For feature-enabling profiles, the helper rejects the
weekday 04:45–10:14 Eastern arrival window unless the exact protected-window
confirmation is bound into the plan. Without that confirmation it also rejects
an API desired count outside 1–2. Every path rejects a
non-singleton worker, an autoscaling target outside the scheduled minimum
`1`/`6` and maximum `6`, scheduled-action drift,
mutable/mismatched images, missing emergency memory, incomplete TURN state, and
an ECS deployment strategy other than exact reviewed ROLLING, or any mutation
outside the allowlist. Protected-window and emergency `off` plans accept only
an exact stable current API count from one through six.
The helper registers both candidates before the
all-scaling hold, rechecks the exact source pair and full deployment
configuration, waits for exact healthy API and running singleton-worker
convergence, and restores the scheduled scaling state only after a coherent
candidate or rollback pair is proven.

Every Apply or Rollback also owns a renewable, fenced record in the production
DynamoDB lock table. Before the first task-registration, scaling, deployment-
configuration, or service mutation, the helper changes that record from
`preparing` to `mutating`. An expired `preparing` or `terminal_safe` lease may be
taken over, but an expired `mutating` record may not: that state means an
already-started process could still resume an AWS write. Stop the rollout and
escalate for exact API/worker/scaling reconciliation; first prove and terminate
the original process so it cannot resume. Do not delete or bypass the lock to
start a second writer. The helper records `terminal_safe` only after one exact
coherent pair, deployment bounds, and scheduled scaling release are proven,
and it performs no external mutation after that point.

`-Operation Rollback` is not the emergency capability kill switch. It accepts
the same plan and hash only to restore that plan's exact immediately prior API
and worker task-definition pair. It cannot turn selected capabilities off,
construct a different rollout registry, or restore an arbitrary older pair.
If automatic recovery cannot prove one coherent pair, the helper records
`apply_failed_manual_intervention`, retains the autoscaling hold, and exits
nonzero. Stop the rollout and escalate the unresolved pair; do not hand-edit
task definitions, rollout entries, or scaling state.

Emergency capability containment is a separate forward operation: first pause
OU unpinning, then create a fresh private profile with `mode` set to `off`, run
a new `Plan`, review and hash its returned relative plan, and run `Apply`.
That mode disables protocol-v3 capability acceptance and every repaired
capability together. Never remove or modify individual rollout entries as a
substitute for the `off` profile.

```json
{
  "schemaVersion": 1,
  "mode": "off"
}
```

Each capability-prefix advance is a new plan/apply operation. After a successful
step, use that step's candidate API and worker ARNs as the exact active source
ARNs for the next plan; never reuse an older plan against a newer serving pair.
The app SHA and image digest remain unchanged throughout this config-only train.

Verify the retained protocol-2/2.7.0 compatibility path before capability
activation, even though the 2.7.1 Store artifact is already public:

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

Every item in that eight-capability sequence depends on
`scopedAuthorityChecksV1`. The server accepts none of them unless the current
exact binding both advertises and is accepted for the marker. This includes
chat, screenshot, safety, Live View, and kiosk V2; the dependency is not limited
to ACK, tab-close, or telemetry capabilities. `kioskLaunchTicketV1` is not a
dependent fallback and remains off.

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

## Managed test acceptance (not passed)

The following remains the strict managed acceptance suite for a future managed
validation record. It was not passed for the approved August 24 synthetic-only
completion and must not be cited as completed. When managed devices are
available, use the unpacked release ZIP and the exact Store artifact and record
all of the following:

- identity A to B changes cannot transmit, persist, upload, or ACK A data under
  B authority;
- ordinary commands remain functional while each high-risk capability is
  enabled independently;
- selected-tab close targets one opaque reference when duplicate URLs exist;
- stale tab/control revisions and incomplete bindings fail unavailable;
- applied, idempotent, and allowlisted terminal ACK receipts drain only their
  exact outbox entries; retryable or mismatched receipts remain;
- chat retry carries its original teaching-session ID, is idempotent, and is
  rejected before insertion if that session is no longer the current authority;
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

The final target is the same for either authorized route: the ordinary strict
route after managed acceptance, or the approved synthetic-only route with the
exact validation and waiver evidence above. Deploy this global registry to the
exact same-digest API and worker pair:

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

This is nine repaired capabilities globally on: the parent marker plus all
eight dependents. `kioskLaunchTicketV1` is explicitly outside that nine and
stays off. A healthy 2.7.1 heartbeat that advertises the marker and dependents
receives the full accepted set; no dependent can be accepted without the marker.

Chrome Web Store publication and runtime activation are separate from Google
Admin installation. Continue controlled adoption and fleet observation, but do
not label that observation “managed validation passed” until the managed suite
above is actually executed. For the approved protected completion, require the
global-on result to retain `validationLevel: "synthetic_only"` and
`managedValidation: "waived_not_passed"`, all nine repaired rollout entries to
be global `on`, V1 to be `off`, and the synthetic TURN and Redis evidence to
remain green.

## Rollback and retained evidence

For emergency containment, pause further managed adoption and create/apply a
fresh `mode: "off"` profile with the runtime helper. This disables the entire
repaired capability set; do not partially edit registry entries or hand-edit
ECS task definitions. The flags-off 2.7.1 path remains compatible with
2.7.0/protocol 2.
Use `-Operation Rollback` only with the exact successful plan whose immediately
prior API/worker pair must be restored. Repair forward if a device already
running 2.7.1 is defective.

Delete merged branches only after backend/frontend smoke and the exact approved
completion evidence is retained. Do not substitute the synthetic-only waiver
for a managed-pass record. Retain the release tag, paired SHAs, uploaded ZIP,
SHA-256, CI and package evidence, TURN and synthetic-validation evidence,
managed-test waiver, rollout result, and previous ECS task definitions. Preserve
protocol 2, legacy ACK fields, ticket V1 code, and legacy kiosk bindings until
99% of the fleet advertises `scopedAuthorityChecksV1` for 30 consecutive days.
