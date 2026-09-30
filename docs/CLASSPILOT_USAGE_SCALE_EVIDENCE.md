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
