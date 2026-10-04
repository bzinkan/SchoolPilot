# Unused compatible anchor128 preparation

This additive tool step closes the gap between the supported candidate rehearsal and compatible fallback registration. A rehearsal cloned from the currently serving 121-table admission preserves 121. The fallback controller requires a matching compatible source pair at 128 or 129. Preparing unused 128 definitions does not require first changing the serving services, admitting tables on serving tasks, or applying migrations. Only the new anchor128 path requires its source definitions to be unused; the original fallback path can use the exact current compatible serving pair.

The executable remains `scripts/register-compatible-fallback-inactive.mjs`. The original `Plan` and `RegisterInactive` operations, their 128/129 floor, and their historical 28 mocked checks remain separate. The new opt-in operations are:

| Operation | Complete positional signature after the script path |
|---|---|
| `PlanAnchor128` | `PlanAnchor128`, absolute sealed input JSON path, that file's SHA-256 |
| `RegisterInactiveAnchor128` | `RegisterInactiveAnchor128`, absolute generated `plan.private.json` path, its SHA-256, absolute authorization JSON path, its SHA-256 |

These are interface signatures, not executable release commands with invented inputs. No published resulting-main digest, captured unused definition ARNs, sealed input, Plan or authorization is supplied by this document. Prepare those actual records before deriving a command. Implementation and mocked checks grant no cloud authorization.

`PlanAnchor128` is offline. It accepts only exact 121 API/worker definitions using the same reviewed published serving source and digest, with RLS GUCs enabled, both Usage modes explicitly off, and precise restrictions, Focus and private-chat issuance/rollouts off under the existing controller's contract. Scoped, idempotency, scheduled and all unrelated capabilities remain as captured. It rejects either source definition referenced by the captured services, deployments or task sets. The preserved source must be clean and have unchanged DDC application/schema inputs; source labels in task environment alone are insufficient.

Rendering applies `enforce-deploy-rls-allowlist.mjs` four times, using the registry's exact ordered reviewed bundles: PassPilot rules (121→125), usage rollups (125→126), usage-day coverage (126→127), then appointments (127→128). Every intermediate inventory is checked. The only allowed structural difference is the runtime container's `RLS_ENABLED_TABLES` value. Image, `GIT_SHA`, `SERVICE_NAME`, resources, pools, timeouts, commands, secrets, other environment values, sidecars, tags and every other requestable field remain unchanged. The private-chat thread table is excluded.

## Required input custody

The sealed input has `schemaVersion:1`, a fresh absolute `outputDirectory` outside all three source directories, clean absolute `anchorDirectory` and `fallbackDirectory`, full `anchorSource` and published `anchorImage` digest. The fallback directory must remain at `c578120d980d4c2405a72f4f40b2d3c29a07e20b`; the anchor application/schema inputs must equal `ddc5996b3b8645859fa51a9613486db52c481b7f`. A resulting-main source with only approved non-image changes can qualify, but its rebuilt registry image is not asserted to be historical DDC index `sha256:8ae47ef898382883c20406c83a97728168d115d47345b7790701cb266fd7c835`.

Each of these input keys is an actual private record `{path: absolutePath, sha256: rawFileSha256}`:

| Key | Actual required record |
|---|---|
| `api`, `worker` | Tagged `describe-task-definition` responses for the unused reviewed API and scheduler-worker 121 definitions produced by the separately authorized candidate rehearsal. |
| `liveServices` | Exact two-service `describe-services` response, retaining service and deployment identities. It is the unchanged serving baseline, not a claim that the unused sources serve. |
| `anchorScan` | Passed source-bound legacy image scan receipt, pinned scanner, Linux/amd64, zero HIGH/CRITICAL including unfixed findings. |
| `anchorScanCleanup` | Additional scan-hash-bound exact-owned Exit0/unforced scanner-absence receipt; historical `cleanup.complete` alone is insufficient. |
| `anchorRegistryProof` | Passed scan/config/source/registry proof with the actual published digest, platform digest, region and repository. |
| `anchorPublishedTag` | Exact twelve-character source tag resolving to that published digest, account and repository. |
| `syntheticStage` | Unchanged historical full-contract actual-service DDC/C578 safety proof already pinned by the original controller. The new production-default 43→53/52 recovery is additive evidence; historical 54-ledger proof is not relabelled. |

The pinned registry context is account `135775632425`, region `us-east-1`, repository `schoolpilot-production-api`; scanner `aquasec/trivy@sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa`. There is no publisher in this operation. The candidate rehearsal's existing reviewed publication/scan/archive/config/source-tag/registry chain must complete first under its own authorization. Existing C578 publication likewise remains separate.

The Plan writes private API/worker requests and a hash-bound plan. Registration additionally requires an actual authorization record with `schemaVersion:1`, `operation:'RegisterInactiveAnchor128'`, `authorized:true`, the exact `planSha256`, and `startsAtUtc`/`expiresAtUtc` defining a window of at most 60 minutes. This distinct operation cannot reuse fallback registration permission. Plan age is limited to 60 minutes, and a registration receipt makes the Plan single-use.

## Registration and handoff

`RegisterInactiveAnchor128` replays clean source/tool/helper identities, private permissions, scan report/archive/config/source and exact unforced cleanup, then current AWS account, tag and registry manifest. It rechecks the unchanged serving baseline and both unused source definitions before the first mutation, and each source again immediately before its registration with a fresh authorization-window check. It registers exactly one API definition and one scheduler-worker definition. A returned ARN is persisted before post-return window and exact tagged-definition checks. Unique-name environment permutation is tolerated in captured or registered responses; changed, duplicated or missing bindings and every other array/field difference fail.

No task is launched, service updated, table admitted on serving tasks, migration run, image published, scaling changed or definition automatically deregistered. Partial results and uncertain command outcomes remain in the failed private receipt; do not retry that Plan or mistake partial registration for a verified pair. All AWS responses are retained privately. Final success requires both registered definitions to be exact128 and remain unused by unchanged serving services/deployments/task sets.

After actual registration success, capture and hash the two returned tagged 128 definitions. They become the `api`/`worker` inputs to the original fallback `Plan`, with independently completed C578 publication proofs and a newly captured unchanged `liveServices` baseline. That Plan and its separate `RegisterInactive` authorization yield the unused compatible fallback pair. Application rollout/recovery, production migration/catalog validation, per-task image verification and old ALB-target drains retain their existing separate gates and authorizations. Preparing this chain resolves the anchor dependency; it does not grant deployment permission or capacity acceptance.

After DARK129 is healthy with new issuance controls and both Usage modes off, capture the current exact129 API/worker definitions and serving baseline. Use the original fallback `Plan` with `admissionCount:129` and separately authorized `RegisterInactive` to prepare the matching C578129 rollback pair. Bind its returned ARNs and validate the recovery configuration before private-lifecycle pilot adoption. The128 fallback covers only the128 stage and must never be used after129 adoption. This uses the original supported129 path; no additional anchor-rendering operation is required.
