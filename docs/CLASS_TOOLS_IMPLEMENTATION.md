# ClassPilot Class tools implementation and rollout

## Scope and baseline

Implemented across SchoolPilot and the separate ClassPilot extension repository, on `codex/class-tools`. Baselines: SchoolPilot `70b881b` (through #490; messaging #481–483 retained) and ClassPilot `e3865f8` (manifest 2.9.1). This document describes unreleased work; it is not production deployment evidence.

The shared workspace has Help, Messages, Activities, and Tools tabs. The existing Dashboard navigation and Open URL, Manage Tabs, Waypoint, Flight Path, Block List, and Student Sign Out controls remain above the student grid. Desktop floating panels reserve toolbar space; pinned panels also reflow tiles. Below 1,024px the workspace becomes a drawer. Position, docking, and separate tool/message widths are private browser preferences scoped to teacher and school. Reset position restores their defaults. Arrow keys navigate tabs; the resize handle and move control support keyboard input. Escape restores focus to the opener. Countdowns tick independently of the grid.

Messages reuses the chat store, list, thread, composer, readiness helpers, transcripts, channel controls, and server read/delivery model. It keeps 500-character messages, quick replies, Got it, monotonic receipts, teacher read synchronization, soft pause versus hard-off, safety scanning, and clear/end distinctions. Hidden conversations do not mark incoming messages read. Details temporarily replaces the shared panel, preserving selection and drafts within the same authority. School, viewer, or authority changes retire drafts and queries.

## Delivered capabilities

| Phase | Implementation |
| --- | --- |
| 1 | Shared floating/pinned workspace, adaptable Messages, separate counters, recipient labels, countdown, attention controls, built-in quick checks |
| 2 | Unified legacy/typed help, acknowledgement and withdrawal, private grouped questions, server-revisioned pause/resume/extend timers, saved attention and poll templates |
| 3 | Pinned lesson directions/resources/checklist, explicit work status, choice/text exit tickets, exact-recipient follow-up previews, retained history |
| 4 | Participation rounds/exclusions/pass, separate Yes/Pass volunteer prompts, independently serialized authenticated presentation view |
| 5 | Private templates and explicitly advanced routines; preparation before prompt launch, transactional step reservations, original-binding retries for eligible unsuccessful targets |

Student free text is limited to 500 characters and uses the existing lexical safety classification and audit paths. Class tools does not send these new submission types to an AI provider. Lesson links use normal browser navigation and remain subject to existing website restrictions. No activity status, checklist action, or timer completion automatically creates help or advances a routine.

## API and persistence

`src/routes/classpilot/classTools.ts` mounts under `/api/classpilot`. Staff requests require the current school, licensed/full-monitoring access, allowed staff role, and the existing canonical classroom authority. Scheduled requests also carry `X-ClassPilot-Context-Authority-Revision`. Mutations use `{teachingSessionId|supervisionContextId, data}`. Student endpoints derive identity/device binding from authentication, validate current student control revision and individual negotiated capabilities, and never accept teacher-facing device targeting.

- Reads: `/class-tools/rollout`, `/state`, `/history`, `/history/:kind/:id`, `/presentation`.
- Staff writes: `/help/:id`, `/questions/:id`, `/picker`, `/templates`, `/templates/:id`, `/follow-up-preview`, `/follow-up`, `/routines`, `/routines/:id`.
- Student writes: `/student/class-tools/help`, `/questions`, `/progress`; exit tickets extend the existing poll response endpoint.
- Screen-changing work uses the canonical command dispatcher, including `lesson-activity`. Timer identity/revision and prompt identity are server-owned. Original recipients remain frozen for subsequent controls. Follow-ups keep the exact preview audience while canonical dispatch revalidates each student; moved or inactive students receive retained individual unavailable outcomes. Missing targets never mean broadcast.
- One active timer, lesson, routine, picker round, and response prompt per context. Poll and exit-ticket prompts share the existing active-prompt constraint. Repeated responses preserve the first submission.
- Class-tools changes invalidate one context query and push exact-bound revisioned student FAB snapshots. Missed pushes reuse the current FAB recovery marker. No per-student polling was added.

The additive checksum-ledger migration is `classpilot-class-tools-expand-20260922`. Eight new tables have forced RLS and tenant policies: timers, lesson activities, lesson progress, questions, picker rounds, templates, routine runs, and tool history. Context records require exactly one same-school teaching-session or supervision-context parent. Templates belong to a teacher and school independently of a lesson. Triggers reject cross-school recipients, mismatched resource parents, and ownership rewrites. Existing hands/settings/polls/responses are extended additively; messaging persistence is reused.

Context finalizers terminate current tools regardless of rollout. A scheduled classroom reassignment ends the previous teacher's private routine without deleting its history or transferring their templates. History, student text, progress, and duplicated command text use the school's existing retention window (30 days when unset). Reusable private templates remain until deleted. Actual deletion follows the existing `CLASSPILOT_RETENTION_PURGE_SPINE_MODE=delete` control; `count` is an observation mode and does not satisfy deletion. Verify the existing retention configuration before enabling submissions.

## School rollout and release order

1. Build and deploy the additive schema and backward-compatible API/worker first, following `CLAUDE.md`. Keep school feature phases and the new capabilities off initially. Verify the ledger checksum, eight forced-RLS policies, context cleanup, retention worker, and existing messaging/classroom controls.

   For the first deployment, admit the exact new registry bundle with `--enable-rls-table classpilot_timers,classpilot_lesson_activities,classpilot_lesson_progress,classpilot_questions,classpilot_picker_rounds,classpilot_tool_templates,classpilot_routine_runs,classpilot_tool_history` on the guarded backend deploy. Verify that none are already in the live allowlist before using this one-shot flag. The deploy migration gate verifies forced RLS and tenant policies before either service changes; omit the flag on subsequent deployments. Preserve the serving emergency API capacity with `--activate-emergency`.
2. Release the extension separately from the ClassPilot repository. Use `C:/GitHub/ClassPilot/dist/ClassPilot-v2.9.3.zip`, prepared from release commit `6b2cecf7c85189cd2b3e5781de7283fbfd50be5f` (local tag `v2.9.3`). It supersedes the preserved 2.9.2 candidate after packaged CI exposed a timer overlay covering the student launcher; 2.9.3 moves that display out of the launcher area. No upload has been performed by this task. The public Store listing was checked directly on September 22, 2026 and showed 2.9.1; confirm it again immediately before upload. Retain the package SHA-256 and validation record in that directory.
3. Preserve all existing protocol configuration. Enable the relevant individual flags and entries in the existing `CLASSPILOT_CAPABILITY_ROLLOUTS_JSON` for the pilot school: `helpRequestsV1`, `questionParkingV1`, `timerControlsV1`, `lessonActivitiesV1`, and `exitTicketsV1`. They depend on `scopedAuthorityChecksV1`; scheduled classes also need the current scheduled-classroom capability. Flag names are `CLASSPILOT_CAP_HELP_REQUESTS_V1`, `CLASSPILOT_CAP_QUESTION_PARKING_V1`, `CLASSPILOT_CAP_TIMER_CONTROLS_V1`, `CLASSPILOT_CAP_LESSON_ACTIVITIES_V1`, and `CLASSPILOT_CAP_EXIT_TICKETS_V1`.
4. Set `CLASSPILOT_CLASS_TOOLS_SCHOOLS_JSON` to a school-ID-to-phase map, for example `{"<pilot-school-id>":2}`. Values are integers 0–5; missing or malformed entries fail closed. Advance 2 → 3 → 4 → 5 after validating each school's client readiness. The shared workspace and existing messaging/tools remain usable at phase 0/1.
5. Verify teacher and student flows with current and older extensions together. Unsupported targets must report explicit outcomes; legacy start/stop timers and choice polls continue working. Check moved students, sign-out, teacher reassignment, expired contexts, denied access, reconnect/reload, transcripts, and presentation network payloads.

Rollback: lower the school phase to 0/1 and turn off the new individual capability rollouts without changing existing messaging/control capability entries. Keep the additive schema, history, retention worker, and finalization hooks. Authoritative snapshots remove unsupported student panels. Legacy Stop timer, poll close, Release attention, and context-end cleanup remain available. Do not drop tables or rewrite migration checksums during rollback.

## Verification evidence

The complete backend run exercised 2,441 tests (2,425 passed, seven failures, nine intentional skips). The seven initial failures were isolated and corrected: migration ordering, a new FAB snapshot assertion, the reviewed RLS inventory, a fixture cleanup dependency, and stale compiled retention code. A serial rerun of every affected suite passes 33/33 and verifies those corrections; see the task validation logs for the exact commands and results.

API typecheck/build and the test-type/cast ratchets pass. Frontend lint has zero errors and 31 existing warnings; its production build and required focused gates pass. Extension typecheck/build, 186 unit tests, the complete real-Chrome gate, and the new focused Class tools Chrome suite pass. After the final ACK binding adjustment, the scheduled-classroom and resilience Chrome suites were rerun successfully.

The integrated messaging browser run passes 21 cases, including all 20 recent chat regressions. The full 52-case Dashboard suite passed 50 initially; its two legacy FAB-selector failures were updated for the shared tabs and pass on rerun. The expanded panel regression also passes after adding grouped questions and exact-recipient follow-up submission. The new Dashboard integration exercises help, templates, recipient previews, toolbar geometry, docking, narrow/zoom-sized layouts, and focus restoration. The extension's `scripts/test-extension-class-tools.mjs` exercises exact student submissions, pushed responses, checklist/status independence, timer pause/reload, reordered snapshots, owner changes, and mixed capabilities in real Chrome. It is included in `test:extension:chrome`, alongside the existing suspension/restart/disconnect/reconnect/ACK resilience suites.

Database integration tests run serially. The 14-case Class tools suite covers help lifecycle, question retries, timer races, prompt conflicts and first submission, checklist edits, RLS and sanitized presentation data, transactional routines, retry bindings, retention, participation exclusions, exact-recipient follow-ups in scheduled and manual classes, and rollback cleanup. It passes together with the command and chat-control suites (27/27); the final reassignment guard also passes with the scheduled-classroom suite (23/23). Backend and frontend required checks remain the gates documented in `CLAUDE.md`.

No production deployment, school enablement, or Chrome Web Store upload has occurred.
