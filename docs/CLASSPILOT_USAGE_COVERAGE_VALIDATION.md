# Usage coverage correction validation

Validated locally on September 30, 2026, from main `60f33dbcf93b6901ac038c2d0066f79fbd9632a4`. No production changes or historical backfill were performed.

The same four tests in `tests/classpilot-usage-coverage.test.ts` failed against a separate archive of that main commit and passed with the correction. The original reader inserted September 14 as a zero between September 13 and 15; the original refresh cursor skipped the only new heartbeat at 14:10 when the previous 14:00 snapshot was computed at 14:20. The remaining cases verify successful empty-day metadata and withholding pre-ledger aggregates.

| Check | Result |
|---|---|
| Plain `npm run check` and `npm run build` | Passed with real local dependencies |
| Focused coverage, SQL, registry, admission and migration-ledger tests | 77 passed |
| `tests/classpilot-usage-rollup.test.ts` on the private synthetic Docker DB | 15 passed |
| `tests/classpilot-usage-rollup-rls.test.ts` with a disposable non-superuser, non-bypass role | 6 passed |
| Governed product setter mock suite | 327 assertions passed |
| Terraform `tests\mydesk.tftest.hcl` with mock AWS provider | 19 passed |
| Student Data adapter/CSV suite | 13 passed |
| Frontend lint and build | Passed; lint reported 32 warnings in unchanged components |
| Test type and unsafe-cast ratchets | Passed |

Database tests use `schoolpilot_redesign_usage_20260930` on the local Docker database, with generated fixture credentials kept in process environment and roles removed afterward. Current schema plus additive migrations and the complete 127-table RLS policies were installed before the restricted-role run. The new checks cover concurrent cutoff ordering, empty 23/25-hour DST days, completion-write failure rolling back totals and metadata together, stale final-day protection, retention of empty-day metadata, direct INSERT/UPDATE/DELETE invalidation, retained-data coverage across student/class/session FK actions, and school isolation of the ledger and report.

The runtime setter tests prove aggregate admission alone is insufficient, both API and worker require the ledger admission, and an incompatible serving source SHA fails at Plan and Apply before mutation. Turning both usage flags off remains possible. Historical RLS inventories and `infra/production.tfvars` remain unchanged.

Reproduction commands from the repository root:

```powershell
node --import tsx --test tests/classpilot-usage-coverage.test.ts tests/classpilot-usage-rollup-sql.test.ts tests/rls-registry-consistency.test.ts tests/deploy-rls-table-enablement.test.ts tests/migration-ledger.test.ts
pwsh -NoProfile -File scripts/run-local-workspace-tests.ps1 -Database schoolpilot_redesign_usage_20260930 -TestFiles tests/classpilot-usage-rollup.test.ts
pwsh -NoProfile -File scripts/run-local-workspace-tests.ps1 -Database schoolpilot_redesign_usage_20260930 -TestFiles tests/classpilot-usage-rollup-rls.test.ts -Restricted
pwsh -NoProfile -File tests/product-runtime-config-deploy.test.ps1
terraform -chdir=infra test '-filter=tests\mydesk.tftest.hcl'
node --test schoolpilot-app/scripts/classpilot-student-data.test.mjs
```

This is focused local evidence, not a claim that full CI or production-sized load gates passed. A synthetic million-heartbeat workload, full required CI, and any production activation remain separate gates. Older invalidated dates remain unavailable when they cannot be safely recomputed inside retention.
