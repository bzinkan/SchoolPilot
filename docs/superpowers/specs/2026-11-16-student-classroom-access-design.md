# Student Classroom access in Focus and Flight Paths

## Intent

Teachers can restrict students to Google Classroom and the published work each student can access across all of their own courses. This applies to website Focus and manual or automatic Flight Paths containing `classroom.google.com`. Google Search and unrelated websites stay outside the permission set. The separate **This resource only** control remains narrow; a full URL in Entire website mode is still a website restriction.

The user requested both manual and automatic starts, all student courses, CI confirmation, merge to main, API/web deployment and task branch cleanup. This extends the accepted Classroom design; no additional approval pause is needed for routine implementation choices.

## Approach and alternatives

Use server-side, separately authorized Classroom read access acting as each exact student, then compile each student's scope into the existing 3.0.7 browser contract. Focus receives its existing `classroomScope`; Flight Paths receive existing `allowedDomains` and optional nonempty precise `resources`. Preserve the tagged/packaged 3.0.7 ZIP unchanged.

Teacher-owned course OAuth cannot discover each student's other courses. Chrome profile identity cannot establish the active student on a shared Chromebook. New student OAuth and new extension wire fields would require a separate consent/lifecycle or extension release, so use the existing server DWD machinery with a distinct content purpose and explicit school administrator setup.

## Source and authorization

- Add a separate read-only Classroom-content purpose. Keep `GOOGLE_ROSTER_SCOPES` and roster-only behavior intact. Copy a combined DWD scopes CSV so content setup does not revoke existing roster grants.
- Mint exact student-subject credentials only after checking current-school student identity, imported Google ID, verified same-domain connector, current service-account client identity and locally verified content approval. Verify Google `userProfiles.get('me')` ID against the canonical student Google ID before course content reads; include the already approved profile-emails scope.
- Read the student's accessible ACTIVE and ARCHIVED courses, published coursework, materials and announcements. Read no submissions, comments, unrelated Drive files, credentials or outside destination pages. Reuse the existing audited URL/attachment parser.
- Return per-student scopes/counts only. Teacher review discloses the aggregate website/video permissions without other teachers' course titles or assignment content. Never union recipients' permissions for delivery.
- Bound provider calls to eight seconds, each student to twelve seconds, the whole batch to thirty seconds, four students and two courses per student concurrently. Existing limits apply across each student's entire source: 100 courses, 1,000 posts, 2,000 URLs, 2 MiB and final 200 entries / 49,152 bytes. Incomplete sources fail visibly.
- Missing/withdrawn content approval or incompatible capability withholds the derived restriction. Approval reads may use a short bounded school cache with explicit invalidation after local approval changes; no provider requests on heartbeat or under class/student locks.

## Manual behavior

`POST /api/classpilot/commands/classroom-access/preview` receives mode `focus` or `flight-path`, canonical class/supervision authority, nonempty exact student targets and, for a path, saved path ID/version. It authorizes the exact targets before reading sources. The two-minute HMAC proof binds actor, school, authority/revision, mode, sorted target hash, source-map hash and saved path identity/version/base-policy hash.

Confirm re-reads sources and rejects changed source, recipients, authority, path or expiry. Use a server-private `classroomAccessV1` command envelope and per-target derived payloads through state writes and the canonical last-mile framer. Public command/history projection and every wire frame strip the full envelope and internal provenance. Limit the aggregate private envelope to 512 KiB.

Flight Paths retain their explicit existing websites/resources and add each student's Classroom work. Reject a conflicting broad Google Search allowance in the original path; do not silently widen or rewrite it. Validate combined budgets. Preserve server-only `classroomMaterials` provenance through normalization, locked path rebuilding, Coverage restoration, teacher intent, withdrawal and rollback. Validate the stored compiled projection against that provenance before delivery, then strip provenance from the browser wire.

## Automatic behavior

A class-specific preset review explicitly authorizes current and future published material links from each student's enrolled courses at class start. Save durable class approval, not an expiring manual token or a school-library-wide permission. Bind setup proof to school/actor/class/primary teacher/policy revision/path ID/version/base hash/current roster/source-map hash.

Policy schema 2 holds this approval; ordinary policies retain schema 1. At each real live start, prepare bounded per-student sources before the outer class/Today/student locks, pass a frozen preparation into creation/promotion, then recheck class, teacher, policy/path, roster and preparation expiry under the existing transaction. Freeze schema-2 per-student session payloads once. Manual Today starts, scheduled/report-to-live starts, dated transitions and Coverage return must retain the same permission set and manual-override rules. Missing, stale or failed preparation produces a visible unavailable state and never pretends the expanded path applied.

No source reads inside storage initialization or existing locks. Do not apply source results after a changed authority/policy or overwrite newer teacher controls. Session DTOs expose summaries only. Future published changes are picked up at the next automatic start; manual reapplication reviews current data during a running session.

## Browser and rollout invariants

- Require the current exact-binding `scopedAuthorityChecksV1`, `preciseRestrictionResourcesV1` and `classroomFocusScopeV1` cohort, including compiled domain-only paths. Do not introduce a new unknown browser field.
- Existing school/teacher blocks and separately configured sign-in rules retain precedence. Assigned outside links permit the whole website and subdomains; YouTube remains specific videos. Unlisted redirects are not automatically allowed. Approved sites can themselves contain answers.
- Focus overlays the saved Flight Path; screen-only Unfocus restores it. Remove, expiry, handoff and rollback clear the appropriate derived permissions, including domain-only and restorable entries.
- Deploy API/web with the Classroom capability off. Existing 3.0.7 archive/tag/checksum remain immutable. Google administrator authorization, managed Chromebook verification and guarded school activation remain separate prerequisites; never claim them completed from synthetic tests.

## Verification

Prove source identity, per-student visibility, purpose/path/target proof fences, malformed and partial inputs, budgets, Google Search conflict, no cross-student leakage, source outages, configuration races, automatic preflight outside locks, stale preparations, override/Focus/Unfocus/Coverage lifecycle, unsupported clients and rollback. Run native acceptance against the unchanged canonical 3.0.7 ZIP. Run affected server and browser suites, required repository checks, independent review and all required CI workflows before merging/deploying. Preserve failed receipts alongside final successful verification.
