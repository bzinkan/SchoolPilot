# ClassPilot roadmap implementation

The accepted scope covers Safety Center, review-first notifications, website policy enforcement, after-hours Safety only, screenshot reliability, historical browsing, complete scheduling, monitoring interruptions, OneRoster/Clever reconciliation, and content categories.

## Confirmed product locations

- Safety Center: ClassPilot Admin panel, below Coverage and immediately above Database Cleanup. Route `/classpilot/admin/safety`.
- Scheduling: Class Management tabs `Classes | Scheduling | Schedule Changes`. Route `/classpilot/admin/classes/scheduling`.

## Implemented behavior

Code is on `codex/classpilot-roadmap` in SchoolPilot and the separate ClassPilot extension repository. No production deployment, five-second activation, or Chrome Web Store release has occurred.

| Area | Implementation |
| --- | --- |
| Safety Center | Student cases with individual alerts, review/assignment/closure, encrypted exact-URL approvals and revocation, school website blocking, evidence and delivery status. |
| Notifications | Shared browser/MailPilot administrator outbox, repeated-observation merging, initial email regardless of severity, bundled delivery, one follow-up, bounded retries and explicit uncertain delivery. |
| Review first | AI processing issues no closure commands; explicit classroom and school policies retain their own authority. Legacy settings cannot restore automatic AI closure or silence required administrator notifications. |
| Alert precision | Official NWEA domains bypass the model as educational; self-harm rules require more than a bare topic or generic prevention/help search. Model cache and concurrent request identity include the exact URL and title, preventing safety judgments from spreading between pages on a website. |
| Runtime | Authoritative school-local off/Safety only/full policy, merged settings validation, readonly school-profile timezone, capability gates, restricted collection transitions, exact-binding website policy acknowledgements and reconnect recovery. |
| Screenshot efficiency | Publication shares the validated pixel upload authority transaction. Existing timestamp ordering, observation scope and background-publication suppression remain enforced. |
| History | Retention-aware school-local dates, bounded cursor pagination, frozen historical teacher authority, context-change cancellation and explicit unavailable/expired/denied states. |
| Scheduling | Weekdays, terms, fixed times or named periods, Regular/Early Release bell profiles, A/B instructional-day rotation, weekend makeup dates with mapped weekdays, calendar previews, swaps and frozen occurrence preservation. One occurrence per class/local date. |
| Schedule Profiles | Reusable named grade/class templates with custom times, skipped meetings and optional paired Coverage testing groups. Dated preview/apply snapshots, customize-this-use, future cancellation, normal schedule restoration, exact-scope timed supervision and durable activation status. No roster reassignment or email notification. |
| Monitoring | Durable scoped interruption episodes, batched scheduler detection/recovery, infrastructure uncertainty, Coverage/IT indicators and an opt-in end-of-day administrator digest. |
| OneRoster/Clever | Streamed OneRoster 1.1/1.2 bulk ZIP validation, mapping/named before-and-after preview/apply/results, source ownership, resumable checkpoints, encrypted provider tokens, nightly Clever sync and incomplete/removal holds. Delta packages, custom-role mapping and timed membership activation are outside this adapter's initial contract. |
| Categories | Twenty nullable labels through classification, realtime, history and immutable v3 report/CSV breakdowns, plus contextual weapons/hate/gambling safety rules. |

The tile renderer retains the existing cohort frame carry-forward, viewport grace and decoded-image transition behavior. Browser regression gates verify those behaviors; rendering changes are not added without a reproduced defect.

Administrator guidance is in `CLASSPILOT_SAFETY_CENTER.md`, `CLASSPILOT_SCHEDULING.md`, `CLASSPILOT_MONITORING_INTERRUPTIONS.md`, `CLASSPILOT_BROWSING_HISTORY.md`, and `ROSTER_INTEGRATIONS.md`. Runtime capability, metrics and rollback details are in `CLASSPILOT_ROADMAP_RUNTIME_ROLLOUT.md`; mail replay/cursor recovery is documented in `MAILPILOT_DURABILITY.md`.

## Local verification

The release checks exercise real local PostgreSQL transactions, isolated forced-RLS databases, browser interaction and the packaged extension. Email delivery tests use controlled transports; they do not send administrator notifications to a live school.

The reusable Schedule Profiles follow-up completed a full serial backend run with 2,040 passing tests, eight skips and no failures. After the final frozen-occurrence and inactive-class compatibility fixes, the rebuilt focused scheduling run passed all 71 tests. Fresh isolated forced-RLS verification passed 124 tests with one Redis-dependent skip across the 90-table target. Frontend lint, build, the existing scheduling browser gate and the new desktop/mobile profile workflow gate passed; browser API responses were controlled fixtures. This is local verification, not live-school or production deployment evidence.

- Backend build and application TypeScript checks pass. The existing test-only TypeScript ratchet passes at 439 diagnostics against its 534-diagnostic baseline; this does not mean the historical test typing debt is zero. The unsafe test-cast ratchet also passes without increasing its baseline.
- The broad serial backend run completed 1,975 tests: 1,966 passed, eight skipped and one stale source-contract assertion failed. That assertion was updated for the shared locked tracking-settings reader; its complete 27-test suite then passed. The behavioral screenshot/calendar races passed in the broad run.
- After the final notification batching change, a fresh build and all 53 focused Safety Center, notification, retention and MailPilot checks pass without skips. New database regressions cover 41 waiting alerts, interleaved recipients, three concurrent workers, whole-bundle deferral on a locked row and retry/unknown outcomes. Queue limits no longer manufacture additional emails from an already-waiting report.
- The subsequent alert-precision update passes 102 focused checks without skips after a fresh build. Fixtures cover twelve official NWEA URLs with zero provider calls, lookalikes, benign prevention/education and explicit harm boundaries, safe/unsafe cache isolation in both directions, query/fragment/title changes, out-of-order requests, and the ten-active/100-queued provider budget. The same run verifies administrator deduplication, review/approval, bundled notifications and the single follow-up. Model responses are stubbed; these checks establish deterministic behavior and isolation, not a measured production model false-positive rate.
- The backend dependency audit passes the high-severity gate: zero critical/high and eleven moderate findings on unchanged dependencies. The added ZIP parser and its dependencies introduce no advisory reported by this audit.
- Fresh isolated forced-RLS verification passes 123 tests with one expected skip, including the fifteen added tenant tables, cross-school parent constraints and configuration survival after source retention.
- Three Redis integration checks pass against a temporary loopback-only Redis 7 instance, including duplicate relay delivery and ordered publication after subscriber reconnect. The instance was removed after verification; the existing development cache was not changed.
- Frontend lint, production build and the release-focused suite pass. The final focused browser runs additionally cover Safety Center acknowledgment without assessment, independent report pagination, URL approval/block actions, readonly canonical monitoring timezone, and a 52-change roster preview requiring two review pages.
- Extension type checking, all 161 unit tests in eighteen files and its build pass. All seven checks against the final canonical validation package pass in Chrome. Nineteen packaged files match source byte-for-byte. This is local browser evidence, not managed-Chromebook adoption evidence.
- `pwsh -NoProfile -File tests/classpilot-runtime-config-deploy.test.ps1` passes 628 mocked deployment assertions, including the schema-v7 school pilot/off profiles, preservation of unrelated capabilities, exact API/worker parity and rollback. No AWS mutation is part of that test.
- Near-limit OneRoster parsing was exercised with a 244.7 MiB expanded, 2.53 MiB compressed fixture. Its measured peak RSS was 106 MiB. This bounds that representative fixture only; production vendor compatibility still requires approved sample exports.

The locally prepared extension manifest remains `2.8.4`. The validation package SHA-256 is `3a3bc1b2176c551fc978d6cd2140c265a799e2610f764724726b745d8f2be867`. This records the tested bytes, not the live Chrome Web Store version or an upload-ready release from a clean tagged commit.

## Migration and activation sequence

The eight additive checksum-ledger migrations cover Safety Center, school scheduling, reusable schedule-profile supervision, roster integration, website-policy delivery, category columns, monitoring interruptions and MailPilot durability. Nonproduction convergence applies the same definitions after schema creation. The Safety migration consolidates duplicate open cases, preserves link redirects and moves evidence references without rewriting exported packets.

The RLS registry preserves the historical 72-table observation and the existing 75-table target. Its separate roadmap target contains 90 tenant tables. CI exercises all 90; Terraform's configured baseline stays at 75 until the documented production admission and catalog checks succeed. The first full expansion uses the exact fifteen-table `classpilotRoadmap` request from the registry. Feature-specific registered bundles support deliberate later re-admission; do not invent partial bundles or preload Terraform to bypass the admission guard.

Deploy and verify migrations before API/worker activation. Deploy SchoolPilot API/frontend and the ClassPilot extension separately. Keep new client-dependent behavior disabled when its capability is absent. Report saved school policy independently of current connected-client acknowledgement.

Pilot administrator notifications and exact-URL review before broad exposure. Pilot scheduling on a complete approved calendar. Validate representative vendor exports and review identity mappings before enabling import automation. Category report v3 requires its explicit rollout gate; already materialized report versions stay immutable.

Before activation, compare the school-profile timezone with any legacy settings timezone and confirm the intended clock. ClassPilot uses `schools.school_timezone` consistently; this release does not synchronize other products' legacy timezone settings. Confirm the dedicated scheduler worker has tenant RLS enabled, the encryption key and email provider are configured, and actual administrator delivery works in the pilot. Clever automation begins only after the first administrator-reviewed import.

## Release gates

Keep code implementation separate from production activation evidence. Five-second previews require fresh 40/500/800 fully observed profiles and managed-Chromebook checks. Clever requires provider onboarding and a district pilot. Vendor OneRoster compatibility requires representative approved exports. The extension ships independently through its canonical packaging and Chrome Web Store process, with the live Store version checked immediately before a successor upload.

The five-second rollout tool currently pins artifact admission to `v2.8.2`. Before activating a later selected extension release, review its release admission and matching runbook, update the required tag and artifact references together, and rerun the strict receipt and capacity checks. The local `2.8.4` validation package does not satisfy that older pin and must not bypass it.

Do not claim the historical paused load campaign or local Chrome harness as managed-school acceptance. Redis replication remains a measured availability/capacity decision. No SMS, category blocking, automatic student deactivation or new parent notification workflow is introduced.

Preserve historical exports and retained audit/report data during rollback. New migrations are additive and recorded in the checksum ledger; run tenant isolation checks before dependent application activation.
