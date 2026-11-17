# Classroom access in Focus and Flight Paths

Implementation prepared November 16, 2026. This document does not establish a
production deployment, Chrome Web Store publication, or managed-device adoption.
The API/web app and the ClassPilot extension are separate releases.

## Student courses: current teacher behavior

A website Focus on `classroom.google.com`, or a Flight Path containing that
website, reviews the selected students' **own** Classroom courses when the school
has activated expanded Classroom access. It includes
their accessible active and archived courses, published assignments, materials
and announcements. Each student gets a separate allowed scope. Never combine
classmates' course websites into a shared delivered allowlist. The review shows
aggregate permitted websites/videos and counts, without other course titles or
assignment content.

Google work apps and student-created copies remain available. Assigned outside
links permit the whole website and its subdomains, explicitly disclosed in the
review. Assigned YouTube videos remain specific videos. Known Google Search
links are excluded with an explicit review warning; unrelated sites stay blocked,
including in new tabs. An existing broad Search grant in the saved Flight Path
must be removed before that path can use this mode. School/teacher blocks and
separately configured sign-in permissions keep their priority. Unlisted redirects
are not discovered or automatically allowed. Approved websites may contain answers.

The separate **This resource only** option stays narrow. Entering a full URL in
Entire website mode is still a website restriction. One Classroom assignment page
does not implicitly allow its linked documents or external materials.

Manual application uses `POST /api/classpilot/commands/classroom-access/preview`
with mode `focus` or `flight-path`, canonical class/supervision authority and
nonempty exact student IDs. A Flight Path review also binds its saved ID/version
and base policy. Confirmation submits only `classroomAccess: { reviewToken }`
alongside the normal command fields; no client-computed website list is accepted.
The two-minute proof binds actor, school, authority, mode, targets, per-student
source-map hash and the saved path. Changed source/path/authority/targets or
expiry require another review. The old teacher-course endpoint below remains a
strict compatibility API, not the new Dashboard's default.

## Automatic class starts

The automatic preset reviews and explicitly authorizes current and future
published work from each student's own courses. Durable approval belongs to one
class, saved path and primary teacher; it is not written onto the school library
path. The short-lived setup proof binds exact current policy/path/roster/source
versions. Existing saved-path edits retain their normal next-session behavior.

At manual Today, scheduled/report-to-live and dated-transition boundaries, source
preparation runs **before** the outer class/Today/student authority locks. The
transaction rechecks policy, primary teacher, saved path, roster and preparation
expiry, then freezes per-student session payloads once. Missing, failed or stale
preparation is visibly unavailable; it never claims expanded browsing permissions
were applied. Later reconciliation and Coverage return use the frozen snapshot,
respect manual overrides and do not reread Google under locks or on heartbeat.
New publications during a running class require explicit review/reapplication or
the next automatic start.

## Separate Google Workspace authorization

The existing roster connector alone cannot read student assignments. In
ClassPilot IT Readiness, a school administrator enables the separate Classroom
assignment-access purpose after authorizing the combined read-only DWD scopes in
Google Admin. The combined list preserves existing roster permissions. The content
token uses courses-readonly, own-coursework-readonly, materials-readonly,
announcements-readonly and the existing profile-email scope. It reads as each
exact student and verifies Google's profile ID against the current-school imported
student Google ID before reading any course content. Chrome profile identity is
not used as the student identity on a shared Chromebook.

The Flight Paths API advertises `features.studentClassroomAccess: true` only when
the school's Classroom runtime capability is active. With it off, existing website
Focus and manual/automatic Flight Paths retain their ordinary behavior; they do
not include the new assignment-derived outside websites. With it on, an unavailable
source or incompatible client stops expanded application instead of substituting
a website-only policy.

Only published links and their metadata are processed. No student submissions,
grades, comments, destination pages or unrelated Drive file contents are fetched.
No Gmail permission is introduced. Source requests have bounded eight-second
calls, twelve-second student and thirty-second batch deadlines, with four students
and two course reads per student concurrently. Existing source and compiled-scope
limits apply across each student's complete course set, including the 200-entry /
49,152-byte final scope. Incomplete/unknown source errors stop the review.

Content verification and local disable are separate from roster import and cannot
damage roster connection status on a failed content check. A nullable
`google_roster_connectors.classroom_access_approval` JSONB column records the
separately verified approval generation. CAS protects disconnect/reconnect and
ABA races. Reverification rotates that generation; old proofs, saved approvals,
stored scopes and queued publications cannot revive under a different approval.

## Existing 3.0.7 wire and current release

The canonical 3.0.7 ZIP/tag are unchanged. Its SHA-256 remains
`bf884705903cc8234024933ba5d9ee297dd8a30f56393674655ed07f5963346a`.
Focus uses the existing `screenLock.classroomScope`; a reviewed Flight Path uses
the existing `allowedDomains` and optional nonempty precise `resources`. Server
`classroomMaterials` provenance and the command's private `classroomAccessV1`
per-target map are validated before delivery and never appear in public history
or browser wire messages. Delayed server publications carry a separate private
approval-generation fence. Screen-only Unfocus restores the saved Flight Path.

Both modes require exact binding and accepted `scopedAuthorityChecksV1`,
`preciseRestrictionResourcesV1` and `classroomFocusScopeV1`, even when no precise
video resource is present. The existing Classroom runtime capability remains
default off. Deploy API/worker and web normally, leaving it off. The new additive
column migration adds no tenant table or RLS admission. Keep the unchanged 3.0.7
ZIP's receipt and run native acceptance with
`node --import ./tests/test-environment.mjs --import tsx scripts/verify-student-classroom-extension.mjs`.
Store upload, managed Chromebook adoption, separate Google administrator approval
and guarded school activation remain real prerequisites; synthetic tests establish
none of those. Windows is not qualified for this new authoring mode.

Rollback must clear live, flat, inactive and restorable Classroom-derived controls,
plus automatic schema-2 approvals and frozen per-student session maps before an
older image can serve them. Use the inventory/proof/clear procedure in
[the rollout runbook](CLASSPILOT_ROADMAP_RUNTIME_ROLLOUT.md); do not hand-delete rows.
Capability/content disable alone can withhold updates while a browser retains its
last restriction until a clearing revision or hard expiry.

## Legacy teacher-course Focus behavior (compatibility API)

An explicit `classroom.google.com` website Focus first reviews a Google Classroom
course using the teacher's connected account for the active school. A mapped
official class supplies the course; an unmapped class requires the teacher to
choose one of their active courses. The review includes all published coursework
and course materials in that course, rather than only one student's assigned set.
Drafts, deleted posts and student-submitted attachments grant no access.

The teacher sees the course, published item/link counts, Google work apps,
assigned YouTube videos, and every outside website before applying Focus.
Outside links permit the **whole website and its subdomains**; the review states
this explicitly. Google Classroom, Docs, Drive, Sheets, Slides and Forms remain
available, including student-created copies. YouTube remains limited to assigned
video identities. Unassigned websites and unrelated YouTube videos remain blocked.
Existing school and teacher blocks retain their priority.

This is a snapshot of the published links at review/apply time. Adding links later
requires another review and application. Redirect destinations are not crawled or
automatically approved. External applications still use the school's separately
configured sign-in policy; an absent identity provider may require an administrator
to update that policy.

Ordinary website/resource Focus, current-page Focus and Classroom Open keep their
existing contracts. Unfocus (`unlock-screen` with `screenOnly: true`) removes the
Classroom scope and reveals the prior Flight Path unchanged.

## Legacy teacher-course authority contract

`POST /api/classpilot/commands/classroom-focus/preview` uses the canonical command
authentication, school entitlement, full monitoring and class authority checks.
It requires `targetScope: "students"`, a nonempty unique `targetStudentIds` set,
and exactly one live teaching session or supervision context. Scheduled contexts
also require the current context authority revision header. Observe, cross-school,
wrong-actor, outside-roster and missing-target requests cannot read Google source.
Teacher-facing requests never contain Chromebook/device IDs.

The review token is an HMAC bound to actor, school, exact class authority/revision,
sorted recipients, course, source hash and a two-minute expiry. The canonical
`lock-screen` command accepts only:

```json
{
  "url": "https://classroom.google.com",
  "classroomFocus": { "courseId": "course-id", "reviewToken": "opaque-token" }
}
```

The server re-reads the published source and checks the token again after that
read. A changed source, expired proof or changed authority fails before command
creation. The server derives `classroomScope`; client-supplied domain/resource
arrays are rejected. The token is discarded before persistence/delivery.

Only the teacher's school-bound Google OAuth account is used. The course must
appear in the account's active `teacherId: me` course list. All pages of coursework
and materials are read; no student submissions or external destination pages are
fetched. Unsupported or incomplete items, repeated pagination, transport errors,
or a limit breach stop the review rather than silently omitting links. Limits:
20 pages per provider list, 1,000 total published items, 2,000 unique URLs,
2 MiB source, 12-second whole-provider deadline and eight-second request deadline.

The delivered `screenLock.classroomScope` has exactly `schemaVersion: 1`, a
64-character source hash, `allowedDomains`, and existing precise `resources`.
It is limited to 200 combined entries and 49,152 UTF-8 bytes, with existing native
regex/rule limits. Broad `google.com`, YouTube website scopes and sign-in host
scopes are rejected. YouTube/auth-host Sections cannot bypass that restriction.

## Shared capability and original Focus release order

`classroomFocusScopeV1` requires both `scopedAuthorityChecksV1` and
`preciseRestrictionResourcesV1`, including advertisement, negotiated acceptance
and active school gates. `CLASSPILOT_CAP_CLASSROOM_FOCUS_SCOPE_V1` defaults off.
The authoritative rollout map must include all three capabilities. Windows
packages do not advertise this new capability until separately qualified.

Malformed scopes, an older extension, capability withdrawal or the live kill
switch withhold the entire scoped snapshot. There is no single-host fallback.
Exact student/session/device binding remains transport-only and is rechecked at
delivery. The separate extension persists a schema-4 marker so an older client
cannot strip the new scope and claim that it restored it.

The following is the original single-course Focus release sequence. Its successor
package is the retained 3.0.7 archive; the student-course server update above uses
that archive unchanged and adds the separate approval-column migration.

1. Merge/review the login recovery and bulk Unfocus prerequisites, then these
   cross-repository changes. Run the source, API, Dashboard and packaged Chrome
   checks. The shared case fixture must have the same SHA-256 in both repos:
   `4b04de889de92a89225d0e5b33bdf9d4f5b0ecce86c95cbe67d21b116bffa0f5`.
2. Deploy the new API/worker and web app with the new capability off, following
   `CLAUDE.md`. No migration or new RLS admission is introduced.
3. Separately version, build and review a successor ClassPilot package. Reconfirm
   the Store's live/pending versions immediately before upload. Record the exact
   source/tag/ZIP identity and package tests; Store publication alone is insufficient.
4. Verify managed Chromebook adoption, mixed-fleet rejection, shared login,
   assignments/external work, sign-in, reconnect, class handoff and Unfocus. Use
   the guarded runtime configuration Plan/Apply workflow for a school pilot only
   after its successor-release evidence is complete. No legacy 2.9.7 waiver or
   synthetic receipt qualifies this feature.

## Containment and rollback

Turn off the Classroom capability with its guarded runtime profile to block new
reviews/commands and withhold stored scopes. Devices can retain their last
applied restriction until a clearing revision or its hard expiry; disabling the
flag alone does not remove an already applied Focus.

Keep a scope-aware server until stored live, flat and Coverage-restoration scopes
are cleared. The existing reviewed precise-restriction clear now inventories and
ends Classroom scopes, including malformed/inactive entries, with a revision bump.
Follow the dry-run/proof/admission steps and exact SQL in
[the rollback runbook](CLASSPILOT_ROADMAP_RUNTIME_ROLLOUT.md). That broad emergency
clear requires the precise parent capability off and also ends other precise
restrictions; review its per-school counts and notify affected teachers. Retained
ordinary Flight Paths, blocks and other independent controls remain intact.

After the inventory is empty, project the runtime registry onto the rollback
image using the guarded tool before selecting an older server. Never restore a
pre-scope extension over stored schema-4 state as an ordinary downgrade.
