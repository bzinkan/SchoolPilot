# Release 2.9.7 usage and runtime evidence

This document describes the focused release-tool and usage acceptance work. It
does not record a deployment, Chrome Web Store upload, managed-device test pass,
or production capacity result. SchoolPilot and the extension release separately.
The canonical release checklist remains the operator's release authority.

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

Before activation, bind both features to the independently reviewed exact
`v2.9.7` merge SHA and ZIP SHA-256 in the runtime tool. Empty, partial, uppercase
or different-version bindings refuse activation. The release receipt must match
those pins, the extension ID, serving app SHA/image digest, tool SHA, selected
capability, pilot school, shared matcher fixture hash and test-evidence hash.
Package edits invalidate the binding and require a new package and review.

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
a completed teaching period and at least 15 minutes, with nonzero actions and
verified exact recipients, enforcement, completed outcomes, stale/offline
cleanup, unsupported-client refusal, healthy API/worker/roster operation and no
privacy/authorization defects. Review within 30 minutes after that window.
This is live validation in the current active school; it imposes no two-device
enrollment requirement. Global operation still retains the managed waiver label.

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

Schema-7 `private-chat-lifecycle-global-on` and
`private-chat-lifecycle-global-off` preserve every other capability, school
setting and announcement control. Activation requires global scoped authority
and student-chat idempotency, the bound reviewed 2.9.7 successor, and the complete
preserved 129-table GUC admission on both serving services. The singleton
`classpilot_private_chat_threads` admission is indivisible and must already have
passed the backend deployment's actual migration/catalog/FORCE-RLS checks.
The runtime tool does not perform migrations or infer catalog admission merely
from a table's existence.

Both profiles require the exact serving source's lifecycle writer version 1,
matching immutable migration and sticky `private_chat_lifecycle_required`
enforcement. Capability withdrawal stops new private issuance; persisted thread
generations/epochs, expiry and cleanup remain enforced. It neither restores a
legacy private writer nor turns off announcements. Once a lifecycle-aware source
is serving, the tool conservatively refuses registry projection onto an image
that predates the lifecycle contract, even with the capability off. Use a
compatible repaired image; capability withdrawal is not data rollback.
Global eligibility includes qualifying schools added later without manual pins.

## Capacity acceptance remains separate

Historical million-observation runs remain immutable. They measured SQL-stored
observations and concurrent sampled HTTP requests, not one million live HTTP
ingestions. The full-128 integration repeat's minimum complete-worker margin was
4.8% against 60 seconds; earlier valid high-cardinality stress and repeat failures
remain limitations. The retained long-range fixture contains 541,500 historical
aggregate rows per school, not a dense full year of heavy daily grains.

The new acceptance requires three fresh, separately recorded final-schema runs
with the same 4-CPU/4-GiB owned PostgreSQL container and 512-MiB Node heap cap,
all existing constraints/RLS/deadlines, two schools with one million stored
observations each, all supported report scopes/date queries, and independently
offered 100 HTTP heartbeats/second total at the observed 10-second device cadence.
Every complete worker operation must finish within 48 seconds of its 60-second
budget. Offered, started, completed, failed, delayed and outstanding HTTP work
must be recorded separately; awaiting responses must not slow the offer rate.
No passing result is recorded here until those exact measured gates complete.

Run the separately named scenario with
`scripts/load/usage/run-local-cold-open-loop-scale.ps1`, selecting an isolated
full-current-schema database and a new empty external evidence directory for
each run. It requires the explicit 129-table inventory before creating the
fixture. The preparation process seeds/ANALYZEs the data and closes its server
and pools. The runner verifies ownership again, restarts only its generated
container, then starts a fresh measurement process using the hashed synthetic
identity snapshot. No JWTs or database passwords are stored in that snapshot.
This resets PostgreSQL shared buffers; it does not flush host filesystem caches.
Ordinary authentication/range preflights still precede concurrent timing.

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
