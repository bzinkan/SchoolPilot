# Screenshot traffic and database efficiency, second pass

The operator requested continued implementation toward 2,000 online students
under $300/month, preserving features and performance, with no paid AWS load
testing. Earlier authorization covers both repositories and implementation
without further design approvals. This extends the November 9 design.

## Constraints

Keep all genuine captures, JPEG bytes/quality, 30/5-second screenshot rates,
ten-second heartbeat opportunities, history and retention. Preserve canonical
entitlement, RLS, exact binding, privacy/final-publication checks and HTTP recovery.
Do not cache authority or alter immutable migration definitions. No production
deployment, subscription, Terraform apply or Store publication is automatic.
Use Node 22 for SchoolPilot, Node 24 for ClassPilot, existing Windows/local
PostgreSQL/Redis/Chrome, and bounded synthetic fixtures only.

## Selected work

1. Origin gzip for authorized teacher screenshot JSON, level 1, bounded work
   and identity fallback. It removes Base64 transport overhead without changing
   image bytes. Compression finishes before the existing final authority check;
   changed authority cannot reuse a prepared pixel response. No other API/token
   responses are compressed. Cache policy remains private/no-store.
2. Reuse only the final safety-free educational/unknown classifications that
   the current classifier would return from its existing valid cache. Keep
   unsafe-search and provider-input checks in their existing order, TTL/model/
   input-policy boundaries, fresh teacher intent for non-educational results,
   and asynchronous safety handling. Persist every heartbeat; avoid redundant
   classification UPDATE/cache-patch/fan-out work when INSERT already contains
   the exact final fields. RETURNING remains the proof for the fast path.
3. Prove whether the single-column student/email heartbeat indexes are redundant
   with their composite leading-prefix counterparts. Use catalog checks and
   representative local EXPLAIN queries before a guarded retirement migration.
   Do not remove exact-binding history indexes, change retention or drop rows.
4. Investigate bounded lossless deltas on real local Chrome JPEG captures. Any
   implementation requires measured byte and CPU benefit, exact reconstruction,
   scoped bases and full-frame fallback; changing pages/video may save nothing.
5. Prepare a separately negotiated binary full-screenshot upload if the above
   measurement supports it: raw JPEG bytes plus bounded metadata, decoded into
   the same canonical operation. Keep the 256 KiB logical frame bound, stable
   operation IDs, JSON/HTTP fallback and unsupported-client compatibility.
   Any new capability must remain off and have governed scoped activation.

## Alternatives and limits

Lower capture rates, lower image quality, dropped history, stale authorization
caches and unreviewed edge subscriptions are excluded. Teacher WebSocket reads
can reduce request work but save much less than image-byte reduction on PAYG.
New native screenshot authority SQL may later reduce four network round trips
to one while retaining fresh internal statements; immutable v1 cannot be reused
blindly because current manual-class expiry rules have evolved.

The current PAYG all-moving-image scenario cannot be made less than $300 by
database optimization alone. Keep zero-reuse and eight-hour cases, uncertain
compute/storage costs and unavailable Pro compatibility explicit. No local
correctness or compression test constitutes AWS fleet-capacity acceptance.
