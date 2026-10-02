# Focus and Bring Forward v1: command contract

Status: **IMPLEMENTED ON THE COORDINATED RELEASE BRANCH; FINAL RELEASE GATES PENDING**. This document defines the reviewed Focus/Bring Forward contract. Record final combined-source, exact-package and CI acceptance separately from deployment and activation in the [2.9.7 operator checklist](RELEASE_2_9_7_OPERATOR_CHECKLIST.md). The owner replaced the two-managed-Chromebook prerequisite with documented live validation; record it as `waived_not_passed`.

The public command shapes below are fixed. This document supersedes the former provisional Focus section 12 of [the precise restriction contract](CLASSPILOT_PRECISE_RESTRICTIONS_CONTRACT.md). The existing precise matcher, resource fields, restriction precedence and sign-in envelope remain authoritative. Focus never creates a restriction exception.

## 1. Behavior and protocol boundary

- **Bring Forward** activates one teacher-selected existing tab once, including its Chrome window. It uses `activate-tab`, a transient action with a 15-second server deadline. It neither opens a missing tab nor persists a Focus assignment.
- **Focus** keeps one teacher-selected existing tab active while its original classroom authority remains valid. It uses `focus-tab`, a persistent control. Moving to another allowed page within that same tab does not select another tab or end Focus.
- **Stop Focus** uses `stop-focus {}`. It clears Focus alone and leaves Waypoint, Flight Path, school/teacher blocks, attention mode, tab limit and temporary allows intact.
- **Open + Focus** uses the server-owned continuation in section 4. The teacher supplies a URL to `open-tab`, not a guessed tab reference. Each recipient's authenticated successful open receipt supplies that recipient's exact Focus target.

`CLIENT_PROTOCOL_VERSION` remains 3 and the wire `CLASSROOM_STATE_SCHEMA_VERSION` remains 1. `focusTabV1` is additive and depends on accepted `scopedAuthorityChecksV1`. Its server capability flag, `CLASSPILOT_CAP_FOCUS_TAB_V1`, defaults false; deployment and negotiation never enable it implicitly. Precise restriction support remains an independent capability.

Only an existing teacher mutator for the exact teaching session or supervision context may use these actions. Observe access, administrator status by itself, saved roster membership and the selected UI tab confer no mutation authority. Existing school entitlement, immutable staff, ownership, lifecycle and context-tool gates still apply. Every request identifies exactly one original `teachingSessionId` or `supervisionContextId`.

## 2. Strict teacher command inputs

Existing-tab requests use the ordinary command routes, including the original supervision-context route when applicable. The sole syntactic parser must accept these strict payloads:

```ts
type ExactTabTarget = {
  studentId: string;        // bounded existing student identifier
  tabRef: string;           // opaque, nonempty, maximum 128 characters
  observedRevision: number; // positive safe integer
};

// activate-tab and focus-tab
type ExactTabPayload = { tabTargets: ExactTabTarget[] };

// stop-focus
type StopFocusPayload = {};

// open-tab: existing input, plus an optional literal true continuation
type OpenTabPayload = { url: string; focusAfterOpen?: true };
```

`tabTargets` has 1–50 rows and exactly one row per student. Every row and payload object is strict: no URL, browser tab ID, device ID, student-session ID, authority, source, assignment ID, `openTabCommandId` or client-supplied receipt proof is accepted in an exact-tab payload. Duplicate student rows are invalid even if their tab references differ.

For `activate-tab` and `focus-tab`, require explicit `targetScope: "students"` and explicit `targetStudentIds` containing exactly the same distinct student IDs as `tabTargets`. Do not infer targets from the rows, expand them to a class/subgroup, or accept rows for unselected recipients. Malformed or mismatched targeting rejects the request before mutation. UI selections spanning contexts must be partitioned into separately authorized requests; each student's row remains attached to that student.

`stop-focus` and `open-tab` retain the existing explicit `students`, `class` and `subgroup` targeting forms. Require an explicit target scope for the new stop action; a missing scope or missing student list is never a broadcast. Class/subgroup scope means the server's authorized frozen roster for that named activity, not school-wide devices. `open-tab` without `focusAfterOpen` retains its existing input and behavior. `focusAfterOpen: false`, arbitrary options and a teacher-supplied follow-up command are rejected.

After parsing, the server freezes the selected roster and resolves every recipient's current student/session/device binding under the existing command transaction. It rechecks entitlement, actor authority and control ownership there. A recipient without an online exact binding or accepted `focusTabV1` is unavailable; no new Focus or Bring Forward work is deferred to a future login. Other valid recipients retain independent outcomes.

For an ordinary exact-tab row, the server requires the current same-binding public tab snapshot to contain that opaque ref at exactly `observedRevision`. A stale, missing or unsupported row fails for that student. Never find a substitute by URL, title, active-tab position or matching hostname. The extension rechecks the exact ref and revision immediately before executing the action; a server-side snapshot check alone is insufficient.

## 3. Per-recipient Focus state and private binding

Each available `focus-tab` recipient gets its own validated payload before persistence. Never place the first selected student's tab ref in a shared classroom-state payload. Focus is represented in the recipient's desired control state and does not become a class-wide reusable tab setting.

The wire restriction addition is:

```ts
type FocusRestriction =
  | {
      active: true;
      assignmentId: string; // server-created immutable identifier
      tabRef: string;
      observedRevision: number;
      targetKind: "snapshot" | "open_receipt"; // server-derived resolver provenance
      source: "teacher";
      setAt: string;        // server timestamp, not a new lease
    }
  | { active: false };

// restrictions.focus may be absent for legacy snapshots.
```

No target URL is needed or permitted in Focus state. `targetKind` is derived by the server: ordinary exact-tab requests use `snapshot`; the validated continuation alone uses `open_receipt`. Teachers cannot supply or change it. It selects the extension's adoption resolver and is not permission to guess a target. `source: "presentation"` and Teacher Present media control are outside v1. An inactive shape has no assignment or target fields. A malformed active shape invalidates the whole snapshot; it must not be partially dropped while acknowledging success.

The server stores private `focusAssignmentV1` metadata alongside the recipient's desired-state record, outside public restrictions. It freezes the school, student, authenticated student session, device, original server origin, typed classroom scope, current owner/context authority and source command/target. It also records the immutable assignment ID and the control revision at assignment. These values are derived from locked server rows and authenticated transport, never the teacher payload or extension outcome JSON.

Private metadata is excluded by explicit projection from teacher command/results, desired-state DTOs, telemetry and logs. Recursive removal of obvious `deviceId` keys alone is insufficient: the complete private records must be protected, and only an intentional public status projection may be returned. Student transport retains the exact binding envelope it already needs; teachers receive student IDs and opaque refs only.

New command adoption is fenced to the frozen control revision. That revision is an adoption fence, not a requirement to keep every subsequent restriction revision equal: an unrelated authorized Waypoint or timer update may retain the same Focus assignment. Delivery of retained Focus requires the original exact binding and typed ownership to remain current. Ownership transitions must retire Focus, including saved/restorable copies, even when the same context ID later returns.

The full classroom-state snapshot is authoritative for `focus-tab` and `stop-focus`. A Focus command frame is exact-bound (`exactBinding.bindingVersion: 2`), scoped to one original authority and contains its classroom state. Active Focus frames list `focusTabV1` in `requiredCapabilities`. Bare Focus payloads, a state from another recipient and state without trusted origin metadata are refused before mutation.

Focus inherits the authoritative classroom state's scheduled end and hard expiry, including the existing maximum lifetime. Receipt timestamps, re-hello and worker restore do not extend them. An explicitly authorized context end-time change may update the parent deadline under the existing lifecycle contract; it must still preserve the exact binding and owner. Bring Forward remains transient and creates no desired state.

## 4. Durable Open + Focus continuation

`open-tab { url, focusAfterOpen: true }` is the only v1 Open + Focus entry point. It uses ordinary explicit recipient targeting. Gate it as Focus work for every recipient before dispatch; an unsupported recipient gets no open command and no pending Focus intent. The extension open command's data remains `{ url }`: the continuation is server-owned, not an instruction for the extension to create a local Focus assignment.

When creating the source command and target rows, create one protected `focusOpenIntentV1` record per eligible target in `classpilot_command_targets.result`. This uses the existing tenant table; it does not require a new tenant table or permit unscoped DB access. The record contains version 1, a server-created immutable assignment ID, a deterministic child command ID, the source command deadline, and a state of `pending`, `committed`, `refused` or `expired`. The existing frozen exact binding/control/context metadata remains authoritative. Allocate the IDs once with the source target and preserve them on retry.

ACK result merging must strip all client-supplied private intent/assignment/authority keys and preserve the existing server-owned records. Extend the existing protected result-key mechanism explicitly. The public projection may expose only `followUp: { kind: "focus", state, commandId?, errorCode? }`; `committed` means desired state was committed, not that the Chromebook verified activation. Child command and Focus status provide the actual enforcement outcome.

A Focus-capable extension's successful `open-tab` result includes:

```ts
{ tabReceiptVersion: 1, tabRef: string, tabSnapshotRevision: number }
```

These fields are bounded and strictly validated. They name the exact tab returned by the browser's successful create operation, revalidated under the original authentication/command authority. A `received` ACK, an error, null ref, invalid revision, missing receipt version, successful command enqueue or Redis subscriber count is not a successful open receipt. Result URLs and titles are never used to find or validate the Focus target.

Consume a successful completed ACK in one tenant-bound transaction following the established school lifecycle, student/control and command-target lock order. Before consumption, recheck all of:

1. The source target has a pending server-created intent and belongs to this `open-tab` command, student and original typed context.
2. The authenticated ACK and every supplied binding field match the source target's full exact binding and frozen control revision; protocol-2 permissive absence is not sufficient for this workflow.
3. The command has not expired and the authenticated completed ACK arrives within the original 15-second transient deadline, using server time.
4. The school is still entitled, the original actor still has mutator authority, the context is active/in-window, and ownership and exact binding are unchanged.
5. The Focus feature is enabled and the current exact binding still has accepted `focusTabV1` and its scoped-authority dependency. Historical advertisement or acceptance before a re-hello does not authorize the continuation.
6. The receipt is the authenticated per-recipient receipt described above, not a target reconstructed from the public snapshot or client request.

On success, internally construct exactly `{ studentId, tabRef, observedRevision: tabSnapshotRevision }`. In the same transaction, persist the source ACK, create the deterministic one-recipient child `focus-tab` command/target, commit its trusted assignment/desired control state and new revision, and mark the intent `committed` with that child/revision. Reuse the command/state persistence predicates rather than creating a weaker continuation-only authorizer. The child uses the intent's immutable assignment ID; retry cannot mint a replacement assignment or increment the revision again.

Fan out the child frame and authoritative state only after commit. A crash before commit leaves the entire operation retryable by the source ACK. A crash after commit but before fanout leaves durable desired state that the ordinary exact-bound resync/heartbeat paths can deliver. Duplicate ACKs return the original continuation disposition and child ID; they never create another child. Failed authority/capability/binding/deadline checks finish the intent as `refused` or `expired` without changing an existing Focus. Source-open completion and follow-up failure remain separate visible outcomes.

Pending intents that never receive a valid completed ACK expire with the source command. Reconnect, scheduler retries and a browser/API restart do not extend or reissue the source transient action. Outbox/intent records follow the existing command retention and school cleanup policy. Every read, continuation write and post-commit detached operation runs under the original tenant context.

### Tabs outside the public 20-tab snapshot

The public tab snapshot can omit the 21st opened tab. A successful browser create is not enough to fabricate a public snapshot row, and waiting for a URL match is forbidden.

For a negotiated Focus-capable binding, the extension must mint/retain an opaque receipt ref for the newly created exact tab even when that tab is outside the public snapshot limit. Keep the private receipt-ref-to-tab mapping in protected browser-session storage under the exact authentication scope. It shares the opaque-reference namespace but does not expand the public tab snapshot or expose Chrome tab IDs. The receipt revision is the positive local snapshot generation at the create/receipt boundary; it does not assert that the target was included in the public 20 rows.

The server's receipt continuation has a distinct trusted resolver from ordinary teacher-selected rows. It validates the authenticated receipt and frozen target, without requiring membership in the public snapshot, and writes `targetKind: "open_receipt"`. The extension's receipt-backed adoption requires the exact private mapping and its captured receipt revision to equal `observedRevision`, then rechecks the same browser tab's existence and policy. It does not require the public snapshot's current revision to equal that private receipt revision; unrelated public snapshot changes cannot turn a valid 21st-tab receipt into a URL fallback. An ordinary `targetKind: "snapshot"` adoption always uses the current public revision and cannot take this receipt exception. After adoption, ordinary Focus maintains the exact ref as described in section 5. Closed/missing refs, a lost private mapping or an authentication-scope change fail safely and leave no replacement tab selected.

## 5. Extension adoption and maintenance

Append `focusTabV1` to the advertised and scoped-authority-dependent capability lists. Check `hasNegotiatedCapability` against the exact current authenticated context for every new Bring Forward or Focus adoption. Do not infer support from extension version, advertisement or the dashboard feature flag.

For Bring Forward, resolve the exact ref at `observedRevision`, revalidate it immediately before `tabs.update(tabId, { active: true })`, focus the tab's existing Chrome window, and verify the resulting last-focused active tab. A disappeared or changed target returns `STALE_TAB_REF` with status `stale_tab_ref`; unsupported capability returns `TAB_ACTIVATE_CAPABILITY_REQUIRED` with status `unsupported`. Success returns `{ status: "activated", tabRef, tabSnapshotRevision }` only after verification. No fallback tab is created, navigated or selected.

For Focus, resolve and validate the exact ref/revision once during adoption. Persist its immutable assignment/ref under the same exact local authority as classroom state. Once adopted, unrelated snapshot revisions do not invalidate it: other tabs opening, titles changing and movement to another allowed URL within the assigned tab do not end Focus. Never rebind a retired ref to a recycled Chrome tab ID.

Register `tabs.onActivated`, `windows.onFocusChanged`, `tabs.onRemoved`, `tabs.onReplaced` and URL-relevant `tabs.onUpdated` listeners synchronously at service-worker top level. A `tabs.onReplaced` event retires the original assignment and opaque reference even when `onRemoved` does not fire; never transfer Focus or its reference from the removed tab ID to the replacement tab ID. They must await startup/auth/classroom restore, capture the current immutable authority, and recheck assignment, binding, owner and policy immediately before and after asynchronous browser effects. A queued event for assignment A cannot activate or invalidate replacement assignment B.

Maintain Focus at most once per 2,000 ms per current assignment. Coalesce event bursts; do not queue repeated focus operations or run overlapping activations. Bring Forward is one operation and does not start this maintenance loop. Worker suspension/wake restores only a still-owned session mapping and original deadline. Browser-session loss, sign-out or student/device/server change retires the mapping and assignment; URL lookup cannot repair it.

Every policy check uses the finalized pure navigation decision and precise matcher. Attention mode, school and teacher blocks, delivered sign-in authority, Waypoint and Flight Path remain authoritative. Focus cannot navigate, reopen or whitelist a tab, relax a tab limit, or pull a student to an off-policy target. A policy update that disallows the target invalidates Focus; cleanup clears Focus only.

Attention mode suspends Focus without deleting its assignment. Approved authentication navigation/foreground tabs also suspend it, using only the delivered auth pass-through envelope or the already-defined exact pending-auth recovery fence. No new sign-in exemption is invented. Do not steal focus from an auth popup or navigate it. When attention ends or authentication finishes, resume only if the original assigned tab still exists, the original authority is current and its URL is now permitted. A different destination tab is not a substitute. Without approved sign-in authority, an off-policy auth URL receives the ordinary policy decision.

Negotiation withdrawal blocks adoption of newly delivered active Focus, with an `unsupported` ACK and the prior applied state retained. Keep a previously applied exact-owned Focus until an authoritative newer state clears/replaces it, its deadline passes or a local invalidation occurs. The server withholds active Focus from bindings that cannot negotiate it; it never strips Focus and delivers the rest as an applied state. Inactive/absent Focus cleanup is deliverable without accepted `focusTabV1`.

## 6. ACKs, invalidation and late-event fencing

New Focus adoption must distinguish rejection from later suspension/invalidation. Invalid payload, unsupported capability or failed exact resolution before adoption leaves prior state intact and reports the existing command/classroom-state failure outcome. State persistence does not claim that browser/window activation succeeded.

Extend classroom-state ACKs and the heartbeat's state-ACK projection with this bounded addition:

```ts
type FocusAck =
  | { state: "inactive" }
  | { assignmentId: string; state: "active" }
  | { assignmentId: string; state: "suspended"; reason: "attention" | "authentication" | "browser_operation_pending" }
  | { assignmentId: string; state: "invalidated"; reason: "focus_tab_closed" | "focus_tab_missing" | "focus_tab_off_policy" };
```

`active` reports an adopted assignment with its exact target verified, not control of other native applications. Pending/timed-out browser activation is suspended and may retry under the bounded loop. It never reports success merely because Chrome accepted an API call. Focus status is distinct from whether the other classroom restrictions were successfully applied.

ACKs name the actually applied classroom-state revision and original typed classroom authority. Use the authenticated exact tuple and strict current control-revision/context-authority checks on both heartbeat and WebSocket surfaces. Under the same lifecycle/student/control locks, validate that the ACK assignment ID, origin binding, owner and applied revision still match the current Focus before recording status or clearing anything.

An accepted `invalidated` ACK clears only the matching Focus assignment/private metadata, increments the desired control revision and fans out its tombstone. Repeat invalidation is idempotent. A late ACK, old-context message, old auth generation or cleanup for assignment A cannot clear, suspend or mark assignment B applied. A new Focus status on an already-ACKed revision must not be discarded by the existing same-revision ACK write-skip optimization.

The public teacher projection exposes the explicit Focus state/reason and assignment ID needed for honest status and stable UI selection. It exposes no origin binding, receipt intent, device/browser tab ID or student-session identifier. Partial multi-student success is reported per recipient and never triggers a broad retry against the class.

## 7. Stop, lifecycle and rollback

`stop-focus {}` is available to the currently authorized owner even when `CLASSPILOT_CAP_FOCUS_TAB_V1` is off or the selected recipient no longer negotiates Focus. It cannot bypass entitlement or grant Observe users mutation access. It resolves the explicit server-owned recipient scope, clears Focus/private assignment metadata and any same-authority saved/restorable Focus, and emits the newer full state. It requires no tab ref, online snapshot or Focus capability and does not defer a fresh assignment.

Stop is idempotent. If there is no Focus, do not generate an assignment or claim an activation. The stop transaction also cancels pending Open + Focus intents for those original recipient/authority pairs so a later source-open ACK cannot restart Focus. A new assignment created after stop remains protected from late prior cleanup by its distinct immutable ID and current revision.

If the remaining precise/auth restriction snapshot is wholly withheld, an exact-bound bare `stop-focus` command with strict `data: {}` remains deliverable. It carries the current control revision, original explicit student binding/typed scope and unextended classroom expiry; it carries no partial classroom snapshot. A protected server-only `focusCleanupV1` tombstone retains the original stop command and retired binding for restart, heartbeat and WebSocket recovery. The heartbeat/hello `focusCleanup` field contains this complete command envelope. Capability withdrawal may not suppress this cleanup while scoped authority remains accepted. New Focus or binding/ownership transitions retire the tombstone. Duplicate cleanup is idempotent; a late lower-revision cleanup cannot clear a replacement. The extension clears only its currently owned Focus and saved Focus, preserving the previous valid non-Focus policy, its original lifetime and every other control. Stop ACKs are fenced to their frozen control revision; a late ACK cannot authorize another cleanup or modify a replacement.

Lifecycle cleanup must retire active and saved/restorable Focus plus matching pending continuations on:

- teaching/supervision end, expiry and scheduled handoff;
- claim, release, delegation, send, reassignment and ownership return;
- student-session/device/server/authentication-boundary change or sign-out;
- school/product entitlement revocation and activity/student cleanup.

Returning from delegated supervision must never restore the previous classroom's tab Focus. Other existing restorable restrictions retain their current behavior. Cleanup predicates use the original scope/binding/assignment; a delayed callback never clears state adopted under a replacement authority. Local hard-expiry cleanup remains available while offline and clears Focus without removing school restrictions.

Turning the Focus capability off prevents new assignment/Bring Forward/Open + Focus work; it is not an image-rollback cleanup procedure. Before an image without this contract serves traffic, turn the feature off, clear active and restorable Focus and pending continuations with the compatible cleanup path, verify no such state remains, and deliver/verify the resulting revision where bindings are online. Retain additive data needed to make retry/cleanup idempotent. Do not let an older image silently drop Focus from a live state or resurrect a pending continuation.

The runtime profile and any future publication remain refused until reviewed release evidence is bound. No tag, image SHA, ZIP hash, Chrome version or managed-device result is assigned by this draft. Server/API deployment and extension Store upload remain separate actions.

## 8. Required implementation and review gates

Implement the server contract/backend before enabling UI or extension Focus. Independently review this document and the backend change before extension Focus implementation. Local candidates may use the reviewed draft; production activation and publication remain subject to the release checklist's independent deploy, privacy and managed-device gates.

Required server verification:

- Strict payloads, explicit matching target IDs, duplicate/missing/foreign rows and partial recipient outcomes; normal `open-tab` remains unchanged.
- Accepted-capability admission for command dispatch and continuation; feature-off stop cleanup; no offline replay or partial-state projection.
- Per-recipient trusted persistence, protected public projections and preservation of private metadata against malicious ACK result keys.
- Atomic source ACK/intent/child/state commit; duplicate ACK and API restart/fanout-failure recovery without a duplicate child/revision.
- Reassignment, same-context ownership changes, stale exact tuples/control revisions, revoked authority/entitlement and elapsed deadlines at the continuation boundary.
- Authenticated receipt for an opened 21st tab versus a forged/missing ref, plus refusal to resolve ordinary rows outside the public snapshot.
- Late invalidation/stop/cleanup for A after B, same-revision ACK status changes, restorable-state cleanup and school isolation/RLS.

Required extension verification:

- Exact duplicate-URL tabs remain distinct; close/recycle/navigation/ownership races never select a substitute.
- Per-recipient frames, strict Focus normalization, capability withdrawal, private receipt mapping for the 21st tab, worker wake and browser-session loss.
- Activation/window verification, bounded/coalesced maintenance and honest pending status.
- Precise and domain restriction precedence, tab-limit interactions, attention suspension/resume, auth popup preservation and no-envelope refusal.
- Target close/off-policy invalidation, `tabs.onReplaced` without `onRemoved` (no tab-ID/ref transfer), late callbacks after replacement, sign-out, scheduled handoff and downgrade cleanup.
- Existing packaged/browser lifecycle suites remain green; managed Google Admin devices verify actual foreground behavior before any upload.

Implementation seams are the canonical command parser/dispatcher, delivery policy and public serializer; protected command-result merge/ACK persistence; per-student classroom-state serialization/persistence; shared ACK write-skip gate and lifecycle ownership cleanup; protocol capability/runtime profiles; and the extension core, exact-ref registry, state application and top-level lifecycle listeners. Existing paths remain the authority; new continuation code must not bypass them.
