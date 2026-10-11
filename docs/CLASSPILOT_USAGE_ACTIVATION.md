# Monitored Browser Time activation

This is the selected Usage operating policy, adopted on October 11, 2026. It
authorizes implementation and preparation. It does not authorize production
activation, database changes, a Terraform apply, extension publication or an
operational window. Each activation needs approval of its exact plan and window.
There is no activation date until the gates below pass.

The switches are global. Inventory every eligible active, ClassPilot-licensed
production school, including its fleet/load, timezone, tracking policy and actual
retention settings. There is no Usage school allowlist. Usage-off measurements
remain baseline evidence; they cannot establish capacity with Usage's heartbeat
admission and shared database pool enabled. Historical waivers for a Usage-off
DeSales release do not apply to this activation.

## Release and evidence binding

Finish and review necessary application fixes, then freeze the exact application
source, image digest, migration stage and complete migration ledger, schema,
frontend artifact, fixture, helper, harness and phase-compatible recovery
artifacts. Re-read PR/main state and actual serving task definitions at the sitting;
the plan's #641-merged/#640-open snapshot is not an operational precondition or a
promise of today's state.

The historical fixture and distinct-report contracts remain available with their
original identities and receipts. A successor source must supply the separately
reviewed binding implemented by
`scripts/load/usage/release-gates-v2/usage-source-binding.mjs`. Its `prepare` command
reads a clean committed source's declarative migration manifest for the selected
`expand` or `contract` stage, source inputs, registry, image binding and schema.
It produces `prepared_not_approved`, never acceptance. An independent review and
both exact file hashes are required by successor invocations. Use `validate` to
re-derive source facts before execution. Fixtures must match the entire reviewed
ledger, not a historical count of 54. Do not transfer a historical pass to new bytes.

`prepare <private-config.json>` takes `sourceDirectory`, `source`,
`applicationImage`, `imageBindingFile`, `imageBindingSha256`, `schemaFile`,
`schemaSha256`, `migrationStage`, `rlsInventory` and `outputFile`. The selected
inventory is `classpilotPrivateChatLifecyclePostExpand`. A separate review binds
the prepared file hash with `kind: "usage_final_source_binding_review"`,
`disposition: "reviewed_for_synthetic_execution"`, `source`, `bindingSha256`,
`reviewer`, `reviewedAtUtc`, `operationalAuthorization: false` and
`capacityAccepted: false`. Consumers take the four exact
`usageSourceBindingFile`/`usageSourceBindingSha256` and
`usageSourceReviewFile`/`usageSourceReviewSha256` settings. The fixture PowerShell
wrappers accept their private config through `-UsageSourceBindingConfig`; helper
preparation also takes `applicationSourceDirectory`. Preparing metadata never
executes migrations. A bound local fixture uses the selected compiled manifest
and the original checksum-ledger executor; ordinary test-mode bootstrap cannot
silently add a contract-stage migration to an expand fixture.

Keep private bindings, exported logs, database responses, receipts, inventory and
approval records outside Git. Public records contain hashes and content-free
summaries. Preserve every failed invocation and its original outcome. Performance
remediation requires its own reviewed change and refreshed affected acceptance;
limits remain fixed.

## Full synthetic gate

Use the canonical profiles, ordering and closure rules in
[release readiness](RELEASE_297_DEPLOY_READINESS.md). Run serially in declared quiet
windows with frozen identities. No production-first waiver, smaller school-sized
profile, worker serialization or omitted database error can satisfy this gate.

1. Pass strict paired production-source/candidate comparisons for `sole-133` and
   `normal-34`, with the original eight-attempt ordering and every original limit.
   Preserve the existing three consecutive 15-minute Usage-off mixed classroom
   runs, their one/three/two-API phases, native classroom actions and separate
   capability-on 34/s check. These remain classroom baseline evidence; they cannot
   replace the Usage-on capacity runs below.
2. Pass three consecutive cold canonical three-API Usage runs: two synthetic
   schools, one million stored observations per school, 6,000 offers at 100/s,
   concurrent reports and concurrent workers. Keep every correctness, persistence,
   tenancy, acquisition, statement, timing, drain and unforced cleanup check.
   Reports remain bounded by 20 seconds and heavy workers by 48 seconds. Perform
   native command/private-message verification after the load.
3. Pass the separate 64-distinct-endpoint campaign bound to those three accepted
   cold receipts and a fresh restore.
4. Pass both 800-client survival variants, ordinary and concentrated reconnect
   traffic. Each requires three consecutive 15-minute runs, actual three-to-two
   server loss and measured reconnect offers.
5. Have a second reviewer independently reload the receipts and verify every
   campaign closure. A failed gate keeps Usage off and produces a blocker report.

Local unit, browser or tooling tests are preparation evidence, not synthetic
capacity acceptance. Run applicable backend/database/RLS suites, canonical harness
tests, product/shared runtime PowerShell tests, frontend lint/build, Digital Usage
browser tests, guide tests, deployment evidence and final-main CI. Freeze final
identities only after source review; CI on an earlier SHA cannot clear them.

## Before switching

Privately record the complete school inventory and reviewed report history from
actual retention/timezones; unavailable dates must remain unavailable. Confirm
both Usage tables' existing admissions, compatible exact serving SHA/digest,
phase-compatible recovery, final CI, health, fleet headroom, three applicable clean
deployed daily-shadow school days and one normal baseline school day on the chosen
serving build. Admissions and deployment are separate operations requiring their
own authority; this document does not perform them.

Name the attended operator and an owner-reachable notification route. Record the
observation dates, school-local boundaries, Eastern monitoring windows, off
authority start/end, incident thresholds and approvals. Ship the frontend first.
Freeze main merges, backend/runtime changes, extension publication and destructive
cleanup from Switch 1 through 17:00 America/New_York on the final monitored normal
school day. A separately approved guarded off operation is the containment action
within that freeze. Keep the shared runtime fence and all protected-clock checks.

## Switch 1 and rehearsal

After hours, approve the exact normal runtime manifest setting rollup `on` with
reporting `off`, then Apply through
[product runtime operations](PRODUCT_RUNTIME_CONFIG_OPERATIONS.md). Run each Apply
in a durable logged process; verify exact API/worker task convergence and an actual
successful worker computation. Finish before the watched day starts.

Rehearse the separately reviewed `-UsageOffContainment` both-off plan and measure
its recovery duration. Preserve any initial failure even if recovery proves off.
Approve a fresh normal rollup-on/reporting-off plan separately after the rehearsal.
Re-enablement does not follow automatically from a containment receipt. Keep
fresh, reviewed off manifests within their two-hour lifetime and regenerate them
after serving or capacity drift.

## Observation and incident response

Watch at least one complete normal school day for every eligible school, every
required hourly worker sample and the following-day finalization/live computation.
Sample classroom and pool health every five minutes during 07:45–17:00 Eastern;
inspect every hourly worker result, including overnight finalization. School-local
day boundaries govern ledger evidence even when schools have different timezones.
An idle live hour need not advance the stored processed cutoff. Restart duplicates
cannot replace a missing scheduler hour.

During the recorded authority window, apply guarded **both-off** and immediately
notify the owner for any of these measured conditions:

- Ten target 5xx responses in a rolling ten-minute window, or at least three in
  each of two consecutive ten-minute windows.
- Any pool-acquisition failure or pool-stalled transition.
- Confirmed simultaneous monitoring loss across multiple students.

Worker failures, missing hours, cleanup, exhausted/deferred work or an
unrepresentative school day invalidate the observation. Resolve the cause and
repeat it. A protected-window or unhealthy/unstable-service refusal enters
incident response; it never permits an unlocked task-definition change. Unproven
recovery keeps `recovery_required` and its fence. Do not promise a recovery time.

## Ledger collection and independent replay

`scripts/collect-classpilot-usage-observation.mjs` is offline. It consumes an exact
identity/window specification, a complete AWS `filter-log-events` worker export and
a bounded read-only ledger/inventory JSON response. Run `--help` for exact input
schemas. Bind the exact serving application SHA, digest, API/worker task ARNs and
observed worker streams; a supplied identity is a record of live inspection, not
proof that SQL or logs authenticated ECS. No serving-image change may cross the
window.

```powershell
node scripts/collect-classpilot-usage-observation.mjs ledger-sql --spec $SpecPath
node scripts/collect-classpilot-usage-observation.mjs collect `
  --spec $SpecPath --logs $WorkerExportPath --ledger $LedgerExportPath `
  --out $EvidencePath --receipt $ReplayReceiptPath
node scripts/collect-classpilot-usage-observation.mjs verify `
  --spec $SpecPath --logs $WorkerExportPath --ledger $LedgerExportPath `
  --evidence $EvidencePath --receipt $ReplayReceiptPath
```

The SQL command prints a template and executes nothing. Obtain the response with
an approved read-only role able to see the complete eligible inventory and each
requested school's ledger. Keep repeatable-read/read-only, explicit school/date
predicates, timeouts and the inventory cap/sentinel. Tenant-limited or truncated
inventory is not full coverage. No policy, grants, GUC or RLS elevation is performed
by this collector. Do not silently treat inaccessible rows as empty days.

All CLI inputs and outputs must be outside every Git repository in private
operator storage. The standalone `scripts/private-permissions.ps1` helper checks
for reparse traversal and operator/SYSTEM-only Windows ACLs (owner-only on Unix).
Create a private parent directory and explicitly protect each exported input
file with `Set-PrivatePathPermissions`; inherited Windows permissions alone do
not satisfy the existing input contract. The collector protects its own new
outputs and refuses overwrite, without changing inputs or parent ACLs.

The collector derives UTC hourly buckets from school-local days, including DST,
and requires actual finalized watched-day ledger rows and valid following-day
live rows. It hashes both input exports and binds them into the setter's existing
schema-1 evidence, with a separate replay receipt. Missing/invalidated coverage,
failures, deferrals, exhausted budgets, malformed ledgers and stale evidence refuse
collection. The second reviewer re-reads the original bytes and re-derives the
evidence; a manually asserted `finalDayComplete` is insufficient. Repeat verification
with current time immediately before Plan/Apply; deterministic `--now` is for tests
and historical replay only.

When complete raw observations and the actual tracking policy/server transitions
remain retained, independently recount numerical totals using the application's
tracking exclusions and compare the rollups, API, CSV and audit. Preserve private
inputs, source identity, hashes and reviewer result. When complete inputs no
longer exist, record the exact retention/deletion reason; never infer numerical
agreement from worker counts or ledger completion. The replay receipt states
whether a numerical recount was available. Report history follows the reader's
retention/coverage fields and may be shorter than the ledger's retained dates.

Use `scripts/classpilot-usage-retained-recount.mjs recount-input-sql --spec
<private-spec> --school-id <watched-school>` to generate the private context
export, then `recount-sql --spec <private-spec> --context <actual-context>` to
generate a bounded read-only totals check. These commands execute no SQL; capture
the actual results separately through the approved read-only procedure. They
load the exact serving source's tracking exclusions and reread retained inputs
using its canonical grain algorithm, checking policy/state drift and finalized
ledger coverage in the same repeatable-read snapshot. This is a separate retained
input recount, not independent reference-algorithm proof.

Index each school's original context and actual result with
`{ "schemaVersion": 1, "entries": [{ "contextPath": "<absolute-private-path>",
"resultPath": "<absolute-private-path>" }] }` and pass `--recount-index` to both
collection and replay. Complete retained raw watched days require a successful
actual recount. Query generation or omitted inputs cannot satisfy it. A size cap,
timeout, policy drift or numerical mismatch blocks that check; resolve it without
inventing agreement. A legitimately partly purged raw day may still have valid
finalized ledger proof, with its unavailable recount reason recorded separately.

## Switch 2 and completion

Obtain mandatory ledger proof for every eligible school and an independent replay.
Approve reporting-on separately. Pass the fresh schema-1 file using
`-UsageObservationEvidencePath` to normal Plan and Apply. Continue attended
monitoring and governed off authority through the next normal school day at 17:00
Eastern. Any incident invalidating evidence must be resolved before proceeding.

Walk through Entire school, grade, class and student scopes, ranges and unavailable
dates, CSV/audit agreement and Student Data exports. Verify teacher and cross-school
denial and normal live classroom monitoring while reports run. Inspect finalization
each morning for five school days. Close with exact source/artifacts, receipts,
evidence hashes, independent replay, walkthrough, incidents and measured rehearsal
recovery duration.

Turn-off retains both tables, RLS, invalidation triggers, retention and cleanup.
Compatible re-enablement can recompute today/yesterday only while complete inputs
remain inside the writer's retention horizon; older missed dates stay unavailable.

The separate [Usage successor record](releases/usage-activation/current.json) tracks
this policy and future evidence references. It records preparation with all gates
pending, a dated read-only both-off serving observation and no authorization. The
generated operator status appends it without rewriting dated 2.9.7 evidence. Status
metadata does not replace private receipt validation, canonical replay or approval.
