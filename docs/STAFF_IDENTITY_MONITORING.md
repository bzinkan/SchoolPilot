# Staff Identity Operational Monitoring

The singleton scheduler worker runs a read-only staff ownership integrity scan
at startup and every 60 minutes by default. The optional
`STAFF_IDENTITY_INTEGRITY_SCAN_INTERVAL_MINUTES` setting is bounded to 5–1440
minutes; missing or invalid values use the 60-minute default.

The job enumerates every non-deleted school through the scheduler's Super Admin
database context and calls the same school-scoped integrity inventory used by IT
Readiness and the repair CLI. Suspended or disabled schools stay in scope because
stale live rows there would still block the deferred database contract. The scan
also counts global normalized-email collision groups with the exact
`lower(btrim(email))` rule used by the migration. It runs schools sequentially,
takes the standard scheduler advisory lock, and also rejects overlap inside one
worker process. It does not run migrations, mutate assignments, or attempt
automatic repair.

CloudWatch and operational alerts contain aggregate counts only: schools in
scope, schools scanned, schools with findings, normalized-email collision
groups, scan failures, total findings, and the fixed integrity categories.
School, user, membership, class, request, email, and other resource identifiers
are never included. A nonzero inventory or email-collision count raises
`staff_identity_integrity` immediately; confirmed alert delivery applies the
normal six-hour fingerprint cooldown. An incomplete scan raises a generic
`scheduler_failure` signal without the failed school's identity.

Canonical lifecycle and database ownership guards also emit an identifier-free
`staff_lifecycle_guard_violation` signal. Three matching outcomes for the same
safe guard code within five minutes trigger an operational alert. Aggregation is
shared through the existing Redis monitor adapter across API tasks and degrades
to bounded local aggregation if Redis is unavailable.

When either alert fires:

1. Review **ClassPilot → Admin → IT Readiness → Class ownership integrity**.
2. Run the all-school dry-run inventory from the controlled environment if a
   complete ID-only recovery inventory is needed.
3. Resolve ownership through the guided staff transition or the reviewed repair
   command. Do not edit production assignments with direct SQL.
4. Rerun the inventory immediately and again the next day. Escalate any nonzero
   result or recurring guard alert before enabling the deferred identity
   database contracts.
