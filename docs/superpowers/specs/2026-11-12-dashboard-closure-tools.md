# Dashboard school-closure notice and ClassPilot tools

User request: make an explicitly closed school day visible on ClassPilot,
PassPilot and GoPilot dashboards, and keep ClassPilot classroom tools on one row.
The user authorized deployment and cleanup after completion.

The notice uses the shared saved instructional calendar and the current date in
the school's timezone. Empty rosters, weekends, time outside a class and failed
requests do not imply a school-wide closure. ClassPilot's explicit instructional
override has precedence in that product and must be described accurately. The
notice is informational and changes no scheduling or classroom authority.

Read a bounded current-day DTO through each product's existing staff and license
boundary. Return schoolLocalDate, schoolTimezone, evaluatedAt, validUntil,
calendarClosed and classpilotInstructionalOverride. Do not expose the full
calendar/settings or accept a caller-selected school/date in this read.

Use the shared notice on ClassPilot and PassPilot dashboards and both GoPilot
staff dashboard variants. Keep its cache scoped to the active school/product
and refresh at date rollover, focus/reconnect and a modest foreground interval.
Unknown/failed/expired data must not leave an incorrect closure notice visible.

All ClassPilot tool buttons stay in a single horizontal row. On narrow screens
the tool area may scroll horizontally; the page must not overflow. Preserve the
Focus selection guidance below the row, targeting, capability checks, keyboard
access and menu visibility.

Before deployment the user added: remove the visible disabled-control guidance
above **Not logged in** on signed-out student tiles. Keep the existing signed-out
display, accessible unavailable reason and padlock click fence. Retain visible
Focus cleanup guidance when a saved Focus state still requires attention.

No extension update, migration, AWS infrastructure, capacity/flag changes or paid
load testing is needed. Review and verify locally and in CI, merge and deploy
backend before frontend, observe ordinary service health, then remove only this
task's branches and retain release/rollback evidence.
