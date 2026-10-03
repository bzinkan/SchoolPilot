# Synthetic b112 snapshot restore proof

Attempt 01 failed full schema text equality after native CHECK-expression rendering changed parentheses. Attempt 02 passed native-rendered schema equality but failed an incorrect RLS fixture assertion on the globally readable schools table. Both failures remain intact. Attempt 03 passed the exact schema, ledger, restricted-role data/control/identity/clock checks, standard ANALYZE, zero-other-client check, and a 16-minute expiry horizon. Its actual-image EXPLAIN handoff completed and the owned PostgreSQL container was removed.

The immutable snapshot was not rewritten. This separate proof establishes a tested restoration path; it does not establish capacity or actual production-schema compatibility. Private dump, role verifiers, credentials and populated fixture contents are hash-only. Accepted capacity run count remains zero.
