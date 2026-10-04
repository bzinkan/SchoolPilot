# Focus status wire correction

The exact retained ClassPilot 2.9.7 ZIP sends `focusStatus` on heartbeats and classroom-state ACKs. The server previously read `focus`, losing active/suspended acknowledgements and invalidation reports. Both ingress paths now share a bounded resolver. The provisional alias remains accepted only when canonical input is absent or both fields validate to the same status. Invalid canonical input never falls back. The existing locked storage assignment, binding, revision and authority validation is unchanged.

The focused regression also exposed order-sensitive JSON comparison: schema-normalized status was compared to raw stored JSON. Semantic equality now ignores JSONB key ordering, preventing unchanged status from generating repeated ACK writes. Invalid reported status is still ignored; invalid stored status allows a valid replacement.

Evidence:

- Original wire regression: 24 tests, 6 passed and 18 failed against the old server. Retained in red-01.
- First correction attempt: delivery passed but unchanged-status assertions exposed the JSON-order bug. Retained as green-01 despite its filename; it is a failed attempt.
- Final focused wire/control-state ACK/Focus/optional-status/protocol suites: 64 passed, zero failed/skipped.
- Build, test-type and cast ratchets: all exit zero.
- Existing Focus integration suite plus one new regression: 15 passed, zero failed/skipped. The application used an actual NOSUPERUSER/NOBYPASSRLS role owning no tables; independent privileged access only bootstrapped and cleaned the owned fixture. This suite requires restricted execution, so no owner-role pass is claimed.
- Native coverage includes JSONB round-trip semantic no-op, active/suspended state, exact invalidation, wrong binding/revision/assignment rejection, malformed canonical no-fallback and repeated old invalidation fencing. All seven captured source files remained unchanged. The owned container was removed after exact name/label/image checks.
- Native runner01 failed PowerShell parsing before execution; no fixture existed. Runner02 is the corrected successful attempt. Both are retained.

The packaged producer snippets are byte-bound to the unchanged ZIP and service-worker hashes in packaged-source-verification.json. Tests execute those captured producer snippets and the actual server ACK blocks, not a duplicated ACK implementation. The restricted suite exercises the canonical locked storage API. This is focused correction evidence, not final release or capacity acceptance.

Commands (cwd release-stabilization-297/SchoolPilot):

```powershell
node --import ./tests/test-environment.mjs --import tsx --test tests/classpilot-focus-wire.test.ts
node --import ./tests/test-environment.mjs --import tsx --test tests/classpilot-focus-wire.test.ts tests/classpilot-control-state-ack-gate.test.ts tests/classpilot-focus.test.ts tests/classpilot-focus-optional-status.test.ts
node --import ./tests/test-environment.mjs --import tsx --test tests/classpilot-focus-wire.test.ts tests/classpilot-control-state-ack-gate.test.ts tests/classpilot-focus.test.ts tests/classpilot-focus-optional-status.test.ts tests/classpilot-protocol.test.ts
npm run build
npm run check:tests
npm run check:test-casts
pwsh -NoProfile -File $env:TEMP/release297-focus-wire-native-01.ps1
pwsh -NoProfile -File $env:TEMP/release297-focus-wire-native-02.ps1
```

Each command output is archived separately. Schema contents are excluded from this packet; their original SHA is retained in execution.json. No production, extension package, pool size or timeout change occurred.
