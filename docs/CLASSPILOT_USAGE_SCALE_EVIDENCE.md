# Monitored Browser Time: capped two-school workload

The September 30, 2026 profile at source `b5e433d1a25b5ac4480eb54ea63c54deac5d9d04`
failed the existing 60-second worker statement deadline. Its immutable compact
record is `scripts/load/usage/evidence-scale-failure-20260930.json`; the original
million-heartbeat evidence remains unchanged. Full local evidence is outside the
repository at `%TEMP%/schoolpilot-usage-scale-20260930-run4`.

PostgreSQL 16.15 ran in a dedicated generated container capped at 4 CPUs and
4 GiB memory (4 GiB including swap), publishing only `127.0.0.1:5437`. Node ran
with a 512 MiB V8 old-space cap. These limits do not reproduce RDS I/O or cap
Windows Node CPU/total RSS. The runner verified the exact generated container
name, ownership label, loopback port, and quotas, then removed only that container
and its generated storage. It did not mutate production or other local databases.

Each of two schools had 500 students, 100 official classes, 37,200 sessions,
186,000 frozen roster rows, 1,000,000 heavy-day heartbeats (500,000 unique), and
541,500 precomputed historical aggregate rows. Historical aggregate seeding is a
reader cardinality fixture, not evidence of replaying a year of raw heartbeats.
The real API accepted the supported 366-date range and rejected 367 dates.
Retention withheld the oldest date, with a successful empty day and an internal
unavailable day represented separately.

Both concurrent heavy-day insertions timed out with SQLSTATE `57014`, at
60,003.5 ms and 60,069.8 ms: **no positive worker deadline headroom**. Sixty-four
concurrent all-scope JSON requests returned HTTP 200 with independently checked
historical/date/scope totals and snapshot coverage. School-scope p95 was
14,970.8 ms and 15,540.5 ms; grade p95 was 13,764.9 ms and 13,171.5 ms. HTTP
duration includes several queries and acquisition, so it is not a measurement
of an individual 15-second statement or the 5-second pool-acquisition deadline.
Peak API waiting count was 6; worker waiting count was 0. Peak Node RSS was
264.9 MiB.

The run issued 108 heartbeat requests with HTTP 200 (p95 8,862.6 ms). Its original
generator did not alternate schools promptly under pressure, and the timed-out
writers prevented the post-phase raw count, current-day oracle, and CSV checks.
The `insertedHeartbeats: 0` field in that failed record is unmeasured, not a claim
of zero actual inserts. Those acceptance gates remain open. Follow-on collection
alternates schools, verifies actual stored observations per school, and continues
current-day and export diagnostics after a worker failure without reporting a
capacity pass. Closed-loop throughput is observed capacity, not proof of a fixed
external arrival rate.

The separate repeated profiles preserve subsequent collection results rather
than replacing the initial failed record. `evidence-scale-failure-diagnostics-20260930.json`
also includes HTTP 500 failures; its raw oracle initially used a fractional
cutoff beyond the writer's established whole-second SQL input and therefore did
not complete the current-day checks. `evidence-scale-failure-complete-20260930.json`
uses a whole-second cutoff and passes the post-phase raw oracle and all eight
scope/date CSV checks, while both writers and some concurrent reads still fail.
Its EXPLAIN collection had an untyped unused date parameter (`42P18`), fixed in
follow-on tooling. No attribution-performance result is claimed from that failed
diagnostic. An immutable read-only reference query permits subsequent bounded
EXPLAIN ANALYZE comparisons on the same synthetic dataset; it cannot insert
aggregate rows and runs only after the actual workload measurement ends.

The hourly fleet, preceding heavy jobs, Redis distribution, managed Chromebook
behavior, RDS capacity, and production rollout remain unverified. This failed
profile does not authorize feature activation or infrastructure expansion.

The report-query checkpoint at `ec890bd158268c229fee29961459364c994fe8ff`
preserves `evidence-scale-partial-improvement-20260930.json`. All 64 concurrent
reports and both schools' raw-observation/CSV checks passed. The measured usage
SQL maximum was 4,714 ms and API acquisition maximum 925 ms, below the existing
15,000/5,000 ms deadlines. Both aggregate insertions still reached 60 seconds;
both original and revised read-only attribution/grouping queries also reached
that deadline. Its failed-run `concurrentPhaseMs` includes later diagnostics;
the follow-on collector preserves the actual measured phase separately.

Planner-only diagnosis on the identical capped fixture found forced-RLS
estimates of 10 school observations versus 1,000,000 actual rows and one roster
interval versus 5,000 actual intervals. A nested-loop plan scanned the entire
school's materialized roster for each deduplicated observation. Interval
boundaries could also be recomputed for each roster candidate. The correction
bounds school sessions once and runs observations, newest heartbeat AI lookup,
roster intervals and grouping one student at a time. It preserves the session
winner, exclusions, rounding and all retained grain dimensions. No optimizer
setting, deadline, infrastructure cap or supported date range changed.

The full capped profile at `22cf604a2231d3ad027e3caf43d0fe2938b0c1ee` remains
**failed**, preserved as `evidence-scale-bounded-insertion-failure-20260930.json`.
Read-only attribution/grouping afterward finished in 7,680 ms without temporary
reads, but both concurrent insertions still reached 60 seconds and four of 64
school-scope requests returned HTTP 500. The 64 measured usage-report queries
had no SQL errors and a 10,242 ms maximum; four other API queries failed. Their
initial collector did not identify query families, so this does not establish
API deadline acceptance. Follow-on diagnostics retain fixed query-family labels
and bounded SQLSTATE counts, never SQL text or request parameters. Both workers
rolled back heavy-day aggregates and completion. Current-day independent raw
oracles, all eight scope/date CSV exports and audits, successful empty days,
withheld gaps/expired dates and cross-school denials passed.

The heavy-day profile uses recorded heartbeat categories and has no dense AI
decision history or tracking-exclusion population. Their capacity remains open,
alongside the fleet, RDS I/O, device and operational gates above. Isolated
diagnostic fixtures may be held for at most 30 minutes for EXPLAIN work, with
an external completion marker and exact generated-ownership cleanup. Diagnostic
INSERTs run only against synthetic data and are rolled back; they cannot establish
a capacity pass. Original workload and failure records remain immutable.

Insertion-only diagnosis is preserved in
`scripts/load/usage/evidence-insertion-cost-20260930.json`. After materializing
the independently checked 500,000 grains, a 100,000-row insert took 12,323 ms:
3,882 ms in heap/index work, 3,289 ms in student foreign-key checks, 3,234 ms in
session checks, 1,216 ms in class checks, 613 ms in school checks and 28 ms in
coverage invalidation. The parent lookups already use appropriate indexes.
The full isolated 500,000-row insert still timed out at 60 seconds.

Three additional same-transaction diagnostics applied one absolute 60-second
budget from before the advisory lock and day deletion, including private
`ON COMMIT DROP` staging, indexing, every insert and completion. The 10,000-row
batch run completed 470,000 rows before cancellation; the 50,000-row run and a
transaction-local generic-planning comparison each completed 250,000. Every
failed transaction independently left zero heavy-day aggregates and ledger
rows. These comparisons cannot establish successful commit or concurrent
headroom. No staged writer, planner override, constraint relaxation or cap
increase was adopted. The dedicated fixture was removed after preserving
external plans and hashes. The 60-second writer capacity gate remains open.
