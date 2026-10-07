# Release 2.9.7 source binding v2

This is an additive artifact-preparation contract. The committed profile in
`docs/release-bindings/release-297-current-school-v2.json` is **pending**. Its
`applicationSource` and inventories describe provisional main `56df7a4f`, not an
accepted or frozen candidate. No source-specific native acceptance campaign was
run for this repair. Final candidate freeze, supported native runner inputs,
independent replay, and explicit owner applicability of the existing criteria
remain required. The exact retained C578 image also failed its fresh pinned scan
on October 7, 2026: Critical proxy-addr CVE-2026-90711 and High sharp
GHSA-wq5f-xc86-pv6w. Its identity and zero High/Critical guard are unchanged.

## Version and operation boundary

Version 1 remains the historical DDC application-equivalence path, including its
exact C578 identities and historical 54-row synthetic recovery receipt. It rejects
`releaseBindingId`; it never silently falls forward to v2.

Version 2 requires `schemaVersion: 2` and the allowlisted
`releaseBindingId: release-297-current-school-v2`. Callers cannot supply a binding
path, source override, replacement policy, or acceptance booleans. Only a reviewed,
committed change to the allowlisted profile and its committed public seals can
complete readiness. Plans fail on the shipped pending profile before Git, scan,
GitHub, Docker, AWS, or output-directory creation.

| Controller operation | Binding provenance |
| --- | --- |
| `PlanPublication` / `PublishImage`, serving-anchor | v2 candidate source, profile hash, validator hash, exact extension and both inventories in plan and receipt |
| `PlanUnused121` / `RegisterUnused121` | Same binding plus the pinned successful candidate publication receipt |
| Compatible fallback Plan / `RegisterInactive` | Same candidate publication binding, exact C578 identity, and existing C578 scan/registry proof |
| Anchor128 Plan / `RegisterInactiveAnchor128` | Same candidate publication binding and ordinary-53 recovery seal |
| C578 `PlanPublication` / `PublishImage` | **v1 only**; exact C578 publication is not relabeled as v2 |

Recovery v2 inputs add a pinned `anchorPublication` receipt. `syntheticStage`
points to the committed ordinary-53 public recovery seal or its exact exported
copy. C578 publication does not carry a candidate binding: its provenance enters
the v2 fallback plan through the profile's immutable fallback identity and the
existing exact local-index/config/platform, scan, alias and registry checks.
No supported operation launches tasks, updates services, migrates production,
uploads to the Chrome Web Store, or activates features.

## Source and artifact identity

The backend inventory hashes sorted Git mode/object/path tuples for `src`, root
`package*.json` (the Docker COPY wildcard), `tsconfig.json`, `drizzle.config.ts`,
`Dockerfile`, `.dockerignore`, `config`, and `docs/soc2`. The frontend inventory
covers the entire tracked `schoolpilot-app` subtree. Symlinks and submodules in
either scope fail closed. Git object identities avoid Windows checkout newline
differences. Changes to source, dependencies, frontend, copied SOC2 content,
Docker inputs, or file modes invalidate equivalence. Documentation outside these
scopes can succeed without changing application inventories; tooling changes
still invalidate controller/helper hashes and existing plans.

The profile fixes ClassPilot 2.9.7 ID `iggbfegfcjkfieoemeolfmfnapepalca`, packaged
source `065be165b5df704d84eb716e3fb914c1fed17f98`, merged source
`03a9c3633d1e1f7d763ea5cf910f870994400e02`, extension tree
`f7a3174e5631dcad9d02eb2357b245c5d2df714f`, ZIP bytes `376052`, and ZIP SHA-256
`82352b04020b5fefdee06aa46cc3ba963ddac0d6c7eab4e241fca2cf6ca61575`.
These are candidate evidence identities, not claims about current Store or
installed versions. SchoolPilot does not publish that extension.

Accepted profiles require `sourceStatus: frozen-and-native-tested`, no remaining
`blockers`, an exact `testedApplicationImage` and `testedApplicationConfig`, passed evidence for every required
lane, and owner source applicability. All native lanes must use that tested
candidate image. Publication and both recovery controllers require candidate scan image/config
identity to equal that exact native-tested tuple. They independently verify its
scan, source label, config, platform and registry identity. Rebuilding from the
same Git source does not satisfy this contract: mutable base/APK/CA inputs can
change the executable image and require fresh native evidence.

The tested application/artifact source A is separate from current-main
coordination source B. Build and run native acceptance on the exact A-labelled
image, then commit reviewed binding/evidence/tool documentation as B. The two Git
inventories must prove A and B have identical application inputs; B must be clean
and current remote main with green exact-main push CI. Publication uses B's tags
and records `source: B`, `artifactSource: A`, and the binding; the image's existing
OCI revision label, scan and registry proof continue to identify A. Task-definition
runtime identity uses B. Controllers obtain A only from the committed binding;
caller `artifactSource` overrides are rejected. No image relabel, rebuild or
container-layer equivalence exception is implemented. Both identities are
replayed on Apply. This allows a documentation-only sealing commit without a
self-referential image-hash/source-label cycle.

## Public seals and retained native evidence

The policy path and SHA-256 are fixed to the approved current-school amendment.
An owner applicability seal must say `APPROVED_READINESS_SOURCE_ONLY` and bind
the allowlisted ID, candidate source, backend/frontend inventory hashes, policy
hash, exact extension, and schema. `operationalAuthorization` stays false.

Every committed acceptance/recovery seal binds the same identities plus scope
and evidence kind. It pins two retained records in `retainedEvidence`:
`nativeResult` and `independentReview`. Each is `{storage, path, sha256}`.
`storage: committed` permits only committed public JSON under
`docs/release-evidence/`. `storage: private` resolves a relative JSON path under
the explicit absolute input `retainedEvidenceDirectory`. Path traversal, missing
files, symlinks, uncommitted public bytes, and changed private bytes fail.
Private directories cannot overlap tool/source/output directories; the existing
hash-pinned PowerShell `Assert-PrivateInputPath` ACL check runs before each
private dependency is read, and is repeated during Apply/mutation replay. Private
content stays private; only metadata/hashes belong in committed public seals.

The fresh native receipt contract is defined in
`scripts/release-source-binding.mjs`. A native result has schema 1, kind
`release_binding_native_result`, its lane's required checks, the tested image,
and actual pinned `runs`. Each run is a schema-1 `release_binding_native_run`
with the same candidate identities, unique `runId`, complete error coverage,
safety and cleanup outcomes. Load runs also carry actual measured source/image,
schema, timing, client counts, offer/persistence/error counts and absolute results.
The independent review is schema 1, kind `release_binding_independent_review`,
with `fullIndependentReviewComplete`, the exact native-result hash, image and
ordered run hashes. The resolver reopens, rehashes and validates all these files,
including ordinary recovery's underlying native result. An outer `passed: true`
with nonexistent raw files, a stale source, wrong extension, or wrong schema
cannot complete readiness.

The accepted profile also pins the fresh exact C578 scan, raw Trivy report and
cleanup-custody receipt. Resolution rehashes all three, recomputes report severity
counts, requires zero High/Critical findings, and checks exact C578 identities and
unforced cleanup. The scan must be timestamped after the known failed observation
at `2026-10-07T17:32:59.633Z`. Fallback Plan/Apply must use that pinned scan/custody pair;
an older passing scan cannot replace the reviewed fresh evidence. The shipped
profile records this dependency as failed with no fabricated receipt references.

Existing native runners do **not** yet emit this fresh source-bound contract.
Preparing and independently reviewing those runner outputs is a remaining
release prerequisite. Historical DDC summaries must not be copied into new
wrappers and called fresh. Unit fixtures are synthetic temporary Git repositories
and never release evidence. Committed seals and their adapters require review;
hashes establish identity and replay, not independent truth of measurements.

Public JSON seals are hashed as Git LF bytes. A CRLF checkout/export of the
public ordinary-recovery seal is compared using that same canonical LF form,
after its input's raw-byte pin has been checked. Private native JSON hashes are
always exact bytes; no newline equivalence is applied to private capture files.

## Preserved acceptance scope

| Native lane | Required campaign shape |
| --- | --- |
| Current school | Eight 60-second, 133-client arms in order A,A,A,B,B,A,A,B; 798 offers each; baseline43/121 and candidate53/129 |
| Classroom | Three consecutive 900-second, 133-client runs; 15 rounds, 11,970 ordinary plus 133 reconnect offers per run |
| Normal load | One 60-second, **340-client** run at 34 requests/second; 2,040 offers |
| Headroom | Three 60-second, 250-client runs; 1,500 offers per run |
| Ordinary recovery | baseline43 → candidate53 dark128 → candidate53 adopt129 → exact C578 retaining53 → candidate return53 |

Load windows cannot overlap; missing, reordered, duplicate, shortened or
mis-sized runs fail. Baseline absolute latency failures remain allowed under
the approved bounded amendment. The resolver requires all eight safety/cleanup
results and the approved bounded criteria, not the superseded strict comparison.
Candidate absolute passes remain mandatory. Existing criteria remain p95 ≤500ms,
fixed-window CPU <0.6, CPU control ≤1.05, paired CPU ≤1.10/median≤1.05, paired
latency increase ≤100ms/median≤50ms, median p95 ratio≤1.10, conservative CPU≤1.05
and p95≤1.10. Headroom remains CPU≤0.50 and p95≤400ms. The independent native
review must evaluate those numerical checks; this controller does not rerun the
workload or reinterpret the owner policy.

Ordinary recovery keeps optional staff identity deferred: 43 baseline migrations,
53 candidate migrations, C578 declaring52 while retaining53, and unchanged
121→125→126→127→128→129 admission. It requires restricted role verification,
screenshot function body/ACL retention, private chat history/fences, exact Focus
cleanup and unforced zero/OOM-free drains with zero named SQL connections.
Historical full54 evidence remains historical v1 evidence. Both Usage modes stay
off. Managed Chromebook waiver stays `waived_not_passed`; current-school scope
remains DeSales133 and the separate 30-minute live acceptance remains required.

## Replay and operational authorization

Each plan/receipt carries binding and validator hashes. Apply replays committed
profile/evidence bytes, source inventories and clean source/tool state; v2 does
so again before each mutation. Current remote main and exact-main push CI are
rechecked before each v2 push, alias write or inactive registration. A moved main,
pending/failed workflow, altered tool/helper, changed registry tag, expired
authorization window or changed live baseline stops the operation. Existing
single-publisher, target-account, permissions, scan-custody, registry-alias,
admission, command-contract and no-task/no-service-change guards remain.

Readiness never grants execution permission. A later operator must separately
approve the concrete fresh plan and bounded operation window. No mutation was
performed while implementing or testing this repair.
