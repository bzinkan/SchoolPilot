# Isolated paperwork capacity check

`run-split.ps1` runs the compiled candidate API and worker from the same pinned Linux/amd64 production image. It creates a private Docker network, a disposable schema-only PostgreSQL instance, and separate API/worker containers. It does not update ECS services, runtime flags, production databases, or production storage. No ports are exposed and the network has no external access.

Prerequisites:

- PowerShell 7.5 and local Docker.
- The exact candidate image already pulled by digest.
- Its expected reviewed commit. If the image has an OCI revision label, it must match. Otherwise, first run the normal backend build from that clean final commit and pass `-ExpectedCompiledDirectory <absolute path to dist>`. The harness compares critical compiled API/worker/schema files inside the pinned image with that reviewed build and retains the hashes; keep the deployment build receipt alongside this proof.
- An explicitly local synthetic database bootstrapped through the candidate migrations. Only its schema is copied. The current stage-ledger RLS registry is used, with a new restricted application role that neither owns tables nor bypasses RLS.
- A new evidence directory outside the repository. Existing evidence is never overwritten.

Example, substituting the actual reviewed image digest and local schema database:

```powershell
./scripts/load/paperwork/run-split.ps1 `
  -ImageReference '<registry>/<repository>@sha256:<candidate digest>' `
  -ExpectedRevision '<reviewed full 40-character commit SHA>' `
  -ExpectedCompiledDirectory '<absolute path to the final backend dist directory>' `
  -SchemaDatabase 'schoolpilot_paperwork_progress_20260928' `
  -EvidenceDirectory "$env:LOCALAPPDATA/SchoolPilot/evidence/paperwork-capacity-<unique run>"
```

Default limits match the reviewed split profiles: API 1 CPU/2 GiB; worker 0.5 CPU/1 GiB. The script accepts explicit alternatives for an isolated diagnostic, records them, and verifies cgroup limits inside both containers. A test with different limits is not evidence for an unchanged production profile.

The HTTP scenario uploads two maximum packets, each containing five 10-MiB source files and twenty pages/images, including a 24-megapixel photo. Deterministic provider responses yield fifty forms per packet. The actual worker claim transactions and protocol-2 stage pipeline prepare both packets; the test then rebuilds a twenty-region continuation form in each. Four ordinary note attachments upload through the API while processing runs. Source, preview, and evidence bytes use physical local files shared only by these containers.

Both processes await asynchronous filesystem writes, reads, and idempotent deletion, preserving the production object-store's asynchronous contract without using production storage. Each report's `storageIo` records at most 4,096 operation timings, byte counts, and safe success/error codes, never storage keys, filenames, or contents. A slot is reserved before each operation to enforce the bound under concurrency; exceeding it fails the run. The test retains the same file bytes, native processing, quotas, and resource limits. Local storage latency still does not model S3 network latency.

The provider transport is deliberately synthetic, with short bounded occupancy, so this measures native work, database contention, durable permits, HTTP upload behavior, and process isolation without external latency. Use `benchmarkPaperworkPreparation` separately for the three paired live-model timing comparisons. This test does not substitute for extraction-quality evaluation or the user's real-paperwork walkthrough.

Acceptance checks include:

- All forty pages and one hundred forms prepared, continuation evidence built, the queue drained, and temporary physical objects cleaned up.
- At most two provider calls and two initial claims, with completed durable stages.
- At least one hundred baseline and loaded authenticated reads, alternating My Desk capabilities, ClassPilot groups, and Dashboard teacher settings through the actual `createApp` middleware/authentication/routing path. Require at least thirty samples per endpoint and loaded p95 no greater than 120% of baseline both overall and for each endpoint. These synthetic read requests and ordinary uploads are representative checks, not the full production traffic mix.
- Actual API pool readiness and worker pool checks, plus evidence-expiry and staff-integrity scheduler callbacks under load. Timer lag and due-job start delay must remain below the five-second paperwork refill cadence. These two callbacks do not represent every scheduler workload or production fleet size.
- Peak kernel memory below 70% of each process limit. Sampling stops load at 85%; three consecutive twenty-sample latency windows above the allowed p95 threshold also stop the test.
- No OOM, worker exit failure, restart, or controller deadline breach. The controller stops at fifteen minutes and removes only its uniquely named containers and network.

`split-execution.json` proves the running image IDs, processing protocol/width, and resource settings. `split-source-identity.json` records how the expected commit was bound to the image. `split-metrics.json`, `split-worker-metrics.json`, and `split-cleanup.json` retain counts, timings, limits, safe codes, and cleanup proof. Treat a nonzero exit or a false acceptance field as a failed check; never infer success from a container merely starting. Evidence is retained outside Git for review. Temporary local credentials exist only in the controller process and disposable container environments, are never written to evidence, and are restored/cleared during cleanup.

All percentile calculations use the nearest-rank method, `ceil(quantile × sample count) - 1`, consistently for baseline, loaded windows, endpoints, and pool/scheduler observations. The three-window stop threshold remains 120% of baseline p95. `readProbeEvidence` retains at most 4,096 exact full-request timings, including body parsing, with fixed endpoint, phase, elapsed start time, and HTTP status (or null on a failed read). These metadata samples remain in both successful and failed reports; exceeding the bound fails rather than silently discarding samples. The memory sampler retains counts and peaks rather than an unbounded sample array.

The production image's inherited Docker healthcheck targets `localhost:4000`; it is inapplicable to this harness's ephemeral API port and worker-control port 3999. Its `Health` field is retained as observed and must not be reported as healthy production evidence. Actual API pool/readiness and worker scheduler probes remain mandatory and independent of that inherited check.

The capacity scenario runs two simultaneous imports in one worker container, matching the worker resource profile. Its observed provider peak proves the cap only within this scenario. Independent multi-process ledger/claim integration tests supply the cross-worker and competing import-type proof.
