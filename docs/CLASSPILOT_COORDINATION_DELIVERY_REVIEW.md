# Coordination and delivery warning review

This local investigation reviews the October 26, 2026 operational warnings. It
does not change delivery behavior, time limits, authorization, retries, feature
flags, or production configuration. Private event identifiers, bindings, payloads,
and evidence locations remain outside this repository.

The serving application revision was
`fcffbe0b3aba950d3c6ea1383b71893d50c9e0b0`; the reviewed tooling baseline was
`ec147b3030c67d6735b3aa211db31d6e83cbaae7`. Their FAB pending, bounded Redis,
WebSocket broadcast, student-chat delivery, and relevant route implementations
are identical. There is no newer application fix for these paths in that tooling
baseline. A source comparison is not a production deployment.

## What the retained observations establish

- One runtime-summary interval contained four unavailable shared pending takes.
  It does not establish four Redis exceptions, four students, or four lost
  deliveries. Its cause and the local fallback's result were not recorded by
  these counters.
- The true chat counters reported two task-local misses and one staff-socket
  write. The summaries do not join those operations by message or establish
  receipt, rendering, reading, or acknowledgement at a client.
- FAB local-miss, pending-mark, and pending-served counters were positive in
  multiple intervals. They count different operations. Subtracting served from
  marked or local-miss counts does not measure lost messages or students.
- The reviewed observations did not establish a pool-acquisition failure,
  stalled-pool transition, worker failure, or simultaneous monitoring loss across
  multiple students. Later zero values or an event leaving a query window do not
  prove recovery.

These are operational observations, not independent proof of report UI accuracy,
end-to-end delivery, or capacity acceptance.

## Shared pending take: known path and unresolved cause

`src/services/classpilotFabSyncPending.ts` uses a ten-minute HMAC-keyed shared
hint and a bounded process-local fallback map. `mark()` counts
`fabSyncPendingMarked` only after a shared `SET` reply of `OK`; otherwise it stores
a local hint and counts `fabSyncPendingMarkFallback`. A successful shared mark is
not also mirrored into the local map.

`take()` calls bounded `GETDEL`. A string reply consumes a shared hint and returns
true. An ordinary missing-key `null` reply does **not** increment
`fabSyncPendingTakeUnavailable`. An `undefined` result, including a caught
exception, increments that counter and then attempts `takeLocally()`. The returned
boolean does not distinguish local hit, absent hint, expiration, or eviction.

`src/realtime/ws-redis.ts` currently maps both non-admission and uncertain
post-admission outcomes to `undefined` for this compatibility API. An absent
Redis configuration also returns `undefined`. The underlying
`BoundedRedisPublication` distinguishes:

- `not_admitted`: not ready, queue full, circuit open, shutdown, aborted, or not
  configured; the operation was not admitted;
- `unknown`: timeout, lost transport, shutdown, or abort after admission; Redis
  may already have executed the operation;
- `accepted`: an actual reply, including an authoritative `null` miss.

General coordination outcome and latency aggregates already exist, but the FAB
take counter does not retain an operation-specific disposition or reason. A
coincident general coordination warning cannot be assigned to these four takes
from these aggregates alone. The existing caller and transport bounds must not
be increased to make the warning disappear.

Two limitations follow from the code and are not diagnoses of the observed
episode. First, a local-only fallback hint is visible only in the process that
stored it. Second, a shared `GETDEL` with an unknown outcome may have consumed its
hint without returning an accepted result to this caller. Blindly retrying that
one-shot operation would not establish what happened. Existing authoritative FAB
recovery remains separate; its success for this episode was not measured here.

The heartbeat starts this take in the same concurrent Redis round after releasing
PostgreSQL (`src/routes/classpilot/devices.ts`). A true pending result requests an
authoritative FAB snapshot. `fabSyncPendingServed` is counted when that snapshot
is prepared immediately before the HTTP response, not when a device acknowledges
or applies it. The stale-snapshot path re-marks a taken hint. These distinctions
must survive any future repair.

## Why chat M2/D1 can be ordinary fan-out

The message-creating task calls `reportStudentChatFanOut` after local broadcast
and Redis publication. Each receiving relay task reports its own local broadcast
result. `broadcastToStaffSessionLocal` and `broadcastToStaffContextLocal` count
local `ws.send` calls after staff authorization, subscription, context-revision,
observer, and open-socket checks. The counter does not wait for a client receipt.

For example, the writer may own no eligible staff socket, one relay task may own
one, and another relay task may own none. The three task reports are `0, 1, 0`:
the aggregate is M2/D1 despite one local socket write. The focused offline test in
`tests/classpilot-chat-delivery.test.ts` reproduces exactly that diagnostic shape.
It does not assert that this synthetic placement caused the production episode,
or that the write was received or rendered.

The previous helper comment incorrectly located any remaining gap on the client
once a socket write was counted. The comment now states the actual evidence
boundary. Runtime logging and counter behavior are unchanged.

## Why FAB misses and marks do not imply failed delivery

`src/services/classpilotControlStateDelivery.ts` records a pending hint when an
authorized exact-bound FAB frame cannot be written to a local student socket. It
then publishes the frozen frame to the other tasks and reports the local miss
along with the relay disposition. A worker or API task with no matching local
socket can therefore record a local miss while another task handles the socket.
The counts alone do not prove either the remote delivery or its failure.

An immediate local write clears an older pending hint; a heartbeat may consume
one later; an authoritative recovery request may build a snapshot independently.
`classpilotToolsEvents.ts` can also mark a hint without calling the local-miss
reporter, and the stale-heartbeat path can re-mark a consumed hint. Marks and
local-miss reports therefore are not a one-to-one population even without a fault.
The producing and consuming operations can fall in different task summaries or
query windows. They must not be treated as one arithmetic delivery ledger.

## Proposed next diagnostic decision

Before changing product behavior, add a separately reviewed, content-free
diagnostic path that preserves existing return values and bounds:

1. Record a fixed FAB operation enum (`mark` or `take`) with the bounded
   disposition and fixed reason enum already produced by the transport. Separate
   an accepted empty take from non-admission and an unknown outcome. Do not add
   command text, Redis keys, payloads, identifiers, or unbounded labels.
2. Record the local fallback result with fixed aggregate counters, so an
   unavailable shared take can be distinguished from a successful local recovery.
   Do not expose or log the underlying binding.
3. Test missing configuration, not-ready admission, accepted `null`, accepted
   string, timeout/abort after admission, late completion, and local hit/miss.
   Verify that diagnostics cannot throw, retry an operation, change a result, or
   change the existing time limits.
4. Use a bounded, separately authorized observation to decide whether any
   remaining warning represents a transport problem, expected task placement, or
   a recovery gap. Existing per-message operational logs require private handling;
   neither their identifiers nor their payloads belong in this document or metric
   dimensions.

No new ACK protocol, eligibility relaxation, identifier logging, retry, timeout
threshold, or delivery-behavior change is part of this investigation. In
particular, do not treat an unknown destructive take as permission to replay it.

The existing unit tests cover shared take-once behavior, local fallback,
expiration/eviction, clearing, safe diagnostic sinks, and content exclusion.
Those tests are useful local reproductions; they do not prove a production cause
or authorize a deployment. See `docs/CLASSPILOT_RELIABILITY.md` for the existing
bounded transport and content-free health contracts.

The two focused offline suites passed all 11 tests for this change with
`NODE_ENV=test`, the test-environment preload, and no environment-file argument:

```text
node --import ./tests/test-environment.mjs --import tsx --test --test-concurrency=1 tests/classpilot-chat-delivery.test.ts tests/classpilot-fab-sync-pending.test.ts
```

This is a focused unit result, not the full backend release gate or a production
reproduction. The combined backend change still requires the repository's
typecheck, build, and serial test gates.
