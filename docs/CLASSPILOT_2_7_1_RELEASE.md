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
For API desired counts 2 through 6, it temporarily uses minimum healthy
percentages `50`, `66`, `75`, `80`, and `83`, respectively, with maximum
`100`. ECS rounding therefore permits exactly one stop and no capacity growth.
A singleton API uses `100/200`, allowing one temporary replacement without a
stop-first outage. The singleton worker uses `0/100`. The helper preserves the
complete reviewed ROLLING deployment configuration, including the enabled
rollback circuit breaker and alarm fields, while changing only those
percentages. It suspends dynamic and scheduled scaling during mutation,
restores the exact deployment configuration, and reconciles the current
weekday 05:45–10:00 Eastern scheduled minimum (`6` in-window, `1` otherwise)
with a two-phase, boundary-checked release before removing the hold. If desired
capacity drifts after hold acquisition, service mutation stops immediately;
recovery re-derives the no-growth policy from the current frozen count rather
than a stale pre-hold count. The bounded convergence budget is one hour because
a no-growth six-task rollout can require sequential 300-second ALB drains. This
exception can only turn every capability off; it cannot enable or partially
activate features.

Store profiles, TURN proof, plans, checkpoints, and results outside the
repository in one dedicated private evidence root. The helper protects
generated material for the operator account and SYSTEM only on Windows
(owner-only permissions on Unix), prints counts and hashes rather than profile
contents, and rejects repository-local, broad, shared-readable, or
reparse-point inputs. During planning it reads each operator input once and
copies the exact bytes into the new private run directory under the neutral
names `profile.json` and, when supplied, `turn-evidence.json`. Apply and
rollback use only those hash-bound copies; they do not reopen the original
input paths. Neither operator-supplied source paths nor school or TURN values
are written to the plan or stdout. The plan names only the neutral files, and
the final stdout value is the identifier-free `PlanRelativePath` after the
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
  "schemaVersion": 1,
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
    "udpBlockedFallbackPassed": true
  }
}
```

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

For a profile that does not yet activate Live View, omit
`-TurnEvidencePath`. For feature-enabling profiles, the helper rejects the
weekday 04:45–10:14 Eastern arrival window, wrong AWS account, source drift,
API desired count outside 1–2, a
non-singleton worker, an autoscaling target outside the scheduled minimum
`1`/`6` and maximum `6`, scheduled-action drift,
mutable/mismatched images, missing emergency memory, incomplete TURN state, and
an ECS deployment strategy other than exact reviewed ROLLING, or any mutation
outside the allowlist. Emergency `off` uses the stricter
containment exception above and accepts an exact current API count through six.
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

Only after the complete managed test suite is green, replace the test-school
registry with this global rollout registry and deploy it to the exact API and
worker task pair using the helper above:

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

For emergency containment, pause OU unpinning and create/apply a fresh
`mode: "off"` profile with the runtime helper. This disables the entire repaired
capability set; do not partially edit registry entries or hand-edit ECS task
definitions. The flags-off 2.7.1 path remains compatible with 2.7.0/protocol 2.
Use `-Operation Rollback` only with the exact successful plan whose immediately
prior API/worker pair must be restored. Repair forward if a device already
running 2.7.1 is defective.

Delete merged branches only after backend/frontend smoke and managed test-OU
validation. Retain the release tag, paired SHAs, uploaded ZIP, SHA-256, CI and
package evidence, rollout record, and previous ECS task definitions. Preserve
protocol 2, legacy ACK fields, ticket V1 code, and legacy kiosk bindings until
99% of the fleet advertises `scopedAuthorityChecksV1` for 30 consecutive days.
