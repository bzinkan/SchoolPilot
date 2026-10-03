# Rollout failure diagnostics

The AWS rollout CI job at `204ae93d0869f4fe6dda33e663a4f91d5321eee7` failed because the unavailable-probe start-gate case reported `monitor_exception` instead of the expected load reason. Its actual exception was not retained by the prior test/workflow and remains unidentified.

This change preserves bounded, redacted mock failure output before cleanup and uploads it on CI failure. The production monitor and all existing assertions are unchanged. CI now runs the five-assertion diagnostics proof followed by the original full suite, without a targeted selector.

Local checks passed: five diagnostics assertions and 169 startup/start-gate assertions. The original exception did not reproduce. These results do not repair or explain the earlier failure; fresh required CI remains necessary.

The manifest binds raw/sanitized/gzip hashes, source snapshots, full retained CI logs and local receipts. Every gzip was decompressed and verified. No production operation or capacity acceptance occurred.
