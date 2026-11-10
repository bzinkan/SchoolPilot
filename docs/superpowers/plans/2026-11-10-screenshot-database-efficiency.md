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
