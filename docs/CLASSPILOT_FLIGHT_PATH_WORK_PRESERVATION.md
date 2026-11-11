# Flight Path work preservation and Google Classroom

## Teacher behavior

An ordinary `classroom.google.com` website in a Flight Path includes Docs,
Drive, Sheets, Slides, Forms and Forms short links. Companion websites are
`docs.google.com`, `drive.google.com`, `sheets.google.com`, `slides.google.com`,
`forms.google.com` and `forms.gle`. They allow other files in those apps too.
This does not include Gmail, YouTube, Sites, arbitrary linked websites, or all
of `google.com`. Redirect destinations remain independently restricted.

Exact normalized Classroom website entries trigger this behavior. A precise
Classroom Section or resource does not. School and teacher block precedence
and exact-host authentication/SSO policies remain unchanged.

Stored selections are unchanged. Read/preview DTOs add `effectiveAllowedDomains`;
the existing command `allowedDomains` carries the expanded list. The central
apply payload builder covers manual, reviewed, automatic-start and Windows
paths. Existing saved paths gain the bundle on their next application/occurrence
freeze, not by rewriting active desired-state snapshots. Expansion beyond the
1,000-domain wire limit fails before dispatch and asks the teacher to reduce
the list. Native rule installation retains its existing additional budgets.

## Extension behavior and release boundary

ClassPilot 3.0.6 is the separately prepared successor for work preservation.
Applying Flight Path retains allowed work without reload/navigation, preserves
an allowed foreground tab, and removes disallowed tabs first. It reuses an
existing allowed tab before opening a landing page. Every destructive tab
operation rechecks the latest tab and still-current policy/identity.

Routine apply, restore, heartbeat, reconnect and retry use `preserve-existing`
tab-limit reconciliation. Existing allowed work survives even above the limit.
Only an explicit teacher limit action or a verified administrator limit change
uses `enforce-existing`. Same-value/first-boot settings restore does not close
allowed work. A new excess tab is rejected without sacrificing older work;
bounded authentication popup protections remain. Delayed tab-created events
cannot reinterpret retained work as a new excess tab.

API/web deployment does not upgrade installed extensions. A prepared ZIP,
Store publication and managed-device installation are separate evidence.
Preservation acceptance requires the successor installed on the test device.
No paid AWS load test or additional infrastructure is part of this release.
