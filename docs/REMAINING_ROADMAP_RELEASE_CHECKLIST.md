# Remaining-roadmap release preparation

**Historical September 30–October 1 evidence.** Current release instructions are
in [the 2.9.7 operator checklist](RELEASE_2_9_7_OPERATOR_CHECKLIST.md) and
[reconciled PR inventory](RELEASE_2_9_7_PR_INVENTORY.md). The owner selected 2.9.7
and waived the two-Chromebook prerequisite in favor of documented live validation.
The 2.10.0 package and managed-device requirements below describe the earlier
candidate; retain them as history, not current execution instructions.

Status: preparation only, scope dated 2026-09-30; final local evidence through
2026-10-01 UTC. No deployment, activation, Store upload,
paid service creation or legacy resource deletion is authorized by this document.
The canonical scope and gap matrix remain in `SCHOOLPILOT_COMPETITIVE_ROADMAP.md`.

## Evidence record for each slice

Record the exact repository, commit, PR, tests/CI runs and artifact hash. Keep
these columns separate: implemented, local automated tests, CI, packaged,
browser-tested, managed-device-tested, load-tested, deployed and activated.
Use UNKNOWN for unverified serving images, live flags and Store publication.
Do not turn skipped tests or simulation into managed-device evidence.

The initial 2026-09-30 source baseline was SchoolPilot `60f33db` and ClassPilot
`55bb531`. SchoolPilot main subsequently advanced to `d4f3f232` through the
independently merged deployment-safety #578 and Axios #580 fixes. The common
corrective foundation incorporates that main; dependent slices must retain the
new deployment checks when rebased. ClassPilot main remains `55bb531`. The
[public Store listing](https://chromewebstore.google.com/detail/classpilot/iggbfegfcjkfieoemeolfmfnapepalca)
rechecked September 30 showed 2.9.6, updated September 27, superseding the earlier
2.9.5 observation. The v2.9.6 tag resolves to ClassPilot `55bb531`; GitHub release
history was empty. These observations do not establish the published ZIP hash.
Local combined precise/Focus candidate 2.10.0 was selected after these checks;
source/package/device acceptance and publication are separate. Repeat the Store
check immediately before any later authorized upload.
Preserve the existing draft Observe branch and other sessions' checkouts.

## Review order and draft slices

The links below are reviewable implementation slices, not merged or deployed
state. Their current-head checks and exact source evidence are recorded in each
PR; a green earlier head does not cover a later amendment. Stacked branches
preserve the common corrected foundation without modifying either original
checkout. Rebase dependents after their prerequisite changes and rerun affected
checks before review.

| Stage | SchoolPilot draft PRs | Dependency or evidence |
|---|---|---|
| Foundation | [merged Axios correction #580](https://github.com/bzinkan/SchoolPilot/pull/580), [stacked-branch CI #564](https://github.com/bzinkan/SchoolPilot/pull/564) | Equivalent duplicate #562 was closed without merging; its retained branch preserves stack history. Required checks must run on every current stack head. |
| Corrections | [confidentiality #566](https://github.com/bzinkan/SchoolPilot/pull/566), [usage coverage/cutoff #563](https://github.com/bzinkan/SchoolPilot/pull/563) | Public retained overrides and both usage correctness findings have regression coverage; ledger admission and writer fencing remain release preconditions. |
| Precise authoring | [normalized preview API #567](https://github.com/bzinkan/SchoolPilot/pull/567), [interfaces #571](https://github.com/bzinkan/SchoolPilot/pull/571) | Server normalizer, uncached review, broader-site warnings and explicit Classroom boundaries. |
| Focus | [contract #565](https://github.com/bzinkan/SchoolPilot/pull/565), [backend #572](https://github.com/bzinkan/SchoolPilot/pull/572), [teacher controls #575](https://github.com/bzinkan/SchoolPilot/pull/575) | Exact student/tab references, current authority, validated Open receipt and cleanup remain one contract. |
| Classroom | [revision/prerequisite backend #582](https://github.com/bzinkan/SchoolPilot/pull/582), [integrated actions #577](https://github.com/bzinkan/SchoolPilot/pull/577) | Actual interface-to-HTTP/acknowledgement test proves only confirmed students open a lesson; migration is additive and append-only. |
| Appointments | [API #570](https://github.com/bzinkan/SchoolPilot/pull/570), [eligibility races #573](https://github.com/bzinkan/SchoolPilot/pull/573), [school year #574](https://github.com/bzinkan/SchoolPilot/pull/574), [staff interface #579](https://github.com/bzinkan/SchoolPilot/pull/579) | Admission and source-matched writer v2 before activation; configured calendar, atomic issuance and staff-only reminders. |
| Reports | [aggregates/audited CSV #583](https://github.com/bzinkan/SchoolPilot/pull/583), [staff interface #584](https://github.com/bzinkan/SchoolPilot/pull/584) | Authority-fence v1 is mandatory even on wire-version-2 images; changed class/roster/student/membership snapshots fail before data or export audit. Backend owns denominators and historical scope. |
| Usage | [administrator page #568](https://github.com/bzinkan/SchoolPilot/pull/568), [initial synthetic load #569](https://github.com/bzinkan/SchoolPilot/pull/569), [equivalent query improvements #586](https://github.com/bzinkan/SchoolPilot/pull/586), [bounded school-day profiles #591](https://github.com/bzinkan/SchoolPilot/pull/591), [canonical assignment fixtures #592](https://github.com/bzinkan/SchoolPilot/pull/592) | Expanded bounded profiles supplement the initial result; retain each measured source and workload, including failed stress limits and failed repeats. Current-schema fixtures preserve primary staff-assignment constraints. |
| SFU decision | [dated hosting/privacy/cost ADR #561](https://github.com/bzinkan/SchoolPilot/pull/561) | Proposed managed-service cap is unapproved; no media implementation or provisioning. |
| Verification and browser usability | [browser teardown #576](https://github.com/bzinkan/SchoolPilot/pull/576), [fixed metrics clock #581](https://github.com/bzinkan/SchoolPilot/pull/581), [appointment reminder bounds #585](https://github.com/bzinkan/SchoolPilot/pull/585), [active schedule clock #587](https://github.com/bzinkan/SchoolPilot/pull/587), [native capture phase #588](https://github.com/bzinkan/SchoolPilot/pull/588), [responsive Class tools/actual browser readiness #589](https://github.com/bzinkan/SchoolPilot/pull/589), [load-harness startup/cohort fixture #590](https://github.com/bzinkan/SchoolPilot/pull/590), [concurrent device creation #593](https://github.com/bzinkan/SchoolPilot/pull/593), [retained-root auth fixtures #594](https://github.com/bzinkan/SchoolPilot/pull/594) | Preserve authority, pixel, workload and threshold assertions; distinguish test timing corrections from the real narrow-drawer usability fix and exact database-conflict recovery. Current-schema cleanup preserves school/staff roots and primary assignments. |

The separate ClassPilot stack is [precise enforcement #119](https://github.com/bzinkan/ClassPilot/pull/119),
[Focus #120](https://github.com/bzinkan/ClassPilot/pull/120), then
[local 2.10.0 candidate #121](https://github.com/bzinkan/ClassPilot/pull/121).
Publication, managed-device acceptance and capability activation are distinct.

The combined SchoolPilot verification branch is
[`codex/remaining-roadmap-integration` at `954685aeec179bb143b0c65372d30e70ffceca1a`](https://github.com/bzinkan/SchoolPilot/tree/954685aeec179bb143b0c65372d30e70ffceca1a).
It preserves the independent draft slices; it is not a merge or deployment
instruction. Backend/frontend builds and application type checks passed at
`9758a546`; later backend commits change fixtures and CI only. Unit tests passed at
`9940bf51`: 1,653 passes and four existing skips, with unchanged test-type/cast
ratchets. All 122 shard-1 release-focused checks passed at `02fddfe7`. The final
frontend amendment corrects held Usage CSV cancellation after a current access
denial or context change: both 403/409 baseline probes downloaded the old CSV,
while the corrected 21-case Usage suite and 19 administrator checks pass on
`c97c4403`, including actual native request aborts and authorized recovery. The
final frontend build passes; lint retains zero errors and 32 existing warnings.
The later test-only amendment proves actual 401 login navigation destroys the
old export document and prevents a download after draining its response. It
passes on `954685ae`; mounted 403/409 cases retain strict native abort assertions.
The original CI failure of the old-document network-event assertion is preserved;
its absence was not reproduced locally and is not claimed as a product failure.
API/query/schema/workload source hashes are unchanged from the measured
`cc7b3b05` build. The 21 pure workload
guards also pass. Frontend lint has zero errors and 32 existing
warnings. On the complete current 128-table schema, all 35 native authentication
and recovery cases passed, including 48 concurrent writer rounds and all cleanup
hooks, with no skips. That authentication fixture runs with privileged database
access; tenant-isolation evidence remains the separate restricted-role suites.
The measured combined workload and per-command source/log hashes are recorded
in the [structured release index](release-evidence/schoolpilot-remaining-roadmap-20260930.json).
Its CI snapshot is dated: pending checks at capture are not passes. Later
exact-head outcomes are recorded in each PR, including this documentation PR;
do not transfer a prior head's CI or load result to amended source.

The exact local ClassPilot 2.10.0 candidate at
`b187af42d97f63eff31da9a1c9cf7535f853bb6f` passed Node 24.19.0 type checking,
199 unit tests, the full source/native browser chain, 20 expected old-release
regressions, and the exact packaged verifier. The retained ZIP has 24 verified
files, 363,097 bytes and SHA-256
`84808cfc8b900d0fe29f2e682f4211c84510bff72afcf3e969b4b8794c94557e`.
The later candidate documentation commit changes no extension/script bytes.
[Structured evidence and log hashes](https://github.com/bzinkan/ClassPilot/blob/codex/precise-focus-release/docs/release-evidence/classpilot-2.10.0-candidate-20260930.json)
and the [exact-artifact device checklist](https://github.com/bzinkan/ClassPilot/blob/codex/precise-focus-release/docs/CLASS_PILOT_2_10_CANDIDATE.md)
preserve the local evidence and pending device gate. Subsequent exact-head CI
at documentation commit `3a9ece517d521632f1accbb5a51ff3fcf1934162` passed all ten
checks across the [push run](https://github.com/bzinkan/ClassPilot/actions/runs/36796822346)
and [PR run](https://github.com/bzinkan/ClassPilot/actions/runs/36796826297),
including Chrome 120/133/152/stable. Chrome/151 local managed-mode simulations
remain separate from two Google Admin-managed Chromebook acceptance records.

Expanded usage measurements retain their exact workload cardinalities and
failed evidence. The extreme fixture produces 500,000 aggregate grains per
school from repeated 20-second domain changes and ten short sessions. Its
measured writes exceeded the existing 60-second limit and rolled back both
aggregates and completion. Improved reporting passed all 64 requests on that
fixture, with a 4.55-second maximum usage query under the 15-second API limit;
successful extreme-profile writing remains unverified.

The separate school-day fixture uses one million unique observations per school
at the actual 10-second cadence, six lessons, passing windows, 200 school-wide
domains and valid device bindings. It produces 84,000 aggregate grains and
10,002,500 monitored seconds per school. Earlier queries failed, briefly passed
in 46.634/46.857 seconds, then failed their unchanged repeat with six of 64
report requests also failing. Those results remain immutable evidence.

After the equivalent query improvements in #586, two independently recorded
school-day runs passed at unchanged PostgreSQL 4 CPU/4 GiB and Node 512 MiB heap
limits. Both concurrent workers took 52.864/52.204 seconds in the first run and
28.042/28.388 seconds in its repeat. All 64 reports passed in each run; the worst
report SQL took 9.031 seconds and worst API connection acquisition took 642 ms.
Across those runs the narrowest measured margins were 11.9% below the 60-second
worker statement deadline, 39.8% below the 15-second API statement deadline and
87.2% below the 5-second API acquisition deadline. Exact totals, coverage gaps,
tenant rejection, atomicity, CSV/audit and actual heartbeat ingestion passed.
These measurements establish bounded headroom for the named school-day fixture;
they do not establish RDS I/O guarantees or whole-fleet scheduler capacity.

The supported full-year date-range fixture scans 541,500 historical grains; it
does not measure a 365-day history containing 84,000 grains every day. A separate
10,000-AI-decision-per-school scenario exercises nonempty lookup and passed:
concurrent workers took 29.875/29.827 seconds, all 64 reports passed, the maximum
report SQL was 4.414 seconds and maximum acquisition was 726 ms. All independent
totals, binding, tenant, coverage, ingestion and export/audit checks passed.
These three runs use their recorded 127-table admission and source revisions.
The final combined build was subsequently measured twice at `cc7b3b05` with the
complete current schema, all 128 admitted tables forcing RLS under a non-owner
role, and 52 complete migration-manifest entries. Both runs use the same source,
workload, caps, compiled runtime modes and schema; schema comparison removes only
the `pg_dump` restrict/unrestrict nonce after UTF-8/LF normalization.

Both two-school, one-million-observation-per-school runs passed with 10,000
matching AI decisions per school. The first workers took 57.120/56.507 seconds;
the unchanged repeat took 34.311/34.243 seconds. All 64 reports per run, atomic
completion, independent totals, live/empty/unavailable coverage, tenant checks
and audited CSV checks passed. The conservative two-run margins are only 4.80%
below the 60-second complete-worker budget, 19.71% below the 15-second report SQL
budget and 44.49% below the 5-second connection-acquisition budget. The maximum
whole HTTP report took 16.029 seconds; the SQL deadline is not a total HTTP
response guarantee. The first run recorded 319 heartbeat requests and the repeat
857, including four preflight calls in each; actual concurrent offerings were
315/853. Stored rows were 318/856, including successful preflights.

These passes establish bounded local headroom for this fixture. The tight 4.80%
worker margin, failed 500,000-grain stress profile, dense retained-year capacity,
dense AI/exclusion populations, fleet scheduling and RDS I/O remain explicit
limits. No timeout, constraint or infrastructure increase was used. Preserve
each independent source and immutable record in
[the final comparison](https://github.com/bzinkan/SchoolPilot/blob/5d628383f6df9c7fad6d27e7a11e4d7af4ec28e7/scripts/load/usage/evidence-school-day-integrated-128-ai-comparison-20261001.json).

## Operator preflight for a later authorized release

- Confirm the exact approved America/New_York start/end of the September 30
  evening through October 1 evening freeze. Do not invent hours or assume expiry.
- Read serving API/worker task definitions and digest-pinned images, flags,
  RLS allowlists and database catalog. Record source/serving-state differences.
- Use current main and required green CI. Verify the confidentiality and usage
  corrections are included; existing wave-1 green CI does not cover those bugs.
- Require matching API/worker RLS admission and the reviewed migration ledger.
  Preserve historical checksums/inventories. Never preload production tfvars or
  rerun an already-admitted bundle. Admit only missing bundles in registry order.
- Prepare dark backend migration/API/worker release, then frontend release using
  `CLAUDE.md`. SchoolPilot deploys API/web only; the extension is separate.
- Produce fresh reviewed runtime plans after any main/tool-SHA change. Product
  modes use `deploy-product-runtime-config.ps1`; capabilities use
  `deploy-classpilot-runtime-config.ps1`. No hand-edited task definitions,
  alternate setter, Terraform flag activation or bypass of evidence gates.

## Independent product gates

| Product | Evidence required before a later activation |
|---|---|
| School Library | Existing shared/private/Official authorization and copy tests; same-school resource copying, old-client compatibility and website-only acceptance. Does not wait for the new extension. |
| PassPilot Rules | Confidential public DTO/export regression tests, canonical issuance races and restricted-role RLS for all Rules tables. Does not wait for the extension. |
| Daily usage promotion | Three clean shadow school days on the relevant deployed build, using the documented mismatch query and no substituted legacy rows. |
| Monitored Browser Time | Corrected aggregate plus completion ledger admission on both services, compatible reader/writer images, synthetic load evidence and one school day of usage-rollup observation before reporting activation. |
| Appointments | Reviewed appointment admission, atomic activation/concurrency and manager/current-teacher authorization tests; staff reminders only; explicit departure window. |
| Reports v2 | Governed flag addition, report contract v2 plus authority-fence v1 on API/worker, factual denominator/retention behavior, tenant/teacher scope and confidential aggregate/export acceptance. |
| Precise/Focus | Final server contracts, capability/registry parity, exact package tests and two Google Admin-managed Chromebook acceptance records bound to the chosen candidate. |

Page implementation and synthetic fixtures may proceed before operational
shadow/observation gates. Missing operational evidence blocks activation, not
independent development. A successfully computed empty day means no browser
activity was observed; unavailable dates must never appear as measured zeros.

## Extension candidate and rollback

1. Check live Store publication and repository release history before selecting
   the successor. The local successor selected after September 30 verification
   is `2.10.0`; selection does not satisfy release acceptance. Keep the production extension identity
   and canonical package scripts; do not claim a tag is a published version.
2. Record manifest version, tested commit, package contents and SHA-256. Run
   source and packaged lifecycle/enforcement tests against the pinned resource
   current #559 fixture `4ff6b3311bcf6937a776deb5c5eec60de98d7d74e9dc963bf762a842b440d243`.
   Recompute and repin both repositories for any approved fixture successor.
3. On two managed Chromebooks test sign-in, shared-device transitions, duplicate
   tabs, stale references, precise provider/section navigation, worker wake,
   offline/reconnect, restriction failure and Focus cleanup. Record actual
   results and blockers. Synthetic Chromium is separate evidence.
4. Only after acceptance, prepare binding of the exact release evidence to the
   reviewed profiles. Leave managed-validation fields unbound while unavailable.
5. Reconfirm the live Store version immediately before a separately authorized
   upload. Releasing SchoolPilot never uploads ClassPilot.

Precise rollback: disable the capability with the governed tool, clear incompatible
persisted state with the service-bound clear procedure, then use an approved
compatible image. Both serving and rollback images include #550. Preserve the
ClassPilot registry projection and do not strip resources into broader domains.

Usage rollback below the correction: disable both usage modes first. Older writers
cannot establish completion. Invalidate coverage affected by an older writer
before trusting it after roll-forward; never reconstruct coverage from computation
timestamps or aggregate presence. Keep tables/RLS/audit data during rollback.

Focus rollback clears only Focus; it does not remove a retained Waypoint, Flight
Path or unrelated presentation state. Cleanup must remain available with the
new capability gate off. Client support is negotiated, not inferred from a version.

## Presentation and legacy media

`TEACHER_PRESENT_ARCHITECTURE.md` is a decision document, not provisioning approval.
Hosting, privacy/subprocessor review, monthly cap and revocation acceptance must
be approved before media implementation. No production load tests or real student
fixtures; no SFU media in Express, no recording and no frame-relay substitution.

Retained TURN resources stay parked with their current identity protections.
Keep legacy Live View signaling disabled. Later deletion needs current dependency
and supported-client evidence, historical record retention and independent approval.
Never combine decommissioning with feature activation.
