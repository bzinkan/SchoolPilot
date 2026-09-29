# SchoolPilot competitive roadmap

Status: canonical forward roadmap, adopted 2026-09-29. It does not supersede `CLASSPILOT_ROADMAP_IMPLEMENTATION.md`, which remains the September 6, 2026 release and evidence record.

This document turns the product owner's eight-phase master plan into a sequence of safe, independently deployable pull requests. It records the product model, the engineering rules every PR follows, the PR order and its hard constraints, the capabilities and flags each PR adds, and the Phase 0/0A status. The retired Live View and parked TURN inventory, with its A–E classification and deletion order, is in `CLASSPILOT_LEGACY_MEDIA_AUDIT.md`.

The master plan also sets three standing prohibitions: do not implement the roadmap in one PR, do not deploy production infrastructure or publish a Chrome Web Store extension automatically, and do not permanently destroy legacy TURN resources during the cost-reduction phase.

Line references are to SchoolPilot `origin/main` at `a811b04d` and ClassPilot `origin/main` at `55bb531` (extension 2.9.6). They drift; re-locate each anchor by symbol before editing. A PR that changes a status row in this document updates it in the same PR.

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

- **New tenant table ceremony** (precedents #503, #530): schema in `src/schema/passpilot.ts` or `src/schema/classpilot.ts` (both are in the `drizzle.config.ts` push list, so the CI database job creates the table); migration module `src/db/<name>Migration.ts` modeled on `src/db/passpilotKioskScheduleMigration.ts` (`school_id TEXT NOT NULL REFERENCES schools(id)`, `ENABLE` and `FORCE ROW LEVEL SECURITY`, a `tenant_isolation` policy with the exact predicate `src/db/rlsEnforcement.ts` checks); added to `schoolPilot27Migrations` before `staffIdentityIntegrityMigration` in `src/db/migrations27.ts`; mirrored in `runStartupMigrations` (`src/index.ts`); a new `rlsRegistry.json` inventory `<name>PostExpand` and `reviewedEnablementRequests.<name>`; `src/db/rlsPolicies.ts` constant, `currentInventory` and `assertRlsRegistryIntegrity` list; `infra/main.tf` (`rls_post_expand_tables` and its check); `infra/tests/mydesk.tftest.hcl`; `RLS_ENABLED_TABLES` in `.github/workflows/ci-build.yml`; `tests/rls-registry-consistency.test.ts`, `tests/deploy-rls-table-enablement.test.ts`, `scripts/run-local-workspace-tests.ps1`, `scripts/load/paperwork/run-split.ps1`; and the RLS block of `tests/cross-tenant-isolation.test.ts`. Feature PRs never edit `infra/production.tfvars` `rls_enabled_tables`; production admission is `scripts/deploy.sh production --backend --enable-rls-table <bundle>` once, with baseline adoption later (the #533 pattern). Same-school foreign keys use `students_school_id_id_unique`, `groups(school_id, id)` and `teaching_sessions(school_id, id)`.
- **Test lanes**: cross-school RLS assertions belong in an `RLS_SERIAL` file (`scripts/run-test-lane.mjs`). The `DB_SERIAL` lane runs as the PostgreSQL superuser and proves nothing about policies. A new frontend `schoolpilot-app/scripts/*.test.mjs` needs an npm script in `schoolpilot-app/package.json` and a step in `ci-build.yml`.
- **Flags**: exact `off|on` environment modes parsed like `src/config/mydeskModes.ts`; a malformed value reads as `off`. Mode readers for PR 7 and PR 10b return `off` unless `RLS_GUC_ENABLED === 'true'` and `parseRlsEnabledTables()` contains every table of their bundle, so a missing RLS admission fails closed at runtime.

## Phases

The master plan's phases, with the PRs that implement them. Status is as of 2026-09-29.

| Phase | Master plan name | PRs | Status |
|---|---|---|---|
| 0 | Current-state audit + legacy TURN cost reduction | PR 0, PR 0A, operational stop | Parking shipped (#541) and applied; audit in this PR; PR 0A hardening pending |
| 1 | Shared Flight Paths + Block Lists | PR 1-pre, PR 1a, PR 1 | Planned (PR 1-pre open as #547) |
| 2 | Precise Restriction Engine for Waypoints + Flight Paths | PR 2-pre, PR 2, PR 3, PR 4, ClassPilot 2.10.0 | PR 2-pre and PR 2 planned; PR 3–4 next plan cycle |
| 3 | Focus Tab + Bring Forward | PR 5, ClassPilot 2.10.0 | Extension contract defined; server PR next plan cycle |
| 4 | Google Classroom Assignment -> Open / Open + Focus / Open as Lesson | PR 6 | Next plan cycle |
| 5 | PassPilot Rules + Appointments + Expanded Analytics | PR 7, PR 8, PR 9 | PR 7 planned; PR 8–9 outlined |
| 6 | Digital Usage / Monitored Browser-Time Analytics | PR 10a, PR 10b, PR 11 | PR 10a and PR 10b planned; PR 11 outlined |
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
- A Waypoint contains exactly one destination. Entire Website stays the default. "This resource only" keeps the student in the selected activity without general access to the rest of the domain. "This section" is an optional later choice.
- A Flight Path contains one or more allowed resources, and the student may move among all of them.
- Provider-aware resource identity for YouTube videos, Google Docs, Forms and Slides, and Google Classroom assignments or materials where practical. `youtube.com/watch?v=ABC123` and `youtube.com/watch?v=ABC123&t=90` are the same resource; another video ID is not allowed.
- Enforcement restricts top-level (main-frame) navigation and leaves page subresources alone, using Chrome `declarativeNetRequest` and `webNavigation`.
- Google and Clever authentication pass-through stays tightly scoped and never becomes a general browsing exemption.
- Master plan precedence, approximately: Attention > School blocks > Teacher Block List > Waypoint / Flight Path > approved temporary authentication pass-through. Teacher allows never override administrator blocks. The wave-1 extension contract keeps today's DNR order, which places the tightly scoped authentication pass-through above the Waypoint so a restricted student can finish an approved sign-in (see "ClassPilot 2.10.0").
- Capability `preciseRestrictionResourcesV1`. Website restrictions keep working on older compatible clients. A section or resource restriction for a client without the capability fails closed with an honest unsupported-client outcome; one YouTube video is never converted into all of youtube.com.
- The exact wire contract is defined by PR 2 in `src/services/restrictionResources.ts` with a shared case file, `tests/fixtures/restriction-resource-matcher-cases.json`, whose SHA is pinned in both repositories.

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
- Appointments: scheduled appointment passes (for example, Student, Counselor, 1:15 PM) with school, student, destination, scheduled time, requesting staff, reason or notes, notification lead, status and timestamps. An upcoming appointment can notify the teacher or student. An appointment does not mark the student out of class before activation.
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

| PR | Scope | Lane | Status (2026-09-29) |
|---|---|---|---|
| PR 0 | Roadmap + legacy media audit (this document and `CLASSPILOT_LEGACY_MEDIA_AUDIT.md`) | 0 | IMPLEMENTED (docs) in this PR |
| PR 0A | Legacy TURN parking Terraform/documentation protections | 0 | Parking shipped in #541; hardening (more `prevent_destroy`, HA profile parity, WebSocket signaling gate) pending in its own PR |
| Operational | Stop legacy TURN A/B after explicit verification/approval | 0 | Done: stopped 2026-09-28; the saved TURN Terraform plan was applied 2026-09-29 |
| PR 1a (wave-1 addition) | Governed product runtime activation tool, `scripts/deploy-product-runtime-config.ps1` | 0 | Planned |
| PR 1-pre (wave-1 addition) | Scope the AI assistant's Flight Path list to the caller's own paths | A | Open (#547) |
| PR 1 | Shared Flight Paths + Block Lists | A | Planned |
| PR 2-pre (wave-1 addition) | Forward-compatibility fence one release before PR 2 | A | Planned |
| PR 2 | Structured restriction-resource backend/model | A | Planned |
| PR 3 | Precise Waypoint enforcement: Entire Website + This Resource | A | Next plan cycle |
| PR 4 | Mixed Website/Section/Resource Flight Paths | A | Next plan cycle |
| PR 5 | Bring Forward + Focus | A | Next plan cycle |
| PR 6 | Google Classroom Assignment quick actions | A | Next plan cycle |
| ClassPilot 2.10.0 | One extension release carrying `preciseRestrictionResourcesV1` and `focusTabV1` | A | Contract defined; ships after server PRs 2–5 |
| PR 7 | PassPilot Rules | B | Planned |
| PR 8 | PassPilot Appointments | B | Outlined |
| PR 9 | PassPilot Analytics | B | Outlined |
| PR 10a (split of PR 10) | Daily usage rollup hardening, shadow-safe | B | Planned |
| PR 10b (split of PR 10) | Digital Usage rollup table + read API | B | Planned |
| PR 11 | Digital Usage admin UI | B | Outlined |
| PR 12 | Present to Class SFU/LiveKit architecture ADR + new TURN/TLS design | C | Waits for the ADR decision |
| PR 13 | Presentation session/auth backend + short-lived SFU credentials | C | Not started |
| PR 14 | Teacher capture + SFU publisher | C | Not started |
| PR 15 | ClassPilot student SFU subscriber + presentation UI | C | Not started |
| PR 16 | Presentation Focus integration | C | Not started |
| PR 17 | AWS SFU/media infrastructure definitions + operations runbook | C | Not started |
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
| A | PR 1-pre, PR 1, PR 2-pre, PR 2, then PR 3/4/5/6 + ClassPilot 2.10.0 | PR 1 before PR 2 (PR 2 edits PR 1's files). PR 2 and PR 3 edit the runtime-config tool, so they merge only after the `live-view-retire` apply (Plan and Apply must share a tool SHA); that apply ran on 2026-09-29 |
| B | PR 7 → PR 8 → PR 9; PR 10a → ops → PR 10b → ops → PR 11 | The RLS inventory chain is serialized: each new-table PR re-points `infra/main.tf` (`rls_post_expand_tables`), `rlsPolicies.ts` `currentInventory` and the registry tests to its own inventory, in merge order (PR 7, PR 10b, PR 8) |
| C | PR 12 ADR, then PR 13–18 | Brian's ADR decision first |
| D | PR 19–21 | Only after Lane C is live and independent |

Near-term order: the two operational applies (done 2026-09-29) → PR 0 → PR 0A → PR 1-pre and PR 1a → PR 1 → PR 2-pre → PR 2; PR 7 and PR 10a in parallel.

### Hard ordering constraints

1. PR 0A merges only after the saved TURN Terraform plan and the `live-view-retire` runtime profile are applied. Both were applied on 2026-09-29.
2. PR 1-pre merges before PR 1, and PR 1 before PR 2.
3. Never merge a change to `scripts/deploy-classpilot-runtime-config.ps1` between a runtime-config Plan and its Apply; Plan and Apply must run from the same tool SHA (`CLASSPILOT_RUNTIME_CONFIG_OPERATIONS.md`). PR 2 and PR 3 edit that tool.
4. PR 2-pre is deployed, in an image that does not contain PR 2, before PR 2 is deployed.
5. Server before extension. ClassPilot 2.10.0 ships only after server PRs 2, 3, 4 and 5 are deployed with their capabilities off.
6. Lane B new-table PRs merge in the order PR 7, PR 10b, PR 8, each chaining its RLS inventory onto the previous one.
7. PR 10b waits for PR 10a plus its shadow evidence; PR 11 waits for PR 10b plus one observed day of rollups.
8. Lane C starts with the PR 12 ADR decision. Lane D starts only after Present to Class runs on its own media stack.
9. A feature rollout and a destructive legacy removal never share a deployment.

### Deployment-order rules

- **Migrations first.** Checksum-ledger migrations complete before the dependent API and worker rollout; startup migrations must report completion before rollout. Never edit a shipped migration.
- **Clean deploys.** Deploy from a clean `main` clone with CI green, including the SOC 2 approval job that `scripts/deploy.sh` gates on. Backend and frontend deploy as separate runs.
- **RLS admission.** A new tenant-table bundle is admitted once with `scripts/deploy.sh production --backend --enable-rls-table <tables>`; its mode stays `off` until a later governed Apply.
- **Flags off at deploy.** Production mode flags change only through a PR 1a Apply; capability kill switches and registry entries change only through `scripts/deploy-classpilot-runtime-config.ps1`. Nobody edits ECS task definitions by hand, and no Terraform seed variable is added for a wave-1 flag.
- **PR 2-pre before PR 2**, in separate images, as above.
- **Server before extension.** A SchoolPilot deploy never publishes or updates the extension. ClassPilot 2.10.0 is packaged from a clean tag after server PRs 2–5 are deployed, MANAGED-CHROMEBOOK VERIFIED on at least two Google Admin-managed Chromebooks, and only then uploaded to the Chrome Web Store by Brian.
- **The serving image must know every capability in the live registry.** `parseCapabilityRollouts` (`src/services/classpilotProtocol.ts:138-160`) treats any unknown key in `CLASSPILOT_CAPABILITY_ROLLOUTS_JSON` as an invalid registry, and an invalid registry turns every protocol-v3 capability off. The runtime-config tool writes an entry for every capability it registers, adding a missing additive capability as `{"mode":"off"}` (`scripts/deploy-classpilot-runtime-config.ps1:74-80` and `:2459-2476`). Therefore: deploy the server image that registers a new capability before any runtime-config Apply writes its entry; before reverting an image past a capability's introduction, remove that entry from the live registry (for example with `-Operation Rollback` of the Apply that added it); and PR 19 removes the live `liveViewIceServersV1` entry, or keeps the parser accepting that retired name, before it deletes the name from the server registry.
- **PR 2 rollback** (runbook in `CLASSPILOT_ROADMAP_RUNTIME_ROLLOUT.md`, added by PR 2): apply `precise-restriction-resources-off`, clear every active precise restriction with a control-revision bump, and only then revert the image, observing the registry rule above.
- **Legacy removal** follows the deletion order in `CLASSPILOT_LEGACY_MEDIA_AUDIT.md` and never ships with a feature rollout.

## Capabilities

All new capabilities default off and are negotiated, never inferred from an extension version. The two wave-1 capabilities join the scoped-authority dependent set, so they also require an accepted `scopedAuthorityChecksV1`.

| Capability | PRs | State | Kill switch | Set in production by |
|---|---|---|---|---|
| `preciseRestrictionResourcesV1` | PR 2 (server), PR 3 and PR 4 (enforcement), ClassPilot 2.10.0 (extension) | Designed in wave 1 | `CLASSPILOT_CAP_PRECISE_RESTRICTION_RESOURCES_V1` plus a registry entry | `scripts/deploy-classpilot-runtime-config.ps1`, pilot and off profiles in the existing `<name>-pilot` / `<name>-off` pattern (`precise-restriction-resources-off` is the rollback profile) |
| `focusTabV1` | PR 5 (server), ClassPilot 2.10.0 (extension) | Extension contract defined; server design in the next plan cycle | Named when PR 5 is planned (existing convention `CLASSPILOT_CAP_<NAME>`) | `scripts/deploy-classpilot-runtime-config.ps1` |
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
| PR 9 | `PASSPILOT_REPORTS_V2_MODE` | `off`, `on` | `off` | Outline name. Not in PR 1a's wave-1 allowlist; PR 9 adds it to that tool by review. |
| PR 10a | `CLASSPILOT_DAILY_USAGE_ROLLUP_MODE` | existing `legacy`, `shadow`, `set_based`; PR 10a adds `on` as an alias of `set_based` | unset = `shadow` | Existing variable (`src/services/scheduler.ts:906-913`). Unset on the live API and worker revisions (read-only check, 2026-09-29). PR 1a refuses `on` without a shadow-mismatch evidence file from three clean school days. |
| PR 10b | `CLASSPILOT_USAGE_ROLLUP_MODE` | `off`, `on` | `off` | Reads `off` unless `classpilot_usage_rollups` is RLS-admitted. |
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

IMPLEMENTED
AUTOMATED-TEST VERIFIED
BROWSER VERIFIED
MANAGED-CHROMEBOOK VERIFIED
LOAD VERIFIED
DEPLOYED
PRODUCTION VERIFIED

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
8. Present to Class: no design work until the PR 12 ADR is decided.

## ClassPilot 2.10.0

Extension work for Phases 2 and 3 ships as one ClassPilot release, 2.10.0, after server PRs 2–5 are deployed. The extension specialist owns the implementation in the ClassPilot repository. Contract summary:

- **Capabilities.** Append `preciseRestrictionResourcesV1` and `focusTabV1` to `EXTENSION_CAPABILITIES` and `SCOPED_AUTHORITY_DEPENDENT_CAPABILITIES`; use them only when negotiated. Version 2.10.0 in the manifest and the release pins, a new `CLASSPILOT_2_10_0_RELEASE.md`, and `SCHEDULED_CLASSROOM_PROTOCOL.md` sections for the new fields.
- **Restriction fields.** `restrictions.flightPath.resources`, `restrictions.screenLock.resource` and `restrictions.focus`, parsed with a verbatim port of PR 2's normalizer and matcher and asserted against the shared case file.
- **Old code fails closed.** Precise restrictions are persisted in a form a 2.9.x restore rejects, so a downgrade never restores a domain-wide lock.
- **Unified precedence.** One pure `decideNavigation(url, policy)` drives the DNR rules and every navigation listener, in today's DNR order: attention, school block, teacher block (priority 800), authentication pass-through, Waypoint (domain or resource), temporary allow, Flight Path (websites, sections and resources). This fixes the JavaScript listener, which today lets the Waypoint win over a teacher block. The full pairwise table is published in `SCHEDULED_CLASSROOM_PROTOCOL.md`.
- **Main-frame DNR shapes** with anchored matching (never substring `||host/path` rules), a regex budget checked before touching Chrome, SPA navigation enforcement, and startup reconciliation of stale rules.
- **Focus** re-activates the focused tab at most every 2 seconds, never during sign-in, is invalidated when the tab closes or leaves policy, and always yields to restrictions. **Bring Forward** is a transient `activate-tab` command that requires `focusTabV1` and reports `activated`, `stale_tab_ref` or `unsupported`.
- **Release gate.** New and extended lifecycle harnesses green locally and in CI, then MANAGED-CHROMEBOOK VERIFIED on at least two Google Admin-managed Chromebooks before Brian uploads the exact ZIP. The precise pilot profile refuses until it is bound to that ZIP's evidence.

## Present to Class direction

- **ADR first.** PR 12 writes `docs/TEACHER_PRESENT_ARCHITECTURE.md`. Nothing is deployed during ADR work, and no Present to Class design work starts until Brian decides the ADR (Decision 8).
- **Options compared.** The master plan asks the ADR to evaluate self-hosted LiveKit in AWS primarily (EC2 versus ECS, UDP networking, public IPs, Redis, room model, authentication, metrics, horizontal scaling, updates, failure handling, cost, TURN/TLS and managed-Chromebook compatibility). The 2026-09-29 assessment makes a managed SFU the default unless the ADR proves otherwise. The ADR compares three options: LiveKit Cloud (managed), self-hosted LiveKit in AWS, and an S3/CloudFront frame-relay MVP.
- **TURN for the new SFU.** Client-to-SFU over WebRTC/UDP is preferred, with TURN/TLS as the fallback for restrictive school networks. TURN is not the fan-out system; the SFU distributes media. The default direction is the TURN capability integrated with the new LiveKit/SFU stack (UDP, TCP fallback, TURN/TLS, port 443 where appropriate, short-lived access, reliable Chromebook behavior). Reusing the parked legacy coturn nodes is considered only if it shows a clear reliability, operational or meaningful cost advantage. The parked coturn nodes are never restarted because the new feature needs TURN.
- **Privacy.** Live only, no recording, no media in PostgreSQL, Redis, S3 or logs. The current Live View and TURN wording on the legal pages (`PrivacyPolicy.jsx`, `TermsOfService.jsx`, `Subprocessors.jsx`) is reviewed in the PR 12 privacy review, not in Lane 0.

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
| PR 0 (this document and `CLASSPILOT_LEGACY_MEDIA_AUDIT.md`) | IMPLEMENTED (docs) | This PR |
| PR 0A | Pending in its own PR: `prevent_destroy` on the Elastic IPs, Route 53 records, Elastic IP associations, security group and IAM resources; TURN parity for `infra/production-ha-2000.tfvars`; the default-off WebSocket signaling gate `CLASSPILOT_LIVE_VIEW_SIGNALING_ENABLED` | Wave-1 plan |

Both operational applies that gated PR 0A, PR 2 and PR 3 are done. The tool-SHA rule still governs every later runtime-config Plan and Apply.

## Cross-references

- `CLASSPILOT_LEGACY_MEDIA_AUDIT.md`: A–E inventory of Live View and legacy TURN, protection status and deletion order.
- `CLASSPILOT_TURN_PARKING.md`: parking status, restart conditions and procedure, decommission prerequisites.
- `CLASSPILOT_TURN_OPERATIONS.md`: historical TURN provisioning and activation record.
- `CLASSPILOT_RUNTIME_CONFIG_OPERATIONS.md`: runtime-config tool operations, including "Live View ICE is retired".
- `CLASSPILOT_ROADMAP_RUNTIME_ROLLOUT.md`: capability rollout and rollback rows.
- `CLASSPILOT_ROADMAP_IMPLEMENTATION.md`: the September 6, 2026 release and evidence record.
- `CLAUDE.md`: repository guidance, including "ClassPilot Realtime and Live View" and "Launch cost rollout".
