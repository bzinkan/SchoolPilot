# Final control and SSO projection

Incremental proof on the `7cf86cf1` base. Final heartbeat preparation now reads control and SSO in **one fresh query instead of two**, under the existing locks. It preserves all 17 control fields, five Date decoders, independent missing-row defaults and canonical SSO handling.

Focused **13/13**; native **9/9 owner +9/9 restricted**, no skips. Native proof includes exact old/new DTO parity, missing/disabled/malformed policy, tenant isolation, actual SSO writer ordering, expiry after preparation and replacement before projection. Both owned fixtures were removed.

Attempt 01 failed due a test spy shadowing a later prototype spy; its logs remain intact. Test-only property restoration and a bounded ready latch fixed it. Application bytes stayed identical between attempts.

Source and cast checks passed. Test types remain **pending a refreshed build**: stale dist is missing the new export in two existing tests. No full-suite or capacity acceptance is claimed. See [manifest.json](manifest.json) for exact commands, source receipts and raw/sanitized/archive hashes.
