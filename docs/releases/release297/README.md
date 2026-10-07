# Current release record

`current-release.json` is the current preparation index for the bounded DeSales
133-client release. It records observed source state and evidence applicability,
not deployment readiness or operational authorization. Historical receipts remain
immutable; failed attempts and `waived_not_passed` retain their original outcomes.

Update this index when a new source, artifact or reviewed observation supersedes a
current fact. Set a frozen application reference only after the reviewed release
changes are selected. Record real source-specific receipts before changing a gate
to passed; application changes require refreshed affected acceptance, while
tool/document-only changes require proven application equivalence and fresh
applicable CI. Refresh live-state observations before each separately authorized
operator action. Unknown values must remain unknown.

Each `gitBlobSha256` hashes canonical UTF-8 Git text with LF line endings. It
identifies tracked receipt content equally on Windows and Linux; it does not
replace raw artifact/archive/scan hashes or erase CRLF differences in a packaged
extension. The fresh extension record carries the canonical verification pass
and the distinct retained raw-Git comparison failure.

The fresh local artifact observation records preparation-only backend/frontend
identities and a Linux screenshot-processing pass. These sources are not frozen
resulting main. The exact retained C578 fallback's fresh scan is **failed** with
one Critical and one High finding. Its historical passing scan remains dated
evidence; resolve the failure through separate review before executable release
plans. This index does not authorize substituting another fallback.

Generate the operator checklist's current section offline:

```text
node scripts/release297-current-state.mjs
node scripts/release297-current-state.mjs --check
node --test tests/release297-current-state.test.mjs
```

The checker verifies referenced evidence content, source/merge and artifact
metadata, key release invariants and the generated section. Its `--check` mode
does not write files or query providers. It is included in the unit test lane via
the current-state regression suite. Passing this checker is documentation
validation, not candidate acceptance.

Public records contain only source, artifact and aggregate operational metadata.
Keep identifiers, credentials, private captures and raw runtime exports in the
protected operator evidence location.
