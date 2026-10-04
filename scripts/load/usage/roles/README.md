# Linux role workload

This successor preserves the original release-enabled workload and runs its API,
worker, generator and coordinator in separate, owned Linux containers. It uses
the candidate's untouched Node, dependencies and compiled application under
`/app`. The clean application checkout is `/source`; generated harness files are
under `/diagnostic`; ownership/runtime modules are `/prototype`.

API: 1 CPU / 2 GiB, worker: 0.5 CPU / 1 GiB, driver: 2 CPU / 1 GiB,
coordinator: 0.5 CPU / 1 GiB. PostgreSQL remains 4 CPU / 4 GiB and Redis remains
1 CPU / 256 MiB. Pools, acquisition/statement/request deadlines and the original
report and worker acceptance thresholds are unchanged. Runtime roles use the
candidate's default V8 settings, with numeric heap/cgroup observations retained.
The historical seeder still uses its existing 512 MiB heap and memory assertion.
These are declared synthetic limits. In particular, the local PostgreSQL
4 CPU / 4 GiB cap is not the dated production `db.t4g.medium` configuration.
A local campaign result cannot establish actual production headroom; deployed
Usage observation and current production evidence remain separate requirements.

The diagnostic entry point supports the complete 60-second, 6,000-offer ingest
or combined workload (64 reports and both million-observation school workers).
It never applies the historical diagnostic 10-second shortcut. Current Focus
ACK/public-state checks and lifecycle proofs come from the exact source's
canonical generator. API main/session and worker pools receive one additional
pre-measurement restricted-role/GUC verification on the actual pool.

`prepare-context.ps1` takes an exact clean repository commit, its passing image
scan receipt, a new context directory and a separate new host checkout. Install
host fixture dependencies there; do not install them in the Docker context.
`build-role-helper.mjs` builds locally from the bound candidate and verifies the
untouched runtime in a network-disabled owned probe. No image is pushed.
`run-role-scale.ps1` uses the host checkout and helper binding, creates only owned
local fixtures and stops at `measurement-ready.json` before the cold restart.
The exact nonce/source/image/harness/profile marker must be released by the
operator before measurement. Inspect the resulting owned exit and cleanup
receipts even when the workload fails.

Every single run retains `capacityAccepted:false`. A separately declared
`capacity-candidate` helper and campaign can execute a registered combined
attempt through `run-restored-role-scale.mjs`. The helper build's final argument
must explicitly be `capacity-candidate`; old diagnostic bindings remain invalid
for that mode. This execution path is pending final review/native verification;
no accepted campaign exists. Historical diagnostics cannot be relabeled.

The modern generated role overlay requires 6,000 HTTP 200 responses with all six
negotiated authority capabilities and 6,000 inserted observations. It rejects
every 204. Each school's six prepared/priming observations plus 3,000 measured
observations must produce exactly 3,006 rows; independently read raw counts,
persisted counts and current-day rollup heartbeat counts must agree for the same
school ID. The original source scripts and Windows comparison retain their
historical first-offer 204 allowance. Both pre-reset API drain gauges and final
API/worker drains must be complete and exactly zero.

`run-campaign.mjs` exposes four explicit operations, each taking a reviewed JSON
configuration file. It neither releases measurement gates nor retries attempts:

```text
node scripts/load/usage/roles/run-campaign.mjs declare campaign-config.json
node scripts/load/usage/roles/run-campaign.mjs attempt attempt-config.json
node scripts/load/usage/roles/run-campaign.mjs close-journal journal-config.json
node scripts/load/usage/roles/run-campaign.mjs close closure-config.json
```

The declaration contains `campaignDirectory` and `declaration`: exact source,
profile, candidate image/scan, helper/runtime, complete executed harness,
validator, canonical schema, registry and 54-entry migration identities, plus
the unchanged native comparison's source/schema/profile/script constraints.
It contains no predicted comparison result or receipt hash. Retain the returned
trusted campaign hash independently. Attempt configuration contains that hash,
the same campaign directory, `mode:"capacity-candidate"`, `phase:"combined"`,
and the exact restored-owner configuration (new evidence/private directories,
clean source checkout, immutable snapshot, candidate/helper/proof hashes,
pinned local Docker endpoint and image identities). The owner registers a
fresh run/nonce before creating a fixture and checks that exact pending plan.
The operator reviews and releases the resulting nonce-bound ready marker.

A fresh restored database is validated, analyzed, disconnected and restarted
for every attempt; Redis joins only after the PostgreSQL cold restart. No
post-restart fixture scan is performed. All role/fixture cleanup attempts run
independently, and the 13-record manifest binds their actual receipts. A setup
error, numerical failure, abort or unconfirmed cleanup is retained. Unconfirmed
cleanup blocks any later attempt and closure. Owner exceptions or exit/receipt
disagreement cannot be credited as a completed successful run.

After the last three consecutive registered attempts pass every strict check
under identical identities, close the append-only journal. Then run the exact
predeclared original Windows/native `run-release-enabled-scale.ps1 -Phase
combined`, without diagnostic/profiler switches and with its historical 512 MiB
role heaps. Preserve its actual metrics/execution/schema/cleanup receipts in the
separately bound comparison envelope. `close` receives `campaignDirectory`,
`trustedCampaignSha256`, `trustedJournalSha256` and `comparisonFile`; the immutable
closure binds that actual receipt to the original declaration and final journal.
The comparison must start after journal closure. A failed comparison is retained
and cannot be overwritten. Only this validated closure can report synthetic
capacity acceptance; it does not establish production readiness.

Run the pure guard suite with:

```text
node --test tests/private-load-usage-profiles.test.mjs
```

The original scripts and previous failure artifacts remain unchanged. Cold
means fresh processes and PostgreSQL shared buffers, not flushed host caches.
Synthetic protocol acknowledgements do not establish managed-browser behavior,
production RDS capacity or the separate deployed Usage observation days.

The screenshot evidence function adds migration 54 without adding a table.
New-source campaigns require a new same-source 54-entry snapshot; prior 53-entry
snapshots and their immutable driver copies remain historical evidence. Fixture
bootstrap now explicitly revokes PUBLIC execution and grants only the exact
four-text-argument function to its actual restricted role, including after a
no-privileges restore. The real API startup separately verifies the catalog and
its own EXECUTE permission before serving. This is also a bootstrap-only delta
to the original Windows/native comparison script and its hash declaration; its
traffic, 512 MiB heaps, deadlines and historical numerical criteria are unchanged.
Production migration uses the supported API secret and creator permission; it
never discovers or auto-grants a different production login. A different runtime
role without an explicit compatible grant fails startup. The compatible fallback
keeps its own reader and tolerates the additive function/54th ledger entry.

A new-source snapshot can be captured at the seeded diagnostic ready gate without
running traffic. After verifying the private read-only snapshot and all hashes,
the operator may exclusively create `measurement-abort.json` beside the ready
receipt. Copy the ready fields exactly (including `harnessSha256`), set
`action` to `abort-before-measurement`, and `intent` to
`preserve-prepared-snapshot`; retain `capacityAccepted:false` and the ready
`diagnosticOnly` value. `measurement-go.json` must be absent. The gate preserves
`measurement-abort-receipt.json`, throws `ABORTED_BEFORE_MEASUREMENT`, and the
existing owning runner performs exact cleanup. Both markers together fail
closed. This is a failed/aborted preparation, never a successful workload or
capacity pass; a registered campaign abort remains in its attempt journal.
