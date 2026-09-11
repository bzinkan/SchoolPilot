# Testing and Coverage activity summaries

ClassPilot sends completed activity summaries to the staff who actually supervised testing groups, direct pickup, scheduled Coverage and other temporary supervision. This extends the existing class-summary email workflow. It does not add schedule announcements, reminders, parent emails or new Safety Center alerts.

## When a summary is prepared

- Finishing or expiring a supervision assignment closes its reporting period. The worker waits at least 30 seconds for final observations before preparing the summary.
- Reassigning a context closes the outgoing supervisor's period and starts a separate period for the replacement. Returning to the same staff member later creates another period; nobody receives a predecessor's activity.
- Extending an active assignment retains its reporting period. Partial student release records the departure without sending a separate email; releasing the last student closes the assignment.
- A student who arrives late, leaves early, changes supervision or returns later contributes only those actual participation intervals. Scheduled expiration ends the interval at the scheduled end even if cleanup runs late.
- A profile that was only saved/applied, a failed or missed testing activation, or an assignment with no supervised student interval has no completed activity to email. A normal class following changed bell times continues using its existing class-summary workflow.

The summary uses the school's timezone and labels actual recorded activity, monitoring gaps and unavailable observations. Lack of telemetry is not proof of on-task behavior. Activity delegated to testing or Coverage remains excluded from the regular class's report. Summaries do not include student device identifiers, sign-in tokens or unrestricted browsing histories.

## Recipients and delivery

The supervisor receives their own completed period. The existing optional **Central Email Recipient** setting can receive a separate copy. Configuring a central recipient does not add them to the supervision assignment, and the summary does not grant new historical-data or control permissions.

Report preparation and email delivery are durable worker jobs. A successful end/release remains successful while report preparation or delivery retries. Duplicate finalization and worker runs must not enqueue another message for the same reporting period and recipient. Known temporary failures can retry; a provider submission with an unknown outcome is retained as unknown rather than blindly resent. A provider acceptance is not a guarantee that a message reached the recipient's inbox. Missing provider configuration is recorded as unavailable and must never count as a successful send.

Student details and retained results follow the school's activity-retention policy. Shortening that policy also applies to existing summaries. Expired reports stop pending delivery and clear retained student activity. No new report/history page is added by this update; existing authorized views retain their permissions.

## Persistence and rollout

Each supervision reporting period preserves its staff assignment and actual start/end boundaries. Per-student rows preserve participation intervals separately from the context's mutable current staff assignment. Report materialization and delivery rows use those captured facts rather than reconstructing earlier responsibility from the latest context or audit log.

Apply the reviewed checksum-ledger migration and forced tenant policies for the report, student-result and delivery tables before activating compatible API and scheduler-worker code. Admit the exact reviewed table bundle through the documented deployment procedure in `CLAUDE.md`; do not preload a future production RLS baseline. Release verification must confirm all writers understand the new reporting lifecycle before enabling capture with `CLASSPILOT_SUPERVISION_REPORTS_CAPTURE_FROM` and delivery with `CLASSPILOT_SUPERVISION_SUMMARY_EMAIL_ENABLED`.

The first release adds this exact one-shot argument to the documented backend deployment command:

```text
--enable-rls-table classpilot_supervision_report_segments,classpilot_supervision_student_reports,classpilot_supervision_summary_deliveries
```

Preserve the existing production RLS baseline. Omit the argument on subsequent deployments after the reviewed three-table addition is recorded.

Before enabling production sends, verify delivery using an explicitly authorized test recipient and a controlled testing or Coverage assignment. Confirm the supervisor, school-local period, student participation windows and optional central copy. Inspect the durable provider outcome and verify receipt; implementation and automated tests do not authorize sending messages to real staff.

The capture setting is a fixed UTC ISO timestamp shared by API and worker. Set the delivery flag to `true` only after capture is configured and the compatible release is verified. A still-active older context is adopted from the first trustworthy observation after activation and produces a clearly partial summary. Earlier staff assignments and activity are not inferred or backfilled. Previously ended contexts never generate retrospective email. Preserve the capture timestamp on later releases; do not clear it or move it backward to replay historical work. Pause email with the separate delivery flag while continuing to capture accurate staff and student intervals.

After reporting is enabled, a backend rollback must retain the reporting lifecycle and staff-interval compatibility. Disabling delivery does not make an older writer safe if it can change supervision without recording the corresponding interval. No Chrome extension release is required. Repository implementation and review do not deploy or enable the feature.

## Verification

Verify the 9:00–10:45 testing example, staff handoff, late arrival, partial release and rejoin, last-student release, an extension, delayed expiry and normal class restoration. Assert that two supervisors cannot receive the same student's interval and that profile save/apply or failed activation creates no summary.

Exercise repeated worker runs, concurrent finalization, settlement delay, missing observations, retryable delivery, ambiguous provider acceptance, missing configuration, optional central copies, revoked staff membership, school isolation, tenant RLS, retention expiry and partial adoption without historical backfill. Inspect worker report/delivery outcomes separately from schedule activation and supervision control outcomes.
