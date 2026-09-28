# Paperwork preparation benchmark

`dist/cli/benchmarkPaperworkPreparation.js` compares the serial and pipelined workers using the same generated 15-page synthetic PDF. It runs three matched pairs by default, alternating execution order. It exercises the actual import claim, native processing, persistence, local matching, and evidence preparation. It never saves school records.

Run the compiled CLI in an isolated instance of the candidate production image. Supply a separately bootstrapped disposable local PostgreSQL database named `schoolpilot_paperwork…` or `schoolpilot_benchmark…`. The CLI rejects remote database hosts and refuses to proceed when other imports are queued or processing. Both normal and privileged connection settings must identify that same disposable database. No schema bootstrap, production task update, storage provisioning, or feature activation occurs inside this command.

Set `PAPERWORK_BENCHMARK_ISOLATED=1` in that isolated process. The default transport generates strict synthetic responses with a 500-millisecond delay; no API key is needed:

```text
node dist/cli/benchmarkPaperworkPreparation.js --transport synthetic --pairs 3 --image-digest sha256:<candidate digest>
```

For the release comparison, set `PAPERWORK_BENCHMARK_LIVE_PROVIDER=1` and provide `ANTHROPIC_API_KEY` through the isolated process's secret environment. Never pass the key as a command-line argument or include it in evidence. Then run:

```text
node dist/cli/benchmarkPaperworkPreparation.js --transport live --pairs 3 --image-digest sha256:<candidate digest>
```

The selected model and current prompt version are fixed for the whole comparison and recorded with the synthetic fixture hash. Each result contains queue-to-claim delay, processing time, first-ready-form time, counts, provider concurrency, and expected-field accuracy. It contains no packet contents, names, storage keys, request bodies, or source filenames. The first-ready measurement reads the durable form and evidence checkpoint rather than inferring progress from a timer.

Set `PAPERWORK_BENCHMARK_SOURCE_REVISION` to the reviewed checkout's full commit identifier. The CLI also hashes its own source/compiled module plus the worker, pipeline, durable-stage service, processing helpers, and configuration, and verifies these files remain unchanged before returning an accepted report. Hashes bind uncommitted test builds more precisely than the base commit alone. The CLI emits content-free sample records as each pair member completes, then the final aggregate report. Queued retries follow the worker's real backoff and five-second dispatch cadence and remain included in preparation time; terminal failures never become accepted comparisons.

The performance target requires three complete matched pairs, at least 25% lower median preparation time, an early reviewable form in every optimized run, all 15 forms prepared with the expected student/date/referral fields, no unreviewed school publication, and at most two concurrent provider calls. A nonzero exit code means configuration, execution, or acceptance failed. The synthetic transport is useful for debugging; its timings are not live model latency evidence.

The CLI owns one synthetic school and its users, roster, imports, and temporary local objects. It removes the exact roster/import/file fixtures afterward and soft-deletes the school. Credential-free school/user identity roots remain until the disposable database is removed, preserving the normal staff-history guards. It never uses the production object store. It also samples cgroup memory when available and aborts at 85% utilization. The operator must independently verify the supplied image digest against the actual container identity.

This paired benchmark does **not** establish production capacity. Release evidence must separately run two maximum-sized imports alongside ordinary uploads in the candidate image's separate API/worker resource profiles, observe scheduler and readiness behavior, and verify memory below 70% and API p95 within 20% of baseline. The existing native-only `measureMyDeskProcessing` report also cannot substitute for that integrated capacity check or the full extraction-quality evaluation.

The checked-in [split API/worker capacity harness](../scripts/load/paperwork/README.md) runs that bounded scenario against the actual pinned image, with explicit limits on the representative routes and scheduler callbacks it measures.

The durable ledger's reviewed admission is the singleton `import_processing_stages`. Inspect both serving RLS allowlists before using `--enable-rls-table import_processing_stages`; do not repeat admission after the table is enabled. The forward registry inventory extends the preserved preference baseline. Adopt a subsequently verified production inventory into Terraform only through the separate reviewed baseline process.
