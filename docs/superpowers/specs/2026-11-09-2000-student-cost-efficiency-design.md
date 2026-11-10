# 2,000 online students within a $300 monthly AWS budget

Status: operator approved both repositories and implementation without further
design approvals on November 9, 2026. Implementation is complete in isolated
branches, with local regression verification complete. Production capacity and
the monthly budget have not been accepted.

## Intent

Make the existing SchoolPilot/ClassPilot service economical at 2,000 online
students while retaining its current features, capture quality, update cadence,
retention, authorization, reporting and recovery behavior. The operator's normal
AWS baseline is approximately $233/month; October's $415.59 account-wide usage
is not the normal production baseline. The target is under $300/month before
promotional credits, excluding unusual development/test expenditure.

No paid AWS load environment, Linux capacity campaign, new staging cluster,
load generator, production synthetic traffic or automatic infrastructure apply
is part of this work. Use the existing Windows development environment and
read-only aggregate observations of the existing production resources.

## Observed baseline, November 9, 2026

- Production API: one off-hours task, three weekday school-day minimum tasks,
  maximum six; 1 vCPU / 2 GiB per task. Singleton worker: 0.5 vCPU / 1 GiB.
- RDS: Single-AZ PostgreSQL db.t4g.medium, 100 GiB gp3, storage autoscaling up
  to 1,000 GiB. Redis: one cache.t4g.micro. Both are in us-east-1b.
- API tasks use the two public subnets; NAT is absent. Legacy TURN instances
  are stopped, with their retained IP/storage resources still chargeable.
- Both CLASSPILOT_USAGE_ROLLUP_MODE and CLASSPILOT_DIGITAL_USAGE_MODE are on.
  API DB_POOL_MAX=20 is effectively clamped to 16. Existing pool budgets and
  worker isolation remain unchanged.
- The last fourteen days show school-hour API CPU averaging about 3.3%, database
  CPU averaging about 8.1%, Redis memory below 2.7%, no Redis evictions and no
  RDS surplus-credit charges. These observations concern the current small
  workload and do not establish 2,000-device capacity.
- A seven-day aggregate of existing realtime_hot_path_summary logs contains
  109,144 uploads and 2,438,497,892 screenshotPayloadBytes: approximately 22,342
  bytes per screenshot string. This counter measures the UTF-8 screenshot
  string, not compressed HTTP wire bytes or full request bodies. There were
  27,301 stored and 81,843 discarded uploads. Do not assume that distribution
  persists at 2,000 students or means captures can simply be disabled.
- Current extension source already generates 640px routine JPEG thumbnails,
  quality 0.6, after its original capture. Full-resolution safety evidence is
  separate. Adding thumbnails or lowering their quality is not the proposal.

## Requirements that must remain unchanged

1. Ten-second ordinary heartbeat opportunities, event/recovery behavior,
   thirty-second background screenshots and five-second active observation.
2. Current screenshot legibility, full-resolution safety evidence, capture-time
   fences, observation leases and private authority-scoped retention.
3. Complete successful heartbeat persistence, current retention, Usage/report
   semantics, command and chat receipts, FAB/poll behavior and session recovery.
4. Fresh canonical entitlement and exact school/student/session/device binding
   checks for mutations; JWT expiry, RLS, immutable staff authority and revocation.
   Passive WebSocket authorization caches must never authorize telemetry writes.
5. No device IDs in teacher-facing APIs, frames or UI. No widening missing targets.
6. Old extension compatibility, HTTP recovery, MV3 service-worker/offscreen
   lifecycle fences, cancellation on auth/session/connection-generation changes.
7. No smaller resource sizes, reduced alarms, loss of security headers or dropped
   WAF protections to make a budget model appear to pass.

## Approaches considered

### Recommended: shared telemetry operations with negotiated WebSocket adapters

Move recurring device telemetry onto the existing authenticated WebSocket;
keep HTTP adapters and recovery. Reuse a single canonical operation pipeline,
including authentication, validation, admission, persistence and the current
response. This removes most recurring edge HTTP request charges while keeping
the same product behavior. It requires coordinated SchoolPilot and ClassPilot
extension changes and is a substantial security-sensitive implementation.

Add narrowly scoped Redis script caching as a separate efficiency improvement.
Evaluate fixed-price CDN billing only after its compatibility and request budget
are demonstrated. This is the agent's recommended approach, pending the
operator's workflow/scope selection; it has not been approved or implemented.

### Backend-only caching and query changes

The existing hot path already combines fresh persistence-context reads, uses
throttled presence writes, caches non-authoritative tracking projections, batches
tile reads and optional classification updates, and separates worker pools.
Small improvements are worthwhile but cannot remove the extension's edge HTTP
request volume. This does not satisfy the complete cost objective by itself.

### WebSocket-to-loopback HTTP forwarding

A bridge to hardcoded local Express endpoints would preserve the current
middleware pipeline with fewer extraction changes. It introduces extra local
HTTP/JSON processing and request/response lifecycle complexity. It is not the
preferred production design when performance must be retained. Do not implement
arbitrary path/header forwarding, synthetic unverified identities or a generic
remote proxy.

## Proposed implementation boundaries

### 1. Canonical operations and transport equivalence

Extract heartbeat and routine screenshot execution into shared, typed operations
with thin HTTP and WebSocket adapters. A shared operation receives an immutable
authentication context, validated payload, server-derived source IP, cancellation
signal and operation identifier; it produces the same status and JSON outcome
used by the HTTP endpoint. Transport selection must not affect authorization,
reporting, classification, inbox recovery, authority projection or persistence.

HTTP middleware and the shared operation must agree exactly on when a tenant
connection is acquired and released. Keep foreground publication barriers and
existing mutation locks. Do not hold a database checkout while waiting for a
WebSocket reply or background classification.

Use new negotiated capabilities/message names for telemetry; the current
WebSocket heartbeat is only passive liveness and must retain that meaning.
Backend negotiation remains additive and disabled until both sides are ready.

### 2. Bounded telemetry lanes and replies

Do not await heartbeat/screenshot work in the current per-socket control-frame
queue. That queue has at most eight pending frames and carries command/chat ACKs.
Provide separately bounded single-flight telemetry lanes, tracked through normal
shutdown, with existing API admission and byte bounds still enforced. A slow
screenshot must not delay a command or its receipt.

Keep the 256 KiB WebSocket frame ceiling. Oversized routine operations and
full-resolution evidence use the existing HTTP path. Apply current per-device
ingest limits and server-derived source-IP bounds to both transports so moving
off WAF-inspected HTTP requests does not remove abuse protection.

Correlate replies by operation ID and immutable auth/connection generation.
Do not return success merely because an offscreen document accepted a message.
Only the canonical operation's completed result is a product receipt.

### 3. Cross-transport retry correctness

A lost reply does not prove an operation failed. Establish idempotent heartbeat
persistence across a WebSocket retry and HTTP fallback before enabling replay.
The existing heartbeat primary key may support a stable, validated operation ID,
but collision, tenant isolation, payload mismatch and replay outcomes require
explicit tests before choosing that implementation. Do not add an index or
change the production schema casually: every heartbeat already maintains many
indexes, and any migration follows the repository's immutable ledger/RLS rules.

Repeated persistence must not increment usage or heartbeat counts. After a retry,
the policy/command response is derived from current authority; never replay a
cached old classroom policy after revocation, handoff or class transition.

Screenshots retain their atomic newer-capture fence, original capturedAt and exact
authority. Retries may not relabel stale pixels. Evidence completion keeps its
existing exact request identity and idempotency.

### 4. Extension integration

In the separate ClassPilot repository, route routine telemetry through the
existing offscreen WebSocket owner only after capability negotiation. Keep all
existing context/generation checks, abort behavior, license/auth denial handling,
backoff and cadence coalescing. Unsupported/unhealthy sockets recover via HTTP.
Do not keep an additional periodic HTTP heartbeat when WebSocket telemetry is
healthy, since that preserves much of the request charge being removed.

SchoolPilot does not publish the extension. Backend deployment, Store packaging/
review and managed-device adoption remain separate release steps. Recheck the
live version and pending submissions immediately before any future upload.

### 5. Unchanged-image references, without skipping captures

Capture and encode at the current cadence and quality even when a previous
image appears unchanged. Compare the newly acquired bytes with the previous
acknowledged capture locally. A negotiated client may send an opaque reference
instead of identical pixel bytes only when the server previously acknowledged
that exact image under the same school/student/session/device and classroom or
supervision authority, including its control revision.

The server computes the content hash for the original full image and exposes
only a scope-bound opaque image ID. Do not expose raw global image hashes or
create cross-student/global deduplication. Every reference carries the actual
new capturedAt and current tab metadata, passes the existing authorization and
capture-time fences, and atomically preserves the newer-capture rule. A plain
heartbeat, reference lookup or reused old capture cannot renew screenshot age.

If the image is absent, stale, superseded or belongs to a different authority,
require the bytes from the new capture rather than admitting an unverified
reference. The extension retains that capture briefly for this bounded recovery,
keeping the original capturedAt. Class/auth changes clear pending references.

Separate or otherwise atomically patch screenshot metadata from the image blob
so a reference does not rewrite the full image to Redis. Preserve rolling-backend
compatibility and the 120-second retention rules. Teacher batches may include
their known scoped opaque IDs; an authorized unchanged result can contain only
fresh metadata and the exact known image ID. The frontend reuses already decoded
pixels only with the matching privacy/authority key; otherwise it requests the
full current image. Existing useDecodedScreenshot behavior already supports
reusing identical sources under an unchanged privacy key.

This must improve the unchanged-image case without degrading moving/video pages.
Do not assume an unchanged-image percentage in the headline budget. Compare
0%, 25%, 50% and 75% unchanged-image workloads and state any dependency on the
measured ratio. Random/animated images remain full-resolution normal transfers.

### 6. Redis script efficiency

Replace repeated source-body EVAL calls in shared realtime coordination with
EVALSHA using a locally computed SHA1. Fall back once to the exact original EVAL
only after a definite NOSCRIPT response. Preserve the original script, keys,
arguments, TTLs, atomicity, timeout budget and bounded publisher behavior.
Never retry a timeout, disconnect or other outcome that might have executed.
Bound any local script registry; script bytes must be application constants.

This is useful internal efficiency work, not proof of the full business target.

### 7. CDN billing compatibility, independently reviewed

AWS CloudFront Pro currently advertises $15/month, 10 million requests and
50 TB transfer, with WAF/DNS and certain edge logging included. This could
stabilize transfer cost after routine telemetry no longer generates HTTP
requests. It is a candidate, not an adopted baseline.

Before proposing enrollment, verify:

- Paid account eligibility, exact WebSocket/transfer coverage and behavior at
  sustained allowance use; do not assume arbitrary sustained traffic is free.
- Managed cache/origin policies equivalent to every current legacy forwarding
  behavior. All API responses remain uncached and required auth headers/cookies,
  school context and WebSocket upgrade behavior remain intact.
- Current custom CSP-report-only, Permissions-Policy and other security headers
  remain present on success and error responses. A viewer-response function
  alone cannot preserve origin error headers because it does not run for all
  origin errors. Preserve the existing origin/managed-policy protections.
- Whether included WAF limits count managed rule-group entries or their internal
  rules; never drop current security checks to qualify.
- Teacher tile requests, boot/login, control traffic and HTTP recovery fit the
  request allowance with headroom. At 2,000 observed students, thirty per class
  and one tile batch per five seconds, tile reads alone approach 6.4 million
  monthly requests under the six-hour/twenty-two-day assumption.

If Pro cannot preserve current functionality/security, do not switch or count its
savings. Record the target as unresolved and evaluate another reviewed option.

## Budget model and acceptance

Use the operator's $233 normal baseline for actual operating comparisons. A
component estimate around $188/month covers scheduled-minimum compute, RDS,
100 GiB storage, Redis, ALB base and minimum IPv4 resources; it excludes several
real operational charges and must not be presented as an all-in baseline.

For 2,000 devices, six hours/day and twenty-two school days/month:

- Heartbeats at ten seconds: 95.04 million/month.
- Screenshots: 31.68 million/month at thirty seconds, or 190.08 million if every
  device remains at five seconds for the entire modeled day.
- WebSocket telemetry removes individual HTTP request charges, not PAYG bytes.
- At the observed mean string size and one teacher download per image, ALB
  screenshot byte charges alone are roughly $11/month at thirty seconds and
  $63/month at all-day five seconds, before full request/frame overhead.
- Cross-AZ Redis bytes, heartbeat bytes, actual compression, extra readers,
  retries, storage growth, backup/logging and extra API tasks still matter.
  Three extra API tasks throughout school hours add about $37/month.

Therefore $300 is a target requiring measurement, not an implementation claim.
The all-day/all-devices observed case may exceed it even after transport changes.
Do not quietly substitute a smaller observed cohort or lower cadence as success.
Distinguish modeled cost, local correctness/performance and actual AWS spend.

For planning, the agent selects the demanding reference workload: all 2,000
online, with all 2,000 eligible for five-second observation for six hours/day,
twenty-two days/month. Also report an eight-hour sensitivity case. These hours
are an explicit modeling assumption, not a usage limit or a user-approved SLA.
All-observed and 0%-unchanged cases must remain visible even if the target does
not fit. The implementation is not complete against the business goal merely
because the mixed/unchanged case is cheaper.

The acceptance ledger must separately record: implementation correctness; no
behavior/performance regression in bounded local comparisons; modeled cost for
ordinary/mixed/all-observed cases; and production confirmation as real use grows.
No local Windows check is labeled AWS 2,000-device capacity acceptance.

The local deliverable is reviewed implementation, successful existing functional
and bounded comparative checks, and a reproducible cost model with explicit
unknowns. Actual 2,000-device performance and monthly spend remain pending until
confirmed through real-school use; the absence of a paid capacity campaign is
not replaced by an invented acceptance result. This is the agent's proposed
verification scope and does not represent a completed capacity guarantee.

## Local verification and release

Use normal source/unit/contract tests, the already configured local PostgreSQL
fixture and bounded loopback HTTP/WebSocket comparisons on Windows. Use real
Chrome MV3 tests for the extension. No new Docker/Linux test setup is required.

Test old/new negotiation, identical HTTP/WS responses, stale/revoked bindings,
expired JWT, license loss, control changes, lost receipts, retry after commit,
same-ID/different-payload collisions, socket replacement, MV3 restart, oversized
frames, denied/overloaded queues, shutdown, Redis NOSCRIPT, uncertain Redis
outcomes and command latency while telemetry is delayed. Verify successful
heartbeat rows/counts and reports are identical across transports.

Run the repository-required checks for each touched area, including backend
check/build/tests, applicable SOC 2 evidence generation for auth/session changes,
extension check/tests/real-Chrome/build and git diff --check in both repositories.
Preserve all unrelated user edits in the active workspaces.

Prepare reviewed code and rollback instructions before any production change.
Do not apply Terraform, subscribe to a plan, change runtime flags, deploy or
upload an extension as part of local verification. A production rollout follows
the existing repository procedures and separately observed release identities.
Rollback disables the new negotiated transports and retains HTTP compatibility;
it does not delete retained data or weaken enforcement.

## Primary references

- CLAUDE.md: realtime, data pipeline, screenshot policy, RLS, required checks and
  deployment boundaries.
- src/routes/classpilot/devices.ts; src/services/storage.ts;
  src/realtime/websocket.ts; src/realtime/ws-redis.ts;
  src/realtime/boundedRedisPublication.ts; src/services/classpilotProtocol.ts.
- C:/GitHub/ClassPilot/extension/service-worker.js and extension/offscreen.js.
- docs/CLASSPILOT_RELIABILITY.md; docs/SCALE_READINESS.md.
- https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html
- https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/billing-and-usage-interpreting.html
- https://aws.amazon.com/cloudfront/pricing/
- https://aws.amazon.com/elasticloadbalancing/pricing/
- https://aws.amazon.com/elasticache/pricing/
