# SchoolPilot competitive roadmap

Status: canonical forward roadmap, adopted 2026-09-29. It does not supersede `CLASSPILOT_ROADMAP_IMPLEMENTATION.md`, which remains the September 6, 2026 release and evidence record.

October 2 release stabilization: the owner approved one coordinated SchoolPilot
integration release and separate ClassPilot **2.9.7**, preserving individual
review branches. The current [operator checklist](RELEASE_2_9_7_OPERATOR_CHECKLIST.md)
and [PR inventory](RELEASE_2_9_7_PR_INVENTORY.md) supersede the earlier candidate
version, independent stack-merging order and two-Chromebook prerequisite. Managed
validation is `waived_not_passed`; actual sample-bearing live acceptance is still
required before global promotion. No implementation or test status here implies
deployment or activation. The owner's subsequent decision requires all Usage
development and synthetic capacity acceptance before requesting coordinated
release execution. Usage's deployed observation remains a later activation
gate. SFU implementation and legacy media changes remain excluded.

Latest October 3 application `e95a2b56476b1225434c1b0f3907db46c9d84fe3`
normalizes exact repeated URLs once per student's rollup. Its [local checks](release-evidence/release-297/usage-contention/domain-map-implementation-e95a2b56/manifest.json)
pass 1,906 unit tests, 25 owner and 12 restricted database tests without skips,
and build/type/cast checks. All nine semantic grain columns match immutable
b112 SQL. A repeated-URL prototype improves, with a documented all-distinct
kernel slowdown. Its [fresh image](release-evidence/release-297/usage-contention/candidate-artifact-e95a2b56/manifest.json)
passes build/scan/compatibility checks. [Follow-up CI at `97dad081`](release-evidence/release-297/usage-contention/ci-97dad081-final-01/manifest.json)
passes all 17 CI jobs and three security workflows after a
[test-only rollout clock fix](release-evidence/release-297/usage-contention/clock-minute-boundary-01/manifest.json).
Final-source capacity remains unaccepted; there is still no deployment green light.

The [subsequent full e95 diagnostic](release-evidence/release-297/usage-contention/linux-role-combined-e95-01/manifest.json)
has 4,413/6,000 successful heartbeats, 949 failures, 638 refusals and zero late
offers. Reports pass 64/64 and whole workers finish in 12.284/30.984 seconds,
but API CPU pressure and 950 acquisition failures persist; the classroom
lifecycle fails. Correctness and cleanup pass within their recorded scope.
Zero capacity runs are accepted; current-source CPU attribution is next.

Preceding October 3 application `b11202fc305198d76e73c5e6d711b7dc9ed2d938`
reuses heartbeat query definitions while retaining fresh authority, tenant
bindings and mandatory-work sealing. [Checks](release-evidence/release-297/usage-contention/heartbeat-prepared-reads-implementation-01/manifest.json)
pass 1,906 unit tests without skips, 50 owner and 50 restricted native tests,
four restricted private-recovery cases, and build/type/cast checks. The
[final binding](release-evidence/release-297/usage-contention/heartbeat-prepared-reads-implementation-01/final-binding.json)
records the whitespace cleanup and identical compiled output. The
[fresh candidate image](release-evidence/release-297/usage-contention/candidate-artifact-b11202fc/manifest.json)
passes an uncached build, a pinned scan with zero findings and compatibility
checks. The [local recovery pair](release-evidence/release-297/usage-contention/recovery-pair-b112-6e251/manifest.json) passes synthetic source
re-entry and actual-image function checks, including hard-off expiration and
Focus cleanup. It does not establish production catalog or service-traffic
rollback. [Earlier CI at `a109fd27`](release-evidence/release-297/usage-contention/ci-a109fd27-final-01/manifest.json) passes all 17 jobs and all three security workflows for b112.

The [combined b112 diagnostic](release-evidence/release-297/usage-contention/linux-role-combined-b112-01/manifest.json) failed: 3,020 of
6,000 offered heartbeats succeeded, 2,095 failed and 885 were refused at the
in-flight ceiling; 199 offers were late. All 64 reports passed. Complete worker
operations took 25.049 and 47.561 seconds, including admission and cleanup.
There were 2,096 database acquisition failures: 2,095 on heartbeat paths and
one on the classroom lifecycle path, which failed before acceptance. Independent
totals, coverage, tenant isolation and eight audited CSV checks passed. Physical
owners drained and all six owned containers were removed. This is valid failed
diagnostic evidence, not an accepted capacity run or a proven connection leak.
Three consecutive final-source passes and the original comparison remain required.

No deployment green light or change to operational authorization is recorded.

Earlier October 3 checkpoint: [full CI at `9630c009`](release-evidence/release-297/usage-contention/ci-9630c009-final-01/manifest.json)
passes, while its [resource-bounded Usage diagnostic](release-evidence/release-297/usage-contention/linux-role-combined-9630-01/manifest.json)
fails at 2,704/6,000 heartbeats and 34/64 reports, with the second complete
rollup taking 57.768 seconds including admission wait. Independent correctness
checks pass, but the capacity gate does not. The subsequent `5d543f40` checkout
instrumentation correction passes regression/full-unit checks and local image
scanning. The `6035239b` identity scheduler passes 66 focused cases, native
owner/restricted checks and 1,868 unit cases (four conditional skips).
[CI for that application at `2378e04e`](release-evidence/release-297/usage-contention/ci-2378e04e-final-01/manifest.json)
passes all 17 CI jobs and three security workflows. Final-source capacity and
release preparation remain in progress. The subsequent isolated, profiled
ingestion run completes 4,158/6,000 heartbeats despite zero late offers;
API CPU saturation remains unresolved. Earlier checkpoint statements below
are historical. Application `0e427e3c` also fixes the exact 2.9.7
package's Focus ACK field and JSONB-order-dependent repeated status writes.
Its [64 focused and 15 restricted database tests](release-evidence/release-297/usage-contention/focus-status-wire-297-01/manifest.json)
pass, along with build/type/cast checks and [61 load-profile guards](release-evidence/release-297/usage-contention/focus-lifecycle-harness-01/manifest.json).
The combined synthetic lifecycle now requires the exact authorized public
Focus state after the packaged ACK shape. [Fallback source `6e251f2d`](release-evidence/release-297/usage-contention/rollback-focus-wire-01/manifest.json)
has the same narrow correction with 61 focused and 13 restricted database cases
passing. The fresh [unprofiled ingestion diagnostic on `0e427e3c`](release-evidence/release-297/usage-contention/linux-role-ingest-unprofiled-0e427-01/manifest.json) still fails:
5,139/6,000 heartbeats succeeded, 144 failed and 717 could not start at the
in-flight ceiling; zero offers were late. CPU saturation remains unresolved.
Drains and cleanup passed. [CI on `5d031512`](release-evidence/release-297/usage-contention/ci-5d031512-final-01/manifest.json)
passes all 17 CI jobs and three security workflows for application `0e427e3c`.
The [fresh `6e251f2d` fallback image](release-evidence/release-297/usage-contention/rollback-artifact-6e251f2d/manifest.json)
passes its uncached build, vulnerability scan with zero findings and embedded
compatibility checks; both Usage modes must remain off. Accepted combined
capacity, the final candidate image and recovery pairing remain pending.
Later application changes and merged main require fresh checks.

The subsequent [API connection scheduler correction](release-evidence/release-297/usage-contention/fair-main-pool-scheduler-01/manifest.json)
separates waiting report requests from other main-pool requests with alternating
FIFO service, using the same pool and deadlines. It is active only for admitted
Usage reporting. Build/type/cast checks, 38 focused cases, eight native cases and
the actual application regression under owner and restricted roles pass.
Combined capacity remains unproven; this implementation does not change the
release or activation status.

The earlier [combined diagnostic at `204ae93d`](release-evidence/release-297/usage-contention/linux-combined-204-01/manifest.json)
remains failed: 4,840/6,000 heartbeats, 51/64 reports and 978 acquisition failures.
Workers return correct historical totals below 48 seconds; aborted responses and
unreached current-day/CSV checks prevent acceptance. Its exact local candidate
passes the pinned image scan and embedded compatibility checks. The subsequent
[test-only listing correction](release-evidence/release-297/usage-contention/test-lane-listing-flush/manifest.json)
reproduces and fixes truncated Linux lane output, with 1,825 local unit passes
(four existing skips) and 699 infrastructure passes. The [rollout fixture follow-up](release-evidence/release-297/usage-contention/rollout-live-harness-lifetime/manifest.json)
passes all 380 default-suite assertions without changing production monitoring.
Fresh complete CI, corrected combined capacity and final-source recovery rehearsal remain required. All
earlier failed runs below are retained as historical evidence.

The subsequent [inbox owner projection](release-evidence/release-297/usage-contention/inbox-projection/manifest.json)
preserves fresh authority and all delivery fences while reducing repeated reads.
Build/type/cast checks, 1,824 unit cases and both 21-case native role suites pass;
four unit skips remain documented. Its query-count reduction is not capacity
acceptance. New-source CI and full measured acceptance remain required.

The [92307780 checkpoint](release-evidence/release-297/usage-contention/ci-92307780.json)
passes all required CI workflows for the `d6492333` application. The subsequent
[Linux diagnostic](release-evidence/release-297/usage-contention/load-linux-combined-01/manifest.json)
does not establish capacity: 5,652/6,000 heartbeat offers and 38/64 reports
succeeded, with 348 refused and five late offers. Both workers finished below
48 seconds and acquisition failures were zero, but 23 aborted responses prevent
drain certification. Separate Linux processes shared one unrestricted container;
this is a diagnostic topology, not a production capacity claim. Later application
changes require new source-bound acceptance.

The historical [combined attempt09 at d6492333](release-evidence/release-297/usage-contention/load-combined-09/manifest.json)
also fails: 3,677 of 6,000 heartbeat offers and 30 of 64 reports succeeded,
with 1,957 acquisition failures. Workers returned correct historical totals in
17.983/38.501 seconds, and both optional failure counters were zero. Seventeen
aborted responses prevented drain certification despite zero physical owners.
The exact local candidate image passes its vulnerability and compatibility checks;
baseline/candidate/compatible-fallback migration re-entry passes locally. Those
results do not establish Usage capacity or production readiness. A separately
identified Linux comparison remains diagnostic only.

The October 3 [combined attempt08](release-evidence/release-297/usage-contention/load-combined-08/manifest.json)
remains failed capacity evidence: 2,692 of 6,000 heartbeat offers and 26 of 64
reports succeeded, with 3,008 API connection-acquisition failures. Both historical
workers finished below 48 seconds. Physical ownership counters reached zero,
but 11 aborted responses prevented drain certification; current-day and audited
CSV checks did not run. Usage remains off; neither three passing cold runs nor a
supported 100-request/second envelope is established. Earlier failures retain
their own source, measurements and correctness results. The correction adds bounded fair report
admission, narrowly scoped tenant connections, complete request deadlines,
content-free ownership diagnostics and removal of a redundant modern heartbeat
authority calculation. A separate release-enabled harness uses isolated API,
worker and traffic-generator processes, real staff sessions and Redis, with
precise restrictions, Focus and private-chat lifecycle active. Implementation
alone does not satisfy the required three consecutive final-source capacity
runs. See the [contention and acceptance record](RELEASE_297_USAGE_AND_RUNTIME_EVIDENCE.md).

The later [ingestion-only diagnostic at bcb2b33c](release-evidence/release-297/usage-contention/ingest-cpu-bcb2b33c-01/manifest.json)
also fails, with 5,148 of 6,000 offers successful and 232 acquisition failures,
despite clean server drain. Its API uses 82.062 CPU seconds during the 67.879-second
phase; the recorded CPU profile guides further correction, not a readiness claim.

The subsequent [owned inbox correction](release-evidence/release-297/usage-contention/heartbeat-owned-inbox/manifest.json)
removes the separate inbox connection while retaining exact authority and fresh
expiry checks. Forty-eight focused cases and 19 native cases per database role
pass; failed claims roll back and required preparation survives an optional inbox
failure. Suppression caches update only after transaction cleanup. The equivalent
recovery path uses 27 rather than 33 statements and one rather than two leases.
New combined capacity acceptance is still required; optional inbox failures now
also fail that gate.

SchoolPilot #603's [CI at `bcb2b33c`](release-evidence/release-297/usage-contention/ci-bcb2b33c.json)
has 15 successful jobs and two failures: a deployment command detector and four
PassPilot fixtures whose intended same-day passes crossed midnight. Security
workflows passed. Both failures have passing local corrections with retained
evidence; the new heartbeat work still requires fresh combined-source checks
and capacity runs.
The heartbeat correction now reuses its already locked final-delivery authority
for eligible foreground updates, and checks school/license/session expiry again
before the HTTP response. Its [native proof](release-evidence/release-297/usage-contention/heartbeat-foreground-fusion/manifest.json)
passes 23 owner and 23 restricted-role cases; this is not capacity acceptance.
The compatible fallback advances to `5c01944e` with the same final expiry fence
and both Usage modes required off. Its [exact local image](release-evidence/release-297/usage-contention/rollback-artifact-5c01944e/index.json)
passes the pinned full scan with zero findings and embedded compatibility checks;
final candidate artifacts and migration
re-entry remain pending; local preparation does not establish registry publication
or deployment.

St. Francis DeSales Cincinnati (`desalescincy.org`) is the only live school,
as confirmed by the owner. Both schools in capacity and tenant-isolation tests
are synthetic. Resolve the actual DeSales UUID and current eligibility through
authorized production reads before preparing a live pilot.

This document turns the product owner's eight-phase master plan into a sequence of safe, independently deployable pull requests. It records the product model, the engineering rules every PR follows, the PR order and its hard constraints, the capabilities and flags each PR adds, and the Phase 0/0A status. The retired Live View and parked TURN inventory, with its A–E classification and deletion order, is in `CLASSPILOT_LEGACY_MEDIA_AUDIT.md`.

The roadmap was developed in independently reviewable PRs. The owner now authorizes one integration PR to consolidate their reviewed work; automatic deployment/Store publication and permanent legacy TURN deletion remain prohibited.

Historical line references below are to SchoolPilot `a811b04d` and ClassPilot `55bb531`. The initial continuation baseline was SchoolPilot `60f33db` and ClassPilot `55bb531` (repository manifest 2.9.6). SchoolPilot main subsequently advanced to `d4f3f232` through independently merged deployment-safety #578 and Axios #580; the corrected foundation incorporates those changes. ClassPilot main remains `55bb531`. Re-locate anchors by symbol before editing. Repository versions do not establish the live Chrome Web Store version. A PR that changes a status row updates it in this document.

The [public Store listing](https://chromewebstore.google.com/detail/classpilot/iggbfegfcjkfieoemeolfmfnapepalca) rechecked September 30 shows 2.9.6, updated September 27, 2026, superseding the earlier 2.9.5 observation. The v2.9.6 tag resolves to `55bb531`; GitHub release history was empty. These observations do not establish the published ZIP hash. The historical 2.10.0 candidate is superseded by the owner-selected 2.9.7 successor; preserve its evidence and recheck the Store and pending submissions immediately before upload.

## Product model

The intended classroom-control model, from the master plan's "FINAL PRODUCT MODEL":

| Control | Meaning | Detail |
|---|---|---|
| Waypoint | "Keep students in one place." | Entire Website (the default and today's behavior) or This Resource. A specific IXL starting page with the Entire Website restriction allows Math IXL and Science IXL while preventing students from leaving ixl.com. |
| Flight Path | "Let students move among these approved places." | Combines whole websites, sections and specific resources. |
| Focus | "Keep this tab in front." | Persistent until the teacher stops it. |
| Bring Forward | "Bring this tab forward once." | One-time; the student may navigate or switch afterwards. |
| Google Classroom | "Open the teacher's existing assignment and optionally Focus or create a lesson restriction from its resources." | Open, Open + Focus, Open as Lesson. |
| PassPilot | "Manage student movement using enforceable school rules, appointments, capacity, and factual analytics." | Rules, appointments and analytics. |
| Digital Usage | "Give administrators understandable browser-activity analytics without falsely claiming full-device screen time." | Called Monitored Browser Time, never Screen Time. |
| Present to Class | "Teacher publishes one instructional screen stream to an SFU; authorized student Chromebooks subscribe to it." | New media stack; `teacherPresentationV1`. |

Legacy Live View is not part of this architecture. Legacy coturn remains parked only until it is safe to permanently remove.

The controls stay separate:

- Bring Forward: put this tab in front once.
- Focus: keep this tab in front.
- Waypoint: confine browsing to one destination.
- Flight Path: confine browsing to a set of approved destinations.
- A Waypoint's start location and its restriction boundary are separate concepts.

## Global engineering requirements

The text below is copied verbatim from the master plan. Every PR in this roadmap must satisfy it.

All phases must preserve SchoolPilot's existing security and authorization model.

Always preserve:

- school/tenant isolation
- PostgreSQL RLS
- exact student/session binding
- teaching-session authority
- supervision-context authority
- entitlement checks
- role checks
- command authorization
- capability negotiation
- audit logging
- safe retention behavior
- no teacher-facing raw device IDs

Do not create alternate authorization systems.

Do not trust frontend state as authority.

Do not weaken teacher intent because a client is old.

Do not silently broaden restrictions.

Do not create cross-school access paths.

Every extension-dependent feature must use negotiated capabilities rather than extension-version assumptions.

Every new tenant table must receive:

- school_id NOT NULL
- same-school FK protection where applicable
- forced RLS
- tenant_isolation policy
- RLS registry entry
- startup migration support
- appropriate indexes
- cross-school tests

### How the repository applies these requirements

- **New tenant table ceremony** (precedents #503, #530): schema in `src/schema/passpilot.ts` or `src/schema/classpilot.ts` (both are in the `drizzle.config.ts` push list, so the CI database job creates the table); migration module `src/db/<name>Migration.ts` modeled on `src/db/passpilotKioskScheduleMigration.ts` (`school_id TEXT NOT NULL REFERENCES schools(id)`, `ENABLE` and `FORCE ROW LEVEL SECURITY`, a `tenant_isolation` policy with the exact predicate `src/db/rlsEnforcement.ts` checks); registered in `schoolPilot27Migrations` in `src/db/migrations27.ts` without rewriting historical SQL/checksums or reordering historical entries; later additive migrations may follow the staff contract because default-expand selection excludes that contract by ID; mirrored in `runStartupMigrations` (`src/index.ts`); a new `rlsRegistry.json` inventory `<name>PostExpand` and `reviewedEnablementRequests.<name>`; `src/db/rlsPolicies.ts` constant, `currentInventory` and `assertRlsRegistryIntegrity` list; `infra/main.tf` (`rls_post_expand_tables` and its check); `infra/tests/mydesk.tftest.hcl`; `RLS_ENABLED_TABLES` in `.github/workflows/ci-build.yml`; `tests/rls-registry-consistency.test.ts`, `tests/deploy-rls-table-enablement.test.ts`, `scripts/run-local-workspace-tests.ps1`, `scripts/load/paperwork/run-split.ps1`; and the RLS block of `tests/cross-tenant-isolation.test.ts`. Feature PRs never edit `infra/production.tfvars` `rls_enabled_tables`; production admission is `scripts/deploy.sh production --backend --enable-rls-table <bundle>` once, with baseline adoption later (the #533 pattern). Same-school foreign keys use `students_school_id_id_unique`, `groups(school_id, id)` and `teaching_sessions(school_id, id)`.
- **Test lanes**: cross-school RLS assertions belong in an `RLS_SERIAL` file (`scripts/run-test-lane.mjs`). The `DB_SERIAL` lane runs as the PostgreSQL superuser and proves nothing about policies. A new frontend `schoolpilot-app/scripts/*.test.mjs` needs an npm script in `schoolpilot-app/package.json` and a step in `ci-build.yml`.
- **Flags**: exact `off|on` environment modes parsed like `src/config/mydeskModes.ts`; a malformed value reads as `off`. Mode readers for PR 7 and PR 10b return `off` unless `RLS_GUC_ENABLED === 'true'` and `parseRlsEnabledTables()` contains every table of their bundle, so a missing RLS admission fails closed at runtime.

## Phases

The master plan's phases, with the PRs that implement them. Status is as of 2026-09-30.

| Phase | Master plan name | PRs | Status |
|---|---|---|---|
| 0 | Current-state audit + legacy TURN cost reduction | PR 0, PR 0A, operational stop | Parking shipped (#541) and applied; audit merged in #549; PR 0A hardening merged in #551, not deployed as of merge |
| 1 | Shared Flight Paths + Block Lists | PR 1-pre, PR 1a, PR 1 | Merged in #547, #552 and #553; default off; current deployment/activation UNKNOWN |
| 2 | Precise Restriction Engine for Waypoints + Flight Paths | PR 2-pre, PR 2, PR 3, PR 4, coordinated extension candidate | #550/#555/#559 merged; normalized preview API #567 and interface #571, ClassPilot enforcement #119 are draft implementations; package/device gates remain separate; production UNKNOWN |
| 3 | Focus Tab + Bring Forward | PR 5, coordinated extension candidate | Final exact-tab/receipt/lifecycle contract #565, server #572, teacher interface #575 and ClassPilot #120 are draft implementation slices; source/CI/package/device gates tracked separately; default off |
| 4 | Google Classroom Assignment -> Open / Open + Focus / Open as Lesson | PR 6 | Backend prerequisite/revision contract #582 and combined interface/integration #577 pass focused actual HTTP/browser tests; required current-head CI tracked separately; activation UNKNOWN |
| 5 | PassPilot Rules + Appointments + Expanded Analytics | PR 7, PR 8, PR 9 | Rules #554 merged; confidentiality #566, appointment API #570/races #573/year setup #574/interface #579 and Reports v2 API #583/interface #584 are draft continuation slices; default off; production UNKNOWN |
| 6 | Digital Usage / Monitored Browser-Time Analytics | PR 10a, PR 10b, PR 11 | #548/#556 merged; coverage/cutoff correction #563, administrator page #568, initial load evidence #569 and equivalent query improvements #586 are drafts; expanded bounded workloads, failed repeats and stress limitations tracked separately; production UNKNOWN |
| 7 | Present to Class using a NEW SFU-based architecture | PR 12–18 | Waits for the PR 12 ADR decision |
| 8 | Final cleanup/decommission of retired Live View + legacy TURN infrastructure | PR 19–21, operational destroy | Not started; blocked on Phase 7 |

### Phase 0 — Current-state audit and legacy TURN cost reduction

- **0, legacy media audit.** Live View is treated as retired unless current runtime evidence proves an active feature depends on it. The audit covers the Live View UI, `useWebRTC`, backend routes, telemetry, WebSocket signaling, extension capture code and student-to-teacher WebRTC paths; the capabilities `liveViewNegotiationV1` and `liveViewIceServersV1`; the runtime variables `CLASSPILOT_TURN_HOSTS`, `CLASSPILOT_TURN_REST_SECRET` and `CLASSPILOT_STUN_URLS`; and every AWS TURN resource. Each item is classified A (still required by an active feature), B (generic infrastructure potentially reusable), C (Live View-specific legacy code), D (Live View-specific legacy infrastructure) or E (unknown; requires production verification). Nothing is deleted. Result: `CLASSPILOT_LEGACY_MEDIA_AUDIT.md`.
- **0A, park legacy TURN.** Both coturn nodes are stopped while their EC2 identity, Elastic IPs, DNS, Secrets Manager secret, security group, IAM role and instance profile, Terraform ownership, certificates and configuration, CloudWatch configuration and restart documentation are preserved. `enable_classpilot_turn = true` stays and means "Terraform retains ownership of the legacy TURN infrastructure." It does not mean TURN should be running, that Live View is enabled, or that TURN remains part of the active ClassPilot product. The parked state is explicit (`classpilot_turn_parked = true`, `aws_ec2_instance_state`), production pins the verified deployed AMI, and ordinary Terraform fails loudly before it destroys or replaces a parked node, without `ignore_changes = all`. Restarting TURN never enables Live View. Runbook: `CLASSPILOT_TURN_PARKING.md`.

### Phase 1 — Shared Flight Paths and Block Lists

- A School Resource Library under Teaching Tools ("My Resources", "School Library").
- Private (the existing default; the owner manages it), school shared (the owner manages it; school teachers may use it and "Copy to My Resources"; applying does not duplicate), and official (an admin-controlled canonical resource; teachers may use or copy it and cannot silently modify it).
- Additive metadata only: `visibility` (private or school), `official`, `publishedAt`, `publishedBy`. Existing personal resources are not destructively altered.
- Required tests: Teacher A's private resource is invisible to Teacher B; a shared resource is visible within the school; School B cannot see School A's resources; Teacher B can apply but not mutate Teacher A's resource; copying creates a Teacher B-owned version; admin official resources work.

### Phase 2 — Precise restriction engine for Waypoints and Flight Paths

- One restriction-resource model (`AllowedResource`: website, section or resource) serves Waypoints and Flight Paths. Teachers never see raw regex configuration.
- A Waypoint contains exactly one destination. Entire Website stays the default. "This resource only" uses the canonical provider identity; the generic-page adapter creates a section that includes descendants, not a literal exact page. Show the normalized scope before application.
- A Flight Path contains one or more allowed resources, and the student may move among all of them.
- Provider-aware resource identity for YouTube videos, Google Docs, Forms and Slides, and Google Classroom assignments or materials where practical. `youtube.com/watch?v=ABC123` and `youtube.com/watch?v=ABC123&t=90` are the same resource; another video ID is not allowed.
- Enforcement restricts top-level (main-frame) navigation and leaves page subresources alone, using Chrome `declarativeNetRequest` and `webNavigation`.
- Google and Clever authentication pass-through stays tightly scoped and never becomes a general browsing exemption.
- Use the normative pairwise precedence table in `CLASSPILOT_PRECISE_RESTRICTIONS_CONTRACT.md`, including conditional temporary allows and the Waypoint overlay over a retained Flight Path. Approved authentication may pass a Waypoint while school and teacher blocks remain authoritative. Do not implement an approximate hierarchy from this roadmap.
- Capability `preciseRestrictionResourcesV1`. Website restrictions keep working on older compatible clients. A section or resource restriction for a client without the capability fails closed with an honest unsupported-client outcome; one YouTube video is never converted into all of youtube.com.
- The exact wire contract is defined by PR 2 in `src/services/restrictionResources.ts` with a shared case file, `tests/fixtures/restriction-resource-matcher-cases.json`, whose SHA must be pinned and exercised in both repositories. ClassPilot main has not implemented that port yet.

### Phase 3 — Bring Forward and Focus

- Bring Forward is a one-time action that makes a selected existing tab active; the student may navigate or switch afterwards.
- Focus is persistent state that keeps the selected tab or resource in front until the teacher stops it. Focus is not a Waypoint.
- Both use the existing exact tab-reference concepts and never expose Chrome tab IDs.
- Capability `focusTabV1`. Focus is exact student/session bound, context/session bound, revisioned, restart recoverable, cleared when authority ends, and safely invalidated when tab identity becomes stale.

### Phase 4 — Google Classroom assignments

- Reuses the existing Classroom OAuth, courses, coursework, materials, Drive resources, Forms, YouTube extraction and Classroom-to-Flight Path work.
- Teacher actions: Open (open the assignment or resource), Open + Focus (open it and Focus its tab), Open as Lesson (create or reuse a resource-aware Flight Path and apply it).
- One assigned YouTube video never allows all of YouTube. The teacher reviews generated restrictions before they apply. Generated Flight Paths are not duplicated uncontrollably.
- The master plan suggests a capability `classroomAssignmentLaunchV1`; it is reserved and undesigned (see "Capabilities").

### Phase 5 — PassPilot rules, appointments and analytics

- Current PassPilot behavior is preserved.
- Rules: student maximum passes per day and per period or class window; per-destination policy (bathroom capacity, expected duration, optional auto approval; separate nurse and office policies); encounter rules that stop configured student pairs from holding overlapping active passes. The issuance transaction evaluates active pass, daily limit, period limit, destination capacity and encounter restriction atomically, without race conditions.
- Appointments: one-time, staff-managed appointments with explicit earliest/latest departure times. Existing PassPilot managers create/edit/cancel scheduled appointments; currently authorized teachers activate manually. Staff reminders appear inside PassPilot when the window opens, independently of lifecycle state. Student/kiosk reminders, recurrence and automatic issuance are deferred. Activation rechecks eligibility and atomically links one canonical pass; unused appointments become missed at the latest departure time. Returning the linked pass completes the appointment; overdue passes remain open.
- Analytics: passes per student, average and (where useful) median duration, overdue percentage, busiest periods and destinations, capacity denials, rule denials and appointment completion. No stigmatizing labels such as "problem student" or "frequent flyer"; write "12 passes this week".
- Wave-1 scope for PR 7: destination capacity, default and per-student daily and period limits, encounter restrictions, and an override for admin roles only. Auto approval stays unenforced and unsurfaced (Decision 6).

### Phase 6 — Digital Usage

- Reuses heartbeats, `daily_usage`, `classpilot_session_usage`, top domains and the existing student, class and session analytics. Raw heartbeats are not the permanent reporting warehouse; durable aggregate rollups are added (dimensions such as school, date, student, grade, class, domain, classification and duration).
- Admin → Digital Usage shows Monitored Browser Time, active monitored students, instructional and off-task browser activity, and top educational and non-educational sites, by school, grade, class and student, for today, 7 days, 30 days or an allowed custom range, with CSV export.
- The total is never called "Screen Time", because ClassPilot sees browser activity only. Use Monitored Browser Time, ClassPilot Monitored Time or Chromebook Browser Activity.
- Reconnects, class switches, handoffs and duplicate heartbeats are never double counted.

### Phase 7 — Present to Class

- A new media capability, `teacherPresentationV1`. The retired Live View architecture is not revived, and nothing is built on `liveViewIceServersV1`.
- The teacher publishes one stream to an SFU (LiveKit in the master plan) and students subscribe. One teacher upload per student is not the production architecture.
- Scope: share a browser tab, a window or the entire screen, to the whole class, a subgroup or selected students. It is not a conferencing product: no student webcams or microphones, video grids, speaker detection, automatic recording or conferencing features. Typical sessions last 3 to 15 minutes.
- The SchoolPilot API owns authorization, teacher identity, class and context, audience, presentation lifecycle, short-lived media credentials, entitlement, expiration and audit metadata. The SFU owns WebRTC media, publication, subscription and forwarding. SFU media never runs in the normal SchoolPilot Express containers.
- A presentation binds to school, teacher, `teachingSessionId` or `supervisionContextId`, authority revision, audience, `createdAt` and `expiresAt`. No cross-school room access; unguessable room IDs are not the security boundary. The teacher is the only publisher; students subscribe only and can never publish media.
- The teacher chooses the source through an explicit `getDisplayMedia()` call and sees a clear active-presentation state; the teacher desktop is never captured silently. Ordinary teachers never see ICE, TURN, SFU or SDP terms.
- "Keep presentation in front" reuses Phase 3 Focus. Presentation-specific Focus ends with the presentation and never clears unrelated Focus state.
- Students see the presentation in a controlled ClassPilot surface: clearly identified, no arbitrary teacher HTML, a safe media source, prior state restored afterwards, late join and reconnect supported, and cleared when authority changes.
- A presentation ends when the teacher stops, the teaching session or supervision ends, the teacher signs out or loses authority, entitlement is revoked, the presentation expires, a hard context deadline is reached, or the media source permanently ends.
- Live only. No automatic recording. Presentation media is never stored in PostgreSQL, Redis, S3 or logs; future recording needs its own architecture and privacy review.
- Targets: 720p at about 5–10 FPS for mostly static material, adaptive at about 400–800 Kbps where practical, readable for Slides, Docs, spreadsheets, IXL, websites, Classroom and text or code. Start with minimum practical ready capacity; track presentation minutes, subscribers, downstream GB, average bitrate, TURN percentage, SFU CPU and memory, join failures and reconnect rate; compute cost per presentation, per classroom-hour and per active school.
- Validation before broad activation: 10, 25 and 40 students for 5 and 15 minutes, static and changing screens, teacher and student reconnects, five simultaneous reconnects, Chromebook sleep and wake, extension restart, class transition and session termination, measuring upload, CPU and memory on each side, bandwidth, packet loss, join, reconnect and startup times, and TURN usage. Passing synthetic tests does not make it production-ready.
- Direction and TURN: see "Present to Class direction".

### Phase 8 — Legacy Live View and TURN decommission

- Starts only after: legacy TURN has stayed parked without product failures; Live View is confirmed retired; Present to Class uses the new media stack; no supported extension depends on Live View; no API or worker consumes legacy TURN; historical requirements are preserved; and the exact production resources are inventoried.
- Record: `docs/LEGACY_LIVE_VIEW_DECOMMISSION.md`.
- Potential removal: the Live View UI, hooks, routes, telemetry, signaling, obsolete extension capture, `liveViewNegotiationV1`, `liveViewIceServersV1` and the old runtime variables; the TURN EC2 instances, Elastic IPs, Route 53 records, security group, IAM role and instance profile, TURN REST secret, CloudWatch TURN resources and the Terraform TURN module.
- STOPPED != SAFE TO DELETE. Destruction needs a separately reviewed Terraform destroy plan. A feature rollout and a destructive legacy removal never share a deployment.
- The deletion order and each resource's protection status are in `CLASSPILOT_LEGACY_MEDIA_AUDIT.md`.

## Pull requests and order

### PR list

The master plan's PR list, plus five wave-1 additions (marked). Lane letters refer to the lane table below.

| PR | Scope | Lane | Status (2026-09-30) |
|---|---|---|---|
| PR 0 | Roadmap + legacy media audit (this document and `CLASSPILOT_LEGACY_MEDIA_AUDIT.md`) | 0 | IMPLEMENTED (docs), merged in #549 |
| PR 0A | Legacy TURN parking Terraform/documentation protections | 0 | Parking shipped in #541; hardening (literal `prevent_destroy` on the rest of the retained TURN identity, HA profile parity, default-off WebSocket signaling gate) merged in #551: IMPLEMENTED and AUTOMATED-TEST VERIFIED, not deployed as of merge |
| Operational | Stop legacy TURN A/B after explicit verification/approval | 0 | Done: stopped 2026-09-28; the saved TURN Terraform plan was applied 2026-09-29 |
| PR 1a (wave-1 addition) | Governed product runtime activation tool, `scripts/deploy-product-runtime-config.ps1` | 0 | Merged in #552: AUTOMATED-TEST VERIFIED against mocked AWS; never run against AWS |
| PR 1-pre (wave-1 addition) | Scope the AI assistant's Flight Path list to the caller's own paths | A | Merged in #547 |
| PR 1 | Shared Flight Paths + Block Lists | A | #553 merged; default off; current deployment/activation UNKNOWN |
| PR 2-pre (wave-1 addition) | Forward-compatibility fence one release before PR 2 | A | Merged in #550; see constraint 4 for the activation rule |
| PR 2 | Structured restriction-resource backend/model | A | #555 and hardening #559 merged; capability default off; production UNKNOWN; contract in `CLASSPILOT_PRECISE_RESTRICTIONS_CONTRACT.md` |
| PR 3 | Precise Waypoint enforcement: Entire Website + This Resource | A | Draft preview API #567/interface #571 and ClassPilot #119; final #555/#559 contract and exact shared fixtures |
| PR 4 | Mixed Website/Section/Resource Flight Paths | A | Included in #567/#571/#119; safe prior-policy retention and honest installation acknowledgements |
| PR 5 | Bring Forward + Focus | A | Draft contract #565, backend #572, interface #575 and ClassPilot #120; exact student/tab bindings and lifecycle tests |
| PR 6 | Google Classroom Assignment quick actions | A | Draft backend #582 and integrated interface #577; actual UI-to-HTTP/ACK regression verifies partial lesson opening |
| Coordinated extension candidate | One extension release carrying `preciseRestrictionResourcesV1` and `focusTabV1` | A | 2.9.7 successor consolidates #119–#122; automated/package/CI/live/publication evidence remain separate; managed prerequisite waived, not passed |
| PR 7 | PassPilot Rules | B | #554 merged; draft confidentiality #566 passes retained-override public-response regressions; default off; production UNKNOWN |
| PR 8 | PassPilot Appointments | B | Draft API #570, eligibility races #573, school-year setup #574 and staff interface #579 |
| PR 9 | PassPilot Analytics | B | Draft server aggregates/audited CSV/governed v2 flag #583 and staff interface #584 |
| PR 10a (split of PR 10) | Daily usage rollup hardening, shadow-safe | B | Merged in #548 |
| PR 10b (split of PR 10) | Digital Usage rollup table + read API | B | #556 merged; draft atomic completion/cutoff/RLS/writer correction #563; production UNKNOWN |
| PR 11 | Digital Usage admin UI | B | Draft #568 and synthetic load #569; expanded load acceptance retains documented stress failures |
| PR 12 | Present to Class SFU hosting/security/cost ADR | C | Draft dated hosting/privacy/cost recommendation #561; implementation and proposed budget require approval |
| PR 13 | Presentation session/auth backend + short-lived SFU credentials | C | Not started |
| PR 14 | Teacher capture + SFU publisher | C | Not started |
| PR 15 | ClassPilot student SFU subscriber + presentation UI | C | Not started |
| PR 16 | Presentation Focus integration | C | Not started |
| PR 17 | Selected-host media operations; AWS infrastructure only if approved hosting needs it | C | Not started |
| PR 18 | 10/25/40 managed-Chromebook validation + rollout preparation | C | Not started |
| PR 19 | Remove retired Live View application paths | D | Only after the new media stack is independent |
| PR 20 | Remove retired extension Live View paths | D | After PR 19 |
| PR 21 | Prepare legacy TURN destruction/decommission Terraform plan | D | After PR 20 |
| Operational | Execute legacy destruction only after explicit review and approval | D | After PR 21 |

### Why the wave-1 additions exist

- **PR 1-pre.** The AI assistant's `list_flight_paths` tool (`src/services/chatToolExecutor.ts`) reads the school-wide Flight Path list (`getFlightPathsBySchool`), so it can return another teacher's private paths. PR 1-pre limits it to the caller's own paths now, and PR 1 extends it to own plus library. Shipping it separately keeps PR 1's flag-off path byte-identical.
- **PR 1a.** The wave-1 environment flags have no production setter today: the ClassPilot runtime-config tool writes only its own names, the ECS services ignore Terraform task-definition changes (`infra/modules/ecs/main.tf`, `ignore_changes`), and `scripts/deploy.sh` renders new revisions from the serving revisions. PR 1a adds a governed Plan/Apply/Rollback script modeled on `scripts/deploy-mydesk-runtime-config.ps1`, with RLS-admission preconditions. It refuses unknown names, so it cannot touch capability or TURN variables.
- **PR 2-pre.** After PR 2, stored Waypoint and Flight Path payloads can carry `resource`/`resources`. An image rollback to a server that drops unknown keys would turn a resource Waypoint into a domain lock. PR 2-pre makes the current server withhold any `screenLock` or `flightPath` whose stored payload carries unrecognized `resource`/`resources` keys (`withheldReason: precise_restriction_capability_required`), so a later rollback fails closed. It also captures the 2.9.6 compatibility fixture from ClassPilot.
- **PR 10a and PR 10b.** The master plan's PR 10 is split. PR 10a hardens the existing `daily_usage` rollup, which runs in shadow mode in production, without a new table. PR 10b adds the new tenant table and read API. Daily-rollup promotion needs three clean shadow days.

### Lanes

| Lane | PRs | Notes |
|---|---|---|
| 0 | PR 0 docs, PR 0A hardening, PR 1a activation tool | PR 0A merges after the two 2026-09-29 operational applies (both done; see "Phase 0 and 0A status") |
| A | Merged foundation, then precise/Focus/Classroom continuation and coordinated candidate | Precise extension may use the final contract now; extension Focus follows its finalized server contract. Shared tool changes remain serialized. |
| B | Corrective usage PR → appointments → reports; usage page after corrected API | Serialize each new-table inventory onto current main. Operational shadow/observation gates govern activation; they do not block synthetic page development. |
| C | PR 12 ADR, then PR 13–18 | Prepare the ADR now; Brian's decision precedes media implementation |
| D | PR 19–21 | Only after Lane C is live and independent |

Wave 1, including matcher/clear follow-up #559 and deployment clarification #558, is merged. The continuation gap matrix below records the remaining code and operational evidence. Historical labels such as "PR 3" are roadmap slices; they are not GitHub PR numbers.

### Hard ordering constraints

1. PR 0A merges only after the saved TURN Terraform plan and the `live-view-retire` runtime profile are applied. Both were applied on 2026-09-29.
2. PR 1-pre merges before PR 1, and PR 1 before PR 2.
3. Never merge a change to `scripts/deploy-classpilot-runtime-config.ps1` between a runtime-config Plan and its Apply; Plan and Apply must run from the same tool SHA (`CLASSPILOT_RUNTIME_CONFIG_OPERATIONS.md`). PR 2 and PR 3 edit that tool.
4. PR 2-pre (#550) and PR 2 (#555) reached `main` together, and `scripts/deploy.sh` deploys only `origin/main`, so no separate PR 2-pre image will exist. The fence matters only once precise state exists. Never activate `preciseRestrictionResourcesV1` until the serving image and the image a rollback would return to both contain #550, which takes at least one more deploy after the first image that ships it. After the capability has been active, never roll an image back below #550.
5. Final server contract before dependent extension implementation. Candidate packaging and synthetic acceptance do not require production approval; later publication/activation require separately approved compatible server deployment and managed acceptance.
6. The historical Rules -> aggregate inventory chain remains immutable. Chain the new completion ledger onto current main before appointment inventory; serialize all new tenant admissions rather than branching from historical totals.
7. Activation order, not implementation order: daily rollup promotion requires three clean shadow school days on the relevant build. Corrected usage aggregation requires both aggregate and completion admission, followed by one observed school day before reporting activation. PR 11 may be built/tested against corrected synthetic fixtures beforehand.
8. Lane C media implementation starts after the PR 12 ADR decision. ADR research/preparation may proceed independently. Lane D starts only after Present to Class runs on its own media stack.
9. A feature rollout and a destructive legacy removal never share a deployment.

### Deployment-order rules

- **Migrations first.** Checksum-ledger migrations complete before the dependent API and worker rollout; startup migrations must report completion before rollout. Never edit a shipped migration.
- **Clean deploys.** Deploy from a clean `main` clone with CI green, including the SOC 2 approval job that `scripts/deploy.sh` gates on. Backend and frontend deploy as separate runs.
- **RLS admission.** A new tenant-table bundle is admitted once with `scripts/deploy.sh production --backend --enable-rls-table <tables>`; its mode stays `off` until a later governed Apply.
- **Flags off at deploy.** Production mode flags change only through a PR 1a Apply; capability kill switches and registry entries change only through `scripts/deploy-classpilot-runtime-config.ps1`. Nobody edits ECS task definitions by hand, and no Terraform seed variable is added for a wave-1 flag.
- **PR 2-pre and PR 2** ship in the same first image. Constraint 4 gives the activation and rollback rule.
- **Server before extension activation.** A SchoolPilot deploy never publishes or updates ClassPilot. Prepare and test the local versioned candidate against reviewed compatible server contracts without a production deployment. Later publication/activation requires separately approved compatible serving images and exact automated package evidence; the two-device prerequisite is waived for this release and replaced by documented live acceptance before global promotion.
- **The serving image must know every capability in the live registry.** `parseCapabilityRollouts` (`src/services/classpilotProtocol.ts:138-160`) treats any unknown key in `CLASSPILOT_CAPABILITY_ROLLOUTS_JSON` as an invalid registry, and an invalid registry turns every protocol-v3 capability off. The runtime-config tool writes an entry for every capability it registers, adding a missing additive capability as `{"mode":"off"}` (`scripts/deploy-classpilot-runtime-config.ps1:74-80` and `:2459-2476`). Therefore: deploy the server image that registers a new capability before any runtime-config Apply writes its entry; before reverting an image past a capability's introduction, remove that entry from the live registry (since PR 2 the tool projects every runtime onto the serving image's registry, and a plan with `-RegistryTargetAppSha <older app SHA>` drops the entries the older image does not register; see `CLASSPILOT_ROADMAP_RUNTIME_ROLLOUT.md`); and PR 19 removes the live `liveViewIceServersV1` entry, or keeps the parser accepting that retired name, before it deletes the name from the server registry.
- **PR 2 rollback** (runbook in `CLASSPILOT_ROADMAP_RUNTIME_ROLLOUT.md`, added by PR 2): apply `precise-restriction-resources-off`, clear every active precise restriction with a control-revision bump, and only then revert the image, observing the registry rule above.
- **Legacy removal** follows the deletion order in `CLASSPILOT_LEGACY_MEDIA_AUDIT.md` and never ships with a feature rollout.

## Capabilities

All new capabilities default off and are negotiated, never inferred from an extension version. The two wave-1 capabilities join the scoped-authority dependent set, so they also require an accepted `scopedAuthorityChecksV1`.

| Capability | PRs | State | Kill switch | Set in production by |
|---|---|---|---|---|
| `preciseRestrictionResourcesV1` | PR 2 (server), PR 3 and PR 4 (enforcement), coordinated candidate | Designed in wave 1 | `CLASSPILOT_CAP_PRECISE_RESTRICTION_RESOURCES_V1` plus a registry entry | `scripts/deploy-classpilot-runtime-config.ps1`, pilot and off profiles in the existing `<name>-pilot` / `<name>-off` pattern (`precise-restriction-resources-off` is the rollback profile) |
| `focusTabV1` | PR 5 (server), coordinated candidate | PROVISIONAL; final server/ACK/lifecycle contract required first | Named in the final server PR (existing convention `CLASSPILOT_CAP_<NAME>`) | `scripts/deploy-classpilot-runtime-config.ps1` |
| `classroomAssignmentLaunchV1` | PR 6 | RESERVED, UNDESIGNED. Suggested by the master plan; no design yet decides whether PR 6 needs its own extension capability | None | None |
| `teacherPresentationV1` | PR 13–16 | Not designed; waits for the PR 12 ADR (Decision 8). Never reuses `liveViewIceServersV1` | Decided with the design | Decided with the design |

Adding a capability touches every registry below in the same PR. SchoolPilot:

1. `src/services/classpilotProtocol.ts:7-33`, `CLASSPILOT_PROTOCOL_V3_CAPABILITIES` (25 entries at `a811b04d`; append).
2. `src/services/classpilotProtocol.ts:38-73`, `CAPABILITY_FLAGS` (the `CLASSPILOT_CAP_*` kill switch).
3. `src/services/classpilotProtocol.ts:75-99`, `SCOPED_AUTHORITY_DEPENDENT_CAPABILITIES` (not exported; 23 entries at `a811b04d`).
4. `CLAUDE.md`'s capability-flag bullet (line 489 at `a811b04d`) says "all seventeen entries of `SCOPED_AUTHORITY_DEPENDENT_CAPABILITIES`"; the set has 23. PR 2 corrects the count.
5. `scripts/deploy-classpilot-runtime-config.ps1`: `$script:AllCapabilities` (`:119-131`, fixed registry order) and `$script:CapabilityFlags` (`:132-152`); pilot/off profiles through `$script:RoadmapProfileCapabilities`, `$script:RoadmapCapabilities`, `$script:RoadmapPilotModes` and `$script:RoadmapOffModes` (`:98-108`); tests in `tests/classpilot-runtime-config-deploy.test.ps1` (`$script:AllCapabilities` order assertion near `:430`, `$roadmapCases` near `:1432`).
6. `.env.example` (flag, default `false`) and a row in `docs/CLASSPILOT_ROADMAP_RUNTIME_ROLLOUT.md`.
7. Where the capability is projected or required: `src/routes/classpilot/devices.ts:1021-1034`, `src/routes/compat.ts:214-228` and `:1182-1196`, `src/services/classpilotCoverageHydration.ts:102-130`, the `requiredCapability` unions in `src/realtime/ws-redis.ts:25-34` and `src/services/classpilotCommandDispatcher.ts:634-637`, and `tests/classpilot-command-hot-path.test.ts:20-29`.

ClassPilot:

8. `extension/service-worker.js:315-348`, `EXTENSION_CAPABILITIES`, and `:349-365`, `SCOPED_AUTHORITY_DEPENDENT_CAPABILITIES`; the behavior is used only through `hasNegotiatedCapability`; the names are pinned in `server/__tests__/extension-release.test.ts:801-840`.

## Feature flags

Wave-1 product flags are environment modes with exact values `off` or `on`; unset or malformed reads as `off`. Production flips happen only through the PR 1a governed script (`scripts/deploy-product-runtime-config.ps1`, Plan/Apply/Rollback with a plan hash). No Terraform variable sets them: PR 1a writes them into new task-definition revisions cloned from the serving API and worker revisions, and `scripts/deploy.sh` carries them forward on later deploys.

| PR | Environment variable | Values | Default | Notes |
|---|---|---|---|---|
| PR 1 | `CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE` | `off`, `on` | `off` | Master plan flag `sharedTeachingResources`. Surfaced to the client only through `features.sharedTeachingResources`. |
| PR 1 | `CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS` | comma-separated school IDs | empty | Optional allowlist. With mode `on`, an empty list means every school. |
| PR 7 | `PASSPILOT_RULES_MODE` | `off`, `on` | `off` | Master plan flag `passpilotRules`. Reads `off` unless its four tables are RLS-admitted at runtime; PR 1a refuses `on` unless they are in the live `RLS_ENABLED_TABLES`. |
| PR 8 | `PASSPILOT_APPOINTMENTS_MODE` | `off`, `on` | `off` | Master plan flag `passpilotAppointments`. Same RLS precondition in PR 1a. |
| PR 9 | `PASSPILOT_REPORTS_MODE` | `off`, `v2` | `off` | Draft #583 adds the finalized mode to the governed tool. `v2` requires the complete preserved 128-table admission and exact API/worker report contract v2 plus authority-fence v1. |
| PR 10a | `CLASSPILOT_DAILY_USAGE_ROLLUP_MODE` | existing `legacy`, `shadow`, `set_based`; PR 10a adds `on` as an alias of `set_based` | unset = `shadow` | Existing variable (`src/services/scheduler.ts:906-913`). Unset on the live API and worker revisions (read-only check, 2026-09-29). PR 1a refuses `on` without a shadow-mismatch evidence file from three clean school days. |
| PR 10b | `CLASSPILOT_USAGE_ROLLUP_MODE` | `off`, `on` | `off` | Draft #563 requires both aggregate and completion-ledger admission on API/worker and compatible source-matched writers before `on`; incompatible admission reads `off`. |
| PR 10b, PR 11 | `CLASSPILOT_DIGITAL_USAGE_MODE` | `off`, `on` | `off` | Master plan flag `digitalUsage`. PR 1a refuses `on` unless `CLASSPILOT_USAGE_ROLLUP_MODE=on`. |
| PR 13+ | Presentation flags | decided with the design | off | Master plan flag `teacherPresentation`; waits for the PR 12 ADR. |

Two kinds of flag sit outside PR 1a on purpose:

- **Capability kill switches** (`CLASSPILOT_CAP_*`) and `CLASSPILOT_CAPABILITY_ROLLOUTS_JSON` entries, for example `CLASSPILOT_CAP_PRECISE_RESTRICTION_RESOURCES_V1`, are boolean (`true`/`false`) and change only through `scripts/deploy-classpilot-runtime-config.ps1`.
- **`CLASSPILOT_LIVE_VIEW_SIGNALING_ENABLED`** (PR 0A) is a boolean read through `envFlag` in `src/config/runtime.ts`, default off. With it off, the server refuses legacy Live View signaling. It is local and test only, has no production setter, and must never be enabled in production. PR 1a refuses it.

## Readiness vocabulary

Use these terms exactly, in this order of strength:

| Term | Meaning |
|---|---|
| IMPLEMENTED | The change exists in code or documentation. It says nothing about tests or deployment. |
| AUTOMATED-TEST VERIFIED | The automated tests that cover the change pass locally and in CI. |
| BROWSER VERIFIED | A real-browser test exercised the changed behavior. |
| MANAGED-CHROMEBOOK VERIFIED | The exact build ran on Google Admin-managed Chromebooks (at least two for an extension release) and the listed checks passed. |
| LOAD VERIFIED | Measured under a representative load profile, with recorded results. |
| DEPLOYED | Running in production (image and task definitions, or a published extension), with the flag state stated. |
| PRODUCTION VERIFIED | Observed working in production with recorded evidence. |

Do not call something production verified unless it actually is. At merge time a PR claims at most AUTOMATED-TEST VERIFIED, or BROWSER VERIFIED when a browser test for the change actually ran. Local browser harnesses never stand in for managed-Chromebook acceptance, and passing synthetic tests never make Present to Class production-ready.

## Deployment safety report

Every PR description answers all 20 items below, in order. Write "N/A because …" instead of omitting an item. The list and the readiness wording are copied verbatim from the master plan.

For every PR report:

1. What changed
2. Files changed
3. Schema changes
4. RLS changes
5. Capabilities added/changed
6. Feature flags
7. Tests added
8. Tests run
9. Test results
10. Backward compatibility
11. Tenant/security review
12. Manual tests remaining
13. Managed Chromebook tests remaining
14. SchoolPilot deployment required?
15. Extension release required?
16. AWS change required?
17. Deployment order
18. Rollback steps
19. Production-readiness state
20. Remaining legacy Live View/TURN dependencies

Use precise readiness wording:

- IMPLEMENTED
- AUTOMATED-TEST VERIFIED
- BROWSER VERIFIED
- MANAGED-CHROMEBOOK VERIFIED
- LOAD VERIFIED
- DEPLOYED
- PRODUCTION VERIFIED

Do not call something production verified unless it actually is.

## Decisions taken

These decisions were taken for wave 1 on 2026-09-29. Flipping one needs an explicit decision before implementation of the affected PR starts.

1. PR 2 stores resources as a jsonb column on `flight_paths`, not a new tenant table.
2. Precedence: teacher block beats Waypoint (today's DNR, and the master plan's list); the extension's JS listener is fixed to match. Teacher block priority stays 800.
3. Rule override is admin/school_admin/super_admin only; office_staff cannot override. Encounter denials are visible by code only to those roles.
4. Capacity and encounter counts consider today's active passes only (no auto-expiry job exists).
5. Wave-1 production flags are flipped only through the new governed script (PR 1a); no Terraform seed vars are added (deploy.sh renders from serving revisions).
6. Auto-approval (`kioskRequiresApproval`) stays unenforced and unsurfaced in wave 1.
7. PR 10 is split into 10a (hardening) and 10b (new table + API), and daily-rollup promotion needs three clean shadow days.
8. Present to Class: the 2026-09-30 continuation authorizes the hosting/security/cost ADR for Brian's decision. Media implementation, provisioning and spending remain blocked until that decision is approved.

## Coordinated ClassPilot extension candidate (2.9.7)

Extension work for Phases 2 and 3 ships as one ClassPilot release after its server contracts are available and acceptance passes. The owner selected `2.9.7` to follow the verified live 2.9.6. This is not a Store publication claim. Verify publication and pending submissions immediately before upload. Bind precise/Focus activation to the reviewed source, exact ZIP, automated results and scoped live-validation waiver. Contract summary:

- **Capabilities.** Append `preciseRestrictionResourcesV1` and `focusTabV1` to the extension's advertised/scoped-dependent sets; use them only when negotiated. Align manifest, release pins, package guard and version-specific release notes after verifying the chosen successor. Update `SCHEDULED_CLASSROOM_PROTOCOL.md` for the new fields.
- **Restriction fields.** Port the precise resource normalizer/matcher for `restrictions.flightPath.resources` and `restrictions.screenLock.resource`, asserted against the shared case file. Parse `restrictions.focus` separately under the final reviewed Focus server/ACK/lifecycle contract.
- **Old code fails closed.** Precise restrictions are persisted in a form a legacy restore through 2.9.6 rejects, so a downgrade never restores a domain-wide lock.
- **Unified precedence.** One pure `decideNavigation(url, policy)` drives DNR and navigation listeners using the normative pairwise table. Test temporary allow priority 900 without destination restrictions and 100 with a Waypoint/Flight Path, including teacher block 800. Publish the same table in `SCHEDULED_CLASSROOM_PROTOCOL.md`; do not replace its conditional cases with a flat hierarchy.
- **Main-frame DNR shapes** with anchored matching (never substring `||host/path` rules), a regex budget checked before touching Chrome, SPA navigation enforcement, and startup reconciliation of stale rules.
- **Focus** re-activates the focused tab at most every 2 seconds, never during sign-in, is invalidated when the tab closes or leaves policy, and always yields to restrictions. **Bring Forward** is a transient `activate-tab` command that requires `focusTabV1` and reports `activated`, `stale_tab_ref` or `unsupported`.
- **Release gate.** Final-source and exact-package lifecycle harnesses pass locally and in CI before the authorized upload. Record the two-managed-Chromebook prerequisite as `waived_not_passed`; complete at least 30 sample-bearing minutes of current-school live acceptance before governed global promotion. The precise pilot binds the exact package and approval evidence.

## Present to Class direction

- **ADR first.** PR 12 writes `docs/TEACHER_PRESENT_ARCHITECTURE.md` for a hosting/security/cost decision. No media implementation, provisioning or spending starts until Brian approves it (Decision 8).
- **Options compared.** Compare LiveKit Cloud and self-hosted LiveKit in AWS using dated official prices, participant minutes, outbound data, idle resources, TURN/TLS, revocation and operating effort. The continuation evaluates managed SFU first; Brian must approve hosting, privacy and budget before implementation or provisioning. An S3/CloudFront frame relay does not satisfy the selected SFU topology.
- **TURN for the new SFU.** Client-to-SFU over WebRTC/UDP is preferred, with TURN/TLS as the fallback for restrictive school networks. TURN is not the fan-out system; the SFU distributes media. The default direction is the TURN capability integrated with the new LiveKit/SFU stack (UDP, TCP fallback, TURN/TLS, port 443 where appropriate, short-lived access, reliable Chromebook behavior). Reusing the parked legacy coturn nodes is considered only if it shows a clear reliability, operational or meaningful cost advantage. The parked coturn nodes are never restarted because the new feature needs TURN.
- **Privacy.** Live only, no recording, no media in PostgreSQL, Redis, S3 or logs. The current Live View and TURN wording on the legal pages (`PrivacyPolicy.jsx`, `TermsOfService.jsx`, `Subprocessors.jsx`) is reviewed in the PR 12 privacy review, not in Lane 0.

## Wave-1 status (2026-09-30)

All wave-1 pull requests are merged to `main`. The rows below preserve readiness recorded at merge, not current production evidence. No current production deployment or activation was verified in this continuation: both are UNKNOWN. Default-off repository settings and green CI do not establish serving configuration. Each operational activation remains a separate reviewed step.

| PR | GitHub | What it adds | Readiness at merge |
|---|---|---|---|
| PR 0 | #549 | This roadmap and the legacy media audit | IMPLEMENTED (docs) |
| PR 0A | #551 | `prevent_destroy` on the retained TURN identity, TURN parity in the HA profile, the default-off Live View signaling gate | AUTOMATED-TEST VERIFIED; a production plan-only run for `module.turn` at the merged head showed 0 to add, 0 to change, 0 to destroy |
| PR 1-pre | #547 | The AI assistant lists only the teacher's own Flight Paths; administrators keep the school view | AUTOMATED-TEST VERIFIED |
| PR 1a | #552 | The governed product runtime tool, `scripts/deploy-product-runtime-config.ps1` | AUTOMATED-TEST VERIFIED against mocked AWS; never run against AWS |
| PR 1 | #553 | School Library: shared and Official Flight Paths and Block Lists | AUTOMATED-TEST VERIFIED |
| PR 2-pre | #550 | The fence that withholds precise restriction state wherever it cannot be delivered safely | AUTOMATED-TEST VERIFIED |
| PR 2 | #555 | Structured restriction resources, `preciseRestrictionResourcesV1`, registry projection in the runtime-config tool, the rollback clear CLI and `CLASSPILOT_PRECISE_RESTRICTIONS_CONTRACT.md` | AUTOMATED-TEST VERIFIED; independently reviewed twice before merge |
| PR 7 | #554 | PassPilot rules: daily and period limits, destination capacity, encounter restrictions, administrator override, denial records | AUTOMATED-TEST VERIFIED; BROWSER VERIFIED by automated Chromium flows |
| PR 10a | #548 | Shadow-safe hardening of the daily usage rollup | AUTOMATED-TEST VERIFIED |
| PR 10b | #556 | `classpilot_usage_rollups` and the administrator Monitored Browser Time API | AUTOMATED-TEST VERIFIED; not LOAD VERIFIED |
| Security | #557 | `engine.io` 6.6.11 for GHSA-2gc4-cqfq-p2gv | CI |
| Matcher follow-up | #559 | YouTube parameter/path and escape hardening; service-bound rollback clear | Merged; AUTOMATED-TEST VERIFIED |
| Deployment clarification | #558 | Backend/frontend release and independent activation order | Merged; IMPLEMENTED (docs) |

The matcher follow-up is merged in #559. The canonical shared fixture SHA-256 is `4ff6b3311bcf6937a776deb5c5eec60de98d7d74e9dc963bf762a842b440d243`; ClassPilot must pin and exercise this exact fixture.

### Continuation gap matrix (2026-09-30)

Labels below are work slices, not GitHub PR numbers. New PRs record their actual number and evidence when created.

| Slice | Draft implementation and local evidence | Remaining acceptance dependency |
|---|---|---|
| C1 confidentiality | #566 corrects public serialization in both Rules modes while preserving authorized audit access; regressions reproduce the baseline leak | Review/compatible release before Rules activation |
| C2 usage correctness | #563 adds atomic successful-day coverage including empty days, processed cutoff, explicit unavailable dates, appended ledger admission and compatible-writer fencing | Database admission on both services and deployed compatibility; no historical completion inference |
| W2 precise UI | #567/#571 add normalized previews, broader-site warnings, Section wording and explicit Classroom boundary selection | Current-head CI and combined extension/device acceptance |
| W2 browser enforcement | ClassPilot #119 ports final #555/#559 fixtures, DNR/navigation matching, prior-policy retention and honest failed installation | Exact package, required Chrome CI, waived-not-passed device prerequisite and documented current-school live acceptance |
| W2 Focus contract | #565/#572/#575 and ClassPilot #120 implement exact tab references, validated open receipts, transient Bring Forward and persistent/cleanup Focus | Current-head CI, exact package and managed-device acceptance |
| W2 Classroom actions | #582/#577 verify reviewed resources, content revision and actual applied restriction before each successful student's Open; combined real HTTP/UI regression passes | Current-head CI and extension/device gate for Focus/precise actions |
| W2 appointments | #570/#573/#574/#579 implement atomic manual activation, calendar eligibility/races, manager scheduling and staff-only reminders | Required CI, appointment admission and source-matched writer contract; later governed activation |
| W2 reports | #583/#584 implement server summaries, raw valid durations, historical authorization, paginated history and audited formula-safe exports | Required restricted-role CI and separately authorized Reports v2 activation |
| W2 usage page/load | #568 implements coverage-aware administrator page; #569 records initial 1m workload; #586/#591 pass the bounded 84k-grain school-day profile, including two unchanged combined-source runs with nonempty AI and full current 128-table forced-RLS admission; #592 preserves canonical assignment constraints | Conservative worker headroom is 4.80%; operational shadow/observation remain pending. Extreme 500k-grain writing, dense retained-year/fleet capacity and RDS I/O remain unaccepted |
| W2 SFU ADR | #561 provides dated official pricing, privacy/revocation design and a proposed managed-service cap | Hosting/privacy/budget approval before media implementation or provisioning |

After C1/C2 pass review, advance browser, staff-workflow and reporting lanes in parallel. Give shared schema/RLS/protocol/runtime-tool edits one owner at a time. Use isolated fresh-main worktrees; preserve unrelated draft Observe work. The release checklist is `REMAINING_ROADMAP_RELEASE_CHECKLIST.md`.

### Activation sequence (not started)

Every step respects the AWS cost rollout's windows: no production `scripts/deploy.sh` run or runtime-config apply from Wednesday evening through Thursday evening, 2026-09-30 to 2026-10-01.

1. Deploy current `main`, backend then frontend, with every new mode off. This ships the Live View signaling gate, the assistant fix, the precise-restriction fence and every new migration.
2. Reconcile the actual live RLS inventory, then admit only missing reviewed bundles in chain order: Rules before existing usage aggregates, followed by the new usage completion ledger and later appointment admission. Preserve historical 125/126 inventories; do not use them as an assumed live baseline or rerun already-admitted bundles. Modes stay off.
3. Daily usage rollup: after three clean shadow school days on that build (rows with `mode = shadow` only; the query is in `SCALE_READINESS.md`), promote `CLASSPILOT_DAILY_USAGE_ROLLUP_MODE` with the PR 1a tool.
4. Digital Usage: only corrected compatible writers/readers with complete RLS admission may run. Turn rollup mode on with the governed product tool, observe one school day on that deployed build, then consider Digital Usage activation. Build and test the administrator page with synthetic fixtures before this operational gate if useful.
5. PassPilot rules: C1 confidentiality regression tests must pass before activating Rules through the product tool.
6. School Library: turn `CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE` on with the PR 1a tool, optionally limited to a pilot school through `CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS`.
7. Precise restrictions and Focus: require exact packaged automated evidence and the scoped live-validation waiver. Bind the governed pilot profiles only after automated acceptance, and require sample-bearing live acceptance before global promotion. Precise serving and approved rollback images must both contain #550; rollback follows disable, clear incompatible state, then compatible image. No upload or activation is authorized by this checklist.

## Phase 0 and 0A status (2026-09-29 evening)

| Item | State | Source |
|---|---|---|
| Parking code, #541 (merged 2026-09-28 23:55 ET, `67bb46e6`) | `classpilot_turn_parked`, the pinned AMI `ami-052355af2a014bd2c`, `aws_ec2_instance_state` for both nodes, `prevent_destroy` on both `aws_instance.turn` nodes (the CloudFormation secret stack already had it), and `docs/CLASSPILOT_TURN_PARKING.md` | Repository |
| TURN A and B (`i-0685f7c1550bf6b6a`, `i-0b69609a16334733e`) | Stopped since 2026-09-28 (EC2 `StopInstances`) and still stopped | `CLASSPILOT_TURN_PARKING.md`; read-only `aws ec2 describe-instances`, 2026-09-29 evening |
| Saved TURN Terraform plan | Applied 2026-09-29, 16:47–17:17 ET. `module.turn` now plans 0 to add, 0 to change, 0 to destroy | Verified by the cost-plan session |
| Parked node alarms | The four node alarms (`…-turn-a/b-status-check`, `…-turn-a/b-log-storage`) have actions disabled and treat missing data as not breaching | Read-only `aws cloudwatch describe-alarms`, 2026-09-29 evening |
| Runtime-config tool, #545 (merged 2026-09-29 10:24 ET, `ec1b6ef9`) | `liveViewIceServersV1` retired in the tool; no profile turns it on or carries TURN inputs | Repository |
| `live-view-retire` Plan and Apply | Ran on the evening of 2026-09-29. API `schoolpilot-production-api-emergency:161`, worker `schoolpilot-production-scheduler-worker:177`, `CLASSPILOT_CAP_LIVE_VIEW_ICE_SERVERS_V1=false`, registry entry `{"mode":"off"}` | Verified by the cost-plan session; confirmed by read-only `aws ecs describe-task-definition` |
| Legacy TURN runtime wiring | `CLASSPILOT_TURN_HOSTS`, `CLASSPILOT_STUN_URLS` and the `CLASSPILOT_TURN_REST_SECRET` reference remain on both live revisions, copied unchanged as designed; they are removed only in Lane D | Read-only `aws ecs describe-task-definition` |
| PR 0 (this document and `CLASSPILOT_LEGACY_MEDIA_AUDIT.md`) | IMPLEMENTED (docs), merged | #549 |
| PR 0A | Merged; not deployed as of merge (IMPLEMENTED, AUTOMATED-TEST VERIFIED). Literal `prevent_destroy` on both Elastic IPs, both Elastic IP associations, both Route 53 records, the security group, and the IAM role, inline policy, SSM attachment and instance profile, so with the instances and the secret stack all ten retained identity resources are guarded; TURN parity for `infra/production-ha-2000.tfvars`, so every HA plan needs `TF_VAR_classpilot_turn_tls_email`; the default-off WebSocket signaling gate `CLASSPILOT_LIVE_VIEW_SIGNALING_ENABLED`, which `classroomActivityCapabilities().liveView` follows. The gate takes effect with the next backend deploy. The Terraform change needs no apply; the next reviewed production plan must show No changes for `module.turn` | #551 |

Both operational applies that gated PR 0A, PR 2 and PR 3 are done. The tool-SHA rule still governs every later runtime-config Plan and Apply.

## Cross-references

- `CLASSPILOT_LEGACY_MEDIA_AUDIT.md`: A–E inventory of Live View and legacy TURN, protection status and deletion order.
- `CLASSPILOT_TURN_PARKING.md`: parking status, restart conditions and procedure, decommission prerequisites.
- `CLASSPILOT_TURN_OPERATIONS.md`: historical TURN provisioning and activation record.
- `CLASSPILOT_RUNTIME_CONFIG_OPERATIONS.md`: runtime-config tool operations, including "Live View ICE is retired".
- `CLASSPILOT_ROADMAP_RUNTIME_ROLLOUT.md`: capability rollout and rollback rows.
- `CLASSPILOT_ROADMAP_IMPLEMENTATION.md`: the September 6, 2026 release and evidence record.
- `CLAUDE.md`: repository guidance, including "ClassPilot Realtime and Live View" and "Launch cost rollout".
