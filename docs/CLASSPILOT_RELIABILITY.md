# ClassPilot reliability release

## Status and acceptance boundary

This change repairs the web dashboard, API transport and separate ClassPilot
extension. It does not establish production capacity or managed-Chromebook
adoption. The release target is 800 concurrent Chromebooks in twenty
40-student classrooms on the observed existing infrastructure, not an
800-tile browser grid. Live View remains retired.

Do not expand the release until fresh workload evidence and managed acceptance
pass. The existing production capacity authorization remains paused; earlier
campaigns, extension listings and local tests cannot admit this candidate.
No infrastructure size, database pool cap, WAF limit, RLS inventory or
capability rollout is changed by this release.

## Behavior and implementation

- Active screenshots retain negotiated five-second capture; background
  capture remains 30 seconds. Dashboard screenshot reads share three permits,
  one in-flight read per exact cohort and at most 50 students per request.
  Fast reads start no more often than every five seconds per cohort. An
  eight-second-old eligible preview activates missing-event recovery, even
  while socket probes succeed. Full-cohort reconciliation stays at 30 seconds.
- ClassPilot snapshot reads have eight-second deadlines. Queues retain the
  latest pending targets and discard superseded school/context/binding work.
  No global Axios default or command-submission retry is added. An observation
  PUT caller deadline fences its epoch and preserves late compensating DELETE;
  aborting a read and abandoning a mutation are deliberately separate paths.
- Dashboard reconnect revalidates authority/roster before requesting pixels,
  and independently refreshes classroom state and raised hands. Hidden tabs
  release observation and pause pixel recovery. Denied reads remain denied.
- Extension navigation events survive an in-flight heartbeat, then use fresh
  tab state in one trailing send. ACK transport is independent of classroom/FAB
  processing and is bounded through response-body completion. Original durable
  ACK IDs and exact bindings remain queued until a matching receipt. Cold-wake
  frames wait for verified identity/socket recovery and retain arrival order;
  original transient expiry is rechecked immediately before effects.
- Exact student delivery is serialized inside bounded cohorts of at most 40
  students on one owned transaction. Sorted control locks survive sequential
  target savepoints; no per-student pool fanout is introduced. Redis publication
  runs after commit and ordered ACK-summary transport runs after tenant release.
  End Class takes the canonical school/staff lifecycle lock before its session
  and student locks, preventing the preexisting promotion/coverage deadlock.
  Closing retained or disabled-school sessions remains permitted.
- A URL-only `open-tab` for up to 40 students shares entitlement, binding and
  current-owner reads under sorted authority locks. Plain commands preserve
  their existing optional revision semantics; an explicitly frozen revision
  must match. A fresh database-clock projection and a monotonic deadline fence
  every synchronous send, including school/license expiry and an approaching
  supervision handoff. Rich commands retain their existing delivery path.
  Transport envelopes are copied and frozen before post-commit publication;
  no command replay, deadline extension or database pool increase is added.
- Publication uses a dedicated connection with no offline backlog: 100 ms
  readiness, 250 ms ordinary / 500 ms ordered caller budgets, 32 raw operations
  and a two-second watchdog. The circuit opens after three caller timeouts in
  ten seconds or one raw watchdog. A timeout after admission means **unknown**,
  never device failure or permission to resend a one-shot command. Revision
  watermarks, exact destination checks, original deadlines and durable recovery
  remain authoritative. Matching local sockets still require locked authority;
  tasks with no possible destination skip the database checkout.

### Additive transport hint

`auth-success.transportProbeV1: true` advertises a transport-only echo:

```json
{ "type": "transport-probe", "nonce": "opaque_nonce_8_to_64_chars" }
```

The reply is `transport-probe-reply` with the same nonce. Nonces contain only
ASCII letters, digits, `_` and `-`. Only authenticated sockets can use it.
Echoing never renews presence, authorization, a binding or a lease. Server
protocol pong revalidation and privileged-message checks remain in place.
Clients without the hint use legacy `ping`/`pong`, so a new client does not
churn against an older API. No protocol-version or device-capability change
is required. Ten-second probes plus a five-second deadline detect an awake
blackhole within 15 seconds. A callback delayed more than two seconds probes
again rather than misclassifying sleep as a broken connection.

### Content-free operational health

`POST /api/classpilot/monitoring/client-health` requires verified staff
authentication, school context and canonical ClassPilot entitlement. It accepts
only this strict payload and returns 204:

```json
{
  "version": 1,
  "intervalSeconds": 60,
  "freshnessBuckets": [0, 0, 0, 0, 0, 0],
  "counters": {
    "readTimeouts": 0,
    "reconnects": 0,
    "recoveries": 0,
    "eventGapRecoveries": 0
  }
}
```

Buckets are disjoint: <=5 seconds, (5,10], (10,15], (15,30], >30, unavailable.
Every count is an integer 0..6000 and the bucket sum is at most 6000. Bodies
are bounded to 2 KiB. The visible dashboard samples at most 100 eligible tiles
every five seconds, reports once per minute, and drops reporting errors without
a retry loop. A local verified-actor guard permits two requests/minute per API
process for clock boundaries or multiple tabs, without a Redis wait;
the ordinary shared API limiter still applies. No student/device/session IDs, URLs, pixels or
free-form fields are accepted or emitted. Fixed bucket counts merge across
clients; averages of client percentiles are not fleet percentiles. These
client-reported metrics are diagnostic, not authority or independent release
acceptance evidence.

## Local candidate validation (2026-10-13)

The final full restricted-role RLS lane passed **533/533** on a second fresh
schema-only database, with zero failures, cancellations or skips. It ran against
the final source, the exact 129-table CI allowlist and a dedicated NOSUPERUSER,
NOBYPASSRLS role, including the concurrent delivery regression.

The extension candidate is committed separately at `60920d54` in the ClassPilot
repository. Its runtime source fingerprint is
`6a49379e3ed92c5d3d68b0ac345f69ca29207e96f3f0a9a9177afe5384ab6822`.
Node24 check, build, 205 unit tests and the full actual-Chrome aggregate passed.
The strengthened native navigation test also proves one fresh trailing
heartbeat after a real two-second event timer while another send is active.
No successor version, Store upload or managed installation is established.

Frontend build and lint passed (zero errors, 32 existing warnings). The focused
suite passed 181 cases and the permanent browser fault set passed seven cases.
The exhaustive dashboard run exposed failures that were corrected and passed
their individual/group retakes, including the final large aggregate parent;
this is not a claim of one clean exhaustive invocation. The current inventory
contains 102 parent cases in two 51-case partitions. Command/context, coverage,
lifecycle, router, student-tile, Radix, scheduling and batching gates also passed.

Backend typecheck/build, test type/cast ratchets and governance checks passed.
Governance still reports the repository's existing pending human approvals and
operating-evidence warnings. The new reliability harness passed 11 dry-run,
profile and actual loopback HTTP/WebSocket checks, including deliberately
retired pixel bindings and a simulated cross-school tile leak. All 49 legacy
load-harness checks passed. Loopback fixtures prove harness behavior only.

The full serial API invocation ran 4,260 tests: 4,057 passed, 162 failed, 33 were
cancelled and eight skipped. Its failures exposed stale fixture setup/cleanup
against current database retention and staff-assignment guards, source-contract
expectations changed by the bounded adapter, and two tests that deliberately
refuse a generic local database name. Fixtures were repaired through canonical
writers without disabling guards or weakening behavior assertions. Subsequent
serial runs provide the remaining coverage; the failed full invocation must not
be relabeled as a clean run.
The first corrected 64-file retake ran 714 checks (660 passed, 20 failed,
34 cancelled); its remaining seven files exposed additional fixture premises
and the genuine, baseline-equivalent finalization lock inversion described
above. The inversion was repaired without weakening its concurrent race checks.
The eight-file follow-up passed 209 of 210 checks; its sole wall-time failure
passed in a quiet complete 59-check Session Summary retake, with the original
bound unchanged. Every previously failing file therefore has a passing current
retake. Redis regressions passed 14/14; native delivery regressions passed 6/6,
including independent concurrent requests with overlapping, reversed cohorts.
The application-import/dotenv test also passed with external providers pinned
off and a deliberately unreachable database, proving no DB service is needed.

The two namespace-specific owner regressions passed all 17 checks on a fresh
owned `sptest` database. The restricted-role lane enabled the exact CI allowlist
of 129 tenant tables and ran 532 checks: 529 passed, with three announcement
positive controls exposing a missing explicit-null fixture field. Their corrected
private-chat file then passed all 72 checks through the same NOSUPERUSER,
NOBYPASSRLS role. No tenant guard was disabled. Test startup also clears external
email/Telegram credentials inherited from developer `.env`; provider fixtures
must install their own fake keys/transports, so deliberate faults stay local.

Native batch tests prove shared connection/savepoint boundaries, sorted locks,
individual denial, exact binding, transfer serialization, expiry and relay actor
fences. Their elapsed time includes deliberate external lock probes and is not
a production command-latency or capacity result. Fresh 40/500/800 staging traffic,
twenty rendered dashboards, packed managed devices and five school days remain
separate acceptance evidence.

## Fresh workload and gates

The separate `classpilot-reliability-v3` workload binds new endpoint-shape
identity and cannot masquerade as historical `classpilot-tile-batch-v1` launch
evidence. Its runner deliberately blocks production origins. For HTTPS staging,
`LOAD_RELIABILITY_STAGING_ORIGIN` must exactly match `LOAD_BASE_URL`.

Version2 replaced the original repeated-character JPEG comment with independent
random payloads cached per device. Decoded captures remain exactly40KiB and
keep the existing96-byte capture-stamp tail. Bounded, content-free summaries
record cache counts/bytes, creation and capture costs, and40-device gzip/Brotli
cohort sizes, each at least95% of decoded JPEG bytes. Native Chrome checks
actual response wire sizes and distinct decoded capture identities. Version1
wire results cannot be credited as version2 capacity evidence. The image still
decodes to one pixel: Chromebook capture encoding, real JPEG decode and GPU
costs require the managed-device pilot. Version3 retains that entropy/wire gate,
cycles three exact legal decoded colors per device, and adds controller-monotonic
causal capture/navigation proof. Raw cross-host Date.now age samples remain
diagnostic and cannot satisfy screen-freshness acceptance.

Use fresh private device/teacher/command artifacts under the existing protected
external load-gates root, with a unique `LOAD_RUN_ID`, progress path and summary
path. Each profile includes ten leading second-school canaries, disjoint
cookie/CSRF/bearer-authenticated teachers and exact frozen class command targets.
Roster reads carry each teacher's exact `teachingSessionId`; twenty foreign
student probes exercise the actual screenshot/history tile POSTs under that
same session. A successful response to a negative probe fails the campaign.
The runner obtains real observation leases and uses only the screenshot
authority returned by authenticated bootstrap/heartbeats. Missing five-second
policy fails the gate; fixtures never grant themselves capture authority.

```powershell
node scripts/load/run-classpilot-reliability.mjs --devices 40 --dry-run
node scripts/load/run-classpilot-reliability.mjs --devices 40
node scripts/load/run-classpilot-reliability.mjs --devices 500
node scripts/load/run-classpilot-reliability.mjs --devices 800
```

Profiles run 10, 30 and 90 minutes respectively. `--smoke` is a separate
60-second loopback-only functional check, never capacity acceptance. Dry-run
validates configuration without HTTP or socket traffic. Isolated staging uses
the paired V3 producer/controller, exact schema2 private manifest and measurement
IPC paths; the direct commands cannot create an unpaired acceptance run. Screenshots poll at
five seconds while history stays at 30; application probes run at ten seconds.
The harness records capture-age percentiles, exact command results, isolation,
reconnects, endpoint latency, WAF buckets and durable output. HTTP capture-age
samples do not prove actual browser paint. Browser and managed-device gates
remain independently required, including twenty concurrent rendered teacher
dashboards during the 800-device campaign.

The profile fixes read deadlines and startup warmup rather than accepting
overrides that dilute traffic. It requires sustained successful heartbeat and
capture counts per device and screenshot/history read counts per classroom,
allowing only bounded warmup, stagger, an in-flight deadline and a final round.
Missing, invalid or future capture timestamps count as unavailable against
every expected tile; at least 99% must provide valid age evidence. Exact
pixel binding versions must match the current tile before age is counted;
retired or unbound pixels fail response validation. Independent
history and screenshot cadences are recorded separately. Lease cleanup awaits
renewals and sends each exact viewer identity in its DELETE body.

| Gate | Required result |
|---|---|
| Visible active screenshot age | p95 <=10 s; p99 <=15 s |
| Navigation to updated tile | p95 <=3 s; p99 <=5 s |
| Commands | >=99% received <=2 s; completed <=5 s |
| Awake silent socket | detected <=15 s; correct state/pixels recovered <=30 s after connectivity returns |
| Snapshot stall | releases its permit <=8 s; other cohorts continue |
| Backend endpoints | heartbeat p95 <=500 ms; screenshot ingest/read <=750 ms; other teacher/command <=1 s |
| Infrastructure | existing API/RDS/Redis limits; no >20% endpoint p95 regression |
| Failures | no valid-request WAF/authorization rejection; HTTP/network errors <0.1%; no admission-timeout 503s |
| Isolation | zero foreign pixels, command delivery or target expansion |

At 800 fully observed devices, baseline ingest is 160 screenshots/s plus 80
heartbeats/s: 72,000 requests/five minutes before canaries/retries/controls.
A 30% baseline demand surge is 93,600, not 30% unused allowance. Include actual
extra traffic in rolling totals below 100,000 device-ingest and 50,000 other API
requests/five minutes/IP. Twenty ordinary classrooms require at most 280
screenshot HTTP reads/minute at the conservative fourteen-read bound. An
unusually large single dashboard has a 100-student fast-priority cap, not a
promise of only two cache-cohort requests.

## Release and rollback

1. Run backend typecheck/build/full serial tests and the required frontend and
   real-Chrome extension gates. Preserve new stalled-request, missing-event,
   transaction-lock, Redis blackhole and cold-worker regressions.
2. Bind a newly reviewed capacity campaign to exact source/image/extension
   artifacts before any production load. Existing paused campaigns stay paused.
3. Deploy the reviewed backend/API and worker first, then the web app using the
   governed repository deployment procedures. Do not switch infrastructure
   profiles or alter runtime capability flags to conceal failed gates.
4. Separately version and package the ClassPilot extension from its own clean
   source. Recheck the live Store listing and pending submissions immediately
   before upload; retain the ZIP identity and compare packaged source.
5. Validate 5-10 packed managed Chromebooks, then one full 40-student class
   period with actual screen capture, commands, Wi-Fi loss, sleep/wake and
   exact handoff/isolation. Verify installed versions, not just Store publication.
6. Observe five successful school days before broad rollout. Record actual
   client freshness and command results alongside service/resource metrics.

Any privacy or authority defect stops rollout immediately. Repeated freshness,
command or recovery failures require repair and fresh evidence. Apply the
existing fast-preview-off containment if its governed stop conditions fire;
that retains background capture and every privacy boundary. Backend rollback
must retain existing room/private-chat/schedule data-compatibility floors.
Extension rollback is a reviewed forward release because installed Chrome
extensions do not downgrade automatically.

Outstanding external evidence remains explicit: staged AWS capacity, packed
managed-device acceptance, serving artifact identity, and the five-school-day
pilot. Local tests and dry-runs must never be reported as completion of these
gates.

## Staging and managed pilot status

The isolated stack was provisioned on 2026-10-13 at
`https://staging.school-pilot.net` with its own Terraform state, VPC,
database, Redis, S3/CloudFront distribution, session storage and secrets. Seed
only synthetic schools, twenty teacher accounts and twenty disjoint 40-student
classes. Do not copy production records, credentials or device bindings.

The isolated profile and its state custody are documented in
[staging operations](./CLASSPILOT_STAGING_OPERATIONS.md). It explicitly uses:

- Three API tasks at 1 vCPU / 2 GiB each, matching the existing weekday floor.
  One task is sufficient for smoke checks. The existing six-task maximum is
  a separate autoscaling gate, not an automatic capacity increase.
- One worker at 0.5 vCPU / 1 GiB, single-AZ `db.t4g.medium` with 100 GiB gp3,
  one `cache.t4g.micro`, one ALB across two availability zones with `/readyz`.
- Public task networking without NAT, no Redis replica, no Multi-AZ database
  and Container Insights disabled, matching the read-only production observation
  on 2026-10-13. Preserve runtime environment and effective role-specific pool
  caps; `DB_POOL_MAX=20` is clamped to 16 for API main and 2 for worker main.

Staging now uses the host-only `schoolpilot.staging.sid` cookie consistently
through authentication, logout, CloudFront forwarding and the harness.
Native Chrome verified that an invalid production parent-domain cookie is
ignored and survives staging logout. The production cookie configuration is
unchanged. External providers remain unconfigured; serving source/image and
generator identities are bound in private receipts.

The first full ten-minute 40-device paired run completed on 2026-10-14 UTC
(2026-10-13 local time) and **failed acceptance**. Its 4,280 raw rendered-screen
capture-age samples were within ten/fifteen seconds, but generator/browser
clock offset was unverified. These raw Date.now diagnostics do not establish
actual capture-freshness acceptance. It reported no wrong binding or wrong
class. However, fourteen of twenty command HTTP requests failed. The pooled
screenshot-read p95 was at most 592 ms, while the browser segment alone reached
872 ms; retain both measurements. Command/ACK locking failures require repair
and a new full 40-device run before starting the 500/800 profiles. Private raw
histograms, resource metrics and exact artifacts remain outside the repository.
These synthetic JPEGs measure transport and authorization; managed-device
capture/encoding and actual thumbnail rendering cost remain separate gates.

The second full ten-minute 40-device diagnostic also **failed acceptance**.
It had no HTTP failures, all 760 device command receipts/completions met their
two/five-second limits, and 4,320 decoded screenshots had no wrong binding or
class. Teacher command HTTP p95 still reached 1,618 ms, and the rendered
dashboard command response took 2,275 ms. The URL-only delivery repair reduces
the measured native 40-target transaction from 525 SQL statements to 13;
fresh staging performance evidence is still required.

Both diagnostics used v1 screenshot fixtures whose repeated bytes compressed
unrealistically. The v2 workload uses independent per-device 40 KiB fixtures
and requires gzip/Brotli cohort payloads to retain at least 95% of their decoded
size. The previous runs do not establish v2 capacity. A newly built exact
candidate must pass the complete paired 40-device profile before 500 devices,
then 500 before 800; no profile has passed acceptance yet.

Read-only AWS Price List queries on 2026-10-13 give an estimated **base** of
$0.213/hour for one API task and $0.322/hour for three API tasks (about $5.12
and $7.73 per full day). These include the worker, database, Redis, prorated
100 GiB storage, ALB base and minimum public IPv4 addresses. They exclude
traffic, LCU usage, CDN/internet egress, WAF requests, logs, backups and the
load generator; they are not all-in quotes. Pricing depends on resource time
and usage. [Fargate pricing](https://aws.amazon.com/fargate/pricing/),
[RDS pricing](https://aws.amazon.com/rds/postgresql/pricing/),
[Redis pricing](https://aws.amazon.com/elasticache/pricing/),
[ALB pricing](https://aws.amazon.com/elasticloadbalancing/pricing/),
[IPv4 pricing](https://aws.amazon.com/vpc/pricing/).

At 800 fully observed devices, 40 KiB decoded JPEGs represent about 22 GiB/hour
per direction; JSON/base64 and compression can put wire volume closer to
30 GiB/hour per direction. That adds roughly $0.38-0.52/hour of ALB byte
processing before other LCU dimensions and protocol overhead, plus measured
CDN/internet transfer. Price the actual route and account allowances in the
AWS calculator, then review a fixed test window and spending cap before
creating billable resources. Export evidence and remove the temporary stack
after the approved window. Stopping RDS retains storage charges and AWS
automatically restarts it after seven days. [RDS stop behavior](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_StopInstance.html).

For managed acceptance, create dedicated test user/device OUs and use 5-10
school-owned loaner Chromebooks with synthetic accounts. Google recommends
starting with a small test deployment. [ChromeOS test deployment](https://support.google.com/chrome/a/answer/4601288?hl=en).
The existing managed `serverUrl` can point the packed candidate to staging;
use a staging school/enrollment binding and verify the installed artifact and
`chrome://policy` on every device. Deliver the unpublished candidate through
a separately reviewed test package/ID or enterprise channel. Exclude the
inherited production extension from those test profiles so two extensions do
not enforce simultaneously. After these devices pass capture, commands,
sleep/wake, Wi-Fi recovery and isolation, run one full 40-student period, then
the five-school-day pilot required above.

A managed pilot may use a designated classroom at the operator's existing
pilot school when separate loaner devices and test OUs are unavailable. The
operator has selected two periods in their own classroom; exact session
bindings and times remain pending. Keep synthetic capacity traffic in isolated staging.
Use ordinary authorized classroom traffic for live acceptance, starting with
5-10 awake devices before a complete classroom period. Never copy live school
records or device bindings into staging.

Before that pilot starts, identify the exact classroom/session and period,
verify the teacher's server-enforced command authority, and bind the reviewed
extension ZIP hash, installed version and package ID to the passing backend/web
capacity candidate. Check the live Store listing and any pending submission
again before a separately reviewed successor upload. Store publication alone
does not establish the installed artifact. A separate test extension ID still
requires an administrator to apply the appropriate managed policies.

Record these outcomes for each pilot stage:

- On 5-10 devices, verify that the `serverUrl` policy and school binding match
  the selected pilot environment, one active enforcement extension, live screens, navigation and
  received/completed command times. Include an exact student transfer and a
  second-school denial probe.
- Exercise sleep/wake, Wi-Fi loss/restoration and a silent connection failure.
  Check accurate stale/reconnecting displays, recovery within thirty seconds
  and no expired one-shot side effect after recovery.
- Run a complete forty-student classroom period, measuring actual capture age,
  navigation and command percentiles alongside the unchanged service limits.
- Keep the successful cohort under observation for five school days before
  broader rollout. A privacy defect stops the pilot; repeated freshness,
  command or recovery failures require repair and fresh evidence.

The exact live session/period, installed candidate and five-day outcomes have
not yet been supplied or verified. The isolated stack and local gates do not
establish Chromebook pilot readiness while the capacity campaign is failing.


## V3 measurement contract

The V3 harness requires independent navigation and capture evidence before any
40/500/800 profile may pass. It binds the actual rendered controller bytes,
17-file generator bundle, candidate API image, exact synthetic cohort and new
shared input manifest. Backend/frontend runtime identities remain separate.

One controller monotonic clock records a trigger before each unpredictable
nonce and its receipt after the real Chrome compositor witness. Neither
generator nor renderer clock origins are subtracted from the controller.
The fleet starts only after the first exact pulse; a strict immediate start
receipt must return within the existing one-second paired-start bound. Raw
UTC skew remains diagnostic. Both actors must complete their full durations.

Five-second capture cadence remains unchanged. One-second S3 pulses establish
a conservative age upper bound in each existing JPEG comment reservation.
Unknown, expired or wrong-binding pulse markers are unbounded samples. Three
legal decoded-color variants retain per-device high-entropy40KiB payloads.
A new decoded source cannot claim fresh paint from an unchanged old color:
the older verified causal bound is retained, or the sample is unknown.
The sampler accounts for object-contain geometry, retained outgoing frames
and the existing150ms crossfade without disabling production animation.

Navigation probes preserve ten-second regular heartbeats and two-second event
coalescing through one writer per exact binding. A counted two-second bootstrap
fence drains prior complete HTTP attempts while absolute regular timers keep
queuing their latest work. The real teacher page reads the exact-session roster;
every safe surviving public revision is frozen before monotone probe increments.
Missing authority or revision evidence fails closed. First-round icon absence
is verified before the unpredictable trigger. Real decoded sources, exact
student updates and native compositor pixels must agree; title attributes alone
cannot pass. Ordinary and pointer-events:none overlays are negative cases.
This measures painted tab metadata/icons; it does not claim native hover-title
text paint or replace packed Chromebook navigation validation.

Raw pooled histograms must prove navigation p95<=3s/p99<=5s and causal capture
p95<=10s/p99<=15s. Summary booleans navigationLatencyPassed and
causalCaptureFreshnessPassed are required alongside existing fleet, privacy,
command, wire, request, resource and duration gates. Old V2/rawDate receipts
cannot authorize subsequent profiles. Every extra heartbeat, roster GET, favicon
transfer and S3 attempt is counted. The one-second pulse budget is at most300
PUTs and3000 GET polls per five minutes before explicitly recorded retries or
control/start/bootstrap receipt operations. The800 device-ingest baseline
remains72000/5min plus at most4000 event heartbeats and existing canaries/controls.

Offline pure or local Windows codec/compositor regressions are not capacity
evidence. Actual artifact-bound Linux/S3, candidate UI and20-context resource
preflights are required before a fresh full40 profile, then500 and800.
