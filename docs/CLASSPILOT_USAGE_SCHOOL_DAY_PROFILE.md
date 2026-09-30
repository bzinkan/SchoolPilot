# Separate school-day load profile

The initial review baseline was `60f33dbcf93b6901ac038c2d0066f79fbd9632a4`;
the latest observed main head while recording this evidence was
`d4f3f232be7529ac4d584c2559768e6ad1b5421a`. Every measurement captures its own
candidate source revision and file hashes. The later main changes contain
deployment safety/docs and the equivalent dependency lock correction.

This profile measures two schools concurrently, each with 1,000,000 unique raw
heartbeats, using the corrected usage writer/reader. It does not replace the
immutable 500,000-grain stress fixture or its failed capacity result. Run it with
PowerShell 7.5 using `scripts/load/usage/run-local-school-day-scale.ps1` and a
fresh external `-OutputDirectory`. The shared guarded runner creates only its
generated loopback fixture, applies the unchanged 4 CPU/4 GiB PostgreSQL caps
and Node 512 MiB old-space cap, and removes that exact container afterward.
An existing nonempty output directory or file is rejected before any writes,
so rerunning a command cannot replace an earlier failure's evidence. The bulk
seed uses the registered per-student device and verifies exactly 500 valid
student/device/session bindings per school. Optional `-HoldFixtureForDiagnostics`
permits bounded local EXPLAIN work and retains the exact ownership cleanup.

The ten-second cadence is the actual ClassPilot source constant
`extension/service-worker.js:605` (`HEARTBEAT_INTERVAL_MS = 10000`).
The inspected ClassPilot revision was
`853af87168b548dad09a9de68d305d1b5e9d439a`; the source file SHA-256 was
`e69a241c7d26635a429c1653c3ef89cfd19b57e4b8ef10157f3345ed29870b7c`.
Each of 500 students has 2,000 observations over 5 hours 33 minutes. There are no duplicate
raw observations. Domains dwell for 3 minutes 20 seconds: eight domains per
student, 200 across the school. Stored classifications and teacher-intent
exemptions deliberately exercise all three retained categories within each
domain; this is a synthetic capacity workload, not observed school behavior.

Six 50-minute frozen lessons start hourly, leaving 10-minute passing gaps. A
five-student cohort rotates across six class groups. The frozen historical
rosters represent membership at each lesson; current-day enrollment/devices
retain their separate current cohort. This deliberately keeps a large small-
group class/teacher inventory. It does not claim that 100 teachers is typical
staffing for 500 students. Every student has one class at a time; passing time
counts for the student without a class. A class sees six five-student cohorts
(30 different students) over the day. The last period is partly observed.

| Per-school table or result | Expected count |
| --- | ---: |
| Students / current devices / student sessions | 500 each |
| Official classes / teachers / current teaching sessions | 100 each |
| Heavy-day teaching sessions / frozen roster rows | 600 / 3,000 |
| Historical teaching sessions / frozen roster rows | 36,100 / 180,500 |
| Total teaching sessions / frozen roster rows | 36,800 / 184,000 |
| Historical aggregate rows over 361 dense days | 541,500 |
| Heavy-day raw and unique observations | 1,000,000 each |
| Heavy-day retained aggregate grains | 84,000 |
| Heavy-day monitored seconds / heartbeat count | 10,002,500 / 1,000,000 |
| One student's monitored seconds / grains | 20,005 / 168 |
| Grade monitored seconds / grains | 2,000,500 / 16,800 |
| Class monitored seconds / grains / distinct students | 85,025 / 720 / 30 |

The independent oracle sums the declared observations and nonoverlapping frozen
windows. It checks category/heartbeat/student counts, grain counts, daily totals
and ranked domain sums at every scope. Expected domain lists are prepared before
timing, so the oracle does not create measured server load. The full 366-day
inclusive API range must be accepted and the next longer range rejected; the
365-day retention boundary, successful empty day and unavailable gap remain
distinct. Sixty-four actual reports run alongside both complete day rewrites
and four actual authenticated HTTP ingest clients. Post-phase raw observation
oracles, eight scoped CSV exports with strict audits, current-day scopes and
cross-school denials remain required.

Acceptance requires both whole rewrite operations, including connection
checkout, lock, delete, attribution, inserts, ledger write and commit, below
60 seconds. Every recorded API query must stay below 15 seconds and every API
checkout below 5 seconds, with no failures. Driver measurements conservatively
include client queue and event-loop delay. Successful local measurements do not
establish RDS I/O, fleet scheduling, Redis distribution, device behavior or
production rollout readiness. Dense AI-decision and tracking-exclusion capacity
remains unmeasured. The valid extreme 500,000-grain stress day remains a known
60-second write limitation even if this separate school-day profile passes.

The first run at `6b797ffa3596f7b046998ff5d5c8fffb1da7c273` failed and is
preserved in `scripts/load/usage/evidence-school-day-failed-20260930.json`.
Both 84,000-grain writers reached the 60-second server timeout (63-second
client wall time), with zero committed heavy aggregates or completion. Seven
of 64 reports returned 500: three report SQL cancellations and four checkout
failures; the API collector recorded six checkout failures overall and two
ingest clients received 500. Report SQL peaked at 22,107 ms. Read-only
attribution afterward took 15,121 ms. The measured phase wrote 3,660,749,240
temporary bytes across 162 files, which may contribute to concurrent pressure;
this does not isolate a single cause. Post-phase raw oracles, all scoped CSVs
and audits, successful empty/gap/expired semantics and cross-school denials
passed. Bulk historical device IDs in this first run were synthetic; the
follow-on fixture binds them to registered student devices without changing
raw count, schedule, categories, domains or quotas. This initial failure is
not a school-day capacity pass and remains immutable.
