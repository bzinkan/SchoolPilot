# Coordination and delivery warning review

This local investigation reviews the October 26, 2026 operational warnings. The
follow-up adds fixed aggregate diagnostics without changing delivery results,
time limits, authorization, retries, feature flags, or production configuration.
Private event identifiers, bindings, payloads, and evidence locations remain
outside this repository. Implementation does not establish deployment or explain
the historical warning's cause.

The serving application revision was
`fcffbe0b3aba950d3c6ea1383b71893d50c9e0b0`; the reviewed tooling baseline was
`ec147b3030c67d6735b3aa211db31d6e83cbaae7`. Their FAB pending, bounded Redis,
WebSocket broadcast, student-chat delivery, and relevant route implementations
are identical in those two historical revisions. There was no newer application
fix for these paths in that tooling baseline. The diagnostics follow-up described
below is a later change; a source comparison is not a production deployment.

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
The new diagnostics retain the same boolean while recording the local lookup
outcome separately.

The compatibility `realtimeRedisCommand` API in `src/realtime/ws-redis.ts` still
maps both non-admission and uncertain post-admission outcomes to `undefined`.
An absent Redis configuration also maps to `undefined`. The new
`realtimeRedisCommandOutcome` exposes the typed disposition from the same single
coordination call, so the FAB store can record it without repeating the command.
The underlying `BoundedRedisPublication` distinguishes:

- `not_admitted`: not ready, queue full, circuit open, shutdown, aborted, or not
  configured; the operation was not admitted;
- `unknown`: timeout, lost transport, shutdown, or abort after admission; Redis
  may already have executed the operation;
- `accepted`: an actual reply, including an authoritative `null` miss.

The historical FAB take counter did not retain an operation-specific disposition
or reason. A coincident general coordination warning cannot be assigned to those
four historical takes from these aggregates alone. The new fixed counters can
distinguish future outcomes after a separately authorized deployment. The existing
caller and transport bounds must not be increased to make a warning disappear.

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

## Implemented diagnostic contract

`classpilotFabSyncDiagnosticsContract.ts` defines 37 closed counter names. The
helper accepts only `mark` or `take` plus the existing bounded outcome taxonomy:

- Each operation records an accepted total, or a non-admitted/unknown total with
  one of its fixed reason counters. A caught exception has its own counter and
  makes no claim about transport phase or cause. Reason counters are subsets of
  their totals; they must not be added to those totals.
- An accepted take also records `StringHit`, `NullEmpty`, or `UnexpectedReply`.
  Every string, including an empty string, retains the previous shared-hit
  behavior. Accepted `null` is an ordinary empty reply. Accepted mark means a
  transport reply was received; only the unchanged legacy `fabSyncPendingMarked`
  counter means the reply was `OK`.
- A local fallback lookup records `Hit`, `Miss`, or `Expired`. Expired means the
  entry was present and expired at lookup; an entry previously pruned or evicted
  is a miss. An additional `fabSyncPendingTakeUnavailableLocal*` counter records
  the same outcome only when the shared result maps to legacy `undefined`; these
  are subsets of the ordinary local counters, not extra lookup attempts.
- The legacy undefined mapping is preserved, including an accepted unexpected
  `undefined` reply. Such a reply therefore records `UnexpectedReply` and the
  existing unavailable/local-unavailable path; accepted `0`, `false`, or another
  non-string value retains its previous fallback behavior without that legacy
  unavailable increment. Diagnostics do not stringify or log the reply.

Related total/reason and local/subset increments are recorded atomically in one
runtime interval. Unknown enum values and broken diagnostic sinks are ignored;
they cannot throw into delivery or create recursive logs. No command text, Redis
key, value, exception string, identifier, or unbounded label enters this contract.
The runtime summary remains zero-inclusive. The EMF limit is 100 metric
definitions **per log event across all directives**, not 100 per directive in
one event. With at most 100 active definitions, the existing canonical
`schoolpilot_runtime_performance_summary` still carries its inline EMF; an
all-zero summary has no EMF. Above 100, one canonical summary retains every
counter and timing but has no EMF. Separate
`schoolpilot_runtime_performance_metrics` records each carry at most 100 metric
definitions, the matching metric-root values, and the existing `Environment` and
`Service` dimensions, without `counters` or `timings`.

Those supplementary records are metric transport, not additional process
summaries or interval observations. The canonical interval commits before they
are emitted; a supplementary sink failure is best effort, with no retry,
recursive error log, or duplicate canonical summary. A complete canonical
summary therefore does not guarantee that every supplementary metric reached
CloudWatch.

The typed Redis wrapper uses the existing coordination publisher and 250 ms
budget once, forwards the same abort signal, and preserves observation-status
diagnostics. The compatibility wrapper still returns an accepted value unchanged
or `undefined`. The existing compatibility `readyTimeoutMs` argument does not
introduce a new readiness limit: the transport's existing readiness bound remains
in force. Local TTL, eviction, lookup/delete/expiry ordering, and return values
remain unchanged. A late completion is separate transport evidence and cannot
reclassify a returned take, trigger a retry, or prove recovery.

## Next diagnostic decision

Validation must cover missing configuration, each admission/unknown reason,
accepted `null` and strings, unexpected replies, exceptions, timeout/abort after
admission, late completion, and local hit/miss/expiry. It must prove one command
attempt, the existing time bounds, unchanged legacy results/counters, and that
diagnostic failures do not affect delivery.

After a separately authorized deployment and bounded observation, use the new
operation-specific counters to decide whether a remaining warning represents a
transport problem, expected task placement, or a recovery gap. Existing
per-message operational logs require private handling; neither their identifiers
nor their payloads belong in this document or metric dimensions. This follow-up
does not retroactively classify the four historical unavailable takes.

No new ACK protocol, eligibility relaxation, identifier logging, retry, timeout
threshold, or delivery-behavior change is part of this investigation. In
particular, do not treat an unknown destructive take as permission to replay it.

The existing unit tests cover shared take-once behavior, local fallback,
expiration/eviction, clearing, safe diagnostic sinks, and content exclusion.
Those tests are useful local reproductions; they do not prove a production cause
or authorize a deployment. See `docs/CLASSPILOT_RELIABILITY.md` for the existing
bounded transport and content-free health contracts.

The initial investigation's two focused offline suites passed all 11 tests with
`NODE_ENV=test`, the test-environment preload, and no environment-file argument:

```text
node --import ./tests/test-environment.mjs --import tsx --test --test-concurrency=1 tests/classpilot-chat-delivery.test.ts tests/classpilot-fab-sync-pending.test.ts
```

That is a historical focused unit result before the diagnostic implementation,
not its current gate result, the full backend release gate, or a production
reproduction. The diagnostic follow-up requires its focused contract/runtime
tests plus the repository's typecheck, build, and serial test gates.
