# Remaining-roadmap release preparation

Status: preparation only, 2026-09-30. No deployment, activation, Store upload,
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
| Usage | [administrator page #568](https://github.com/bzinkan/SchoolPilot/pull/568), [initial synthetic load #569](https://github.com/bzinkan/SchoolPilot/pull/569) | Expanded bounded profiles supplement the initial result; record successful school-day capacity and failed stress limits separately. |
| SFU decision | [dated hosting/privacy/cost ADR #561](https://github.com/bzinkan/SchoolPilot/pull/561) | Proposed managed-service cap is unapproved; no media implementation or provisioning. |
| Verification fixtures | [browser teardown #576](https://github.com/bzinkan/SchoolPilot/pull/576), [fixed metrics clock #581](https://github.com/bzinkan/SchoolPilot/pull/581) | Drain held requests and avoid minute-boundary counter flush; preserve actual browser/HTTP assertions. |

The separate ClassPilot stack is [precise enforcement #119](https://github.com/bzinkan/ClassPilot/pull/119),
[Focus #120](https://github.com/bzinkan/ClassPilot/pull/120), then
[local 2.10.0 candidate #121](https://github.com/bzinkan/ClassPilot/pull/121).
Publication, managed-device acceptance and capability activation are distinct.

Expanded usage measurements must retain their workload cardinalities. The valid
extreme fixture produces 500,000 aggregate grains per school from repeated
20-second domain changes and ten short sessions; both initial writes exceed the
existing 60-second limit and roll back aggregates and completion. Report checks
on that bounded fixture passed all 64 requests, with a 4.55-second maximum usage
query under the 15-second API limit. These results do not establish successful
stress writing. A separately named one-million-observation school-day fixture
uses the actual 10-second heartbeat cadence, six lessons, passing windows and
200 school-wide domains. Its result must be recorded independently, preserving
all failed evidence and existing resource/timeout/constraint limits. Its first
bounded run also failed: 84,000 aggregate grains per school exceeded the worker
timeout; concurrent reporting had seven HTTP failures. Consequently neither
expanded profile satisfies capacity acceptance. Measured query improvements
and any later results need their own exact-source evidence; no timeout,
constraint or infrastructure increase may substitute for this acceptance.

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
