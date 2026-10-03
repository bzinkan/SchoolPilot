# Historical release-preparation checkpoints

These dated development checkpoints were moved verbatim from the operator
checklist after the b112 combined CI and recovery results were recorded. Their
statements about current source, pending checks and failed runs describe those
earlier checkpoints. They do not replace the
[current operator checklist](RELEASE_2_9_7_OPERATOR_CHECKLIST.md). All original
evidence records and failed attempts remain intact.

Historical block SHA-256: `601c90c8017d962d879e73dd10765bec976e39794e091da43b5669424ba5f90b`.

Application `0e427e3ca9b82125e0bb8692176accad21f4f699` remains historical.
Its [Focus wire correction](release-evidence/release-297/usage-contention/focus-status-wire-297-01/manifest.json)
accepts the exact 2.9.7 package's `focusStatus` on heartbeat and WebSocket ACKs,
and compares validated status fields without depending on JSONB key order.
The regression failed before correction; 64 focused cases, 15 restricted-role
database cases and build/type/cast checks now pass. The
[strengthened synthetic lifecycle](release-evidence/release-297/usage-contention/focus-lifecycle-harness-01/manifest.json)
verifies exact public Focus state before accepting command completion; all 61
load-profile guards pass. Extension bytes are unchanged. The [fallback source
backport](release-evidence/release-297/usage-contention/rollback-focus-wire-01/manifest.json)
at `6e251f2d1eece2b98fa2325e1fa46bd2b8553420` passes 61 focused and 13
restricted-role cases plus build/type/cast and compatibility-floor checks.
Its [fresh local fallback image](release-evidence/release-297/usage-contention/rollback-artifact-6e251f2d/manifest.json)
now passes the uncached build, pinned vulnerability scan (zero findings),
embedded Focus/compatibility checks and cleanup. Both Usage modes must remain
off with this fallback; pairing it with the final candidate still needs rehearsal.
The fresh [unprofiled ingestion diagnostic](release-evidence/release-297/usage-contention/linux-role-ingest-unprofiled-0e427-01/manifest.json) fails at 5,139/6,000 successful
heartbeats, with 144 failures, 717 in-flight refusals and zero late offers.
API CPU remains saturated; all owners drained and all test containers were
removed. [Combined CI on `5d031512`](release-evidence/release-297/usage-contention/ci-5d031512-final-01/manifest.json)
passes all 17 CI jobs and three security workflows for `0e427e3c`. Accepted
combined capacity, the final candidate image and recovery pairing remain
pending; later application changes and merged main need their own checks.

The [resource-bounded combined diagnostic at `9630c009`](release-evidence/release-297/usage-contention/linux-role-combined-9630-01/manifest.json)
completed 2,704/6,000 heartbeats and 34/64 reports; the second complete historical
rollup took 57.768 seconds including admission wait, above the 48-second gate.
Historical and current-day totals, coverage and eight audited CSV checks passed.
All owned containers were removed, but a coordinator exit-receipt race left its
exit status unavailable; that run does not prove clean coordinator shutdown.
API CPU throttling, database write waits and pre-admission authentication failures
require further correction. They do not establish a connection leak. Its raw
pool counters also double-observe Promise checkout calls; the HTTP failures are
independent and remain failures.

[CI at `9630c009`](release-evidence/release-297/usage-contention/ci-9630c009-final-01/manifest.json)
passes all 17 jobs and three security workflows. The subsequent
[single-checkout instrumentation correction](release-evidence/release-297/usage-contention/fair-main-pool-public-connect-followup-01/manifest.json)
at `5d543f40` passes 54 focused cases, eight native cases, the application test
under both database roles and 1,864 unit cases (four conditional skips).
Its [local image](release-evidence/release-297/usage-contention/candidate-artifact-5d543f40/manifest.json)
passes the full pinned scan with zero findings and embedded compatibility checks.
Linux/amd64 manifest:
`sha256:b163e683f50d2303b1b8aff8d96dbbce6e5d20c3dab715357da67af7a5528d38`;
archive SHA-256:
`9adb8d976bae3c513ebaced258b9b4dc68f1cc338a6ecd73682666c81766efae`.
The permanent packet is
`C:/Users/zinka/.codex/artifacts/release297-candidate-5d543f40-01`.
These local artifacts are not pushed or deployed. The subsequent
[identity scheduling correction](release-evidence/release-297/usage-contention/fair-main-pool-user-identity-01/manifest.json)
at `6035239b` gives fresh credential-backed user lookups a separate fair turn,
alongside ordinary work and admitted reports, in the same pool. Identity is
rechecked after waiting; heartbeat entitlement retains its ordinary lane.
All 66 focused cases, native owner/restricted cases, build/type/cast checks and
1,868 unit cases pass (four conditional skips).
[CI on `2378e04e`](release-evidence/release-297/usage-contention/ci-2378e04e-final-01/manifest.json)
passes all 17 CI jobs and the three security workflows for those application
bytes. Actual-workload capacity, final images and recovery rehearsal remain
pending. The following development checkpoints retain their original
source-specific results; they do not supersede this current status.

## Historical development checkpoints

The following paragraphs retain the status at each named source checkpoint.
Use the current selection table below for release preparation; historical
images and passing checks do not select the final release source.

The [initial API connection scheduler correction](release-evidence/release-297/usage-contention/fair-main-pool-scheduler-01/manifest.json)
adds alternating FIFO admission for report and other main-pool requests when
Usage reporting is enabled. Default-off API, worker and session pools keep
native scheduling. The existing configured connection limits and deadlines
remain unchanged. Build/type/cast checks, 38 focused tests, eight native driver
cases and the actual application regression under owner and restricted roles
pass. Cancellation retains ownership until cleanup finishes. Native logical
pool limits are preserved; closing sockets are tracked through shutdown without
claiming a stricter physical-socket ceiling. At that checkpoint, combined
capacity and final-source checks were pending. The historical `9630c009` image
below includes this initial scheduler; it predates the later identity lane.

The [historical local `9630c009` candidate](release-evidence/release-297/usage-contention/candidate-artifact-9630c009/manifest.json) has passed the pinned full image scan with
zero findings and the embedded 129-table/lifecycle/default-off checks. Its
Linux/amd64 manifest is
`sha256:c3759c8b69acb47feb5dc1dc5416b77f9d5e1a2eccb76bbf1646c96d966a67c5`;
archive SHA-256 is
`0c87d73aae62c026bb7a7fb05259fec5325d3865b682e14d0241c3a2884c53f3`.
The local artifact packet is
`C:/Users/zinka/.codex/artifacts/release297-candidate-9630c009-01`, with manifest
`1afd8c43cb29934e9cd4bc05925e3e466f8c3cf56b981b2525fa81339e79299e`.
It has not been pushed to a registry or deployed. The separately archived
[per-role harness startup](release-evidence/release-297/usage-contention/linux-role-startup-01/manifest.json)
proves resource limits, pool readiness and clean shutdown on earlier source
`204ae93d` with zero traffic. It does not establish capacity for either source.

The [final `9fc4b0e` CI record](release-evidence/release-297/usage-contention/ci-9fc4b0e-final-01/manifest.json)
contains 16 successful jobs and one cancelled rollout-safety job, plus three
successful security workflows. The new source push superseded that run; it is
not a fully green checkpoint. The later `9630c009` CI result is recorded above.

The earlier [combined diagnostic at `204ae93d`](release-evidence/release-297/usage-contention/linux-combined-204-01/manifest.json)
fails acceptance: 4,840/6,000 heartbeats and 51/64 reports succeeded; 974
heartbeats failed, 186 offers were refused and 140 were late. Both historical
workers produced correct totals in 19.107/42.142 seconds, but 978 acquisition
failures and 10 aborted responses prevent acceptance. Current-day and CSV
correctness checks were not reached. Physical ownership returned to zero and
all owned fixtures were removed. The final unchanged-source check was not
reached; the record leaves that field unavailable. This shared-container Linux
diagnostic does not reproduce production CPU and memory limits per role.

The exact local `204ae93d` candidate built and passed the pinned full scan with
zero findings. Its Linux/amd64 manifest is
`sha256:7d20930a7105d0e805eb7c221a81973998a02930de8185684b1b5acf083b4b9b`;
the exported archive SHA-256 is
`d7fcd3d8b7b55d2719262f92231153ae46ff81e0d5b653d16a5b7f8acbc02b8a`.
Embedded 129-table/lifecycle compatibility checks and default-off Usage pass.
The permanent local artifact manifest is
`1428153e1985b0fee87b5142efea9b4f28ccfdbd6f7a4afd3bad05064d498a57`.
This image is retained for local validation; its build and scan do not override
the failed capacity result or establish registry/deployment identities.

The later [204ae93d CI checkpoint](release-evidence/release-297/usage-contention/ci-204ae93d.json)
passes security workflows and 16 CI jobs but fails the rollout-safety startup-probe
test: the monitor records a generic exception instead of the expected fatal
reason. Root cause and a verified correction remain pending.
The [test-only diagnostic follow-up](release-evidence/release-297/usage-contention/rollout-failure-diagnostics/manifest.json)
preserves bounded, redacted mock failure output before cleanup and uploads it in
CI. Five evidence assertions and 169 targeted rollout assertions pass locally;
the original exception did not reproduce. The full CI suite remains unchanged
and must pass on the new head. Production monitor behavior is unchanged.

The [next CI/checkpoint record](release-evidence/release-297/usage-contention/test-lane-listing-flush/manifest.json)
retains `35712eb`'s 15 successful CI jobs, two failures and three successful
security workflows. The infrastructure failure is reproduced and corrected:
lane listing now waits for piped stdout to flush before exiting. Local checks
pass 1,825 unit cases (four existing skips) and 699 infrastructure cases on
unchanged source. The other failure identifies a test generator that was no
longer live at binding validation; its exact underlying cause is not established.
The [fixture lifetime correction](release-evidence/release-297/usage-contention/rollout-live-harness-lifetime/manifest.json)
passes the full 380-assertion rollout suite, 15 lifecycle assertions and five
failure-evidence assertions. Mock generators now publish actual readiness and
remain owned until atomic release or verified rollback containment. Production
monitoring and rollback behavior are unchanged. Fresh complete CI remains
required; neither historical exception is relabeled as a known resolved cause.

The subsequent [Linux ingestion CPU diagnostic](release-evidence/release-297/usage-contention/linux-ingest-cpu-01/manifest.json)
fails with 5,832 successful offers and 168 refused offers out of 6,000, despite
zero request/acquisition failures and clean drain/cleanup. It omits concurrent
reports and rollups, so it cannot count as combined capacity. Its [clipped CPU
analysis](release-evidence/release-297/usage-contention/linux-ingest-cpu-analysis/manifest.json)
guides further measurement; no deployment recommendation follows from it.

A later [ingestion-only SQL-shape diagnostic](release-evidence/release-297/usage-contention/linux-ingest-sql-shape-01/manifest.json) delivered all 6,000 heartbeats with
no refused, failed or late offers and no acquisition failures. The source was
still the historical `d6492333`, and reports and rollups were absent. It improves
attribution without establishing combined capacity or a deployment green light.

The preceding [owned inbox correction](release-evidence/release-297/usage-contention/heartbeat-owned-inbox/manifest.json)
reuses the final heartbeat tenant connection without removing the locked inbox
eligibility check. Expiry uses the database's current clock after foreground
delivery; process-local suppression updates only after commit and connection
cleanup. Forty-eight focused cases and 19 native cases under each database role
pass, including durable claim rollback and preservation of required preparation
writes. The load gate requires zero optional inbox failures. This reduces an
equivalent recovery from 33 to 27 SQL statements and two connections to one;
it is not capacity acceptance. The new combined load run remains required.

The subsequent [inbox owner projection](release-evidence/release-297/usage-contention/inbox-projection/manifest.json)
reduces authority discovery from five queries to two, retaining its fresh row
lock, database-clock checks, canonical ownership ranking and all delivery fences.
Twenty-seven focused and 21 owner plus 21 restricted-role native cases pass.
The full build, type/cast checks and 1,824 unit cases pass on unchanged source;
four conditional skips remain explicit. The full equivalent recovery now uses
24 statements and one lease. Measured capacity and new-head CI remain required.

[Combined checks11](release-evidence/release-297/usage-contention/combined-checks-attempt-11/manifest.json)
pass the build and 699 infrastructure cases; four unit VM-context failures are
retained. The [test-only follow-up12](release-evidence/release-297/usage-contention/combined-checks-attempt-12/manifest.json)
passes types/casts and 1,823 unit cases, with four named conditional skips.
The comparison proves the two changed tests do not alter the application or any
of the 60 infrastructure-selected files and their selector. Final-source capacity
and fresh remote CI remain required.

<!-- End of the verbatim historical block. -->
