# Focused release 2.9.7 validation records

The [superseded CI attempt manifest](ci-attempts/manifest.json) retains the four
failed frontend, database and Terraform logs with exact source/run identities,
hashes and diagnoses. These are failed attempts, never final acceptance. The
[native private relay record](../private-chat-redis-relay-20261002/README.md)
separately covers delayed Redis delivery using actual PostgreSQL and WebSockets.

The [local checkpoint manifest](local-checkpoints/manifest.json) preserves earlier
broad runs, failed attempts and follow-up results in individually hashed gzip
logs. Unfrozen or superseded runs are explicitly labeled and cannot certify the
final release. The [private lifecycle record](local-checkpoints/private-lifecycle-6a1c80ab.json)
contains its isolated source checkpoint, 32 ordinary and 32 restricted results,
and a companion archive retaining the failing proofs and their corrections.
The integration PR's final-head CI and ClassPilot's exact ZIP acceptance are
separate evidence sources.

The later [package-binding record](runtime-package-binding-065be165.json) and
[mocked runtime output](runtime-package-binding-065be165.txt) cover the final
source/ZIP pins and 1,287 assertions. They identify the tested file hashes before
commit, preserve the earlier checkpoint below, and assert neither full package
acceptance nor a merge, release tag, Store publication or production operation.

[The manifest](focused-validation-5f406d8c.json) records exact commands, source
SHA, timestamps, exit codes, test/assertion counts, raw-log hashes, sanitized-log
hashes and the local schema scope. Its companion
[`focused-validation-5f406d8c.logs.ndjson.gz`](focused-validation-5f406d8c.logs.ndjson.gz)
contains 17 compact, sanitized log entries. It is gzip-compressed newline-delimited
JSON; each entry contains an `id` and the complete sanitized `utf8Log`.

The clean `5f406d8c59e0a72647b78ae9cd1faed4622eba50` checkpoint passed:

- 19 real PostgreSQL reference/coverage cases and seven usage cases using a
  restricted, non-owner, non-bypass application role, with no skips.
- 45 deployment/image/admission tests and 29 pure workload guards.
- 1,284 ClassPilot and 378 product runtime-tool assertions using mocked AWS CLIs.
- Date-kind conformance for 159 calls across 14 load scripts; plain application
  check/build; test-type and cast ratchets.

The owned local database had all 129 selected tables enabled/forced with their
tenant policy and 53 complete migration records. This catalog count is distinct
from the seven usage-specific policy tests; it does not claim comprehensive
isolation testing of all 129 tables. Disposable test roles were removed by the
helpers. The schema-only database remains available as future synthetic load
input. These checks performed no real AWS or production operations.

Earlier 19/7 database logs and the superseded `5cc28ceb` settings-insert compiler
failure remain in the archive. The earlier logs did not embed a source SHA; the
manifest identifies their session-recorded tracked application source and later
helper/tool commits. The clean checkpoint reruns provide the reproducible source
binding. The compiler repair is `d2b4e52f`; the exact-source check/build/type runs
prove it resolved. A separate evidence-wrapper `npm.ps1` invocation failed before
TypeScript ran; its output is retained and the native `npm.cmd` rerun passed.

These are incremental focused records. Final combined CI, complete database/
frontend/extension acceptance, exact ZIP/pins, three cold 48-second/open-loop
capacity runs and live acceptance remain separate gates. No managed-device pass,
throughput result, deployment, activation or Store publication is asserted.

To inspect the archive from the repository root without extracting files:

```powershell
node -e "const fs = require('node:fs'); const z = require('node:zlib'); process.stdout.write(z.gunzipSync(fs.readFileSync('docs/release-evidence/release-297/focused-validation-5f406d8c.logs.ndjson.gz')));"
```

The manifest records hashes of both the gzip bytes and decompressed NDJSON bytes,
plus each sanitized log. Sanitization changes only recorded paths, synthetic
mock task-definition labels and line endings; a cluster-wide unrelated role count
is omitted from the owned-schema entry. Original raw-log hashes remain listed.
No credentials, raw AWS environment, student identities or private browsing/chat
content are included.

## Cold/open-loop Run 01 — failed capacity gate

[Run 01 manifest](usage-cold-open-loop-run-01-4ce644af.json) and its
[unchanged synthetic records](usage-cold-open-loop-run-01-4ce644af.raw.ndjson.gz)
preserve the final129-schema run on clean combined source `4ce644af` (product
`8cb02862`). This is a measured **FAIL**, and cannot authorize Usage activation.
Both full worker operations completed in 23.582 and 24.041 seconds, but 14 of
64 concurrent-workload JSON reports failed and main-pool acquisitions failed
2,826 times. Of 6,000 independently scheduled heartbeat offers, 4,072 started,
882 succeeded, 3,190 failed, 1,928 were refused at the in-flight ceiling, and
30 arrived late. No pool, deadline, cadence or infrastructure cap was increased.

The report workload is four sequential waves of **16 maximum parallel JSON
offers**, totaling 64 across both schools and all four scopes. Eight CSV
correctness/audit probes follow separately. The immutable pre-run snapshot's
legacy `concurrentReportQueries=64` field denotes this total, not 64 simultaneous
requests; its `capacityMeasured=false` describes that pre-run source snapshot,
not this final result. Preparation took 434.181 seconds; the measured workload
and request drain took 77.648 seconds. PostgreSQL shared buffers were reset by
an owned restart; host filesystem caches were not flushed, and auth/range
preflights warmed report history before concurrency.

The one million stored observations per school are distinct from live HTTP
offers. Final current-day SQL counts were 1,163 and 1,166, including two inserted
preflights per school, leaving 1,161 and 1,164 concurrently inserted observations.
HTTP successes differ from inserted rows: some failed/aborted responses had
already committed, and a 204 need not insert. The manifest keeps these counts,
the complete catalog/migration/flag contract, raw hashes, post-run correctness,
and verified generated-container cleanup separate. Three passing cold repeats,
dense heavy-year history, fleet/RDS/managed-device capacity and pathological
high-grain acceptance remain unproved.

## Bounded heartbeat optimizations — focused validation

[Focused manifest](bounded-authority-fastpaths-0e9e50df.json) and
[nine retained logs](bounded-authority-fastpaths-0e9e50df.logs.ndjson.gz) record
the two subsequent changes: skip owner/channel discovery for an empty exact
student private outbox, and resolve an unlocked school entitlement in one
uncached statement. Student locks, final binding, synchronous delivery,
nonempty/expired outbox processing and the locked entitlement path remain
enforced. No pool, timeout, infrastructure or schema change was made.

The ordinary native runs passed 55 private lifecycle and 13 entitlement cases.
The combined run passed 84 cases: 55 private cases through the restricted
application role, 13 entitlement cases through their explicit privileged native
SQL connection, and 16 source-contract assertions. Entitlement SQL results are
not presented as RLS isolation proof. Plain check/build, the 438/534 test-type
ratchet and the 689/7 cast counts passed. The independent lane separately owns
the newer combined 75 ordinary and 62 restricted case logs.

Two uncommitted draft failures remain archived: test ordering prematurely
adopted the first-adoption fixture, and Drizzle stripped interpolated column
qualifiers in the nested entitlement projection. The native positive case
caught the latter; fully qualified correlation passed before the product was
committed. The manifest distinguishes these failures, subsequent committed
bytes and the later canonical fixture-retirement assertion.

These focused checks permit a corrected-source capacity retry. They do not
establish 100 requests/second acceptance or three passing cold runs, and cannot
authorize Usage activation. The failed Run 01 record remains unchanged.

## Cold/open-loop Run 02 — corrected source still fails capacity

[Run 02 manifest](usage-cold-open-loop-run-02-60bb2338.json) and
[unchanged synthetic records](usage-cold-open-loop-run-02-60bb2338.raw.ndjson.gz)
preserve the first corrected-source retry at frozen clean `60bb2338`. The same
two-school profile, 129-table/53-migration contract, quotas, cadence, offer
limits and deadlines were used. Preparation took 309.018 seconds; measured
concurrent work and request drain took 71.312 seconds. Input and converged DDL
match Run 01 after removing only each dump's two restrict/unrestrict nonce
lines and normalizing LF; original dumps remain unchanged in both archives.

Both complete workers passed the 48-second target at 22.623 and 22.753 seconds,
with the expected 84,000 grains and one million heavy-day observations per
school. The **full workload failed**: 32 of 64 JSON requests failed (16 returned
500 and 16 returned 503). Of 6,000 heartbeat offers, 4,405 started, 1,541
succeeded, 2,864 failed, 1,595 were refused at the in-flight ceiling, and 23 were
late. The API recorded 2,804 failed acquisitions, a 1,286 waiting peak, and a
5.154-second maximum checkout. Report statements stayed within 15 seconds;
successful concurrent JSON response time still reached over 18 seconds.

Final SQL counts were 1,194 and 1,186 current-day observations, including two
inserted preflights per school; 1,192 and 1,184 came from concurrent traffic.
Those 2,376 persisted observations are distinct from 1,541 successful HTTP
responses. Eight subsequent CSV probes and post-run all-scope, coverage,
tenant and atomicity checks passed; these correctness results do not change
the capacity failure. Generated-container cleanup was verified, and further
identical repeats were stopped as instructed.

Usage remains **off**. Three passing cold repeats and the 100 requests/second
mixed workload are not established, and no lower supported arrival rate is
inferred from partial successes. Worker margins observed while traffic was
rejected cannot establish margins with all offers accepted. No additional
optimization, larger pool, timeout, resource allowance or easier profile was
introduced. Earlier 4.8-percent worker-margin runs and stress failures retain
their original, narrower evidence scope.

## Remote CI application checkpoint — d69322ef

[CI manifest](ci-app-checkpoint-d69322ef.json) and
[exact downloaded records](ci-app-checkpoint-d69322ef.raw.ndjson.gz) preserve
run [37053146557](https://github.com/bzinkan/SchoolPilot/actions/runs/37053146557)
at head `d69322ef`. Backend, frontend lint/build/PDF gates, ordinary database,
restricted RLS, all four frontend shards, and the separate AWS rollout safety
job completed successfully. The latter finished while this archive was being
prepared; both the earlier pending and final successful metadata remain.

The backend unit invocation reports 1,682 passing cases and four skips; source
contracts report 644 passing and two skips. Ordinary database tests report
1,375 passing and eight skips; restricted RLS reports 363 passing and one Redis
service conditional skip. Frontend invocation summaries and every requested
job's step statuses are recorded individually; overlapping model/browser cases
are not added into a unique grand total. The raw logs retain all skip reasons.

GitHub checked out synthetic PR merge `b34db4e5`, whose tree exactly equals
the head `d69322ef`. A direct comparison through integration `e89bcbfd` found
only documentation/evidence changes. The manifest preserves the non-doc root
Git objects so later document-only checkpoints can be checked explicitly.
Any later application, test, dependency, workflow or tooling change needs its
own verification.

The 14-record archive contains nine complete job logs and five REST metadata
snapshots, with each original byte count and hash. No local sanitization was
performed; GitHub's own masking remains as downloaded. Secret-pattern and
assignment review found no unexpected credentials. The fixed public CI
`POSTGRES_PASSWORD=test` fixture literal remains in the two database logs.
The ordinary capture job uses released ClassPilot 2.9.3; this is separate from
the recorded exact 2.9.7 package acceptance. CI success does not assert a
deployment or live acceptance, and does not reopen the failed Usage capacity
gate.
