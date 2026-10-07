# Coordinated SchoolPilot release and ClassPilot 2.9.7

The [current release index](releases/release297/current-release.json) binds the generated status below. [Historical preparation checkpoints](RELEASE_2_9_7_PREPARATION_HISTORY.md) preserve earlier source/artifact selections and every failed attempt. Operational steps below require separate current source, evidence and authorization.

<!-- release297-current-state:start -->
## Current release status

Observed **2026-10-07T23:49:34.842Z**. The [machine-readable index](releases/release297/current-release.json) is the current preparation record; dated evidence below remains historical. Regenerate with `node scripts/release297-current-state.mjs`; verify with `--check`.

**DeSales: 133 clients; both new Usage modes must be off. Candidate freeze and refreshed acceptance are pending. This record grants no operational authorization.**

**Release blocker: the exact retained C578 fallback freshly fails its security scan. Its historical passing scan does not clear the failure; substituting another fallback is not authorized.**

| Source | Current main observed | Historical tested application | Frozen successor |
|---|---|---|---|
| schoolpilot | `a5161eb1` | `ddc5996b` | pending |
| classpilot | `03a9c363` | `065be165` | pending |

All four authorized source preparation PRs **#616, #617, #619 and #620** are merged, with exact resulting-main push checks recorded. Every release-operation authorization flag remains false. The observed main is a dated snapshot; refresh [live main checks](https://github.com/bzinkan/SchoolPilot/actions?query=branch%3Amain) before later release operations.

**Store version 2.9.7 is operator-reported live.** Uploaded ZIP identity and pending submissions remain unknown; managed adoption remains pending and managed validation `waived_not_passed`. The unchanged candidate does not require another upload.

| Stage | Status | Applicability | Next action |
|---|---|---|---|
| Observed merged implementation | passed | current_baseline | Review the bounded successor tooling/state PR; verify exact resulting-main CI after any separately authorized merge. |
| Testing | pending | candidate_pending | Verify the final resulting-main push checks after closing merges; freeze and run the exact-source recovery and bounded acceptance campaign. |
| Packaging | pending | candidate_pending | Resolve the exact fallback blocker, freeze application A, build/test its exact image and frontend, then seal reviewed binding on equivalent final-main B with fresh CI. |
| Publication | pending | candidate_pending | Operator separately authorizes exact artifact publication after acceptance and final-main binding. |
| Deployment | unknown | candidate_pending | Operator refreshes exact serving state and authorizes migration-first deployment. |
| Activation | pending | candidate_pending | Authorize DeSales pilot only after source/image/admission and participating capabilities are verified. |
| Live verification | pending | candidate_pending | Collect at least 30 qualifying minutes on each actual task pair and preserve per-capability promotion freshness. |

| Usage setting | Required value | Fresh observed value | Next action |
|---|---|---|---|
| `CLASSPILOT_DAILY_USAGE_ROLLUP_MODE` | preserve_observed_value | unknown | Read and preserve actual API/worker daily mode separately; do not infer disabled workload. |
| `CLASSPILOT_USAGE_ROLLUP_MODE` | off | unknown | Verify off on every actual API/worker definition before the separately authorized release. |
| `CLASSPILOT_DIGITAL_USAGE_MODE` | off | unknown | Verify off on every actual API/worker definition before the separately authorized release. |

The existing daily/shadow rollup can still run with both new modes off. Preserve its actual observed setting separately.

| Gate | Status | Applicability/source | Evidence and next action |
|---|---|---|---|
| Original baseline exact-main CI | passed | historical; `56df7a4f` | [reconciliationHistorical](releases/release297/source-reconciliation-20261007.json). Repeat applicable CI for preparation heads and final resulting main; a skip is not a test pass. |
| Dated observed main push preparation CI | passed | current_baseline; `a5161eb1` | [reconciliation](releases/release297/source-reconciliation-20261007T233558Z.json). Use this exact source for successor recovery preparation; verify any later application/tooling main and its applicable checks before release operations. |
| Remaining scoped preparation merges | passed | current_baseline; `a5161eb1` | [reconciliation](releases/release297/source-reconciliation-20261007T233558Z.json). Use this exact source for successor recovery preparation; verify any later application/tooling main and its applicable checks before release operations. |
| Operator request for source merges 616/617/619/620 | passed | policy_definition; pending | [mergeRequest](releases/release297/operator-merge-request-20261007.json). Complete and review the named PRs; publication, deployment, activation and settings need separate authorization. |
| Local baseline build, unit and governance preparation | passed | preparation_only; `56df7a4f` | [preparationFollowups](releases/release297/preparation-followups-20261007.json). Review skips/warnings and refresh applicable checks on final source; these local checks do not establish runtime acceptance. |
| Original full Windows infrastructure lane | failed | preparation_only; `56df7a4f` | [coordinatorNewline](releases/release297/coordinator-newline-checks-20261007.json). Retain this attempt. Merge the reviewed tooling fix and require a fresh complete applicable infrastructure lane before closing this preparation dependency. |
| Focused coordinator and role-adapter reruns | passed | preparation_only; `5dfef86c` | [coordinatorNewline](releases/release297/coordinator-newline-checks-20261007.json). Review tooling PR #620; a focused rerun does not turn the original full infrastructure attempt into a pass. |
| Initial local full-infrastructure rerun observation | pending | preparation_only; `5dfef86c` | [coordinatorNewline](releases/release297/coordinator-newline-checks-20261007.json). Require fresh complete applicable CI for the resulting main; preserve the original failed full-lane record. |
| Original public-copy PR preparation CI | passed | preparation_only; `2b7b5dc0` | [preparationFollowups](releases/release297/preparation-followups-20261007.json). Review/merge the copy PR before freezing application A; require fresh resulting-main B CI and proven A/B application equivalence. |
| Disposable full-schema database and restricted-role preparation | passed | preparation_only; `2b7b5dc0` | [preparationFollowups](releases/release297/preparation-followups-20261007.json). Review canonical receipt and skips; run actual ordinary 43→53 restoration and candidate→fallback→candidate recovery on the exact frozen image. Existing 2.9.3 CI capture does not establish 2.9.7 adoption. |
| Retained C578 fresh scan release blocker | failed | current_baseline; `c578120d` | [localArtifactsFresh](releases/release297/local-artifact-observation-20261007.json). Preserve the failed exact C578 scan. Review the dependency-only successor packet and record an exact-artifact selection before any original release acceptance or operational Plan. |
| Local preparation backend scan | passed | preparation_only; `2b7b5dc0` | [localArtifactsFresh](releases/release297/local-artifact-observation-20261007.json). Build/test the exact frozen application A artifact after review; reuse its accepted image/config only with proven final-main B equivalence and fresh CI. Local preparation is not publication. |
| Local Linux screenshot processing | passed | preparation_only; `2b7b5dc0` | [localArtifactsFresh](releases/release297/local-artifact-observation-20261007.json). Refresh final-candidate screenshot/runtime acceptance alongside ordinary recovery and classroom behavior. |
| Frozen source and final main CI | pending | candidate_pending; pending | After the closing merges, retain exact resulting-main push CI; after freeze/sealing, verify fresh applicable CI for final-main B. |
| Bounded criteria approval | passed | policy_definition; `ddc5996b` | [policyApproval](release-evidence/release-297/release-gate-policy-20261003/current-school-gate-amendment-approved.json). Review successor binding/applicability explicitly and rerun the approved fixed-order campaign. |
| Historical bounded numerical acceptance | passed | historical; `ddc5996b` | [policyApproval](release-evidence/release-297/release-gate-policy-20261003/current-school-gate-amendment-approved.json), [fixedComparison](release-evidence/release-297/release-gate-policy-20261003/production-default43-53-fixed8-canonical-independent.json). Preserve original receipts; require fresh successor evidence before assigning a current pass. |
| Successor bounded numerical acceptance | pending | candidate_pending; pending | [policyApproval](release-evidence/release-297/release-gate-policy-20261003/current-school-gate-amendment-approved.json). Use the same amended criteria, fixed order, thresholds, safety checks and stop policy. |
| Historical strict comparison | failed | historical; `ddc5996b` | [fixedComparison](release-evidence/release-297/release-gate-policy-20261003/production-default43-53-fixed8-canonical-independent.json). Retain original failure; the superseding approved bounded policy does not reclassify it. |
| Historical three classroom runs | passed | historical; `ddc5996b` | [classroomHistorical](release-evidence/release-297/release-gate-policy-20261003/classroom-mixed-native-7238-ddc-passed-block.json), [classroomReview](release-evidence/release-297/release-gate-policy-20261003/classroom-mixed-native-7238-ddc-independent-review.json). Rerun three consecutive 900-second runs against frozen successor application inputs. |
| Successor classroom, normal and headroom acceptance | pending | candidate_pending; pending | [normalHistorical](release-evidence/release-297/release-gate-policy-20261003/classroom-normal-native-7238-ddc-summary.json), [headroomHistorical](release-evidence/release-297/release-gate-policy-20261003/lower-250-aaf95-ddc-confirmation-passed.json). Rerun mixed block, capability-on normal-load and accepted 250-client gate with original scope retained. |
| Historical ordinary recovery/restoration | passed | historical; `ddc5996b` | [recoveryOrdinaryHistorical](release-evidence/release-297/release-gate-policy-20261003/production-default43-53-composed06-independent.json). Refresh actual local candidate-to-C578-to-candidate recovery on the ordinary schema/admission chain. |
| Historical full-manifest rehearsal | passed | historical; `ddc5996b` | [recoveryFullHistorical](release-evidence/release-297/release-gate-policy-20261003/staging128129-ddc5996b-passed.json). Never relabel its54-entry evidence as the ordinary 53-entry successor proof. |
| Successor recovery compatibility | pending | candidate_pending; pending | [artifactsHistorical](release-evidence/release-297/release-gate-policy-20261003/runtime-operator-artifact-facts.json), [localArtifactsFresh](releases/release297/local-artifact-observation-20261007.json). Resolve retained-fallback scan blocker by separate review; preserve exact C578. Then verify capability equality, private-chat floors and53-entry recovery without shrinking admission. |
| Historical production catalog | passed | historical; `7af9d0dd` | [catalogHistorical](release-evidence/release-297/release-gate-policy-20261003/catalog-inspection-60cd65-completed.json). Refresh via a new authorized bounded inspection on source/context/window drift. |
| Fresh production, backups, flags and window | unknown | candidate_pending; pending | [productionHistorical](release-evidence/release-297/release-gate-policy-20261003/readonly-production-20261004-03.json), [catalogHistorical](release-evidence/release-297/release-gate-policy-20261003/catalog-inspection-60cd65-completed.json). Operator supplies fresh current task/image/flags/catalog/backups/health and exact authorized window. |
| Two managed Chromebooks | waived_not_passed | policy_definition; `ddc5996b` | [policyApproval](release-evidence/release-297/release-gate-policy-20261003/current-school-gate-amendment-approved.json). Carry the exact waiver label and review its successor applicability; verify actual participating adoption separately. |
| Operator-confirmed live Store version 2.9.7 | passed | current_baseline; pending | [operatorStoreVersion](releases/release297/operator-store-version-20261007.json). Retain the operator report separately from uploaded ZIP, pending-submission and managed-adoption evidence. |
| New Store upload for unchanged 2.9.7 candidate | not_applicable | equivalence_required; `03a9c363` | [operatorStoreVersion](releases/release297/operator-store-version-20261007.json), [extensionFresh](releases/release297/extension-verification-20261007.json). Recheck source/package if it changes; managed adoption still requires actual sample-bearing live evidence. |
| Store uploaded ZIP identity and pending submissions | unknown | equivalence_required; pending | [operatorStoreVersion](releases/release297/operator-store-version-20261007.json). No repeat upload for the unchanged candidate. Verify pending submissions and exact uploaded identity before any separately reviewed successor upload. |
| Separate Usage capacity | failed | historical; `ddc5996b` | [usageFailure](release-evidence/release-297/release-gate-policy-20261003/usage-native-ddc5996b-df919-failed-03.json). Keep both new modes off; diagnostics and Usage activation remain separate follow-up work. |
| Broader800-client capacity | not_applicable | candidate_pending; pending | [policyApproval](release-evidence/release-297/release-gate-policy-20261003/current-school-gate-amendment-approved.json). No broader rollout; require a separately reviewed capacity campaign if scope expands. |
| Live DeSales acceptance and adoption | pending | candidate_pending; pending | [policyApproval](release-evidence/release-297/release-gate-policy-20261003/current-school-gate-amendment-approved.json). Verify already-open pages, sign-in, IXL/precise/mixed paths, Focus/Attention, actions, messaging, reconnect and relevant PassPilot/GoPilot workflows. |
| Fresh canonical extension package verification | passed | current_baseline; `03a9c363` | [extensionFresh](releases/release297/extension-verification-20261007.json), [extensionMerged](release-evidence/release-297/release-gate-policy-20261003/classpilot-merged-main-03a9-passed.json). Retain unchanged version 2.9.7; the operator reports it live, so no repeat upload is needed. Uploaded ZIP identity and managed adoption remain unverified. |
| Raw packaged text versus Git blobs | failed | current_baseline; `03a9c363` | [extensionFresh](releases/release297/extension-verification-20261007.json). Preserve raw failure and newline qualification; never claim byte equality with LF Git blobs or reclassify this failure. |
| Historical published PR #616 CI | passed | preparation_only; `5cb78dfa` | [reconciliationBeforeClosing](releases/release297/source-reconciliation-20261007T212913Z.json). Preserve this dated PR-head snapshot; use the separate merged-source and exact-main gates for current status. |
| Historical published PR #617 CI | passed | preparation_only; `3b7fe064` | [reconciliationBeforeClosing](releases/release297/source-reconciliation-20261007T212913Z.json). Preserve this dated PR-head snapshot; use the separate merged-source and exact-main gates for current status. |
| Historical published PR #619 CI | failed | preparation_only; `9122b61b` | [reconciliationBeforeClosing](releases/release297/source-reconciliation-20261007T212913Z.json). Preserve this dated PR-head snapshot; use the separate merged-source and exact-main gates for current status. |
| Historical published PR #620 CI | pending | preparation_only; `f9bf0f49` | [reconciliationBeforeClosing](releases/release297/source-reconciliation-20261007T212913Z.json). Preserve this dated PR-head snapshot; use the separate merged-source and exact-main gates for current status. |
| Dependency-only successor source review | passed | preparation_only; `d75fc1c4` | [successorSourceReview](release-evidence/release297-successor-20261007/source-delta-independent-review.json). Complete exact-image scan, native processing and ordinary recovery; source review does not approve fallback selection. |

### Inclusion and evidence invalidation

Every listed merge is included in the observed main. CI and historical receipts do not transfer measured acceptance to changed application inputs.

| Merge | Included change | Affected artifacts | Reusable evidence | Required reruns |
|---|---|---|---|---|
| [SchoolPilot #603](https://github.com/bzinkan/SchoolPilot/pull/603) `047bc64f` | Stabilize coordinated roadmap release for ClassPilot 2.9.7 | backend, frontend, release tooling | DDC measurements, failures and policy remain historical; package/runtime changes cannot reuse its image acceptance. | Fresh backend/frontend artifacts, scans, native regression, ordinary recovery and bounded campaigns. |
| [SchoolPilot #606](https://github.com/bzinkan/SchoolPilot/pull/606) `400e71d4` | Preserve admission CSV order in inactive release preparation | release tooling | Application evidence only after final-source equivalence; preserve ordered admission behavior. | Artifact/fallback controller tests and final tool dependency hashes. |
| [SchoolPilot #609](https://github.com/bzinkan/SchoolPilot/pull/609) `a406735c` | Fix School Library loading on lazy Teaching tools routes | frontend | Unchanged backend/extension evidence only with exact-source equivalence. | TeachingTools/School Library lazy-route tests, lint/build and final frontend browser gates. |
| [SchoolPilot #610](https://github.com/bzinkan/SchoolPilot/pull/610) `13420736` | Show daily Chromebook usage averages for each class | backend, frontend, backend dependencies | Policy definitions; source-specific DDC capacity remains historical. | Analytics calculations/browser scenarios, backend scan, screenshot processing, regression/recovery/capacity. |
| [SchoolPilot #612](https://github.com/bzinkan/SchoolPilot/pull/612) `048b0e94` | Accept identical ECR tag aliases during image verification | release tooling | Reviewed image aliases do not authorize a second image; other evidence remains source-bound. | Legacy image verification regression and final tool hashes. |
| [SchoolPilot #613](https://github.com/bzinkan/SchoolPilot/pull/613) `ae41d885` | Simplify ClassPilot usage analytics report | frontend | Backend/extension evidence only if source equivalence is proven. | Analytics browser scenarios and frontend artifact/build. |
| [SchoolPilot #614](https://github.com/bzinkan/SchoolPilot/pull/614) `a14759a2` | Restore Focus and Bring Forward availability on the dashboard | backend, frontend | Existing Focus status/enforcement stays implemented; extension source is unchanged. | Focus/Bring Forward capability availability, current assignment, hydration/recipient regression and refreshed native acceptance. |
| [SchoolPilot #615](https://github.com/bzinkan/SchoolPilot/pull/615) `56df7a4f` | Fix hourly activity chart sizing and readable values | frontend | Backend/extension evidence only if source equivalence is proven. | Hourly activity sizing, labels/readable values and final browser/build gates. |
| [SchoolPilot #616](https://github.com/bzinkan/SchoolPilot/pull/616) `d35e3821` | Release index, generated checklist and historical evidence reconciliation | release-tooling, release-evidence | Retained immutable historical records; no application acceptance is transferred. | Refresh exact candidate evidence and resulting-main CI for applicable later changes. |
| [SchoolPilot #617](https://github.com/bzinkan/SchoolPilot/pull/617) `eecf85f4` | Correct AI/privacy claims and add bounded provider-boundary audit | backend-governance, frontend-public-copy | Source-only copy and audit evidence; issue #618 remains a separate applicability decision. | Fresh candidate image, scan and native acceptance; governance documents are image inputs. |
| [ClassPilot #123](https://github.com/bzinkan/ClassPilot/pull/123) `03a9c363` | Prepare consolidated ClassPilot 2.9.7 release candidate | extension | Fresh canonical package verification passes all 24 files against clean source with identical merged extension tree; raw Git differences remain explicitly CRLF-only. | Reverify package/tree on source drift; fresh Store/pending submissions and actual installed-client capability/adoption checks remain pending. |
| [SchoolPilot #619](https://github.com/bzinkan/SchoolPilot/pull/619) `a5161eb1` | Operator packet, source-specific status and protection proposal | release-tooling, release-evidence | Preparation-only records and reviewed settings proposal; no operational approval. | Refresh source/evidence binding and applicable CI after any tool or source change. |
| [SchoolPilot #620](https://github.com/bzinkan/SchoolPilot/pull/620) `03fbd0fc` | Version 2 binding controller and bounded CI installation correction | release-tooling, ci | Reviewed tooling regressions and passing PR/main CI; v2 profile remains pending. | Refresh tool/binding hashes and exact-main CI; native candidate acceptance remains required. |

### Artifact selection

| Artifact | Status | Source | Identity and limitation |
|---|---|---|---|
| Successor API/worker image | pending | pending | A local preparation image exists, but no exact frozen application A image/config, fresh acceptance or final-main B binding is recorded. Produce a fresh source/scan/archive/manifest/config receipt after freeze. |
| Successor frontend archive | pending | pending | A local preparation archive exists; TeachingTools, Focus and analytics changed from historical inputs. Final-main source is not frozen. Build from frozen source, identify and hash the archive; publication remains separate. |
| Local preparation API/worker image | passed | `2b7b5dc0` | Local Linux scan passes with0 High / 0 Critical / 2 Medium; exact owned scanner exited and was removed without force. Preparation source is not current main or a frozen release. Retain preparation receipts. Build/test exact frozen application A, then reuse that exact image/config under reviewed final-main B only after proven A/B application equivalence. |
| Local preparation frontend archive | passed | `1cb459cc` | Local archive was built from 1cb459cc; public-copy test-only successor 2b7b5dc has equivalent frontend/backend inputs. No frontend deployment occurred. Build/hash the matched frozen application frontend after review; bind it to equivalent final-main B. This archive is preparation-only. |
| Historical DDC API/worker | passed | `ddc5996b` | Historical local build/scan passed for the exact image index, platform manifest, config and archive identities retained in this index. This does not establish successor publication/deployment. Keep as historical evidence; do not select it as the successor image. |
| Retained compatible fallback C578 | passed | `c578120d` | Historical local build/scan passed for the exact image index, platform manifest, config and archive identities retained in this index. This does not establish successor publication/deployment. Preserve exact identity; fresh compatibility/scan checks must pass before operational use. |
| Historical frontend archive | passed | `ed026513` | Retained archive SHA256 7a262bf6704928194ec43cc9da0523084a935a24a040c4de20b2c7a06c321675 describes earlier frontend inputs. Rebuild successor frontend; retain the old artifact as history. |
| ClassPilot 2.9.7 retained ZIP | passed | `03a9c363` | Fresh canonical verifier passes all 24 packaged files byte-for-byte with clean 8069 source; its extension Git tree equals merged 03a9. Raw Git comparison still has 20 CRLF-only differences and remains failed. Retain unchanged version 2.9.7; the operator reports it live, so no repeat upload is needed. Uploaded ZIP identity and managed adoption remain unverified. |

Ordinary migration/recovery uses **43 → 53** completed entries and admission **121 → 125 → 126 → 127 → 128 → 129**. The earlier 54-entry rehearsal remains historical. Preserve C578, equal capabilities and private-chat compatibility floors; never shrink admission during recovery.

<!-- release297-current-state:end -->

## Historical preparation checkpoints

Historical October 3 checkpoint: **Usage capacity has no accepted passing run**.
The new [screenshot-reader implementation](release-evidence/release-297/usage-contention/heartbeat-screenshot-reader-implementation-01/manifest.json)
passes 2,012 unit tests, 95 owner-role and 95 restricted-role database tests,
four private-chat checks, and build/type/cast checks. The initial full-unit
failure and its test-only Windows newline correction remain preserved. All
application and native-test inputs are identical between the passing database
run and final unit run. The reader retains tenant isolation, separate database
snapshots, locks and final authority checks while reducing client round trips.
Its additive 54th migration is included in the [814844f3 candidate image](release-evidence/release-297/usage-contention/candidate-artifact-814844f3/manifest.json),
which passes the uncached build, pinned scan with zero findings and compatibility
checks. The [local recovery rehearsal](release-evidence/release-297/usage-contention/recovery54-814844f3-01/manifest.json)
passes candidate -> compatible fallback -> candidate, preserving all 54 migrations,
private-chat expiration and exact Focus cleanup. This is synthetic recovery,
not verification of the current production catalog or service-traffic rollback.

The first [registered candidate capacity attempt](release-evidence/release-297/usage-contention/capacity-8148-attempt-01/manifest.json)
on `814844f344a45159152415b0fb6d7027f05b093e` **fails**: 3,042/6,000
heartbeats succeed, 2,266 return 500, 692 are refused and 408 offers are late.
Reports pass 48/64; complete workers finish in 15.647/38.266 seconds. Independent
totals, coverage, tenant isolation and eight audited CSVs agree for the observations
actually persisted, but the classroom lifecycle fails. All owners drain and the
six exact containers plus PostgreSQL volume are verified absent. All 13 receipts,
the failed journal entry and the seed-only premeasurement abort remain preserved.
Fewer client queries did not establish capacity: the run also recorded increased
WAL waits and runtime pauses, whose causes are not yet isolated.

Final CI on 814844f3 passes 16/17 jobs and all three security workflows. The
remaining responsive-layout test race has a [test-only synchronization correction](release-evidence/release-297/usage-contention/frontend2-resize-814844f3-01/manifest.json)
with controlled red/green proof and all three targeted browser cases passing.
An unrelated local shard navigation-buffer failure is retained; new-head CI is
still required. Three consecutive accepted capacity runs and the original
comparison remain outstanding. No deployment green light is given.

A [subsequent same-source diagnostic](release-evidence/release-297/usage-contention/diagnostic-8148-pressure-01/manifest.json)
passes all 64 reports and finishes workers in 11.774/29.633 seconds, but only
4,334/6,000 heartbeats succeed. The classroom lifecycle times out after precise
acknowledgement; an aborted response fails API drain verification, so post-load
current-day/CSV correctness is not run. All fixture resources are removed.
Its extra resource sampler produces no samples due to a separately reproduced
AWK compatibility error. That diagnostic cannot establish a host cause or count
as an accepted capacity run. Usage throughput remains unresolved.

The preceding load-tested application is `e95a2b56476b1225434c1b0f3907db46c9d84fe3`.
Its [exact-URL domain-map correction](release-evidence/release-297/usage-contention/domain-map-implementation-e95a2b56/manifest.json)
normalizes repeated URLs once per student while preserving per-observation
classification, timing, tenant scope and atomic writes. Final local checks pass
1,906 unit tests, 25 owner-role and 12 restricted-role native tests, all without
skips, plus build/type/cast checks. All 1,243 captured source files stayed
byte-identical across verification. The measured repeated-URL grain component
improves by 36–39%; the all-distinct normalization kernel increases from 28.022
to 41.495 ms per 6,000 rows. Neither result establishes complete capacity.
The [fresh e95 image](release-evidence/release-297/usage-contention/candidate-artifact-e95a2b56/manifest.json)
passes its uncached build, pinned scan with zero findings and compatibility
checks. The e95 CI rollout clock probe failed; its [test-only correction](release-evidence/release-297/usage-contention/clock-minute-boundary-01/manifest.json)
passes local real-clock and deterministic boundary checks without changing
production deployment code. [Follow-up CI at `97dad081`](release-evidence/release-297/usage-contention/ci-97dad081-final-01/manifest.json)
passes all 17 CI jobs and three security workflows for this application.

The [combined e95 diagnostic](release-evidence/release-297/usage-contention/linux-role-combined-e95-01/manifest.json)
still fails capacity: 4,413 of 6,000 heartbeats succeeded, 949 failed and 638
were refused at the in-flight ceiling, with zero late offers. All 64 reports
passed; whole workers took 12.284 and 30.984 seconds. Independent totals,
coverage, tenant isolation and eight audited CSV checks passed. API CPU used
65.736 seconds over 67.377 elapsed seconds, with event-loop utilization 0.973;
950 acquisitions failed. The first classroom lock-screen request returned 500.
Its generic error log and one tenant-request acquisition failure are consistent
with contention, but do not prove that request's exact cause. Both owners drained,
all six containers were removed, and the recorded PostgreSQL volume was verified
absent. Zero capacity runs are accepted.

The [subsequent ingestion-only CPU diagnostic](release-evidence/release-297/usage-contention/linux-role-ingest-cpu-e95-01/manifest.json)
fails at 5,081/6,000 successful offers, 478 failures, 441 in-flight refusals and
zero late offers. API CPU is 68.140 seconds over a 68.523-second measurement
window. All owners drain and all six containers plus the recorded PostgreSQL
volume are removed. Three raw authority fences account for 1.905 seconds of
sampled construction work; that is not a throughput forecast. Bounded metadata
reuse and narrower heartbeat projections are under investigation. The earlier
zero-offer Redis namespace startup failure remains preserved separately.

The later [restored-fixture combined diagnostic](release-evidence/release-297/usage-contention/restored-combined-e95-01/manifest.json)
also fails: 4,730/6,000 successful heartbeats, 976 failures, 294 refusals, seven
late offers and 977 acquisition failures. All 64 reports pass; whole workers
take 13.987/30.616 seconds. Numeric/coverage/CSV checks pass but the classroom
lifecycle fails. Its actual 13 owner receipts and complete cleanup are retained.
The candidate validator needs the observed single-API preflight-drain shape
and strict 6,000 HTTP-200/persisted-observation agreement; the diagnostic is
not relabeled as accepted. The required passing-run count remains zero.

The [strict candidate harness](release-evidence/release-297/usage-contention/role-candidate-harness-01/manifest.json)
is committed at `0650decf` with 378 passing guard tests and no skips. It now
checks modern HTTP-200/capability/persistence agreement and actual preflight
gauges, and preserves every registered attempt. A three-file EOF-only follow-up
has separate hash/equivalence evidence. Candidate-mode execution is now verified
by the failed 814844f3 attempt above. Three accepted runs remain outstanding;
these harness checks do not establish capacity.

The preceding application was `b11202fc305198d76e73c5e6d711b7dc9ed2d938`.
Its [owned heartbeat SELECT preparation](release-evidence/release-297/usage-contention/heartbeat-prepared-reads-implementation-01/manifest.json)
passes 1,906 unit tests without skips, 50 owner and 50 restricted native tests,
four restricted private-chat cases, and build/type/cast checks. It caches query
metadata only, preserves fresh authority checks, and seals mandatory work before
delivery. The [final binding](release-evidence/release-297/usage-contention/heartbeat-prepared-reads-implementation-01/final-binding.json)
documents a whitespace-only cleanup with identical compiled JavaScript.
Its [fresh local candidate image](release-evidence/release-297/usage-contention/candidate-artifact-b11202fc/manifest.json)
passes an uncached build, a pinned scan with zero findings and embedded
compatibility checks. Full capacity acceptance remains blocked.
[CI's remaining inline-query assertion](release-evidence/release-297/usage-contention/runtime-entitlement-selector-followup-01/manifest.json)
is corrected with 27 focused passes and no application change. At review head
[`a109fd27`](release-evidence/release-297/usage-contention/ci-a109fd27-final-01/manifest.json), all 17 CI jobs and three security workflows pass, including
backend, frontend/browser, both database lanes and rollout-tool validation. The failed
earlier ordinary database job remains preserved.

The [combined b112 diagnostic](release-evidence/release-297/usage-contention/linux-role-combined-b112-01/manifest.json) failed: 3,020 of
6,000 offered heartbeats succeeded, 2,095 failed and 885 were refused at the
in-flight ceiling; 199 offers were late. All 64 reports passed. Complete worker
operations took 25.049 and 47.561 seconds, including admission and cleanup.
There were 2,096 database acquisition failures: 2,095 on heartbeat paths and
one on the classroom lifecycle path, which failed before acceptance. Independent
totals, coverage, tenant isolation and eight audited CSV checks passed. Physical
owners drained and all six owned containers were removed. This is valid failed
diagnostic evidence, not an accepted capacity run or a proven connection leak.
Three consecutive final-source passes and the original comparison remain required.

The [local candidate/fallback recovery proof](release-evidence/release-297/usage-contention/recovery-pair-b112-6e251/manifest.json) passed
for b112 candidate → 6e251 fallback → b112 candidate. Actual bundled image
functions preserved separate thread-close, school-hard-off and activity-hard-off
expiration, delivered history, and Stop Focus cleanup without removing other
restrictions. A separate source migration rehearsal retained 53 migration IDs
and 129 forced-RLS tables through re-entry. Both Usage modes stayed off. These
checks used synthetic fixtures; they do not establish the actual production
catalog, service-traffic rollback, Redis/browser behavior or recovery below the
Usage coverage correction. All failed setup attempts and independent cleanup
proof remain preserved.

The earlier
[candidate-default ingestion diagnostic](release-evidence/release-297/usage-contention/linux-role-ingest-candidate-default-0e427-01/manifest.json)
on `0e427e3c` failed at 5,116/6,000 successes; removing the test-only old-space
override did not resolve saturation. Runtime defaults do not prove live ECS
settings. The following paragraphs retain preceding checkpoint evidence.

Earlier development checkpoints are preserved verbatim in the
[preparation history](RELEASE_2_9_7_PREPARATION_HISTORY.md); their pending-work
statements do not override the current selections below.

## Agreed live-validation boundary

The owner approved 2.9.7 and explicitly replaced the two-managed-Chromebook
prerequisite with documented live validation. Record that prerequisite as
`waived_not_passed`, never as passed. This exception applies to precise resources
and Focus only and must bind the final source, serving image, extension identity,
ZIP hash and automated evidence. It does not waive confidentiality, authority,
recipient, enforcement, tenancy or deployment health checks.

## Release selection and evidence

Use the [generated current status](#current-release-status) and [current index](releases/release297/current-release.json). The [dated source/package selection](RELEASE_2_9_7_PREPARATION_HISTORY.md#archived-checklist-selection--superseded-as-current-state-on-october-7) retains exact historical artifact/tag verification commands and their original results. Reverify source ancestry, tagged packaged commit, retained ZIP and current remote main before reuse; no historical plan/authorization transfers to a successor.

## Acceptance before an operator green light

- Run backend build/type checks, test type/cast ratchets, unit, ordinary database,
  restricted-role RLS, infrastructure and governed runtime suites on final source.
  Run complete migration tests against the converged schema as well as the
  ordinary CI fixture. Distinguish fixture setup failures from product failures.
- Run all four frontend release shards and the aggregate release command,
  including Classroom coverage, frontend build and lint. Preserve assertions;
  PDF failures must be repaired rather than skipped.
- Prove frozen dialog recipients, loss of selection, signed-out Select All,
  offline Stop Focus with issuance off, authority changes, partial failures,
  exact tab references, duplicate URLs and restriction-before-lesson ordering.
- Prove Attention preserves pages while school/precise restrictions remain;
  title-only changes do not invalidate Focus; URL/replacement/closure do.
- Prove private close/send/off/claim/ACK races using real database locks,
  authoritative reconnect, worker restart, reclaims and student binding changes.
  Delivered history remains; expired pending replies never revive. Announcements
  work during private hard-off. Unsupported clients show an update requirement.
- Verify retained-override confidentiality with Rules on/off, all public response
  paths and exports, current/historical authorization, atomic appointments,
  capacity/cancel races, timezone boundaries and reports/CSV denominators and audit.
- Run source and exact-ZIP checks across the existing supported Chrome matrix,
  including pages already open across an update. Record source, manifest version,
  extension ID, ZIP hash and actual outcomes together.
- Require the [amended release gates](RELEASE_297_DEPLOY_READINESS.md): paired
  production-source/candidate checks with both new Usage modes off, current-school
  mixed classroom checks with the three new capabilities on, and compatible
  recovery/artifact evidence on final source. Preserve every failed attempt.
- Before either new Usage mode is activated, separately complete the declared
  three-API/shared-database campaign: three consecutive cold passes, two schools,
  one million stored observations each, 6,000 offers at 100/second fleet-wide,
  all 64 reports plus distinct-report checks, workers within 48 seconds, full
  correctness/drain and no acquisition or statement-deadline failures. Complete
  three-to-two sticky-client survival before claiming broader capacity. The
  historical single-task comparison stays diagnostic, with its failures intact.

Owner-adopted release decision, October 3, 2026:

> SchoolPilot/ClassPilot 2.9.7 may proceed with both new Usage modes off after passing final-source regression, classroom, current-school capacity and recovery checks. Usage activation requires its separate completed development, synthetic capacity acceptance and deployed observation. Historical single-task 100-heartbeat/second failures remain preserved and are not reclassified as passes.

Deployed daily-shadow/new-rollup observation still gates later reporting
activation. A failed confidentiality, authority, recipient, enforcement or
recovery check always blocks the affected release.

## Read actual production before execution

The read-only October 2 snapshot found API 3/3 on
`schoolpilot-production-api-emergency:163`, worker 1/1 on
`schoolpilot-production-scheduler-worker:179`, both at source
`7af9d0dd5bc2bd3e13b96d35a577725e07f8b678` and image
`sha256:c87433cdf3d88e0c291a50d1ae74fbc116f167048f7db9d6c2d1d0ebfc52b9e8`.
Both had GUC enabled and 121 admitted tables. That image is not the compatible
rollback target after private lifecycle adoption. RDS reported available with
14-day backup retention and a recent restorable time; that is not restore-test
evidence. Re-read everything below at execution time.

```powershell
git fetch origin main
git status --porcelain
git rev-parse HEAD origin/main
aws ecs describe-services --cluster schoolpilot-production-cluster --services schoolpilot-production-api schoolpilot-production-scheduler-worker
aws rds describe-db-instances --db-instance-identifier schoolpilot-production-db --query 'DBInstances[0].{Status:DBInstanceStatus,BackupRetentionDays:BackupRetentionPeriod,LatestRestorableTime:LatestRestorableTime,DeletionProtection:DeletionProtection}'
```

Resolve each task definition from the service response; record its digest,
`GIT_SHA`, GUC/admission, capability registry, product flags, network configuration,
desired/running/pending counts and deployment status. Inspect target health,
`/readyz`, recent errors, worker health and CPU/memory/database connection/storage
headroom. The public website's `/readyz` can return the frontend HTML with status
200; that is not a readiness result. Confirm the ALB uses `/readyz` and inspect
its target states. For a task-specific readiness fetch, use the verified API
origin through the existing permitted network path and require HTTP 200,
`application/json`, parsed `{ "status": "ok" }` and `Cache-Control: no-store`.
Do not open origin access to make this check pass. The October 2 workstation
could read public `/health` but could not directly reach origin readiness; the
ALB reported three healthy targets against `/readyz`. Record that limitation,
not an independently fetched readiness body. Record backup readiness and a specific approved America/New_York
operational interval. Do not infer permission from an old freeze note. Retain the
weekday 04:45–05:59 deployment safeguards and public-ECS/no-NAT configuration.

The separately authorized bounded catalog inspection must also verify
`public._health_sentinel` exists and each actual API/worker runtime role has
USAGE on schema `public`, SELECT, INSERT and DELETE on the table, and USAGE on
its owned serial sequence. Verify the exact original table/column/default/sequence
layout and report additional privileges separately. Record these
catalog/privilege results and successful service health checks. Do not grant
schema CREATE or dismiss a missing/denied sentinel as fixture noise. If repair
is needed, prepare the exact owner-side table/privilege correction for approval
before rollout; retain the least-privilege runtime roles.

Check the public Store listing **and the developer dashboard's publication and
pending-submission state** immediately before upload. If a higher version prevents
2.9.7, stop and report it. Publication does not prove client installation.

## Migration and deployment order

Image preparation does not require merging. Build and scan a local candidate
from the frozen review source, bind its image/archive hashes, and rehearse the
additive migrations plus compatible rollback re-entry locally. Keep those proofs
distinct from registry publication and production task-definition bindings.
Before execution, reconcile the artifact source with approved merged main and
passing checks; if the merge changes application bytes, regenerate affected
artifacts and acceptance. The prepared rollback image is local only: no ECR
publication or live task-definition compatibility is established by its synthetic
release-floor proof. Keep both Usage modes off when using that rollback source.

Use a separate clean main worktree after the integration PR is reviewed and
merged; original checkouts and draft Observe work remain untouched. Main must
match origin and required CI must pass. Use the documented `scripts/deploy.sh`
procedure; no hand-edited task definitions. The immutable-image workflow is
opt-in and currently disabled. Keep `IMMUTABLE_RELEASE_IMAGE_ENABLED` disabled
until the `release-image` environment, `AWS_RELEASE_IMAGE_ROLE_ARN` and
repository-scoped GitHub OIDC trust are provisioned and verified. Do not enable
the flag merely to obtain a green workflow. The supported manual consumption
path supplies both `--immutable-image-sha` (the full resulting-main SHA) and
`--immutable-image-digest` (the verified actual ECR digest), even while that CI
publication workflow is disabled. It requires clean main equal to origin/main,
green main CI and a matching full-source ECR tag. Prepare that publication and
unused121 definitions through the separately authorized [artifact-only
adapter](RELEASE_ARTIFACT_PREPARATION.md). This manual path does not establish
a signature; retain scan, source, config and registry verification. The ordinary
legacy path remains available but rebuilds and includes migrations/service updates.
For every admission-stage invocation, the existing controller binds clean main
and the build's `--iidfile`, then runs the pinned `verify-legacy-deploy-image.mjs`
scan before ECR login or publication. All HIGH/CRITICAL findings, including
unfixed findings, and uncertain scanner cleanup stop progression. After push,
the controller verifies the actual registry manifest/config against that scanned
image before task registration, migration or service update. Retain each emitted
evidence directory, source SHA, image archive/config hash, scan receipt/hash,
registry proof and resolved digest in the operator packet. Each rebuilt image
gets its own proof; retain the prepared local image scan as preparation evidence.
The old candidate-rehearsal flags are retired and rejected before AWS credential
work. The capacity-acceptance route is paused. Neither is an artifact-preparation
path, and an ordinary deployment must not be interrupted to prepare artifacts.
The observed ECR repository has mutable tags; preserve its policy and reserve one
authorized publisher during artifact publication. Fresh publisher/tag checks
detect conflicts but do not provide an atomic lock against an unauthorized writer.

Reconcile the live catalog and migration ledger before forming admission plans.
The [read-only access feasibility record](release-evidence/release-297/usage-contention/production-schema-read-feasibility.json)
establishes that this workstation had no verified existing path to obtain the
full private production catalog and ledger. A separately authorized bounded
inspection task, or an operator export through an approved existing path, is
required. The [corrected revision 03](release-evidence/release-297/release-gate-policy-20261003/production-metadata-inspector03-preparation.json) has a concrete read-only plan at `C:/Users/zinka/.codex/artifacts/release297-production-metadata-plan-03/plan.json`, SHA-256 `60cd65f79bdab9dc41b6e7ac30796d2e817271535b98d513705093f1f07f8792`; executable bundle SHA-256 `69f7e77500d94ce2a36dec8fd82bcf8a698db2547790906b281ce20a85adf392`. Its 15 function checks and [independent sealed-plan review](release-evidence/release-297/release-gate-policy-20261003/production-metadata-plan03-independent-review.json) pass. It changes only environment-order comparison, preserving exact values, every other task field, original SQL, repository helpers, production context and limits. The [authorized revision-02 attempt failed before task launch](release-evidence/release-297/release-gate-policy-20261003/catalog-inspection-90304-failed-diagnosis.json); its temporary definition is inactive and serving services/database records were unchanged. The original revision-02 18 Node, 23 PowerShell, nine mocked orchestration, 13 native SQL and two exact-serving-image cases remain historical; they are not relabelled as new revision-03 executions. Both versions include metadata-only health-sentinel layout/privilege checks and configured API/worker database-secret reference equality. The separately approved revision-03 inspection completed on October 4 at 12:35 Eastern: [public execution record](release-evidence/release-297/release-gate-policy-20261003/catalog-inspection-60cd65-completed.json). It observed 121 forced-RLS tables and 43 completed ledger records, the approved school's eligibility and the existing health-sentinel layout/privileges. Exact-task closure and candidate migration reconciliation are recorded separately; these metadata reads do not establish complete production readiness. The [original inspector](release-evidence/release-297/usage-contention/production-metadata-inspector/index.json) and earlier plans remain unchanged. Catalog fingerprints, full ledger and fixed-domain pilot lookup are not a restorable schema export. Do not substitute the reconstructed local rehearsal for that evidence
or derive school UUIDs from a name/domain screenshot. Verify the named DeSales
school's UUID, domain and current licensing/eligibility through authorized
production reads before generating any pilot plan.

The byte-identical executable inspector bundle is retained outside the temporary
directory at `C:/Users/zinka/.codex/artifacts/release297-production-metadata-inspector-03-durable-01`.
Custody checks cover all 45 new manifest members, the sealed copy and the three
unchanged repository helpers. Plan performed only AWS GET metadata reads.
The completed operation used the following exact command; its existing receipt prevents a duplicate execution:

```powershell
pwsh -NoProfile -File C:/Users/zinka/.codex/artifacts/release297-production-metadata-inspector-03-durable-01/run-release-metadata-inspector.ps1 -Mode Execute -OutDir C:/Users/zinka/.codex/artifacts/release297-production-metadata-plan-03 -ApprovedPlanSha256 60cd65f79bdab9dc41b6e7ac30796d2e817271535b98d513705093f1f07f8792
```

Do not rerun this completed operation or reuse its approval for another inspection. A later freshness check requires its own concrete plan and operational window. Any
serving source, network, schedule/task-count or bundle drift requires a new Plan
and review; never edit the existing plan to suppress a drift rejection.
Preserve all historical inventory entries and migration checksums. From the
configured 121-table baseline, the prospective reviewed bundles are below; execute
only those confirmed missing by the actual catalog and ledger:

| Order | Exact `--enable-rls-table` argument | Resulting table count |
|---|---|---|
| 1 | `passpilot_destination_policies,passpilot_pass_limits,passpilot_encounter_restrictions,passpilot_pass_denials` | 125 |
| 2 | `classpilot_usage_rollups` | 126 |
| 3 | `classpilot_usage_rollup_days` | 127 |
| 4 | `passpilot_appointments` | 128 |
| 5 | `classpilot_private_chat_threads` | 129 |

Registry bundle names are labels, not CLI aliases. Preserve the exact ordered
CSV above. These are expected deltas, not permission to repeat an already-admitted bundle.
The tool accepts one reviewed bundle per operation; re-read both services between
operations. First deploy and fully drain to the compatible dark writer/bridge/relay
while the private lifecycle capability remains off and the thread table is not
yet admitted. In this reversible stage, unadopted schools create no private
thread/token/generation state and have no permanent-expiration guarantee yet.
Then admit the final thread bundle only when both exact rollback source images
contain the compatible writer, bridge and relay. The final admission is
`classpilotPrivateChatLifecyclePostExpand`; require identical full admission on
API and worker before capability activation. Run additive migrations using the
candidate's exact image before service rollout. Verify health and admission before
publishing the frontend. Do not shrink admission on rollback.

The screenshot-reader candidate adds the immutable
`classpilot-heartbeat-screenshot-evidence-v1-20261003` migration, bringing its full
manifest to 54 entries without changing the 129-table inventory. Production's
ordinary expansion selector intentionally excludes the unadopted
`20260824_staff_identity_integrity_contract`: the observed 43 completed records
therefore advance by ten required migrations to 53, not 54. Keep
`APPLY_STAFF_IDENTITY_CONTRACT_MIGRATIONS=false`; adoption of that separate
contract requires its existing staged workstream. All 43 observed checksums match
the production-source fixture. Its extra optional contract record and the
historical 54-entry synthetic recovery are not production adoption evidence.
Rehearse the observed 43-entry starting state and ordinary 53-entry recovery
separately before execution. The API verifies
the exact `public.classpilot_heartbeat_screenshot_evidence_v1(text,text,text,text)`
body, invoker execution, volatility, search path and scoped EXECUTE permission
through its actual runtime credential before serving. PUBLIC EXECUTE must remain
revoked. The supported migration task uses the API credential; a distinct
runtime role must have its exact grant verified rather than inferred. The local
fixture CLI is prohibited in production. Preserve this additive function and
the historical migration during compatible rollback. The ordinary production
recovery rehearsal must preserve all 53 completed entries, the screenshot
function/ACL and private-chat expiration. Retain the separate 54-entry rehearsal
for a database where the staff-identity contract was already adopted; never
remove an adopted contract or rewrite historical checksums.

Private lifecycle adoption is a durable compatibility floor. Once admitted,
capability off does not permit a legacy writer or removal of its migration/table.
Prepare a known-good compatible containment/rollback image before activation;
retain it while any offline cleanup is unresolved. The deploy guard verifies each
source image digest against its exact source SHA, the compatible writer/bridge/relay
and full candidate admission. A failed partial rollout retains that compatible
source pair; the original pre-release image is not a lifecycle rollback target.
Compatibility must also include the receiving Redis lifecycle fence
(`PRIVATE_CHAT_RELAY_VERSION = 1`). Writer/bridge markers alone do not establish
that delayed replies are safe. Serving candidates and rollback projections must
retain this fence even with private issuance disabled.

## Runtime and Store sequence

1. Verify the dark compatible API/worker pair, completed migrations and admission;
   publish the matched frontend after health checks pass. Refresh participating
   teachers' already-open SchoolPilot dashboards and verify the served frontend
   assets belong to the release before activating the new chat lifecycle.
   Publishing new assets does not replace JavaScript already running in a tab.
2. Release Library, corrected Rules, appointments and Reports v2 independently
   using `scripts/deploy-product-runtime-config.ps1` Plan → reviewed Apply → verify.
   Respect each mode's authorization, schema and readiness checks. Keep both
   Usage rollup/reporting activation paths off pending their separate evidence.
3. Upload only the independently verified ClassPilot 2.9.7 ZIP. Recheck Store
   state immediately beforehand and preserve the exact uploaded bytes/hash.
4. Confirm participating clients report the installed 2.9.7 version, correct
   extension identity and accepted capabilities. Do not infer support from a
   version string alone or silently route unsupported recipients through an older
   private-chat path. For pages left open during an update, verify the content
   script owner actually changed. Native 2.9.6 upgrade tests require a safe manual
   page reload fallback; do not label that seamless adoption or enable controls
   against stale pages.
5. Use `scripts/deploy-classpilot-runtime-config.ps1` to prepare pilot profiles
   for the verified St. Francis DeSales, Cincinnati school UUID. Confirm its
   `desalescincy.org` identity and eligibility; do not use either synthetic load
   school or guess a UUID. Bind precise/Focus waiver receipts to the exact reviewed
   source, image and ZIP. Enable all three pilots below and let the final
   API/worker pair converge before starting combined classroom acceptance.
   Pilot and global promotion are separate operations.
6. Complete the full live checklist below before **any** global promotion, then
   promote one capability from the actual current-school pilot and its evidence.
   Each Apply changes the task definitions/runtime fingerprint and invalidates
   the prior pair's receipt for subsequent promotion. After convergence, collect
   a fresh qualifying observation window and receipt before the next promotion;
   repeat for the third. Do not relabel earlier samples or copy their timestamps.
   Global availability
   includes future eligible schools; licensing and negotiated client capabilities
   remain mandatory. Observe is not activated by these profiles.

Use governed JSON configurations for Library (`CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE`),
Rules (`PASSPILOT_RULES_MODE`), appointments (`PASSPILOT_APPOINTMENTS_MODE`) and
Reports (`PASSPILOT_REPORTS_MODE=v2`). Never set capabilities or RLS through the
product setter. Generate exact plan manifests only after source/image/serving
state is final; stale plans must be regenerated.

| Capability | Current-school profile | Later global profile |
|---|---|---|
| Private chat lifecycle | `private-chat-lifecycle-pilot` | `private-chat-lifecycle-global-on` |
| Precise restrictions | `precise-restriction-resources-pilot` | `precise-restriction-resources-global-on` |
| Focus | `focus-tab-pilot` | `focus-tab-global-on` |

Each pilot profile is `{"schemaVersion":7,"mode":"<pilot profile>","pilotSchoolId":"<verified DeSales school UUID>"}`.
Its global successor is `{"schemaVersion":7,"mode":"<global profile>"}` and
must omit `pilotSchoolId`. There is no combined global profile or generic unpin
bypass for these capabilities. Each promotion receipt requires at least 30
minutes of positive, sample-bearing observations on its exact current pair,
reviewed within 30 minutes after the window and fresh within two hours at
Plan/Apply. The supported sequential process therefore needs at least three
qualifying observation windows, including the initial full classroom window.
All three pilots must pass the combined user acceptance gate before the first
promotion, even though a per-capability receipt only enforces its own categories.

Require the existing protocol-v3 and repaired-capability prerequisites. Private
lifecycle also requires global student-chat idempotency and the full 129-table
writer/bridge/relay floor. Precise/Focus Plan takes release evidence, production
confirmation and the managed-validation waiver; their global profiles also take
fresh pilot evidence. Private global takes pilot evidence and production
confirmation, without the precise/Focus waiver. Apply consumes the plan-bound
copies; do not substitute evidence files after review.

Product configurations use exactly `{"schemaVersion":1,"environment":{...}}`.
Values below are strings except JSON `null`; omitted names retain live values.
Keep each independent change in a separate reviewed configuration.

| Product change | Exact environment entries |
|---|---|
| Library current-school pilot | `CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE: "on"`, `CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS: "<current-school UUID>"` |
| Library global availability after its acceptance | `CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS: null` with mode already `on` |
| Corrected Rules | `PASSPILOT_RULES_MODE: "on"` |
| Appointments | `PASSPILOT_APPOINTMENTS_MODE: "on"` |
| Reports | `PASSPILOT_REPORTS_MODE: "v2"` |

Appointments require the preserved admission, writer-v2/grant checks and a
configured school year; Reports require report-v2 and authority-fence-v1 serving
support. The product tool uses `-Action`, `-ConfigPath`, `-OutDir` and Apply's
`-ManifestHash`. The capability tool uses `-Operation`, `-ProfilePath`,
`-ExternalEvidenceRoot` and Apply's `-ExpectedPlanSha256`. Use their documented
exact-source/image/task-definition and confirmation parameters; these are not
interchangeable CLI contracts and this table is not an approved production plan.

## Independent product live checks

Use approved sample records in the verified DeSales school. Record timestamps, roles,
opaque record IDs, actual outcomes and evidence hashes privately. Release each
feature through its own governed gate; the classroom pilot does not certify it.
Do not place real student identities or confidential test content in public PRs.

| Feature | Required observed outcomes |
|---|---|
| Library | Exercise a Flight Path and Block List: another teacher cannot see a private original; after sharing, they can apply it and make a private copy, but cannot edit the original. Verify the administrator Official transition and that an administrator cannot publish another teacher's private item. |
| Rules and confidentiality | Observe limit/capacity and encounter denials plus an authorized administrator override. Teacher and office override attempts fail. Verify retained overridden passes, reads and returns omit encounter metadata for teacher, office and kiosk in both governed Rules-on and Rules-off states, while authorized administrator evidence remains available. |
| Appointments | Verify PassPilot-only school-year setup, manager create/edit/cancel, current-teacher reminders and manual activation. Duplicate activation links the same pass; explicit return completes the appointment, overdue remains open and an unused window becomes missed without issuance. An unauthorized teacher cannot read or activate it. Notes are visible to current school managers, including authorized office staff, omitted from teacher DTOs and never copied to the linked pass. |
| Reports v2 | With teacher, office and administrator roles, compare a known authorized filtered cohort to its CSV and committed export audit. Verify completed-overdue and currently-overdue counts separately, retained-only coverage, exact filters and formula-safe cells. Teacher/office reporting must omit encounter override evidence; permitted administrator audit access remains. Appointment note access follows its separate manager contract. |

## Classroom live acceptance record

Bind the record to the verified DeSales school UUID and `desalescincy.org` before
selecting any live recipients. Record start/end timestamps, school, exact API/worker task definitions, image and
source, runtime fingerprints, extension source/version/ID/ZIP and participating
opaque student bindings in private evidence. Do not place student identities or
message content in a public PR. Observe for **at least 30 minutes with actual
samples** and record successes/failures per selected student.

| Exercise | Evidence of success |
|---|---|
| Sign-in and selection | Correct student binding; signed-out students excluded from immediate Select All; dialog audience stays frozen through roster changes |
| Attention on/off | Existing pages survive; overlay clears; school and precise restrictions still apply; valid prior Focus resumes only for its original target |
| Precise / lesson opening | Reviewed resource boundary enforced; failed installation retains previous valid policy; only confirmed students open the lesson |
| Focus / Bring Forward / Stop | Exact referenced tab; title-only change succeeds; URL/replacement stale reference refused; offline Stop Focus remains available with issuance off |
| Private chat close/off | Pending replies expire; reopening/on does not revive them; fresh messages require current thread/epochs; delivered history retained |
| Announcements | Actual announcement delivery while private messaging is off, independent of private expiration |
| Reconnect and cleanup | Worker restart, browser reconnect, sign-out/student change and end-session preserve authority and remove only intended state |
| Health | Sample-bearing API/worker/database/roster health throughout; no wrong recipient, broadened scope, authority leak or revived message |

A successful HTTP response alone is insufficient. Global promotion requires the
actual accepted effects, exact recipient bindings and complete lifecycle samples.
Usage separately requires three clean deployed shadow school days and then one
full school day of rollup observation before reporting activation. Preserve
unavailable/partial/live/final coverage; measured zero means no browser activity
observed, not zero device use.

## Containment and completion

On a wrong recipient, authority leak, broadened restriction, revived expired
message, failed cleanup or unhealthy rollout: stop new issuance, contain the
affected feature and perform exact-bound cleanup. Keep compatible serving
artifacts available while offline cleanup remains unresolved. Stop Focus clears
only Focus. Precise rollback is disable → clear incompatible persisted resources
→ compatible image. Usage rollback below its correction requires both modes off
and coverage invalidation before reuse. Never delete migrations or audit history.

Prepare an extension repair/revert as a higher version, normally 2.9.8. Uploading
2.9.6 does not downgrade installed 2.9.7 clients. Separately identify any locally
installed provisional 2.10.0 copies; 2.9.7 does not update those by version order.

Completion requires reconciled PR dispositions, exact immutable artifacts and
automated evidence, actual deployment and live-validation records, and the final
activated profile state. Keep implemented, tested, packaged, deployed and
activated distinct. SFU implementation, TURN changes, paid provisioning, legacy
deletion and unrelated Observe work remain outside this release.

Sources: [Store listing](https://chromewebstore.google.com/detail/classpilot/iggbfegfcjkfieoemeolfmfnapepalca),
[Chrome update lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/extensions-update-lifecycle),
[Chrome version ordering](https://developer.chrome.com/docs/extensions/reference/manifest/version).
