# C578 security successor review packet

This packet prepares one dependency-only recovery successor for DeSales's
133-client release. The [current-release index](releases/release297/current-release.json)
and generated [operator checklist](RELEASE_2_9_7_OPERATOR_CHECKLIST.md) carry the
dated gate states. Preparation evidence does not authorize selecting, publishing,
registering or deploying an artifact.

## Exact source roles

| Role | Source | Meaning |
|---|---|---|
| Historical retained C578 | `c578120d980d4c2405a72f4f40b2d3c29a07e20b` | Immutable original recovery artifact; October 7 fresh scan remains failed |
| Application reference A | `a5161eb14939132776e0b77eac8e3c485091432c` | Clean, exact resulting-main source with passing push/main checks; used for this local recovery pair |
| Recovery successor F | `d75fc1c48d0a3918857508d3965904c69023a153` | C578 plus only the reviewed dependency-lock corrections |
| Tooling reference B | Exact final reviewed tooling commit | Coordinator reference recorded separately from A and F; later main requires proven application equivalence and fresh applicable CI |

The [independent source review](release-evidence/release297-successor-20261007/source-delta-independent-review.json)
verifies the complete C578→F Git object/mode/path comparison and all 28 changed
package records. The correction applies the lockfile patch from
`86ea5c5ca5f76406300f5170d2ecb3e3554baeb3`; unrelated lockfile records and C578's
build process remain intact. No older application tree is merged into main.

The original findings are Critical `proxy-addr` 2.0.7
([upstream fix 2.0.8](https://github.com/jshttp/proxy-addr/security/advisories/GHSA-jqcg-44mw-7w3h))
and High `sharp` 0.35.4
([upstream fix 0.35.5](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w)).
F includes the matching native Sharp/libvips packages. Applicability details do
not relax the zero High/Critical scan gate. The
[original failed observation](releases/release297/local-artifact-observation-20261007.json)
remains immutable.

## Preparation contract

The additive schema-3 ID is `release-297-current-school-fallback-v3`.
Version 1/version 2 profiles and historical C578 identities retain their existing
semantics. The new contract distinguishes `serving-anchor` from `fallback` and
pins each role to its exact source, image, config and publication evidence.
Caller-selected images, binding files and skip-equivalence flags remain forbidden.

`ValidateSuccessorPreparation` verifies the committed allowlisted profile and
hash-pinned source, scan, cleanup and native recovery/review evidence offline.
A successful result reports `preparationPassed: true`, `releaseReady: false`
and `operationalAuthorization: false`. Its output cannot serve as a publication,
registration or deployment Plan. The operational profile remains pending until
all original candidate acceptance and owner-applicability requirements pass.

Native recovery must use migrations **43→53**, admission
**121→125→126→127→128→129**, and **A→F→A**. It must preserve all 53 completed
migrations, screenshot function body/ACL, RLS, private-message expiry/history and
authority fences, exact Focus cleanup and compatible protocol/private-chat floors.
All processes must drain gracefully with no named SQL connections remaining.
Historical 54-entry evidence does not satisfy this proof.

The new Usage and Digital Usage modes stay off. The independent daily-rollup
setting is recorded and preserved on the synthetic API/worker pair; it is not
inferred from the two new settings. Local fixtures do not establish production
flag values or managed-device adoption.

## Review and subsequent operator actions

Review the exact F source and artifact identities, fresh scan and custody,
source-specific checks, native processing and A/F recovery results, independent
reviews and release-tool regressions. Preserve failures and explicit skips.
Selecting F requires a separate recorded review of this exact replacement,
including the amendment to the original exact-C578 requirement.

The 133-client campaign, three 900-second classroom runs, normal-load/headroom
acceptance, final release binding and live acceptance remain pending. Later
changes to A or F invalidate affected pair-specific evidence. Tool/document-only
B changes require proven application inventories equal A and fresh applicable CI.

After source/selection and the original release gates pass, follow the
[operator handoff](RELEASE_297_OPERATOR_HANDOFF.md) for fresh production prerequisites,
exact publication/unused registration, migration-first deployment and DeSales
activation. These actions each retain their separate authorization requirements.
ClassPilot 2.9.7 remains the unchanged, operator-reported live extension; uploaded
package identity and managed adoption still require their own evidence, with
managed validation preserved as `waived_not_passed`.
