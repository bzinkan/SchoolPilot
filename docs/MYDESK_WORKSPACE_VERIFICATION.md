# My Desk workspace expansion: local verification

Implementation branch: `codex/my-desk-workspace-expansion`, based on
`a2c1b7b065c4633e387d5833d339d0aecf214c78`. These are local verification results,
not a GitHub CI result or evidence of production activation.

## Review scope

1. Personal workspace: assigned/co-teacher class navigation, grade filing
   preferences, zero-note student directory, private historical logs, and
   explicitly selected saved-attachment imports with independent temporary
   copies and orientation handling.
2. Seating: version-2 measured room geometry, fixtures and wall openings,
   accessible numeric editing, obstacle-aware desk arrangements, explicit
   conversion of existing charts, and complete saved-layout printing.
3. Submitted discipline records: independent school-owned evidence, explicit
   submission, immutable corrections/withdrawals, and audited administrator
   viewing grants. Private notebooks retain author-only access.

## Completed checks

| Check | Result |
| --- | --- |
| Backend and frontend production builds | Passed |
| Frontend lint and router/API routing checks | Passed; router reachability 15/15 |
| Backend unit lane | 1,052 passed; four environment-dependent skips |
| Ordinary database regression lane | 1,073 passed; six skips; no failures |
| Restricted RLS lane on fresh CI-equivalent schema | 114 forced tenant tables; 185 passed initially, two fixture omissions corrected and passed on focused rerun, one Redis-dependent skip |
| Latest discipline HTTP integration tests | 12/12 ordinary and 12/12 restricted, including concurrent revocation and membership changes without a tenant GUC |
| Notebook browser suite | 26/26 before final focused additions |
| Final personal-workspace and discipline browser checks | 13/13, including nine discipline cases |
| Import browser tests | 12/12 |
| Seating model/browser tests | 22/22; measured room interaction and Letter/A4 output included |
| Dashboard regressions | 33/33 isolation, 66/66 load-state, 3/3 multi-role |
| Test TypeScript ratchet | Passed with 439 existing test-only diagnostics against the 534 baseline; no application/syntax errors |
| Unsafe test cast ratchet | Passed without increasing the baseline |
| Migration/admission/registry/SOC 2 focused checks | Passed |
| Infrastructure lane | 582/584 passed initially; both timing failures passed unchanged in focused reruns |
| SOC 2 governance check | Passed with existing human-approval/evidence caveats |
| Patch whitespace check | Passed |

The infrastructure lane's two initial failures were the local loopback screenshot
p95 gate and primary-delivery login timeout while other broad checks were also
running. Both passed focused reruns with the original thresholds after the other
test load cleared. The entire lane was not rerun after that focused closure.

Automated integration tests use synthetic data and local isolated databases.
The restricted lane was bootstrapped from an empty database using the CI schema
and RLS setup, including the canonical primary-teacher assignment constraints.

## Release work still required

- Review and run remote CI against the actual release commit. No commit, push,
  merge, deployment, or production mutation was performed for this expansion.
- Follow [the production release runbook](MYDESK_PRODUCTION_RELEASE.md) for the
  additive migrations and reviewed five-table RLS admission before the matching
  frontend. Original notebook/seating/import checksums and the verified live
  Terraform baseline remain unchanged.
- Begin with no school-wide discipline viewing grants. Verify synthetic
  author/viewer accounts, independent evidence and actual object cleanup in the
  authorized production walkthrough.
- Complete physical Android interaction and live Letter/A4 print acceptance.
  Desktop browser emulation and generated PDFs do not establish physical-device
  acceptance.
- Keep AI imports off until provider-retention review, synthetic extraction
  quality and isolated production-image capacity checks cover the configured
  model and `mydesk-forms-20260926-v2` prompt. No real provider extraction or
  student-paperwork transmission was performed during local verification.

See [the teacher guide](MYDESK_TEACHER_GUIDE.md) and
[discipline-record operations](SCHOOL_DISCIPLINE_RECORDS.md) for the user workflow,
ownership boundary, corrections and retention.
