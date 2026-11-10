# Screenshot/database efficiency implementation plan

> For agentic workers: use executing-plans with bounded delegated ownership,
> test-first changes and a fresh final review. The operator opted out of further
> design approvals and asked to keep implementing.

**Goal:** Reduce screenshot bytes and database work without changing observable
features, history, quality, cadence or security; preserve honest budget bounds.
**Architecture:** Selective lossless response encoding; existing safe classifier
cache reuse at INSERT; catalog-verified index maintenance; measured optional
binary/delta transport through the canonical telemetry contract.
**Stack:** Existing Express/TypeScript/pg/Redis/ws and Chrome MV3 JavaScript.
**Spec:** ../specs/2026-11-10-screenshot-database-efficiency-design.md

## Global constraints

The spec's constraints apply to every task. Keep current source isolation and
user edits. One owner per shared file/range; database tests run serially in an
owned empty database on the existing local service. Never rebuild dist during
tests that import it. Do not repeat the broad Node 24 backend run.

## Review focus

- Authority changes while gzip is pending: prepared pixels cannot leak.
- Unsupported encodings, saturation or compressor errors: bounded compatible
  recovery; no delayed teacher controls or authentication-response compression.
- Unsafe searches, credential-bearing URLs, expired/model-changed cached results:
  preserve classifier ordering and safety/teacher-intent effects.
- Retired indexes: representative history/equality/retention plans remain sound;
  unexpected catalog definitions must stop migration rather than drop by name.
- Binary/delta malformed sizes, stale bases and lost receipts: bounded decode,
  exact bytes, current scope, stable IDs and full/HTTP fallback.

## Tasks and interfaces

1. Screenshot response encoder (delegate screenshot owner): new bounded encoder
   module + tests; wire only the tile screenshot response range in devices.ts.
   RED negotiation/saturation/round-trip/stale-authority tests, then implement
   gzip level 1 before final revalidation; verify native HTTP headers/body.
2. Safe classification fast path (delegate DB owner): aiClassification.ts helper
   + focused tests. Initially do not edit devices.ts. Return exact exported helper
   interface and eligibility predicates; root integrates the heartbeat call after
   screenshot ownership ends. RED cache/TTL/model/input/safety tests, then GREEN
   existing classifier and historical-delivery tests.
3. Index proof (root): catalog and bounded query-plan fixture in private validation
   metadata; compare equality/history and purge access with/without only the two
   candidate indexes. Implement guarded immutable migration/schema/bootstrap
   convergence only when proof supports retirement; add meaningful native checks.
4. Delta spike (delegate measurement owner): real local Chrome captures of static,
   typing, scrolling and moving content; exact reconstruction and bounded CPU/byte
   comparisons. No product behavior changes or savings credit without evidence.
5. Binary/delta follow-on: write an exact interface/activation addendum from the
   measurement before implementation. Keep new capabilities off. RED malformed,
   scope, recovery and real-Chrome cases; preserve existing packaged client gates.
6. Verify/review: Node 22 backend check/build/test types/cast + relevant unit/native
   DB/Redis checks; frontend lint/build/relevant gates; Node 24 extension check/
   tests/Chrome/build if changed. Independent review, regression fixes, diff check,
   and updated economic model with separate ingress/cache/egress ratios.

## Progress ledger

- Starting checkpoints: SchoolPilot 35b4c3cb and ClassPilot 659838f. Current main
  reviewed and integrated as ed32fc78; only conflict was the already-fixed manual
  screenshot fixture, resolved to upstream's stronger dedicated manual probe.
- User's no-paid-AWS-load-testing constraint remains in force. No new services,
  infrastructure applies, subscriptions or publication.
- Reconnaissance found uncompressed origin screenshot JSON, redundant candidate
  prefix indexes, and avoidable cached-classification post-insert updates.
- Initial entropy-only gzip probe saved ~25.5%; this is not an observed school
  workload. Real Chrome delta measurements and production cost acceptance remain
  outstanding.
- Task 1 complete: 5eb01ed0/0ff8e484, 16 native HTTP/actual-route tests pass; gzip
  completes before final authority checks, with bounded identity fallback.
- Task 2 helper df4310b4 and route integration complete: 79 classifier cases and
  37 route/history cases pass. Invalid title shapes keep the prior educational-
  only path; completed unknown results use INSERT RETURNING proof.
- Index proof: existing-service temporary 80,000-row fixture copied actual index
  definitions, then removed only the two candidates. Current history/report/
  retention query paths retained valid access; 1,466,368 index bytes were avoided
  in this synthetic fixture. Broad unbounded COUNT (not a current history API)
  was slower, so do not claim every hypothetical query improves. Table vanished
  when its one connection closed; no user rows or permanent schema changed.
- Task 4 measured: 15 genuine Chrome captures/20 comparisons, exact Node/Chrome
  reconstruction. Typing/caret/banner-text patches save 83–99%; scroll/noise
  fall back. See the design's exact delta interface. Binary-full uploads are
  deferred in favor of this larger measured opportunity.
- Task 5 interfaces: canonical src/services/screenshotDeltaCodec.ts -> generated
  frontend lib/screenshotDeltaCodec.js and ClassPilot extension/screenshot-delta-
  codec.js. encodeScreenshotDelta(base,target,options?) returns delta bytes or a
  full-fallback reason; applyScreenshotDelta(base,patch) returns exact raw bytes
  or rejects. New scopedScreenshotDeltasV1 stays off. Root owns frontend/client/
  capability tooling; screenshot owner owns scoped cache/server integration;
  codec owner owns canonical/generator/parity files; DB owner owns index retirement.
- Task 5 implemented: canonical/generated codec parity, exact-scope CP upload
  bases/integrity/full recovery, atomic server materialization and one-patch
  storage, teacher query-cache decode/digest/full recovery. Deltas remain off;
  Schema 13 has parent/source-scope gates and independent review. Completed
  frontend/Schema 13 and server/client reviews found no important remaining issue.
- Task 3 implemented in fb6ea3a3: strict catalog-verified fixed concurrent drops
  and immutable ledger migration. Review found and fixed nontransactional
  cleanup-session reuse; failed apply destroys the session and preserves its
  original error. Independent review and 77 focused checks passed. Root native
  proof passed 13 checks on an owned empty database; cleanup completed.
- Root verification at fb6ea3a3: Node 22 backend check/build, unchanged test-type
  and cast ratchets; 85 focused screenshot/classifier/Redis checks, 94 database
  unit/contracts and 87 fresh-database transport/publication/history checks
  passed with zero skips. Both owned local databases were removed. Frontend
  lint/build and tile/realtime/signal/command gates passed. Runtime 1,446 plus
  registry/32+45 checks passed and now run in the existing CI job.
- Economics separate exact reuse, changed-image eligibility, teacher base hits,
  origin gzip and actual cache work. Lost WS receipts add retransmit bytes and
  conservative full recovery; other misses and database growth remain unknown.
  PAYG six/eight-hour zero-reuse cases remain over target. Favorable scenarios
  are not fleet acceptance. No paid AWS tests/resources or production changes.
- Final browser checks passed: native teacher decoder reconstructed all 30
  genuine-capture tiles exactly over 25 iterations (warm p95 27.5 ms), frontend
  session lifecycle 5/5 and Radix browser regression passed. Extension source
  full Chrome rerun exited zero, including 20/20 immutable expected-red cases.
  The initial ACK diagnostics capture flaked once without a production ACK
  change; four isolated reruns and the full rerun passed.
- Final extension checkpoint 77c88465e337b5fb922658f714ba76674365b943 passed
  check, 209 unit tests, build, 48 focused source/packaged checks, real packaged
  capture/ref/delta/full/HTTP recovery, Windows 13 tests and both browser package
  inventories/native worker parity. The last UUID-bound reservation patch was
  covered by the focused/packaged paths after the broad source-browser gate.
  Candidate ZIP has 30 exact files and SHA-256
  84bc7740d0a5747e37e6915ac510165e31d5efaecf77f7dd3eeb4c80549fc7b2.
  It was not uploaded; live Store identity, pending submissions and managed-device
  adoption remain unverified. No new capability was enabled or AWS fleet accepted.
