# Timer and poll replay release

Status: implementation candidate, replay disabled. This document is not evidence
of a production deployment, Chrome Web Store publication, managed Chromebook
acceptance, or a completed school-day canary.

## Independent request hotfix

The tile POST failures have a reproduced cancellation mechanism: a request can
disconnect during asynchronous session loading before the JSON parser starts.
The original production events did not record sufficient stream flags to prove
that mechanism. The request hotfix stops confirmed disconnected transports and
classifies only typed parser cancellations as expected cancellation. A drained
live stream remains a monitored 500.

Watch the fixed runtime counters `requestDisconnectedBeforeBodyParser`,
`requestBodyParserCancelled`, and `requestBodyParserLiveUnreadable`, together
with the bounded `request_body_parser_live_unreadable` diagnostic event. Do not
log JSON bodies, student data, arbitrary URLs, or credentials to diagnose it.

## Replay contract

- Where the lane is on for the school (the replay gate, or an active
  `pollReplaySafeV1`), new timer/poll intents receive a positive
  server-generated `transientOrder` from `session_settings.tools_revision`
  while the existing student-control and classroom-parent locks are held. Other
  tools may leave gaps. Retries retain the original intent's order. Auth replay
  never allocates a new order.
- With every replay control unset no order is allocated, stored or sent, and
  the lane adds no `session_settings` write. A replay-off deployment therefore
  dispatches timers and polls exactly as before this lane existed. At Class
  Tools phase 0 and 1 a timer or poll does not touch `session_settings` at all.
- Replay independently rejects a command replaced by a later same-type intent
  addressing that student in the same classroom, even when the replacement was
  acknowledged or supersede cleanup failed. A later intent without an order,
  created by a task where the lane was off during a rollout, fences by its
  creation time. Missing order means no replay.
- Each API task decides ordering from its own environment. While a lane setting
  rolls across tasks, a socket that negotiated `pollReplaySafeV1` can still be
  sent a timer or poll without `transientOrder`. The successor must apply such
  a frame as an ordinary live frame, without comparing it to or advancing its
  cursor. The creation time used for the fence above is the start of the
  command transaction, so two overlapping same-type commands on tasks with
  different lane settings can commit in the other order and are not fenced.
  Apply lane profiles outside class time.
- Exact authenticated binding, classroom authority, accepted capability, target
  receipt state, and delivery deadline remain mandatory. Replay never marks a
  target received. Optional replay failure must not fail authentication.
- Poll starts additionally require the matching active, unexpired canonical
  poll and no recorded answer; closes require the matching closed poll.
  Every poll replay requires negotiated `pollReplaySafeV1`. ClassPilot 2.9.8
  retains live poll delivery and receives no poll replay.
- The successor persists an ordered poll cursor and sticky answer state before
  acknowledging the safe poll path. Its canonical renderer must preserve drafts
  and pending answers, reject stale starts/closes, and upgrade existing
  authenticated content scripts without reloading student pages. Signed-out or
  gated pages retain the conservative manual page reload before a fresh PIN.

Protocol remains version 3. No command status or teacher targeting contract is
added. No database migration or new tenant-table admission is required.

## Guarded profiles

Use `scripts/deploy-classpilot-runtime-config.ps1` with its documented private
input directory, immutable Plan, reviewed plan hash, Apply, verification, and
Rollback workflow. Never edit ECS task environment manually.

Current release tools use the separately pinned `scripts/private-permissions.ps1`
helper and bind all runtime imports in their plan inventories. Historical release
evidence and hashes remain unchanged. Regenerate a plan after changing tools;
replay of a plan made with different helper bytes must fail. Production replay
profiles require clean `main` at the reviewed tool commit for Plan and Apply.

```json
{"schemaVersion":11,"mode":"transient-replay-off"}
```

```json
{"schemaVersion":11,"mode":"transient-timer-replay-pilot","pilotSchoolId":"<canonical UUID>"}
```

Timer pilot requires replay off and the repaired serving image. It enables one
school only: timers have 60-second delivery deadlines, polls retain 15 seconds.
No global replay profile exists. Missing/empty replay scope fails closed.

Poll pilot must promote that exact active timer pilot and include real release
evidence inside the private profile. The profile bytes, including this evidence,
are hashed and copied into the immutable plan, then revalidated at Apply.

```json
{
  "schemaVersion": 11,
  "mode": "transient-poll-replay-pilot",
  "pilotSchoolId": "<canonical UUID>",
  "pollReplayEvidence": {
    "validatedAt": "<fresh ISO-8601 timestamp>",
    "pilotSchoolId": "<same canonical UUID>",
    "extensionVersion": "<successor version greater than 2.9.8>",
    "releaseTag": "v<same successor version>",
    "sourceCommit": "<40-character tagged source SHA>",
    "zipSha256": "<64-character verified package SHA-256>",
    "testEvidenceSha256": "<64-character acceptance evidence SHA-256>",
    "extensionId": "iggbfegfcjkfieoemeolfmfnapepalca",
    "checks": {
      "packagedChromePassed": false,
      "managedChromebookPassed": false,
      "crossRepositoryContractPassed": false,
      "restartAndCrashPassed": false,
      "mixedFleetPassed": false,
      "existingPagesUpgradePassed": false,
      "dashboardReloaded": false
    }
  }
}
```

This template intentionally cannot activate anything. Replace placeholders and
set checks to true only after actual acceptance. Synthetic waivers are not
accepted. The validation timestamp must be within two hours of Plan and Apply;
refresh the verification, not the underlying historical evidence, if it expires.

Poll pilot enables `CLASSPILOT_CAP_POLL_REPLAY_SAFE_V1` and its rollout entry for
the same school. Poll deadlines become 60 seconds, but every socket still needs
the negotiated capability. Residual 2.9.8 clients can remain pending for that
shared deadline without receiving extra poll delivery. Verify successor adoption
before promotion; do not represent this as per-target TTL negotiation.

All replay profiles clear manual TTL overrides. The backend recognizes an
integer override from 15000 through 60000 milliseconds only after the applicable
school/type replay gate. Gate off always returns future commands to 15 seconds.
Unrelated runtime profiles preserve replay environment presence and values.
Historical definitions without replay variables/capability remain readable.

## Release and rollback

1. Ship the request hotfix independently after its real HTTP regressions pass.
2. Merge/deploy PR 635 and the corrected backend with replay off. Confirm the
   school's dashboards have reloaded. Run the documented backend/frontend and
   immutable runtime preflights; preserve all unrelated feature/RLS settings.
3. Build the extension separately from clean reviewed source. Candidate 2.9.9 is
   provisional: check current Store publication and pending submissions, choose
   the next unused patch version, and confirm the live version immediately before
   upload. Bind source tag, archive hash, Chrome tests, and managed-device evidence.
4. Enable one timer pilot and observe a full school day. Then promote the same
   school to poll pilot after package acceptance and confirmed negotiated
   successor adoption; observe another full school day. Global promotion is a
   separate reviewed change.
5. Verify delivered-command ACK/expiry counts, replay failures, authentication
   latency, pool acquisition, and API 5xx against the previous school-day
   baseline. No wrong-poll rendering, answer loss, stale command execution,
   binding leak, or authentication failure is acceptable. Reconnect beyond the
   deadline must expire honestly; 60 seconds does not guarantee recovery from
   every silent-socket condition.
6. On any safety regression, apply `transient-replay-off` first. This clears
   replay and poll-capability gates and school scope. Existing command deadlines
   remain unchanged; new commands use 15 seconds. Preserve the independently
   useful request hotfix. Use documented image/frontend rollback procedures only
   after their data-compatibility checks; Store corrective releases are separate.

Managed-device acceptance, Store upload, production deployment, and both
school-day observations remain operator release stages until recorded as passed.

## Open before the timer pilot

Found by the independent review of 2026-10-10. The first two do not affect a
replay-off deployment. The third applies to any deployment of this image once a
runtime profile other than the emergency `off` has been applied.

- Order allocation creates the class's `session_settings` row when none exists,
  which raises the FAB revision from "no row" (0) to 1. A dashboard that loaded
  the class before its first timer or poll then has its next hand-raising,
  messaging or pause toggle refused: once in a regular class (409
  `FAB_REVISION_STALE`), and on every attempt until the page reloads in a
  supervision-context classroom (409 `SETTINGS_REVISION_CONFLICT`). The pilot
  school would see this. The same row is also created by a student's hand
  raise (trigger `cp_help_snapshot_revision`) and, at Class Tools phase 2 and
  above, by tools history, both older than this lane. Allocating the order
  without creating a FAB-visible row would therefore not cover every path, and
  refreshing after a conflict still leaves one refused toggle. Prefer a remedy
  that covers every writer: refresh the dashboard's FAB revision after a timer
  or poll dispatch and after a hand-raise event, or stop treating an implicitly
  created default row as a new revision.
- The emergency `off` runtime profile is refused while a replay pilot is active
  ("Protocol-off runtime must disable transient replay first."). Replay can then
  be cleared only by `transient-replay-off` (Plan and Apply need clean main) or
  by Rollback of the pilot plan (needs that plan's result evidence and the pilot
  task definitions still serving). Both admit at most three API tasks outside
  the weekday 04:45-05:59 ET protected window. Let `off` clear the replay
  controls itself, and cover it with a Plan/Apply case at four to six API tasks.
- Once a runtime profile other than the emergency `off` has been applied on
  this image, the capability registry carries a `pollReplaySafeV1` entry that an
  image built before this lane refuses to boot with. Plan with
  `-RegistryTargetAppSha` set to the older commit before reverting the image
  past this lane.
