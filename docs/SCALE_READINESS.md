# SchoolPilot Scale Readiness

## Launch posture: up to 800 active ClassPilot devices

> **Real-student onboarding hold:** simulated AWS capacity acceptance does not
> authorize onboarding. No managed Chromebooks are currently available. Keep
> real students blocked until the first available managed Chromebooks pass
> enrollment, real screenshot capture, 10-second heartbeat, class-scoped
> command/received/completed ACK, forced reconnect, and cross-school isolation
> smoke checks. The public Chrome Web Store listing
> `iggbfegfcjkfieoemeolfmfnapepalca` was verified July 11, 2026 at live version
> `2.5.7` (updated July 2, 2026), matching the prepared package. Re-check the
> listing at smoke-test time; do not package or upload the extension from this
> repository.

The launch gate is performance-first but cost-conscious. It is intentionally
different from the deferred 2,000-device HA profile:

- API: ordinary minimum 1, weekday 05:45–10:00 arrival minimum 6, and
  autoscaling maximum 8 at `512 CPU / 2048 MB`, with a 70% CPU target. The
  higher memory revision is retained because launch performance takes priority
  over the original 1024 MB cost model.
- Scheduler: exactly one task at `256 CPU / 512 MB`.
- ECS application tasks: public subnets with public IPv4; the ALB remains the
  only inbound application path and RDS/Redis remain private.
- RDS: `db.t4g.medium`, Single-AZ, 100 GB gp3 with a 1,000 GB autoscaling ceiling.
- Redis: one `cache.t4g.micro` node only after its snapshot and load gates pass.
- NAT gateways: removed only after public-task egress soaks successfully.
- Container Insights: enabled through testing and the first five live school
  days, then disabled while native ECS/ALB/RDS/Redis alarms remain active.
- WAF: 100,000 requests/5 minutes/IP for exact device-ingest POST aliases and
  50,000 requests/5 minutes/IP for other `/api/*` traffic.

The `production-ha-2000.tfvars` posture is deferred until growth requires it.
That profile retains private ECS tasks and NAT, at least two API tasks,
Multi-AZ RDS, Redis replication/failover, and Container Insights. Do not use its
higher fixed-cost topology as a prerequisite for the 800-device launch.

## Runtime and rollup controls

API tasks use `RUN_MIGRATIONS_ON_STARTUP=false`, `SCHEDULER_ENABLED=false`, and
`RLS_GUC_ENABLED=true`. The singleton scheduler uses `node dist/worker.js`,
`SCHEDULER_ENABLED=true`, and the isolated scheduler database pool. The release
image's one-off migration task runs with `RUN_MIGRATIONS_ONLY=true` before both
services roll forward.

Daily ClassPilot usage is rolled up once per school-local day after 02:00. The
scheduler computes indexed half-open UTC bounds (`timestamp >= start` and
`timestamp < end`) for the preceding local date, including 23/25-hour DST days.
A Redis completion marker lives for 72 hours; Postgres advisory locking and
idempotent `(student_id, date)` upserts make restart catch-up safe. Raw
heartbeats remain subject to each school's `retentionHours` setting (720 hours
by default) and are purged in 5,000-row batches.

## Launch load gate

First run the credential-free harness check:

```powershell
npm run load:classpilot -- --validate-fixtures
```

For a gate run, the manifest must contain unique, non-empty `deviceId` and
`studentToken` values. Launch/certification entries must also contain a unique,
non-empty `studentId`; batch tile requests never expose or accept device IDs.
Include `schoolId` for tenant-canary validation. Put ten second-school
canary devices inside every tested manifest prefix; their `schoolId` must differ
from `LOAD_TEACHER_SCHOOL_ID`. Never commit the manifest, session cookie, CSRF
token, or JWT.

Production-like browser traffic must provide:

- `LOAD_BASE_URL` and `LOAD_DEVICE_MANIFEST`.
- `LOAD_TEACHER_AUTH_FILE`, the preparer's ACL-restricted schema-v2 artifact.
  It binds the target URL and expiry plus 20 distinct teacher cookies, CSRF
  tokens, JWTs, live teaching sessions, and disjoint 40-student ownership sets.
  A launch run refuses an expired or different-target artifact. The individual
  variables below remain useful only for a partial diagnostic.
- `LOAD_TEACHER_COOKIE` for teacher/dashboard HTTP requests, plus
  `LOAD_CSRF_TOKEN` for command POSTs. This exercises session-user rate limiting
  and browser CSRF behavior; a Bearer token is not an equivalent launch gate.
- `LOAD_TEACHER_TOKEN` and `LOAD_TEACHER_SCHOOL_ID` for teacher WebSocket auth
  and server-side command ACK observation.
- Every selected manifest entry must declare `schoolId` for tenant-canary validation.
- The supervisor supplies `LOAD_RUN_ID`; accepted runs must not generate or
  substitute their own identity.
- Unique external `LOAD_EXTERNAL_PROGRESS_PATH` and
  `LOAD_EXTERNAL_SUMMARY_PATH` values under
  `%LOCALAPPDATA%\SchoolPilot\load-gates`. The harness fsyncs one-minute JSONL
  progress and atomically publishes the final summary; terminal output is not
  acceptance evidence.
- `LOAD_WAF_DEVICE_LIMIT=100000` and `LOAD_WAF_GENERAL_LIMIT=50000`, matching
  the deployed rate rules.
- `LOAD_TEACHER_PATHS=/api/students-aggregated` for the retained aggregate
  dashboard sample at the 5-second `LOAD_TEACHER_INTERVAL_MS` cadence.
- `LOAD_TILE_HISTORY_PATH=/api/classpilot/tiles/history` and
  `LOAD_TILE_SCREENSHOTS_PATH=/api/classpilot/tiles/screenshots`. After the
  45-second screenshot-cache warm-up, each teacher sends those two POSTs
  together every 30 seconds with its 25- or 40-student cohort. Cookie-authenticated
  POSTs carry that teacher's CSRF token. Legacy `{deviceId}`/`{studentId}`
  template paths and `LOAD_SCREENSHOT_GET_PATH_TEMPLATE` are forbidden in a
  launch run and remain available only for diagnostic detail/range traffic.
- `LOAD_WORKLOAD_SCHEMA_VERSION=classpilot-tile-batch-v1`. Certification also
  binds endpoint-shape SHA-256
  `8e9f1942e4b3a27de7dd0571a9f60ffeb276c089e4baae96a885dba69e3233b2` in
  `workload.endpointShapeSha256`; older per-device results cannot be a
  predecessor.
- `LOAD_COMMAND_ENDPOINT` and `LOAD_COMMAND_BODIES_FILE`, an ignored local JSON
  array containing 20 unique active `teachingSessionId` class command bodies.
  The harness issues one sequential sweep across all 20 classes, then cycles
  one class per command interval. A single `LOAD_COMMAND_BODY` remains
  supported only for partial/non-launch runs. Use a
  reversible command such as an approved test `open-tab`, never a missing-target
  broadcast, and never print or commit the bodies file.
- `LOAD_EXPECTED_CLASS_BODIES=20` and `LOAD_EXPECTED_CANARY_DEVICES=10` for every
  full launch-profile run. Set `LOAD_EXPECTED_TARGETS_PER_CLASS=25` for the
  500-primary baseline and `40` for the 800-primary, 1,000-primary burst, and
  endurance gates.
- `LOAD_ENFORCE_THRESHOLDS=true`. The harness does not print authentication
  material and treats missing/invalid configuration as a hard failure.

With enforced thresholds, `LOAD_GATE_PROFILE=launch` is the default and fails
closed if any input above is absent. It also fixes the stage sizes, canary count,
20-class shape, durations, traffic cadences, screenshot sizes, shared-IP WAF
limits, and two-request batch tile polling to the contract below; environment
overrides cannot weaken those invariants. `LOAD_GATE_PROFILE=partial` is the
explicit opt-out for an intentionally incomplete diagnostic baseline; it is
not launch evidence.

Run this sequence against the current-size baseline, then repeat after each
infrastructure stage:

1. 500 primary devices plus 10 canaries (510 sockets) for 30 minutes, standard
   40 KiB screenshots and 25 sent command targets across each of 20 classes.
2. 800 primary devices plus 10 canaries (810 sockets) for 90 minutes, with 40
   sent targets across each of 20 classes, timed to cross school-local 02:00
   rollup eligibility and a `:30` purge tick.
3. 1,000 primary devices plus 10 canaries (1,010 sockets) for 10 minutes with
   `LOAD_SCREENSHOT_PROFILE=burst`
   (valid 50 KiB JPEGs); 20 classes retain 40 command targets each and the
   additional 200 primary devices exercise ingest/WebSocket burst capacity.
4. 800 primary devices plus 10 canaries (810 sockets), again with 40 targets per
   class, for eight hours followed by idle recovery.

For accepted `Waf/800` and private `Waf/endurance`, verify through the live
fixture API that both synthetic schools' `schoolTimezone` and
`schoolHours.timezone` equal the configured timezone. For `Waf/800`, convert
the planned UTC interval through that timezone and require it to contain local
`01:30` purge and `02:00` rollup eligibility. The live-schedule endurance run
does not inherit that night-window condition. Locally defaulted timezone values
are not acceptance evidence.

Set `LOAD_DEVICE_COUNT` to `510`, `810`, `1010`, and `810` respectively. Order
the ignored manifest so its first ten entries are the second-school canaries;
every tested prefix then includes the tenant-isolation probe.

Every launch-profile run must set `LOAD_FORCE_RECONNECT_AT_SECONDS` with enough
duration for all selected devices to enter and complete the configured reconnect
stagger plus 30 seconds. All requests and WebSockets are forced over IPv4 and
originate from one generator/shared egress IP; use the summary's rolling and
projected five-minute counts when validating WAF headroom.
The harness reports device-ingest POSTs and all other `/api/*` traffic as two
separate WAF buckets; the combined count is informational and must never be
compared with the 50,000-request generic API threshold.

The harness's `thresholds.passed` field covers only HTTP, WebSocket, command, and
WAF traffic gates. It fails an interrupted launch run even when the samples
collected before interruption look healthy. Its separate
`externalAcceptance.passed` remains `null`; a full launch-stage acceptance must
combine the saved harness result with contemporaneous CloudWatch, AWS console/
CLI, snapshot, cost, and rollback evidence.
When `LOAD_ENFORCE_THRESHOLDS=false`, `thresholds.passed` is also `null`; a
diagnostic run is never presented as accepted evidence.

The HTTP/WebSocket/WAF harness scope passes only when all of the following hold:

- Zero valid 3xx, 4xx (including WAF 403/app 429), and cross-school command deliveries.
- Primary-school teacher credentials receive 404 for every explicit canary
  history/screenshot negative probe. Successful teacher payloads are scanned
  for known foreign student/device identifiers even when the response has no
  `schoolId`. Each teacher's aggregated response must contain exactly that
  teacher's 40-student class roster—no duplicate, cross-class, or school-wide
  same-tenant expansion. Each tile batch returns exactly the requested
  authorized student IDs, never a device ID; historical per-device probes must
  still match their requested device.
- Both actual rolling and projected device-ingest traffic stay below 100,000
  requests/5 minutes/IP, and other API traffic stays below 50,000; meeting a
  configured limit fails the gate before WAF blocking is considered acceptable.
- HTTP 5xx and network error rates are each below 0.1%, with zero
  admission-timeout 503 responses.
- Heartbeat p95 ≤500 ms; screenshot ingest and screenshot-batch p95 ≤750 ms;
  history-batch, every other redacted teacher endpoint class, and command p95
  ≤1 second. A fast aggregate cannot hide one slow tile batch.
- Each batch HTTP request is counted once for WAF, latency, network errors, and
  response bytes. Each requested/returned student remains a logical tile
  operation: Waf/800 therefore retains 800 screenshot and 800 history logical
  operations per full polling interval. Screenshot retrieval success is
  evaluated per student tile and must be at least 99%.
- The terminal load summary and monitor result must bind the exact workload
  schema/hash plus 20 cohorts, two requests per cohort per poll, the stage's
  25- or 40-student cohort size, and logical history/screenshot counts equal to
  batch requests multiplied by that size. Missing or inconsistent accounting
  cannot seed the next certification stage.
- 100% of devices receive WebSocket `auth-success`; unexpected closes remain
  below 0.1%; every forced reconnect completes within 30 seconds; before
  intentional shutdown every selected device and all 20 teacher sockets must
  be open/authenticated with no outstanding reconnect.
- At least 99% of command targets receive the command/`received` state within
  2 seconds and reach `completed` within 5 seconds, confirmed on the teacher WS.
  The server-reported target count must equal exactly 25/class in the 500 stage
  or 40/class in later stages, and actual recipients must match that command's
  selected class cohort with no duplicate or same-school cross-class delivery.

The external evidence that must also pass is:

- API one-minute CloudWatch Average CPU has a run-wide mean <60% and p95 <70%;
  the separately retained one-minute Maximum CPU series is peak evidence only
  and does not drive steady, p95, or consecutive-breach gates. Missing or stale
  Average or Maximum CPU evidence invalidates the run without selecting an
  infrastructure rollback. Memory peak remains <75%, with no OOM, restart,
  unhealthy target, or sustained maximum autoscale.
- RDS CPU <65%, connections <150, no pool exhaustion, rollup/purge <10 minutes,
  and at least 20% projected storage headroom at 60 school days. The observed
  class must equal the stage's exact `expectedRdsInstanceClass`. On T4g,
  CPUCreditBalance stays strictly above 24 and surplus charged credits remain
  zero. The additional capacity gates apply only after the approved resize to
  `db.t4g.xlarge`: during the eight-hour endurance run, the hours-2-8 credit
  regression slope must be nonnegative; read and write latency each require
  p95 <20 ms and peak <50 ms; DiskQueueDepth p95 is <1 with no three
  consecutive one-minute values >=2; and total ReadIOPS + WriteIOPS requires
  p95 <2400 and peak <3000. Directional IOPS series remain evidence, not
  separate thresholds. These new capacity series are collected as evidence on
  the medium baseline but do not create new medium-track gates. Missing, stale,
  or incomplete required series invalidate the resized run.
- Redis sustained CPU/memory <60%, peak <70%, free memory >100 MiB, zero
  evictions/rejected connections, ≥99% screenshot retrieval, and available
  manual and subsequent automated snapshots.
- NAT, recurring-log, per-service usage/cost-band, fresh deployment, and rollback
  checks for the current rollout stage.

Configured traffic classes must produce samples; a zero-sample latency class
does not pass. Keep bounded histogram and shared-IP results with the rollout
evidence, but never retain the manifest or authentication values with them.

## Staged cost changes and rollback

1. **Safety baseline:** deploy the WAF split, limiter/logging/rollup changes and
   alarms with NAT, current Redis, and Container Insights still enabled. Stop on
   any valid 403/429 or failed gate.
2. **Public ECS:** move API/worker tasks to public subnets while NAT remains.
   Use the guarded same-image networking mode: it must clone the certified
   digest-pinned task definitions and run migrations/stability without any
   image build, push, or retag. Verify fresh deployments, ALB health,
   ECR/SSM/CloudWatch and every required third-party egress path. Soak 24 hours
   and require NAT bytes to approach zero before destroying NAT/routes.
3. **No NAT:** rerun the guarded same-image mode and repeat egress plus the
   800-device gate. Roll back by recreating NAT/routes first, then moving both
   services to private subnets; restoring NAT alone does not reroute public tasks.
4. **Redis micro:** create and verify a manual snapshot, confirm no pending
   maintenance, resize only Redis, then run 800 devices for 90 minutes and eight
   hours. Any eviction, rejected connection, three consecutive one-minute
   resource breaches, or missing follow-up snapshot restores `cache.t4g.small`.
5. **Post-launch telemetry:** retain Container Insights and native alarms for at
   least five stable live school days. Any telemetry reduction is a separate
   reviewed change, not an automatic cost-ladder step. RDS downsize and API 256
   CPU remain separate, deferred tests.

Automatic rollback remains cause-specific. A valid WAF 403/429 can change only
the reviewed rate rules to `COUNT`; application restart/unhealthy-target or
non-OOM regression can restore only the bound prior API/worker revisions;
networking and Redis failures use only their corresponding reviewed actions.
RDS CPU, memory/swap, connection, credit, latency, queue, or IOPS failures stop
traffic and preserve evidence without mutating unrelated infrastructure. PI is
corroboration only and cannot excuse a failed non-RDS gate. An API OOM uses the
bound pre-registered `512 CPU / 2048 MB` revision only when that revision is not
already active; OOM on the active emergency revision is a hard stop.

## Deferred 2,000-device HA gate

Before selecting `production-ha-2000.tfvars`, rerun the same harness at 500,
1,000, and 2,000 devices and add RDS Multi-AZ failover, Redis primary failover,
two-task rolling deploy, scheduler duplicate-lock, frontend rollback, and
database restore drills. Revisit raw-heartbeat partitioning/archival before
going beyond 2,000 devices; `heartbeats` must not become the long-term analytics
store.
