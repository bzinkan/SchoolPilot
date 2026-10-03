# Usage contention correction evidence

These records preserve development checks and failures before the final source
freeze. They do not establish capacity acceptance or authorize deployment.

The first frozen correction checkpoint is
`cb66014d70a275405a5469257b37debe8d20ea18`. Its new records below preserve exact
source identities; later harness/documentation corrections require their own
source binding and do not turn a failed launch into measured capacity.

- [Frozen unit suite](unit-cb66014d.json): 1,705 passed, zero failed and four
  explicitly listed integration-dependent skips. Skips are not passing tests.
- [Exact local API/worker candidate](candidate-artifact-cb66014d/index.json):
  build, exported image hash, pinned Trivy scan and embedded writer/bridge/relay
  and 129-table registry checks. The large image archive remains outside Git;
  registry publication, production task bindings and capacity are separate.
- [Local upgrade and rollback re-entry](rehearsal-cb66014d/index.json): the
  synthetic baseline expands from 44 to 53 migration IDs and retains 129 tenant
  tables through repeats and compatible rollback re-entry. Baseline legacy
  bootstrap had **already applied the staff-identity contract**; the step named
  contract adoption was idempotent re-entry, not an unadopted-to-adopted test.
  This reconstructed empty schema does not establish the actual production
  catalog, a populated RLS test or a production restore.
- [Combined load launch 01](load-launch-01-cb66014d.json): retained launcher
  failure from two Docker executable matches. It failed before fixture creation
  or capacity measurement; a corrected harness needs a fresh recorded attempt.
- [Combined capacity attempt 02](load-combined-02/manifest.json): real workload
  at `9f1580615d72f6b0647abac27677773b03a88269` failed. Only 1,355 of 6,000
  heartbeat offers succeeded; 3,345 started requests failed and 1,300 offers were
  refused at the in-flight ceiling. Reports passed 17/64. Workers finished in
  15,540.9899/15,723.4094 ms with correct independent totals, but these successes
  do not override failed traffic and lifecycle acceptance. Full sanitized logs,
  metrics, schema and resource metadata are retained; the populated fixture
  identity snapshot is hash-only. Owned processes/containers drained and shared
  local database/Redis containers remained healthy. A worker instrumentation
  defect means its zero acquisition counts are **not** evidence of zero worker
  acquisition failures. Post-run review also found that pre-measurement drain
  permanently shut down the classification batcher, disabling normal batching
  during the measured workload. The failures are real observations of that
  altered configuration, not a representative measurement of normal batching
  or proof of a product-only bottleneck. Both harness defects require correction
  and a fresh run; original logs, metrics and hash records remain unchanged.

- [Batching preflight correction](batching-preflight-fix/manifest.json) preserves
  two failing-before regressions, all 60 passing focused checks with no skips,
  the successful type check, and exact dirty-source byte hashes. The full suite
  includes the CPU-profile and worker-proxy guards. Preflight now drains pending
  work without putting the batcher into permanent shutdown; actual shutdown
  retains its terminal flush. These checks repair the test workload and do not
  establish capacity acceptance. Red/type records explicitly identify their
  structured tool-transcript provenance; the complete green log is retained.
- [Report admission and cancellation](reports-manifest.json) indexes ordinary
  and restricted-role PostgreSQL tests, strict audit failure, queued revocation,
  cookie-session invalidation and focused unit checks. The initial failed native
  attempt is retained alongside its corrections.
- [Heartbeat and ownership diagnostics](heartbeat-manifest.json) retains focused
  tests, the original teardown failure and corrected cleanup. Native heartbeat
  results here used an owner role; they are not restricted-role proof.
- [Interface and unit checkpoints](ui-and-unit-incremental.json) retains the
  manual-retry/CSV overload checks, frontend build/lint and an earlier unit run.
  Each entry records which later source changes it does not certify.
- [Review-container observation](pr-review-checkpoint.json) records exact remote
  #603/#123 heads and all reported check entries. The earlier green SchoolPilot
  head does not certify the uncommitted contention corrections; ClassPilot's
  successful run and cancelled sibling-run entries remain separately visible.
- [Local rollback artifact](rollback-artifact/index.json) binds the preserved
  external image archive, source, scan and synthetic compatibility proof. Both
  Usage modes must remain off on that pre-correction source. No registry upload
  or production task-definition binding is implied.
- [Extension reverification](extension-reverification.json) verifies unchanged
  source and exact 2.9.7 ZIP without rebuilding or claiming a fresh browser run.
- [Ingress deadline follow-up](reports-ingress-manifest.json) retains the real
  session-store deadline checks and their failed fixture attempt.
- [Combined unit attempt](unit-attempt-01.json) retains the outdated limiter-order
  assertion failure and identifies the required full rerun.
- [Production schema access](production-schema-read-feasibility.json) records
  the observed private database access boundary. A local reconstructed baseline
  is not an actual production catalog export; that verification requires the
  separately authorized inspection task or an approved operator export.

- [Tenant metadata reuse](reports-metadata-manifest.json) verifies that reusing
  immutable ORM setup preserves fresh school authority, GUC cleanup, RLS and
  transaction boundaries on the same physical client. Owner and restricted-role
  native cases pass; the original CI lock-observer failure remains archived.
- [Private-chat and SSO lock order](sso-private-lock/manifest.json) preserves
  actual PostgreSQL `40P01` failures before the correction in both database roles,
  followed by successful native races and 48 focused checks. The WebSocket
  bootstrap now takes its existing SSO fence before private settings locks;
  ordinary heartbeat query counts are unchanged.
- [Combined unit suite after these corrections](unit-metadata-sso.json) records
  1,710 passing cases, no failures and four conditional skips. Its 1,139 source
  file hashes were captured before the run and verified unchanged afterward.
  This does not replace full CI, database lanes or frozen capacity acceptance.

Manifest entries contain raw and sanitized log hashes. Gzip logs retain complete
sanitized output; transcript-only attempts are explicitly identified where no
separate raw log was saved. No production database contents or credentials are
included. The earlier cold-load failures remain in their original records one
directory above and are not replaced by these focused tests.

Release acceptance additionally requires three consecutive successful combined
release-enabled capacity runs on unchanged application source/schema, the
retained comparison profile, final combined CI, local artifacts and migration/
recovery evidence. Deployed observation and live classroom validation are later
operational gates. Managed-Chromebook testing remains waived, not passed.
