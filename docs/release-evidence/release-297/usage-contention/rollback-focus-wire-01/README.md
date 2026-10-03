# Compatible rollback Focus backport

Base source: 5c01944ed1afb4241e270469c6477121bf48cd84. This packet records the uncommitted narrow backport reviewed before its later source commit. Only Focus ingress normalization, semantic ACK comparison, matching contract and tests changed. No Usage performance, fair scheduler, broad schema or deployment changes were copied.

The unchanged packaged ClassPilot 2.9.7 wire fixture is shared with primary commit0e427e3c. The canonical focusStatus field reaches heartbeat and WebSocket locked ACK paths; legacy alias behavior and ambiguity handling match primary. JSONB key order no longer forces repeated writes.

Verification:

- Baseline wire/semantic regression:6pass,19fail (retained red).
- Corrected focused wire/ACK/Focus/protocol suites:61pass,0fail,0skip.
- Existing restricted Focus native suite plus the regression:13pass,0fail,0skip. Actual app role is NOSUPERUSER,NOBYPASSRLS and owns no tables. Privileged connection is bootstrap/cleanup only. No owner-suite pass is claimed because this suite explicitly requires restricted execution.
- Native seven-file snapshots match before/after. Owned fixture c3e411e92495 removed after exact name/label/image proof.
- Build, test-types and test-cast ratchets all exit0; baselines unchanged.
- Pure release-floor proof uses explicitly synthetic API/worker task definitions:129admission, writer1,bridge1,relay1 preserved. Registry, lifecycle migration/writer/protocol unchanged. Both Usage modes default off and must remain off when using this fallback.

No fallback image was built, pushed or deployed. The source-only floor proof is not actual production admission or an image verification. Historical artifacts remain unchanged. Native schema-only dump content is excluded; its hash remains in execution.json. The runner uses the reviewed primary bounded child-process helper but executes fallback source through tsx.

Commands (cwd isolated compatible rollback worktree):

node --import ./tests/test-environment.mjs --import tsx --test tests/classpilot-focus-wire.test.ts
node --import ./tests/test-environment.mjs --import tsx --test tests/classpilot-focus-wire.test.ts tests/classpilot-control-state-ack-gate.test.ts tests/classpilot-focus.test.ts tests/classpilot-protocol.test.ts
npm run build
npm run check:tests
npm run check:test-casts
pwsh -NoProfile -File $env:TEMP/release297-rollback-focus-wire-native-01.ps1
node --import tsx $env:TEMP/release297-rollback-focus-wire-floor-01.mjs
