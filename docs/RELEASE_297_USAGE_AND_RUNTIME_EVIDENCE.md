# Release 2.9.7 usage and runtime evidence

This document describes the focused release-tool and usage acceptance work. It
does not record a deployment, Chrome Web Store upload, managed-device test pass,
or production capacity result. SchoolPilot and the extension release separately.
The canonical release checklist remains the operator's release authority.

## Current preparation checkpoint

Review slices through `5a03c900` incorporate the distinct report operation/RPC and separately declared mandatory post-load native classroom proof. [Source binding](release-evidence/release-297/release-gate-policy-20261003/harness-integration-5a03-source-binding.json) verifies all 13 reviewed Git blobs and unchanged application/schema/build inputs, while explicitly retaining CRLF-only working-file differences for all 13 canonical Git blobs and the six reviewed host working files. The primary local run passes 150 executions with zero failures/skips (123 unique cases; 27 duplicates). [Host validation](release-evidence/release-297/release-gate-policy-20261003/usage-post-load-native-host967-summary.json) separately passes 118 unique checks, including six report-cost cases. Complete shared integration, unique aggregate checks and subsequent CI still remain.

The [fresh Usage fixture](release-evidence/release-297/release-gate-policy-20261003/usage-fresh-fixture-ddc5996b-summary.json) and [independent review](release-evidence/release-297/release-gate-policy-20261003/usage-fresh-fixture-ddc5996b-independent-review.json) verify 2,000,002 stored observations, 54 migration records, 129 RLS tables, canonical source schema, restricted native restore and exact unforced cleanup. It includes one actual ingest preflight per school. The first invocation fails before measured traffic on a missing host `pg` dependency; original failure/cleanup fields remain immutable. [Repair review](release-evidence/release-297/release-gate-policy-20261003/usage-runner-dependency-repair-independent-review.json) binds the already-tested validator clone and separate resource-absence evidence, preserves its isolated SQL-tripwire preflight and requires a new campaign. No application, original profile, helper, workload, service limit or statement deadline changes. Preparation does not establish Usage capacity or deployment readiness.

The [three full 900-second classroom runs](release-evidence/release-297/release-gate-policy-20261003/classroom-mixed-native-7238-ddc-passed-block.json) and [complete independent review](release-evidence/release-297/release-gate-policy-20261003/classroom-mixed-native-7238-ddc-independent-review.json) pass on application `ddc5996b` and frozen helper `7238c17c`, with both new Usage modes off. All 36,309 heartbeat offers have exact persisted bindings; 180 commands and 90 private messages pass native recipient/lifecycle checks. All 45 minute acceptance sets pass. Worst minute p95 is 115.317 ms and highest API minute CPU is 24.7454%; exact physical API loss precedes reconnect and all resources clean up without force. This is current-school synthetic classroom acceptance. The strict dark comparison, separate Usage capacity, broader 800-client capacity and operational/live gates remain separate.

The [fresh read-only production observation](release-evidence/release-297/release-gate-policy-20261003/readonly-production-20261004-03.json) finds unchanged serving versions/settings, one API and one worker, a healthy API target, and 121 configured admission tables. RDS is available with 14-day backup retention and a restorable point about three minutes before the check. Sunday metrics do not establish school-day capacity; actual catalog/ledger/privileges, successful restore evidence and an approved operational window remain unverified. No production database connection or cloud mutation occurred.

Current application source is `ddc5996b3b8645859fa51a9613486db52c481b7f`.
The [Redis component suite](release-evidence/release-297/release-gate-policy-20261003/realtime-native-green-02.json) passes 24 checks, including four native regressions; [restricted-role health tests](release-evidence/release-297/release-gate-policy-20261003/health-native-green-03.json) pass six cases. The canonical backend type check passes. [Fresh serving/fallback scans](release-evidence/release-297/release-gate-policy-20261003/runtime-artifacts-ddc5996b-c578120d.json) have zero HIGH/CRITICAL findings. [Actual API/worker staged recovery](release-evidence/release-297/release-gate-policy-20261003/staging128129-ddc5996b-passed.json) and [independent review](release-evidence/release-297/release-gate-policy-20261003/staging128129-ddc5996b-independent-review.json) pass bridge, adoption, compatible fallback and return, with all 54 ledger entries/function ACL and expired chat history retained. All eight actual services drain gracefully. The fallback source is `c578120d`; both new Usage modes remain off.

[Combined CI at `dd6d54c0`](release-evidence/release-297/release-gate-policy-20261003/ci-dd6d54c0-complete.json) passes all 20 SchoolPilot and all 10 ClassPilot checks, with application/build inputs bound to `ddc5996b` and the unchanged ZIP. The [native classroom oracle proof](release-evidence/release-297/release-gate-policy-20261003/classroom-native-oracle-c1a09-ddc-proof.json) verifies actual message/outbox/thread bindings and expiration/history rather than assuming message rows always contain attempted-delivery bindings. The [fresh capability-on 34/s run](release-evidence/release-297/release-gate-policy-20261003/classroom-normal-native-c1a09-ddc-summary.json) succeeds on all 2,040 heartbeats, zero refused/late or invalid persisted rows, p95 179.874 ms and fixed-window CPU 55.386%. Both Usage modes remain off.

Final-source current-school comparison and the separate Usage capacity campaign remain pending; the complete mixed-classroom block below passes. The historical strict paired comparison is unaccepted; no host-interference cause or changed policy is claimed. Local synthetic service recovery does not establish production catalog, ECS/ALB drain or live Chrome/SSO behavior; combined Classroom acceptance has its own proof below. [Inspector revision 02](release-evidence/release-297/release-gate-policy-20261003/production-metadata-inspector02-preparation.json) is locally verified and has an exact metadata-only AWS plan, but no production task or database query was executed. Store submission remains held.

The [refreshed helper-13 capability-on 34/s run](release-evidence/release-297/release-gate-policy-20261003/classroom-normal-native-7238-ddc-summary.json) passes all 2,040 offers and exact persisted bindings with p95 162.860 ms and 54.886% fixed-window API CPU, eight commands/four messages, complete error coverage and unforced cleanup. It binds routing source `7238c17c` and application `ddc5996b`. The [short native boundary proof](release-evidence/release-297/release-gate-policy-20261003/classroom-loss-boundary-7238-ddc-native-proof.json) passes all 399 ordinary/reconnect requests and exact persisted bindings, including actual API0 ingress/absence before reconnect. This is a 20-second preparation proof; all three complete 900-second passes and the dark comparison remain separate requirements. The [October 4 public Store observation](release-evidence/release-297/release-gate-policy-20261003/public-store-version-20261004.json) shows 2.9.6, with developer pending submissions still unknown; repeat both checks before any separately authorized upload.

The [native mixed attempt with the preceding helper](release-evidence/release-297/release-gate-policy-20261003/classroom-mixed-native-c1a09-ddc-failed-summary.json) remains failed: all 12,103 ordinary/reconnect offers and exact persisted bindings pass, as do native 60-command/30-message checks and cleanup, but one loss-minute offer used API0. The new routing correction is integrated as `15100dc3` from `7238c17c`; a declared offset selects the endpoint while actual dispatch evidence remains separately recorded. Exact pre-loss arrival counts and physical shutdown before reconnect are mandatory. [All 81 pure checks and generated-wrapper red/green evidence](release-evidence/release-297/release-gate-policy-20261003/harness-boundary-7238c17c-public-summary.json) pass with no skips. Historical clock skew is inferred, not directly recorded. Counts, limits and acceptance thresholds are unchanged. Native preparation, the refreshed normal-load check and the fresh complete mixed campaign now pass.

## Historical ed026 preparation checkpoint

Application `ed0265133d4a87fd3d2477dd90884535b749ee7d` passes all 20 reported
CI checks and 2,032 local unit tests with zero skips. The [application record](release-evidence/release-297/release-gate-policy-20261003/application-correction-summary.json)
binds the fresh scanned API/worker candidate, rebuilt frontend, complete synthetic
54-migration/129-table schema and source re-entry. The [CI and package checkpoint](release-evidence/release-297/release-gate-policy-20261003/ready-checkpoint-ed026-20261004-01.json)
records exact successful runs and unchanged ClassPilot 2.9.7 bytes. At that checkpoint,
subsequent harness/documentation edits preserved application inputs. The later Redis
and health corrections change application inputs and have the separate proofs above.

Native regressions cover atomic cleanup audit, disconnect ownership, exactly-once
lease release and tenant reset. Those fixes also exist in safe fallback source
`6d1f3a7e737ebd2e3e266f2f571cdea811db5e27`; its [fresh scan/focused proof](release-evidence/release-297/release-gate-policy-20261003/safe-fallback-6d1f3a7e-summary.json)
and [actual candidate/fallback/candidate recovery](release-evidence/release-297/release-gate-policy-20261003/recovery-ed026-6d1f3a7e-summary.json)
pass. Recovery preserves all 54 ledger entries, function permissions, expired
private replies, delivered history and exact offline Stop Focus cleanup. These
synthetic image-function checks do not establish production catalog or service
traffic rollback. Real-image preparation smokes are preparation-only. The new measured
paired/current-school and mixed-classroom gates have not passed yet. No new Usage
capacity run is accepted, and no release execution or Store submission is approved.
The unchanged extension's [four packaged retry controls](release-evidence/release-297/release-gate-policy-20261003/packaged-heartbeat-retry-297-summary.json)
also pass, including two-attempt heartbeat limits for 503 and auth cancellation.
Historical checkpoint tables below retain their dated scope and do not select
the current release artifact.

Focused source-bound SQL, restricted-role and release-tool checks are preserved
in the [durable validation manifest and sanitized log archive](release-evidence/release-297/README.md).
They identify their exact incremental checkpoint and retain superseded failures;
they do not certify a later final combined source or measured capacity.

## Precise resources and Focus

The user explicitly approved proceeding without the two managed test
Chromebooks. The new exception is limited to `preciseRestrictionResourcesV1`
and `focusTabV1`, independently. It never reopens the retired TURN/Live View
waiver. The tool continues to reject the old waiver inputs for new plans.

Schema-7 profiles now include `precise-restriction-resources-global-on` and
`focus-tab-global-on`, alongside the existing pilot/off profiles. The pilot
starts from off at one exact school. Global promotion removes only that
capability's school pin, so eligible licensed schools added later receive the
feature automatically. Every unrelated flag, registry entry and school pin is
preserved. An unsupported serving image cannot receive an unknown registry key.
Neither feature is added to the general school-scope-unpin bypass.

The existing after-hours safety and school website blocking pilots also gain
explicit schema-7 `after-hours-safety-only-global-on` and
`school-website-block-global-on` profiles. Their global promotions require the
same exact-package/current-school live acceptance receipt and production
confirmation, without a managed-waiver receipt. Those records say
`validationLevel=live_pilot` and `managedValidation=not_applicable`. They preserve
licensing and negotiated capability checks. Read-only Observe receives no new
global activation profile and is outside this release scope.

Both features are now bound to packaged source
`065be165b5df704d84eb716e3fb914c1fed17f98` and ZIP SHA-256
`82352b04020b5fefdee06aa46cc3ba963ddac0d6c7eab4e241fca2cf6ca61575`
for `v2.9.7`. This identifies candidate bytes; it asserts no acceptance, merge,
tag publication, deployment or Store publication. For these new profiles only,
legacy `RequiredMergeSha` and receipt `classPilotMergeSha` mean the exact packaged
source commit. Historical release bindings retain their existing meaning.
Empty, partial, uppercase or different-version bindings refuse activation. The
release receipt must match
those pins, the extension ID, serving app SHA/image digest, tool SHA, selected
capability, pilot school, shared matcher fixture hash and test-evidence hash.
Package edits invalidate the binding and require a new package and review.

After an authorized history-preserving ClassPilot merge, record its merge SHA
separately and verify the packaged source is an ancestor of `origin/main` and
`v2.9.7^{commit}` resolves to that exact source before upload or activation. The
runtime tool compares pinned identity strings and receipt hashes; it does not
resolve the ClassPilot tag or prove merge ancestry. Keep those operator proofs
with the exact package acceptance. A squash/rebase that replaces this source
requires renewed source binding and acceptance; never silently substitute the
merge commit for the packaged commit.

For Plan, supply a private `RoadmapReleaseEvidencePath` plus
`ConfirmProductionMutation` and `ConfirmRoadmapManagedWaiver`. Approval must be
fresh within two hours and explicitly record the owner's reason. The receipt's
`validationLevel` is exactly `synthetic_only`; `managedValidation` is exactly
`waived_not_passed`. Required evidence covers combined CI, the exact package,
native Chrome, cross-repository matching, unsupported clients, identity/stale
binding, offline cleanup, Attention/lesson/chat regressions, and preserved
announcements. These are assertions backed by private hashed artifacts, not
substitutes for those artifacts or a claim that a managed test occurred.

Global promotion additionally requires private `RoadmapPilotEvidencePath`
from the currently serving one-school pilot. It binds the exact API/worker task
definition pair and managed-runtime fingerprint to the release approval. Observe
a completed teaching period and at least 30 minutes, with nonzero category samples and
verified exact recipients, enforcement, completed outcomes, stale/offline
cleanup, unsupported-client refusal, healthy API/worker/roster operation and no
privacy/authorization defects. Review within 30 minutes after that window.
This is live validation in the current active school; it imposes no two-device
enrollment requirement. Global operation still retains the managed waiver label.

The strict `samples` object records supported clients, completed outcomes,
stale-authority rejections, offline cleanups, unsupported-client rejections and
delivered announcements. Every required count is a positive integer backed by
the private observation artifacts. Precise adds exact-resource/section
enforcement and outside-boundary refusal; Focus adds starts, stops and recipient
outcomes; after-hours adds safety enforcement and ordinary telemetry withdrawal;
website blocking adds blocked and unblocked checks. A single successful action
without the remaining categories cannot authorize promotion.

Plan copies exact evidence bytes into the private run directory. Apply uses
only those plan-bound files, checks their hashes and freshness again, and repeats
the current-source/pilot checks before mutation. Apply requires the explicit
managed-waiver confirmation again. A protected deployment window uses its own
existing confirmation; it is not automatically granted by this exception.
Off profiles need neither waiver nor live-pilot receipts. Rollback restores the
exact compatible preceding runtime using successful apply evidence even if
activation receipts expire or are removed; it does not authorize an image
downgrade or discard persisted feature state.

## Usage observation before report activation

`deploy-product-runtime-config.ps1` permits deploying compatible usage code with
reports off. Activating the worker and reports together is refused. Start the
worker first, retain the three weekday daily-shadow comparisons required by the
existing daily-rollup gate, and observe a complete school day before promoting
Monitored Browser Time reports.

Report activation needs private `UsageObservationEvidencePath`. Its exact
schema-1 JSON contains `reviewedAt`, `reviewReference`, `appSha`, `imageDigest`
and a nonempty `schoolDays` array. Each distinct weekday entry contains
`schoolId`, school-local `date`, `timeZone`, UTC `startedAt`/`endedAt`,
`coverageCheckedAt`, `observedRuns`, `failedSchools`, `deferredDays`,
`budgetExhausted`, `maxRunDurationMs`, `finalDayComplete`,
`currentDayComplete`, `logSha256` and `coverageSha256`.

The receipt must match the serving image, be reviewed within two hours and cover
a school-local day in the preceding 30 days. The window starts no later than
local midnight and ends after the next day's finalization check, at least one
hour after the next local midnight. The timezone calculation handles DST. There
must be at least one run per hour plus the next-day finalization sample, zero
failed schools and deferred days, no exhausted worker budget, a bounded complete
job duration, and ledger-derived finalized-day and current-day coverage. Store
content-free worker logs and the exact coverage response privately and hash both;
do not publish student identities, URLs or browsing history in operator evidence.

Collect successful empty days from the computation ledger as completed days.
Missing/expired ledger days remain unavailable; never substitute numeric zeros.
Plan/Apply hash and revalidate the exact receipt. Unrelated feature plans reject
usage observation evidence. Turning reports off remains available, while retained
coverage tables, RLS, compatible writers and retention continue to protect data.

## Private-chat lifecycle runtime

Schema-7 `private-chat-lifecycle-pilot`, `private-chat-lifecycle-off`,
`private-chat-lifecycle-global-on` and `private-chat-lifecycle-global-off`
preserve every other capability, school
setting and announcement control. Activation requires global scoped authority
and student-chat idempotency, the bound reviewed 2.9.7 successor, and the complete
preserved 129-table GUC admission on both serving services. The singleton
`classpilot_private_chat_threads` admission is indivisible and must already have
passed the backend deployment's actual migration/catalog/FORCE-RLS checks.
The runtime tool does not perform migrations or infer catalog admission merely
from a table's existence.

The current-school pilot begins from off. Global-on requires a fresh exact-source
live pilot receipt covering at least 30 minutes, using
`privateChatLifecycleEnforced` rather than resource/Focus enforcement. In
addition to the common categories, count private threads created, messages
delivered, threads expired, expired messages refused, replacement threads
verified, capability withdrawals verified and hard-off refusals. Every category
must have a real nonzero sample; announcements must remain deliverable. This
promotion has `validationLevel=live_pilot`, `managedValidation=not_applicable`
and no precise/Focus managed-waiver receipt.

All private-chat profiles require the exact serving source's lifecycle writer version 1,
`PRIVATE_CHAT_BRIDGE_VERSION=1`, `PRIVATE_CHAT_RELAY_VERSION=1`,
matching immutable migration and sticky `private_chat_lifecycle_required`
enforcement. Capability withdrawal stops new private issuance; persisted thread
generations/epochs, expiry and cleanup remain enforced. It neither restores a
legacy private writer nor turns off announcements. Once a lifecycle-aware source
is serving, the tool conservatively refuses registry projection onto an image
that predates the lifecycle contract, even with the capability off. Use a
compatible repaired image; capability withdrawal is not data rollback.
Global eligibility includes qualifying schools added later without manual pins.
Once either service admits `classpilot_private_chat_threads`, that append-only
admission is the durable release floor. Unrelated runtime plans must also retain
the complete 129-table/GUC contract and exact compatible writer/bridge/relay/migration after
private chat is off. The ordinary backend deploy guard reads the exact candidate
Git SHA, refuses legacy markers or partial admission before building, and checks
the registered candidates again before migrations or service updates. Turning
the flag off never authorizes rollback to a pre-lifecycle image. Do not remove
the thread table from the allowlist or unset retained school fences.

The first transition has two deployments. First serve the compatible reversible
dark bridge with private capability off and the existing 128-table admission;
before adoption it writes no lifecycle tokens, threads or generation fences.
Let the whole API/worker pair converge and drain every legacy writer. Only then
admit the singleton thread table. The guard requires lifecycle writer version 1,
`PRIVATE_CHAT_BRIDGE_VERSION=1` and `PRIVATE_CHAT_RELAY_VERSION=1` at each rollback source image's exact
`GIT_SHA`, binds that SHA to its immutable ECR image digest, and requires the
same compatible markers at the candidate SHA. This ensures both explicit
rollback and the unchanged ECS circuit-breaker rollback source remain compatible
after first admission. A legacy source cannot be the automatic rollback target
for that admission. After the stable full-129 pair, run the current-school pilot
and its real lifecycle observations before global promotion.

The receiving Redis fence is mandatory even when private issuance is off: it
rechecks persisted message identity, current lifecycle tokens, exact outbox
attempt and current student binding under the delivery locks, then checks expiry
again immediately before synchronous send. A writer/bridge-only image predating
that fence is not a compatible rollback artifact.

## Usage contention repair and capacity acceptance

The historical October 2 decision required all development and synthetic capacity
acceptance before requesting release execution. The approved October 3 amendment
allows the classroom release with both new Usage modes off after its separate
release gates pass. Usage activation still requires completed synthetic capacity
acceptance and deployed observation. Passing worker timings alone is insufficient.

The Usage route now admits at most two reports per API process and one per
school. A round-robin queue holds at most 32 requests overall and 16 per school,
without retaining a database connection. Its 20-second deadline starts before
authentication. After waiting, current credentials, membership, role, school
status and entitlement are checked on the same narrowly scoped tenant lease
used for the repeatable-read report and strict CSV audit. The lease ends before
formatting or transmitting the result. Cancellation discards a running SQL
connection only after its callback and cleanup settle; it never returns an
active connection to the pool. Student Data retains its caller-owned transaction
path. Successful JSON and CSV schemas are unchanged.

Admission overload returns `503`, `CLASSPILOT_USAGE_BUSY` and `Retry-After: 1`.
The interface presents a manual retry action; overload is never a measured zero
and does not cause continuous retries. Negotiated screenshot tracking clients
skip only the preliminary authority/policy calculation whose result was replaced
by the final locked calculation. Legacy behavior and final delivery checks stay
in place. Fixed-label diagnostics contain timings/counters, without identifiers,
URLs, SQL text or message content. No new pool, cache, aggregate table, timeout
increase or infrastructure expansion is part of this correction.

Historical million-observation runs remain immutable. They measured SQL-stored
observations and concurrent sampled HTTP requests, not one million live HTTP
ingestions. The full-128 integration repeat's minimum complete-worker margin was
4.8% against 60 seconds; earlier valid high-cardinality stress and repeat failures
remain limitations. The retained long-range fixture contains 541,500 historical
aggregate rows per school, not a dense full year of heavy daily grains.

The historical October 2 acceptance required three fresh, separately recorded final-schema runs
with the same 4-CPU/4-GiB owned PostgreSQL container and 512-MiB Node heap cap,
all existing constraints/RLS/deadlines, two schools with one million stored
observations each, all supported report scopes/date queries, and independently
offered 100 HTTP heartbeats/second total at the observed 10-second device cadence.
Every complete worker operation must finish within 48 seconds of its 60-second
budget. Offered, started, completed, failed, delayed and outstanding HTTP work
must be recorded separately; awaiting responses must not slow the offer rate.
No passing result is recorded here until those exact measured gates complete.

Both October 2 attempts are retained failures. [Run 01](release-evidence/release-297/usage-cold-open-loop-run-01-4ce644af.json)
and [corrected-source Run 02](release-evidence/release-297/usage-cold-open-loop-run-02-60bb2338.json)
used the same measured workload and normalized schema. Run 02's full workers
finished in 22.623/22.753 seconds, but 32 of 64 JSON reports failed and only 1,541
of 6,000 offered heartbeats succeeded; connection-pool acquisition failures
persisted. Post-run correctness passed. These results establish neither the
required three passing runs nor a lower supported arrival-rate envelope. New
Usage aggregation/reporting remain off. The owner's October 3 amended decision
separates release acceptance from Usage activation:

> SchoolPilot/ClassPilot 2.9.7 may proceed with both new Usage modes off after passing final-source regression, classroom, current-school capacity and recovery checks. Usage activation requires its separate completed development, synthetic capacity acceptance and deployed observation. Historical single-task 100-heartbeat/second failures remain preserved and are not reclassified as passes.

The [amended readiness record](RELEASE_297_DEPLOY_READINESS.md) defines new,
separately identified release and three-API Usage profiles; none is recorded as
passed until its bound final-source measurements complete. The old profile and
failed records remain immutable. Existing daily-rollup shadow mode is a separate
pre-existing setting; do not describe every usage worker as disabled.

The retained comparison scenario runs with
`scripts/load/usage/run-local-cold-open-loop-scale.ps1`, selecting an isolated
full-current-schema database and a new empty external evidence directory for
each run. It requires the explicit 129-table inventory before creating the
fixture. The preparation process seeds/ANALYZEs the data and closes its server
and pools. The runner verifies ownership again, restarts only its generated
container, then starts a fresh measurement process using the hashed synthetic
identity snapshot. No JWTs or database passwords are stored in that snapshot.
This resets PostgreSQL shared buffers; it does not flush host filesystem caches.
Ordinary authentication/range preflights still precede concurrent timing.

That comparison profile advertises the exact 39-capability 2.9.7 list captured from the
extension candidate, records its source commit plus raw/LF source hashes, and
hashes the canonical list alongside the harness. Historical profiles keep their
original empty capability offerings. New precise, Focus and private lifecycle
server gates remain explicitly off and are checked through the production
parsers. Final extension acceptance and a frozen combined-source checkpoint are
required before measurement; the list alone is no package-acceptance claim.

The arrival generator offers 6,000 requests independently over 60 seconds. Each
of 1,000 devices receives six offerings, spaced 10 seconds apart. It records
per-school offered, started, successful, failed and refused requests, offer
lateness, maximum in-flight work, response timings and the final drain. A late
offer over 100 ms, in-flight refusal, request failure or incomplete drain fails
acceptance instead of silently lowering the rate. A bounded 20-second synthetic
request cancellation prevents unbounded drain; production timeouts stay intact.
The actual persisted-heartbeat count is recorded separately and the existing
raw-current-day oracle verifies its attribution. Seeded observations, preflight
HTTP requests, scheduled offers, completed responses and persisted rows are
distinct measurements.

The stronger `release-enabled-isolated-100rps-v1` acceptance profile runs through
`scripts/load/usage/run-release-enabled-scale.ps1`. It separates the API, worker
and arrival generator, performs actual API pool prewarming/readiness, uses staff
session cookies and its own Redis instance, and enables precise restrictions,
Focus and private-chat lifecycle. Representative commands, acknowledgements,
closures and reconnects accompany the workload. These acknowledgements are
synthetic protocol checks, not proof of managed-browser enforcement.

It preserves one API's 16-connection application pool, the worker scheduler's
five-connection pool, the existing PostgreSQL resource limits and production
timeouts. Each run records topology, resource use, source/schema bindings,
connection ownership, PostgreSQL wait categories and event-loop delay. Cold
means a fresh measurement process after restarting the owned PostgreSQL
container; host filesystem caches are not claimed cleared. Diagnostic phases
cannot count as capacity acceptance. Three consecutive successful combined runs
must use unchanged final application source/schema; the original comparison
profile also runs once. Every failed attempt remains evidence.
