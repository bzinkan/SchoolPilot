# Automatic Flight Paths for scheduled classes

Automatic Flight Paths are optional class presets. Existing and newly created
classes have automation off by default. Saved Flight Paths remain in Teaching
tools → Website tools; Teaching tools → Class setup selects a scheduled class
and saves its preset. This setting does not edit official rosters or schedules.

The primary teacher or a school administrator manages one preset for the class.
Co-teachers can see its name and turn it off while authorized to teach the live
session. A private saved path remains private in the author's library; the class
uses only its explicitly approved preset. A school-library path must remain
available to the primary teacher when the next class starts.

## Teacher behavior

- The setting starts off. Enabling it requires a saved path and an explicit Save.
- Changes apply to the next class session. They never introduce
  restrictions into a class already in progress.
- The preset freezes when an actual scheduled teaching occurrence becomes live,
  including a teacher starting that occurrence within its effective window.
  It also freezes when a new Manual today session for that scheduled class is
  created. Its school-local dated override and midnight deadline are verified
  by the server; the session remains manual, with no scheduled occurrence date.
  Reporting-only occurrences, temporary rooms, testing, and other supervision
  contexts do not acquire automatic presets.
- Automatic application requires the same current school monitoring policy as
  manual restriction commands. Outside allowed monitoring hours, the class
  remains live and its automatic preset is marked unavailable. Authorized
  session stopping remains available for cleanup after a monitoring boundary.
- Repeated scheduler ticks, page refreshes, and reconnects reuse the frozen
  session decision. Editing or deleting the saved path affects future sessions.
- Above the student tiles, the named class shows the automatic path, confirmed
  application/pending/failure counts, and **Turn off for this session**. That
  action addresses the complete class session independently of tile selection.
- Turning it off saves the session override and removes this assignment's
  automatic restrictions. Reconnect, late sign-in, and return from temporary
  supervision honor that decision. The next class session may use the saved preset.
- Later manual Flight Path and Focus choices take precedence. Automatic
  initialization and removal preserve website/resource Focus, any remaining
  legacy tab Focus, manual restrictions, block lists, and tab limits. Classroom
  assignments continue to open work through Open URL's plain opening behavior.
  Stop Focus releases Focus without stopping the automatic Flight Path;
  Turn off for this session stops only that automatic preset.
- Class finalization clears session-owned state. Existing scheduled and hard
  expiration deadlines also release restrictions on a disconnected Chromebook.
  An early stop cannot reach an offline browser immediately: the dashboard shows
  pending removal until acknowledgement or expiry; heartbeat/reconnect uses the
  newer cleared snapshot.

## Persistence and authority

The additive migration adds `groups.automatic_flight_path_policy` (default NULL,
read as disabled) and `teaching_sessions.automatic_flight_path_state` (default
NULL). Both existing tables retain their tenant RLS policies. No new tenant table,
RLS inventory admission, or extension release is required.

The class policy has its own optimistic revision. The occurrence freezes the
policy revision, path identity/content revision, validated rules, assignment ID,
and eligible/unavailable students. Its mutable session revision records the off
decision and student manual overrides. Server-only automatic-origin metadata
distinguishes automatic restrictions from later manual commands, including saved
pre-supervision state. Public DTOs omit the immutable resource payload, internal
provenance, and student-session/device bindings.

Only the creation boundary may initialize a new Manual today preset. Existing
manual sessions with no frozen state receive no retroactive restrictions.
Shared-session joins and repeated starts preserve the original assignment and
off decision. Status and Stop use the session's earliest real deadline, including
the school-local midnight and 12-hour hard cap.

Initialization, commands, restoration, and finalization use the existing student
control authority locks and monotonic snapshot revisions. Only the live owner
may receive a state mutation. Old class cleanup cannot clear a new class or
another supervisor's current controls. Session stopping rechecks entitlement,
active membership, and immutable session staff under the mutation transaction.
An administrator's Observe access alone grants no stop authority.

Website presets for signed-out students use the existing
`lateSignInRestrictionSsoV1` gate and provenance. Precise resource presets require
fresh accepted `preciseRestrictionResourcesV1` evidence on each connected target;
offline or unsupported targets are reported unavailable and receive no broader
website fallback. Sign-in pass-through capability gates remain enforced. A
missing, invalid, or inaccessible saved preset leaves the class live and reports
the automatic preset unavailable.
Automatic preset payloads are limited to 48 KiB, leaving room inside the existing
64-KiB control snapshot limit for exact-binding provenance and other controls.

## API

- `GET /api/classpilot/groups/:id/automatic-flight-path` returns the revisioned
  policy, eligibility, management permission, and selected path display name.
- `PATCH` on that resource accepts strict
  `{ expectedRevision, enabled, flightPathId }`. A stale revision returns 409.
- `GET /api/classpilot/teaching-sessions/:id/automatic-flight-path` returns the
  public session decision, `canStop`, aggregate outcomes, and student-scoped
  status. Applied requires acknowledgement of the current revision after the
  current browser sign-in. An unconfigured class has no automatic tile badges.
- Stopping uses the canonical teacher command endpoint:

  ```json
  {
    "teachingSessionId": "exact-live-session",
    "targetScope": "class",
    "commandType": "remove-flight-path",
    "commandPayload": {},
    "stopAutomaticFlightPath": { "expectedRevision": 1 }
  }
  ```

  This option requires a teaching-session class target and forbids subgroup or
  selected-student fields. The frozen roster remains explicit even when every
  student is unavailable. The server commits the off decision with zero online
  targets and sends removal only for matching automatic-origin restrictions.

Policy, automatic start, and session stop audit events use
`classpilot.automatic_flight_path.policy_updated`, `.started`, and `.stopped`.
Automatic starts have `source: automatic` and an assignment identity, so they
can be counted separately from explicit teacher commands. Logs/audits contain
bounded identities, revisions, counts, and reason codes rather than URL content.

## Verification and release

Backend coverage includes restricted-role tenant isolation, actor checks,
default-off and future-only configuration, frozen source rules, co-teacher
starts, stop/reconnect/restore races, manual overrides, capability refusal,
class expiry, and replacement ownership. Frontend browser coverage exercises
the actual Class setup and Dashboard, including reload after stopping.

Run the repository's required backend and frontend checks plus
`npm run test:classpilot-automatic-flight-path` in `schoolpilot-app`. The backend
integration file belongs to the serial RLS lane. Local fixtures must use a
disposable local database and the real prerequisite migrations.

This implementation does not deploy itself. A later release must run the normal
checksum-ledger migration before the API/worker rollout, then deploy the matching
frontend. Keep all existing presets disabled unless a teacher explicitly opts
in. Before downgrading to a backend that does not understand automatic origins,
disable recurring presets and end or turn off every automatic live occurrence;
retain the additive columns and audit history. A frontend rollback should keep
the compatible backend and stop active automatic occurrences first.
