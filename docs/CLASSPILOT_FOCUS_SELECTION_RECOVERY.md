# Focus cleanup selection recovery

A reported Select all → Stop Focus action left a student focused even though
their individual tile could clear it. The code had two eligibility rules:
ordinary selection required fresh monitoring, while the existing tile cleanup
path allowed an owned, capable, logged-in Focus target during stale monitoring.
The reproduced batch omitted that cleanup target before any command was sent.

Selection now admits that same cleanup lane for Select all, individual
checkboxes and tick retention. Canonical `unlock-screen { screenOnly: true }`
continues to target explicit reviewed student IDs. Its server authority,
binding, capability and partial-outcome checks remain unchanged. Other
commands still require their existing fresh-monitoring eligibility and cannot
silently drop a stale selected recipient. No missing target becomes a broadcast.

The native dashboard regression uses synthetic recipients. It reproduces the
omission on unchanged `f8430c905a510bacc2c858b66fa4d8423124b745`, then checks
the selected IDs, stale refresh retention, individual checkbox, honest selection
count, exact Stop Focus request and refusal of unrelated commands. Signed-out,
unsupported and wrong-authority rows remain excluded from Select all.

Verification on Node 22.18.0 and native Playwright Chromium:

- The new selection regression failed on the unchanged baseline with
  `Select All (2)` instead of three recipients. A separate badge assertion
  failed with `0 selected controllable students` despite three checked rows.
- `npm run test:classpilot-recipient-freeze` passed all 17 browser scenarios.
  After the badge correction, a five-scenario focused rerun passed the explicit
  count, stale Focus cleanup, no-broadcast and signed-out-selection checks.
- `npm run lint` passed with zero errors and the existing 37 warnings;
  `npm run build` passed.
- All six required dashboard gates passed:
  `test:classpilot-tile-batching` (18 image tests and 37 isolation/recovery tests),
  `test:classpilot-session-lifecycle` (5 tests),
  `test:classpilot-realtime-cache` (71 tests),
  `test:classpilot-signal-loss` (45 tests),
  `test:classpilot-command-context` (148 tests), and
  `test:classpilot-radix-browser` (native dialog/ACK and runtime boundary checks).
  Tile batching and command context were rerun successfully after the badge change.
- `git diff --check` passed.

This is a SchoolPilot web correction using the existing extension protocol; it does not
publish a ClassPilot extension or establish the reported student's exact
device/session cause. Classroom work-app navigation is a separate issue and is
not changed by this selection repair.
