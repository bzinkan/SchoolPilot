# Release 2.9.7 preparation handoff

The bounded audience is DeSales's 133 clients. The release remains gated: the
fresh scan of the exact retained C578 fallback failed. Preserve that image and
the failure; another image cannot replace it under the existing contract.

Use the [current-release index](releases/release297/current-release.json) as the
single current-status authority and the generated section of the
[operator checklist](RELEASE_2_9_7_OPERATOR_CHECKLIST.md) for its candidate matrix,
gate states and source/evidence applicability. Historical passes, failures and
approvals remain immutable. This packet provides the actions needed to close the
remaining dependencies; it is not a deployment plan or authorization receipt.

## Reviewable changes

| Slice | Review artifact | Release dependency |
|---|---|---|
| Source/evidence reconciliation and generated current status | [Draft PR #616](https://github.com/bzinkan/SchoolPilot/pull/616) | Retains #603/#609 and every merged successor through #615, with inclusion and invalidation matrix |
| Public AI/privacy claims and bounded synthetic audit | [Draft PR #617](https://github.com/bzinkan/SchoolPilot/pull/617) | Merge intended copy/governance changes before freeze; `docs/soc2` changes image content |
| Versioned successor binding | Separate tooling PR, linked on completion | Schema 1 remains historical; allowlisted schema 2 stays pending until reviewed, fresh source-bound receipts exist |
| Protection proposal and this handoff | This PR | Proposed settings for both repositories; no settings application or CI redesign |
| Demonstrated provider-boundary egress | [CP-AI-001 / issue #618](https://github.com/bzinkan/SchoolPilot/issues/618) | Separate narrow remediation and release-applicability review; the copy PR does not fix egress |

The exact source/artifact values and scan findings are in the immutable
[local artifact observation](releases/release297/local-artifact-observation-20261007.json).
Those backend/frontend artifacts were prepared on the clean copy-PR source,
not a frozen resulting-main release. Their hashes do not authorize publication.
The retained extension's source/package evidence is in the
[fresh extension verification](releases/release297/extension-verification-20261007.json).
Version 2.9.7 remains the candidate; Store publication and managed adoption are
separate, unobserved states.

Baseline preparation checks are recorded in the
[check observation](release-evidence/release297-operator-20261007/preparation-checks.json).
The unit lane passed with four explicit environment-dependent skips. The full
infrastructure lane retained three Windows coordinator-parser failures; a focused
tooling correction and rerun must be recorded separately. These local checks do
not replace resulting-main CI or source-bound runtime acceptance.

## Closing preparation gates

1. Review the PRs and CP-AI-001 release applicability. Required merges are operator
   actions. Re-read both remote mains and all intended release changes. Select an
   exact application reference only after copy/governance changes land. Preserve
   already-implemented Focus status and availability unless a remaining defect
   can be reproduced.
2. Resolve the failed exact-fallback scan through a separately reviewed decision.
   Its historical scan pass is not current evidence. Do not waive the scan, alter
   the retained identity, or generate plans that assume it passed.
3. Freeze the tested application reference, deterministic backend and frontend
   Git input inventories, unchanged extension source/package, policy receipt and
   explicit source-applicability/waiver review. Seal the allowlisted
   `release-297-current-school-v2` binding in a reviewed tooling/document follow-up.
   Historical approval of DDC measurements does not approve changed artifacts.
4. Build fresh source-labelled final-main backend and matched frontend artifacts.
   Obtain successful exact-main CI, fresh scan with exact owned/unforced scanner
   custody, native screenshot validation, and the source-bound recovery and
   acceptance receipts below. If main moves, stop affected plans. Application
   changes require new evidence; tool/document-only changes require proven input
   equivalence, refreshed tool/binding hashes and fresh applicable CI.

Keep `CLASSPILOT_USAGE_ROLLUP_MODE=off` and
`CLASSPILOT_DIGITAL_USAGE_MODE=off`. Read the independent
`CLASSPILOT_DAILY_USAGE_ROLLUP_MODE` on API and worker and preserve its observed
value. An omitted daily setting defaults to shadow; the new modes being off does
not prove zero daily-rollup work. Any discrepancy needs an operator decision.

## Required recovery and acceptance evidence

The ordinary chain is migrations **43→53**, admission
**121→125→126→127→128→129**, candidate→retained fallback→candidate. The fallback
declares 52 migrations and must retain the completed ordinary 53-entry ledger,
function bodies/ACLs, RLS and private-message authority/history. Optional staff
identity remains deferred. Historical synthetic 54-entry evidence cannot satisfy
this chain. Require actual restricted-role restoration and local API/worker
execution, compatible capabilities, private-chat compatibility floors and zero
named SQL connections after unforced drains.

The [approved current-school amendment](release-evidence/release-297/release-gate-policy-20261003/current-school-gate-amendment-approved.json)
retains the fixed **A,A,A,B,B,A,A,B** order and every numerical/safety threshold.
Evaluate its 133-client campaign against that policy after explicit applicability
review. Retain three consecutive 900-second mixed classroom runs, the existing
capability-on normal-load check, and accepted 250-client headroom criteria.
Do not replace classroom acceptance with broader Usage tests or revive the
superseded comparison gate. Follow the existing stop policy: preserve a failed
block and state the next falsifiable correction before any rerun.

Include Focus/Bring Forward, Attention restoration, exact command recipients,
private-message expiry versus announcements, reconnect/handoff, screenshots,
analytics and School Library lazy loading. Required browser, extension/package,
unit, type, lint, infrastructure, governance, database and restricted-role RLS
results must retain their actual source, failures and skips. Synthetic schema or
unit checks do not establish native recovery, production health or adoption.

## Separately authorized operator stages

| Stage | Required input and action | Evidence required before proceeding |
|---|---|---|
| 1. Merges and resulting main | Review and merge required changes; refresh both mains and source-specific criteria | Exact merged/head/source identities, proven application equivalence, clean source and green exact-main CI |
| 2. Fresh production prerequisites | Read health, catalog/ledger/admission, backups, all three Usage settings, API/worker environment and task/ALB state in an approved quiet window | Fresh private read-only captures, backup/restoration prerequisites, preserved environment and compatible capability equality |
| 3. Publication and unused definitions | Publish exact scanned artifacts, verify registry index/platform/config mapping; prepare/register only explicitly approved unused121, Anchor128 and compatible fallback definitions | Approved private paths and time-bounded authority; binding ID/hash, final tool hashes, publication receipts and every returned identity; uncertain outcomes stop replay |
| 4. Deployment | Perform documented migration-first backend/worker deployment, then matched frontend deployment | Ordinary phases validated; compatible 128 writer/bridge/relay with issuance off; incompatible tasks and old targets fully drained before 129 admission; fresh health and exact task-pair evidence |
| 5. Extension release and adoption | Recheck live Store listing and pending submissions immediately before exact ZIP upload; separately review a successor only if source/Store state requires it | Fresh Store state, exact uploaded package identity and actual sample-bearing managed version/capability/adoption evidence |
| 6. Pilot activation and live acceptance | Activate only DeSales after the prior gates pass and authority is current | At least 30 minutes of actual live evidence bound to the exact API/worker task pair, including the workflows below |

The [operator prerequisite template](releases/release297/operator-prerequisites.template.json)
contains missing inputs explicitly as null/pending. It cannot be submitted to a
controller as an executable Plan. The version 2 binding is likewise pending and
fails closed. Only create a Plan after actual prerequisites satisfy its controller.
Never invent ARNs, registry proof, timestamps, approvals, receipts or live samples.
Retain returned identities even if partial registration subsequently fails;
resolve uncertainty before retrying.

Live acceptance must cover already-open dashboard/page adoption, sign-in, IXL
Entire Website behavior, precise resources, mixed Flight Paths, Focus/Attention
restoration, Classroom actions, messaging, reconnect and relevant PassPilot/GoPilot
workflows. Preserve exact teacher authority/recipients and student-record roster
boundaries. Adoption must account for open pages and stale dashboards with real
samples; do not treat a deployed bundle or successful upload as client adoption.
Managed-device validation stays **waived_not_passed** until actual evidence supports
a new reviewed status. A zero-sample observation cannot pass.

Later global promotion remains a separate action using the existing per-capability
procedure: each qualifying window is at least 30 minutes, bound to the exact task
pair, reviewed within 30 minutes and fresh within two hours at Plan/Apply. Retain
all additional qualifying-window requirements from that procedure. Pilot evidence
does not automatically authorize global activation.

The [merge-protection proposal](RELEASE_297_MERGE_PROTECTION_PROPOSAL.md) is an
independent settings decision. Optional classroom UX, diagnostics, Usage work,
report labels/pagination, student appointment notices, maintenance extraction and
SFU work remain follow-ups. Usage retains daily-shadow→new-rollup observation→reader
activation; selector follow-up includes grade discovery and selected/inactive
student lookup. No spending increase, TURN operation, legacy destruction,
monitoring expansion or production load testing is part of this preparation.
