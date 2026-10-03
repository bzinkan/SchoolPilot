# Live binding query optimization

Incremental proof based on `25ba868685fa4aa5010023b55f3705a5e525e6fd`; not final capacity acceptance. The live query preserves the previous generated SQL (case/whitespace normalization only), all nine parameter values/order, database-clock lease predicate, and shared locks on session, student and device. Ended/tombstone and replacement reads remain unchanged.

Unit equivalence: **2/2**. Native owner: **15/15**. Native restricted role: **15/15**, no skips. Native cases include lease expiry after preparation, exact tenant/tuple rejection, each joined-row writer waiting until delivery, committed signout/replacement and unchanged tombstone handling. Source/type/cast checks passed; owned fixture removed.

Compilation-only rerun median: **318.335 ms →135.722 ms per3000**, six alternating rounds; one query remains one query. Historical first comparison is preserved and marked as concurrent with other local checks. This is not capacity acceptance.

See [manifest.json](manifest.json) for commands, source receipts, sanitization/raw/archive hashes and limits.
