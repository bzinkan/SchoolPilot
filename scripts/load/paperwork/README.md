# Isolated paperwork capacity check

`run-split.ps1` runs the compiled API and worker from the same pinned Linux/amd64 production image. A third container drives HTTP uploads and records client timings, outside the serving API's process and CPU/memory quota. The private network contains a fresh schema-only PostgreSQL instance. No ports are exposed; the network has no external access. The script does not update ECS, runtime flags, production databases, or production storage.

Prerequisites:

- PowerShell 7.5 and local Docker.
- The exact candidate image already pulled by digest.
- Its reviewed commit. An OCI revision label must match. For an unlabeled image, build the clean final commit and pass `-ExpectedCompiledDirectory <absolute path to dist>`. Critical compiled API/worker/schema hashes must match the pinned image; keep the deployment build receipt alongside this proof.
- An explicitly local synthetic database bootstrapped through the candidate migrations, with the canonical tenant RLS inventory enabled and forced. Only schema is copied. The new application role neither owns tables nor bypasses RLS.
- A new evidence directory outside the repository. Existing evidence is never overwritten.

```powershell
./scripts/load/paperwork/run-split.ps1 `
  -ImageReference '<registry>/<repository>@sha256:<candidate digest>' `
  -ExpectedRevision '<reviewed full 40-character commit SHA>' `
  -ExpectedCompiledDirectory '<absolute path to the final backend dist directory>' `
  -SchemaDatabase 'schoolpilot_paperwork_capacity_schema_20260928' `
  -EvidenceDirectory "$env:LOCALAPPDATA/SchoolPilot/evidence/paperwork-capacity-<unique run>"
```

The serving API retains 1 CPU/2 GiB and the worker 0.5 CPU/1 GiB. The isolated driver has 1 CPU/1 GiB; the disposable PostgreSQL container has 1 CPU/512 MiB. API acceptance uses only the serving API's actual cgroup, memory, readiness, and process identity. The driver reports its own resources separately. The final verifier requires the reviewed API profile; alternative limits are diagnostics, not acceptance for that profile.

Scripts, synthetic objects, and reports use a newly created Linux-native Docker volume. The controller copies files in before measurement and exports evidence after services stop. No Windows bind-mounted filesystem participates in the load. A temporary transfer container sets ownership only on its newly created `/app/evidence` volume; API, worker, and driver all run as `node`. Inspected container IDs must be distinct, CPU/memory/swap limits must match, and each service must mount that exact volume. The API and worker receive restricted database credentials; only the fixture driver receives the disposable database's administrative credentials.

The scenario uploads two maximum packets, each with five 10-MiB sources and twenty pages/images, including a 24-megapixel photo. Deterministic provider responses yield fifty forms per packet. Actual worker claims and protocol-2 stages prepare both packets, then rebuild one twenty-region continuation form per packet. Four ordinary note attachments upload through the real API while processing runs. Physical source, preview, and evidence bytes are preserved, with asynchronous reads/writes and idempotent deletion. `storageIo` retains at most 4,096 operation timings, byte counts, and safe codes; it never records storage keys, names, or contents. Local filesystem latency does not model S3 network latency.

The provider transport is synthetic, with short bounded occupancy. This isolates native work, database contention, durable permits, HTTP uploads, and process resource boundaries. Use `benchmarkPaperworkPreparation` separately for three paired live-model timing comparisons. Capacity testing does not replace extraction-quality evaluation or the real-paperwork/Android walkthrough.

Acceptance checks retain the same workload, quotas, and thresholds:

- Forty pages and one hundred forms prepared, continuation evidence built, no unfinished/failed stages, queue drained, and temporary objects cleaned up.
- No more than two concurrent provider requests and two initial claims, with completed durable stages. This one-worker scenario is complemented by independent multi-process/competing-import integration tests.
- A 30-second warmup with at least ten reads per endpoint, then at least 180 seconds and one hundred baseline reads per endpoint. At a 500-ms cadence, alternate My Desk capabilities, ClassPilot groups, and Dashboard teacher settings through actual `createApp` middleware/authentication/routes. Loaded collection requires one hundred reads per endpoint while work remains active. Insufficient coverage fails; no idle samples are added after completion.
- Overall and each endpoint's loaded p95 remain at or below 120% of baseline. Three consecutive twenty-sample windows above that threshold stop load. Percentiles consistently use nearest rank, `ceil(quantile × sample count) - 1`.
- Actual API pool readiness, worker pool checks, evidence-expiry and staff-integrity scheduler callbacks pass. Timer lag and due-job start delay remain below the five-second refill cadence. These callbacks and synthetic reads are bounded representative checks, not the whole production traffic mix or scheduler fleet.
- Final kernel memory peaks remain below 70% of each serving process's limit. Live sampling stops load at 85%. Missing memory observations fail closed. There are no OOMs, failed worker exits, restarts, or controller deadline breaches.

The immutable `measurementPlan` is written before collection. `measurementObservation` records monotonic boundaries, endpoint counts, and work completion. A read already in flight may finish afterward, but no new loaded read starts after work completes. `readProbeEvidence` retains at most 4,096 complete client-request timings, including body parsing, with fixed path, phase, status, elapsed start, and a unique probe ID. Each ID must match exactly one completed observation from the serving API. Server timings help diagnosis and never replace the original client timings in the latency gate. Readiness headers are emitted only after the actual API readiness check succeeds. Failed requests and failed runs retain their samples.

Evidence files:

- `split-execution.json` version 3: pinned image IDs, source binding, processing version/width, separate API/worker/driver exit states, and declared resources. `repositoryRevision` identifies the image-build checkout. `harnessRevision` is populated only when the executing script is that checkout's canonical runner; external scripts are labeled `external_diagnostic`. `runnerSourceSha256` binds the runner copied before measurement. Release admission requires the canonical reviewed runner and matching frozen source hashes.
- `split-source-identity.json`: expected commit and compiled-image comparison where required. `split-topology-inspection.json`: distinct inspected container IDs, actual Docker limits, user, and volume mounts.
- `split-metrics.json`: driver-observed raw request timings, workload/cleanup results, snapshots of API/worker metrics, and separate driver observations.
- `split-api-server-metrics.json`: authoritative API report written after shutdown, including final kernel peak, actual pool readiness, server probe IDs, and measurement-source hashes. `split-worker-metrics.json`: worker observations.
- `split-api-final-validation.json`: a new immutable receipt binding the original driver/final API reports and copied server, contract, storage, and finalizer sources. The controller runs the finalizer copied before measurement, after the serving API exits; it does not rewrite the original reports.
- `split-cleanup.json`: evidence export/validation and exact-owned container/network/volume cleanup. Any failed command, missing report, or leftover resource fails the run.

The controller has a fifteen-minute deadline. Temporary local credentials exist only in controller/container environments, are never written to evidence, and are restored/cleared during cleanup. Treat any nonzero exit or false acceptance as failed; retain all failed attempts. A successful diagnostic is not release approval: the final reviewed harness must run against the exact deployed image and documented resource profile.

The inherited Docker healthcheck targets `localhost:4000`, which is inapplicable to diagnostic API port 3998 and worker-control port 3999. Its observed `Health` field must not be reported as healthy production evidence. Actual API readiness and worker scheduler probes remain mandatory.

The offline identity/resource/probe/final-report tests live in `tests/paperwork-capacity-*.test.mjs`. The existing `test:unit` lane discovers them automatically; no Docker, provider key, database, or load run is required for these tests.
