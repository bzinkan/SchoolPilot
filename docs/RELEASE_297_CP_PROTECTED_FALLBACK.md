# ClassPilot 2.9.7 CP-AI protected fallback preparation

The operator selected retaining the CP-AI credential protection in a separately
reviewed recovery source and artifact. Schema 4 adds exactly one binding:
`release-297-current-school-cp-protected-fallback-v4`. Historical schemas 1, 2
and 3, C578, F1 and their scans and receipts retain their original identities.

The frozen application reference is
`ecf6ce0100e758f5668c5a26427c1c0ea82ea0a2`. The recovery source F2 is
`6259e768553e55346ba14a6453340772198a3d6b`, a direct child of F1
`d75fc1c48d0a3918857508d3965904c69023a153`. Its eight reviewed paths contain the
CP-AI provider preparation/cache changes and their synthetic regressions. The
lockfile, Dockerfile, build process, migrations, capability configuration,
restriction matching and frontend remain unchanged from F1. F2 is retained as a
recovery source; its older application tree is not a main-branch merge target.
Review the [exact F1 → F2 source comparison](https://github.com/bzinkan/SchoolPilot/compare/d75fc1c48d0a3918857508d3965904c69023a153...6259e768553e55346ba14a6453340772198a3d6b).

The [current protected fallback observation](releases/release297/cp-protected-fallback-observation-20261008.json)
records the exact local image/config/platform/archive identities and independent
reviews. Its runtime scan passed with **0 High, 0 Critical and 1 Medium**
(`sprintf-js`, CVE-2026-97058). Nine actual Linux/musl native checks and
**53/53 compiled-image intercepted-provider fixtures** passed. Host source
checks are separately scoped: producer **175/175**, independent **366/366**,
and full unit **1820 passed / 4 skipped / 0 failed**. Failed attempts remain
retained; these counts are not live managed-device or provider-account proof.
Actual local **A → F2 → A API/worker recovery** and **six restricted-owner
restoration rounds** also passed and were independently reviewed. The ordinary
43→53 ledger, six admission phases, function permissions, private-chat history,
Focus cleanup and all eight unforced service drains were verified with no
residual named SQL connections. The failed initial restoration attempt and its
reviewed TCP-readiness correction remain retained. Full historical DB suites,
production catalog/backup/ALB state and live managed-device validation were not
relabelled as these bounded local checks.

**Overall preparation and exact selection remain pending.** The retained
development/build dependency audit failed with **6 High, 0 Critical and
7 Moderate** findings, tracked in [issue #625](https://github.com/bzinkan/SchoolPilot/issues/625).
Runtime dependency omission passed with 0 High / 0 Critical / 3 Moderate;
it does not clear the full audit. There is no waiver. Resolve the retained
`tsc-alias` → `braces` chain through a separately reviewed minimal build-tool
and source-applicability correction, then refresh exact source/image/recovery
evidence. The eight-path F2 delta cannot silently acquire that extra change.

The validator pins every changed Git blob/mode and the full binary patch hash.
It proves the exact parent, clean F2 source, deterministic application inputs,
separate serving-anchor/fallback roles and exact artifact identities. Controller
inputs cannot override these sources, permit an extra source delta or select a
different image. Null draft pins and pending evidence are rejected before any
external command or cloud operation.

## Preparation evidence contract

`ValidateSuccessorPreparation` remains offline. A successful result means
`preparationPassed: true`, `releaseReady: false`, `operationalAuthorization:
false` and `cloudMutations: 0`. It does not select F2 or satisfy the original
133-client, three classroom, normal-load or 250-client headroom campaigns.

Six evidence kinds are required: `successorScan`, `screenshotRuntime`,
`requestIpRateLimit`, `ordinaryRecovery`, `restrictedRestoration` and
`credentialBoundary`. Each public record has the following identity:

```json
{
  "schemaVersion": 1,
  "kind": "release_successor_preparation_evidence",
  "releaseBindingId": "release-297-current-school-cp-protected-fallback-v4",
  "evidenceKind": "credentialBoundary",
  "artifactPair": {
    "serving-anchor": {
      "source": "exact A",
      "localIndex": "exact local image index",
      "config": "exact image config",
      "platform": "exact Linux/amd64 manifest",
      "archiveSha256": "exact retained archive hash"
    },
    "fallback": {
      "source": "exact F2",
      "localIndex": "exact local image index",
      "config": "exact image config",
      "platform": "exact Linux/amd64 manifest",
      "archiveSha256": "exact retained archive hash"
    }
  },
  "observedAtUtc": "actual observation time",
  "passed": true,
  "retainedEvidence": {
    "nativeResult": {"storage": "private", "path": "retained native JSON", "sha256": "actual hash"},
    "independentReview": {"storage": "private", "path": "retained review JSON", "sha256": "actual hash"}
  }
}
```

This example describes a contract and is not an executable receipt. Real
records must contain complete exact digests and source references.

The native JSON has `kind: release_successor_native_result`, the same identity,
its actual `producer`, the required `checks`, and hash-pinned `rawEvidence`.
The review JSON has `kind: release_successor_independent_review`, the same
identity, a distinct `reviewer`, `independentFromProducer: true`,
`fullIndependentReviewComplete: true`, `nativeResultSha256` and the exact ordered
`rawEvidenceSha256s`. Rehashing a different pair cannot satisfy the binding.
All observations must be at or after the frozen F2 commit; native/review time
ordering remains enforced.

Screenshot, IP, credential and recovery native records additionally hash-pin
the original terminal `executionReceipt`, also present in `rawEvidence`.
The validator replays its actual source/image/role, original start/end times,
bounded test counts, isolation and graceful cleanup. Restricted restoration
also pins `serviceExecutionReceipt` for the same ordinary eight-service replay.
A re-dated aggregate cannot replace stale original execution. Every present
external-provider counter must be zero; contradictory counters are rejected.

Credential evidence additionally identifies `testedArtifactRole: fallback`,
exact F2 `source` and `applicationImage`, `syntheticFixturesOnly: true`,
`providerRequests: 0` and `policyVersion:
classpilot-ai-request-input-2026-10-08.1`. Here `providerRequests` counts real
external provider calls. Safely redacted and allowed fixtures intentionally
make intercepted synthetic requests, whose counts remain in the raw evidence.
The six required credential checks are:

- `syntheticProviderInterceptPassed`
- `credentialRequestsPrevented`
- `sensitiveDiagnosticsAbsent`
- `allowedContextPreserved`
- `unavailableCompletionPassed`
- `originalMatchingInputsPreserved`

Native screenshot/IP evidence must execute the exact F2 Linux/musl image. The
ordinary recovery receipt requires actual A → F2 → A API/worker execution,
43 → 53 ordinary migrations, 121 → 125 → 126 → 127 → 128 → 129 admission,
restricted-role migration/restoration, retained function permissions, private
chat/history fences, Focus cleanup, capability equality, compatibility floors,
unforced exit-zero drains and zero named SQL connections. Historical 54-entry
rehearsals and a516/F1 receipts cannot satisfy this pair.

The exact fallback scan must have zero High/Critical findings, the pinned
scanner, fresh vulnerability database metadata, archive/config/source equality
and unforced owned-scanner cleanup. Lower findings and failed attempts remain
explicit. An old passing wrapper or re-dated expired database is insufficient.

Schema 4 also requires a passed hash-pinned full dependency audit and exact-source
check receipt, bound to the retained lockfile Git blob and F2 input inventory.
The present actual failed audit is preserved in the pending profile. Flipping
its status or the preparation status cannot clear the raw High findings.

## Acceptance and operational prerequisites

The separate allowlisted local acceptance binding is
`release297-current-school-acceptance-ecf6ce01-cp-protected-v2`. It uses exact
A/F2 evidence; the previous A/F1 profile/runs remain unchanged. Both bindings
retain the approved numerical policy, fixed `A,A,A,B,B,A,A,B` 133-client order,
three consecutive 900-second mixed runs, normal-load and 250-client gates.
Source/privacy applicability and exact F2 selection remain explicit reviews.
The new acceptance binding pins `releaseSourceBinding` to the clean harness's
committed schema-4 profile and binds the actual full audit/source-check hashes.
Pending preparation or a failed raw build audit stops validation before Git or
Docker work. Original acceptance behavior does not gain this new binding.

All publication paths, unused121, Anchor128, compatible fallback registration
and replay carry the binding ID/hash, artifact role and validator/tool hashes.
They preserve exact environment/capability equality, private paths,
authorization windows and returned identities on uncertain registration.
Operational Plans reject pending campaigns, applicability or selection even
when offline preparation passes.

ClassPilot 2.9.7 remains unchanged. Both new Usage modes stay off; the existing
daily-rollup mode is recorded independently. Managed-device validation remains
`waived_not_passed`. Deployment authorization is recorded separately from the
evidence gates and cannot replace them. No Store upload is needed for this
backend correction.
