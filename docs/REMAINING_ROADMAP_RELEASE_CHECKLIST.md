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

The 2026-09-30 source baseline was SchoolPilot `60f33db` and ClassPilot `55bb531`.
Recheck remote main before implementation/review. The ClassPilot manifest 2.9.6
was an unsubmitted repository candidate. The next release version is provisional.
Preserve the existing draft Observe branch and other sessions' checkouts.

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
| Reports v2 | Governed flag addition, factual denominator/retention behavior, tenant/teacher scope and confidential aggregate/export acceptance. |
| Precise/Focus | Final server contracts, capability/registry parity, exact package tests and two Google Admin-managed Chromebook acceptance records bound to the chosen candidate. |

Page implementation and synthetic fixtures may proceed before operational
shadow/observation gates. Missing operational evidence blocks activation, not
independent development. A successfully computed empty day means no browser
activity was observed; unavailable dates must never appear as measured zeros.

## Extension candidate and rollback

1. Check live Store publication and repository release history before selecting
   the successor. `2.10.0` is provisional. Keep the production extension identity
   and canonical package scripts; do not claim a tag is a published version.
2. Record manifest version, tested commit, package contents and SHA-256. Run
   source and packaged lifecycle/enforcement tests against the pinned resource
   fixture `4ff6b3311bcf6937a776deb5c5eec60de98d7d74e9dc963bf762a842b440d243`.
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
