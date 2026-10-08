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

The actual offline preparation replay uses clean tooling commit
`0ed0511307dff9a2b72895e1096cc40148413451`; its
[immutable observation](releases/release297/successor-preparation-observation-20261008.json)
records exact binding/validator/result hashes. Subsequent state/packet edits are
outside the application inventories. The eventual resulting-main B and its
exact push/main CI remain operator prerequisites after a separately reviewed merge.

The [independent source review](release-evidence/release297-successor-20261007/source-delta-independent-review.json)
verifies the complete C578→F Git object/mode/path comparison and all 28 changed
package records. The correction applies the lockfile patch from
`86ea5c5ca5f76406300f5170d2ecb3e3554baeb3`; unrelated lockfile records and C578's
build process remain intact. No older application tree is merged into main.
The retained source branch is `codex/release297-fallback-security`; review the
[exact C578→F comparison](https://github.com/bzinkan/SchoolPilot/compare/c578120d980d4c2405a72f4f40b2d3c29a07e20b...d75fc1c48d0a3918857508d3965904c69023a153)
without merging its older application tree into main.

The original findings are Critical `proxy-addr` 2.0.7
([upstream fix 2.0.8](https://github.com/jshttp/proxy-addr/security/advisories/GHSA-jqcg-44mw-7w3h))
and High `sharp` 0.35.4
([upstream fix 0.35.5](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w)).
F includes the matching native Sharp/libvips packages. Applicability details do
not relax the zero High/Critical scan gate. The
[original failed observation](releases/release297/local-artifact-observation-20261007.json)
remains immutable.

## Exact local artifacts and security findings

These are source-labelled Linux/amd64 artifacts built using the unchanged pinned
Dockerfile. Registry identities and publication receipts remain unavailable.
The frontend rows identify source inventories; preparing the matched release
frontend remains part of the original candidate acceptance work.

| Identity | Serving anchor A | Recovery fallback F |
|---|---|---|
| Image/index | `sha256:2faa59a736fd0489ece3e61d3a541adbfa4a8e0eb458563c8b9946add7ea1f85` | `sha256:cf7ce08efaa73aed0e5322ae22fecf54e650e74db35eb2aea080d3afae70a459` |
| Config | `sha256:8ccb8b4be632eabd73763b89381c864411192fa4f719dc585429f81da09af340` | `sha256:f215c48e089bd83cb2306814b05f404c82038d2547a526dc7ae3e4e8fe5f9a84` |
| Platform manifest | `sha256:9cda1da374dbc46abc33a5ae915c838455bebbcaf4769257a53df20dc6a87e46` | `sha256:b5848846b7990714672e52f4785ac562a13fdcbcfce5fdc99e6439170268ecb6` |
| Archive SHA-256 | `938699bca3722e20e842c7748bdba17798cf458ed1bfe49149819222df7eeef9` | `ad88fa8fb0aebb5ef2ee9bbffcfe20a0d64a94000b035da843ed028e9bd9ac58` |
| Backend inventory | 563 files; `11ab2736ad2c4fc7a75da1d00b15168c8f5d297c39e6e269808301b961cf669d` | 548 files; `97c9075f67f871d15c3e29006830a8d799c8e0fe22c7d2173fae3421378bdf53` |
| Frontend inventory | 633 files; `3acea6eb117e8e58fa00cd507963bfc40af0f25cae0aa0acd82cb5e3fee3e1d0` | Unchanged from C578: 632 files; `d6ea482405f1b84efa75f3f80f3a63e0ba452349db42af0b8533e1beb8cb103e` |

Both fresh scans pass with **0 High, 0 Critical and 2 Medium**. The scanner is
`aquasec/trivy@sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa`.
The retained database is version 2, updated `2026-10-07T07:38:55.515026687Z`,
next update `2026-10-08T07:38:55.515026457Z`; F was scanned at
`2026-10-07T23:38:18.988Z`, A at `2026-10-07T23:38:25.016Z`.
Raw reports, database metadata, archive/config extraction and exact owned,
unforced scanner cleanup are privately retained and independently reviewed.

The remaining image findings are Medium `CVE-2026-85091` in zlib `1.3.2-r0`
(fix `1.3.2-r1`) and Medium `CVE-2026-97058` in sprintf-js `1.0.3` (no fixed
version reported). They are explicit follow-ups; this patch does not change
the base image or unrelated dependencies.

Exact-F production `npm audit --omit=dev --audit-level=high` passes with zero
High/Critical and three Moderate findings in the mammoth/argparse/sprintf-js
chain. The default production audit exits 1 for those Moderate findings. The
full development-inclusive audit remains **failed** with 13 findings
(7 Moderate, 6 High), including the unchanged tsc-alias/globby/fast-glob/
micromatch/chokidar/braces tool chain. Review and remediate those development
dependencies separately; neither audit failure is relabelled as a pass. The
bounded successor image passes its zero High/Critical runtime scan without
an exception or scan waiver.

## Native validation and retained attempts

The fresh whole recovery attempt `2151d4342b64` passes actual local API/worker
recovery and restricted-role post-restoration checks on the exact A/F artifacts above. It covers
all six admission counts, eight API/worker processes and eight graceful drains;
every drain exits zero, without OOM or forced stop, with zero remaining named SQL
connections. F declares 52 migrations while preserving all 53 completed ledger
rows. Restricted-role tenant checks, retained screenshot function body/ACL,
private expiry/history and authority fences, exact Focus cleanup, equal runtime
capabilities and private-chat floors pass. Owned fixture cleanup is complete.
Its original DDL restore runs under the fixture's superuser owner; that limitation
remains recorded. Additive fixture `restricted-restoration-13d577a3ca2c` passes
four restore rounds under an actual NOSUPERUSER/NOBYPASS owner, with restricted
non-owner tenant checks, stable second serialization and unforced cleanup.
The separate restricted-restoration evidence binds both proofs; the original
superuser restore is not relabelled as a restricted-owner operation.
The actual ordinary migrations already run through a dedicated LOGIN
NOSUPERUSER/NOBYPASSRLS/NOINHERIT migration role, with explicit schema grants
and source-specific role observations; the restore-owner gap does not apply
to those eight exact-image migration executions.
The eight real services drain after SIGTERM. One-shot probes drain their SQL,
socket and background work before exit; exiting also closes an imported Redis
client that has no probe disposal API. This distinction is retained in the
independent review and does not substitute probe exits for service drains.

Earlier recovery attempts remain failed: `8b7ccbc7af23` requested the wrong
cumulative admission bundle; `69c51faab928` passed its service-pair components
but failed a restoration-fixture query with ambiguous SQL parameter `42P08`.
The final whole attempt applies the existing exact-bundle request and explicit
text-cast fixture correction. No application/image change was made between the
attempts; earlier passes are not used to disguise either failure.

Independent native processing attempt `ff7c29511233` passes nine blocks using
the actual F Linux/musl runtime, Sharp codecs, private-file/PDF functions and
Express rate-limit middleware. Coverage includes EXIF orientation/stripping,
oversized/corrupt image rejection, real bounded PDF tools, encrypted/corrupt/
page-limit PDF rejection and cleanup, trusted proxy-hop/client-IP handling,
IPv6 limiter isolation, bearer-token limits and temporary-file cleanup. It uses
synthetic fixtures, no provider/network calls and an owned read-only container
that is removed without force. This proves native codec/function behavior;
**it does not claim an actual screenshot HTTP-route or classroom campaign**.
Two earlier runtime-probe setup failures are retained before the corrected
whole attempt; neither is relabelled as a product failure or passing attempt.

The native producer and independent reviewer are different for each of the
five preparation evidence kinds. Public envelopes retain the exact artifact
pair and private native/review hashes; raw captures, synthetic operational
identities, SQL fixtures and environment material remain private.

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

The [allowlisted profile](release-bindings/release-297-current-school-fallback-v3.json)
pins the five public envelopes:
[scan](release-evidence/release297-successor-20261007/successorScan.json),
[processing](release-evidence/release297-successor-20261007/screenshotRuntime.json),
[client-IP/rate limiting](release-evidence/release297-successor-20261007/requestIpRateLimit.json),
[ordinary recovery](release-evidence/release297-successor-20261007/ordinaryRecovery.json)
and [restricted restoration](release-evidence/release297-successor-20261007/restrictedRestoration.json).
The binding SHA-256 is
`6dc30aa4d19875a9b2ba08bc0b960c3d54e9736f5eac0129e5f8e10aa1691b7c`.
[Direct operational-controller probes](releases/release297/successor-pending-operational-plans-20261008.json)
reject all five pending Plan paths with `SUCCESSOR_SELECTION_PENDING`, before
any external command. The successful preparation result cannot be used as
an executable operational Plan.

The integrated release-tool suite passes **119/119**, including preserved legacy
behavior and 15 schema-3 regressions. Independent review repeats all 15 new
tests on clean sources. Current-state regressions pass **23/23**, including
role, binding, cloud-mutation and false-authorization changes. Normal PR CI is
tracked on the exact PR head; resulting-main CI remains a separate later gate.

Exact-F type/build checks pass; the unit lane passes 1,732 tests with four
initial service-dependent skips, followed by 65/65 passing tests on those four
files with local services, clearing all four skips. Restricted-role RLS passes
383/383, with no failures or skips and complete owned cleanup. The
[immutable source-specific check summary](releases/release297/source-specific-successor-checks-20261008.json)
retains the full exact-F database command as **failed: 1,400 passed, 1 failed,
8 skipped**. The sole failure is C578's old text-matching Redis mock for
screenshot classification. Main already contains the reviewed test-only
correction `bcded1cfeea7b2b10f3d239eceec09d41748486c`; a private copy passes
**8/8** against F's compiled application modules. Independent verification
proves all 1,571 compiled files byte-equivalent to F's exact image and
[causally reproduces the original mock mismatch](release-evidence/release297-successor-20261007/database-fixture-independent-review.json).
F's tracked source remains lockfile-only. This targeted pass does not relabel
the failed complete command or claim a complete corrected-lane rerun.
All 18 skip markers from the eight original database skips have matching
actual passes in the restricted RLS lane. Earlier database timeout/assertion
and fixture-convergence failures are retained; no partial ordinal is represented
as a successful complete test count. Every owned check container is removed
without force and the existing local services remain untouched.

Native recovery must use migrations **43→53**, admission
**121→125→126→127→128→129**, and **A→F→A**. It must preserve all 53 completed
migrations, screenshot function body/ACL, RLS, private-message expiry/history and
authority fences, exact Focus cleanup and compatible protocol/private-chat floors.
All processes must drain gracefully with no named SQL connections remaining.
Historical 54-entry evidence does not satisfy this proof.

The new Usage and Digital Usage modes stay off. On the synthetic pair,
`CLASSPILOT_DAILY_USAGE_ROLLUP_MODE` is unset and resolves to **shadow** by the
exact source's default. It is recorded independently and may still do work.
Local fixtures do not establish production flag values or managed-device adoption.

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
