# ClassPilot native desktop integration

The native pilot adds independent installation/PIN identities and explicitly observed screen-source thumbnails to the existing student tile. The Chrome extension remains optional for desktop visibility and required for its own browser controls.

Canonical native documentation is in the local sibling ClassPilotDesktop repository:

- `docs/DESKTOP_AGENT_MVP.md`: support matrix, state model, data flow, resource limits, validation and packaging.
- `docs/DESKTOP_AGENT_PROTOCOL.md`: authentication, endpoints, exact source/authority bindings and expiry.

No remote native repository or production deployment is created by this integration.

## Local synthetic demonstration

Start the existing local Docker PostgreSQL/Redis services, install dependencies from the current lockfiles, then run:

```powershell
pwsh -NoProfile -File scripts/start-classpilot-native-local-demo.ps1
```

This helper uses a schema-only copy of a local fixture database and applies the canonical checksum ledger. It refuses production or non-loopback database URLs, creates a dedicated restricted application role, and provisions two synthetic schools through normal schema/storage paths. Staff authentication and native enrollment use real application routes. Credentials remain in an ACL-restricted user-local fixture file. It does not install an authentication bypass or copy a developer `.env`.

The default template names this workstation's existing local schema fixture. On another developer workstation, supply `-TemplateDatabase` with an existing local SchoolPilot schema fixture; no customer rows are copied. Each run provisions fresh synthetic identities. Replace the Agent's prior loopback enrollment when restarting the demonstration with those new identities.

The API listens on `127.0.0.1:4100`. Start the frontend with a local Vite proxy to that API on port 5179. Launch the native Agent with explicit loopback development mode, enroll using the private fixture's one-use token, and sign in the synthetic student with its generated identifier/PIN. Choose a source through the Windows picker; open **View desktop** in the teacher's existing tile.

`schoolpilot-app/scripts/native-desktop-local-e2e.mjs` authenticates through the real login route, opens the actual dashboard, and records content-free sequence/age/byte evidence. It does not mock native endpoints. Fixture UI tests remain available through `npm run test:classpilot-native-desktop`.

## Administrator API flow

Use an authenticated school administrator bearer and an explicitly selected synthetic school. The following example keeps the token in an environment variable; do not paste it into source or logs. The feature and school allowlist must already be enabled in the local API process.

```powershell
$Origin = 'http://127.0.0.1:4100'
$SchoolId = '<synthetic-school-id>'
$Headers = @{ Authorization = "Bearer $env:SCHOOLPILOT_ADMIN_TOKEN"; 'X-School-Id' = $SchoolId }
$Enrollment = Invoke-RestMethod "$Origin/api/classpilot/native/enrollment-tokens" -Method Post -Headers $Headers -ContentType 'application/json' -Body '{}'
# Enter $Enrollment.enrollmentToken in the visible Agent within ten minutes.
# To revoke a known installation belonging to this school:
$InstallationId = '<installation-id-from-the-administrative-record>'
Invoke-RestMethod "$Origin/api/classpilot/native/installations/$InstallationId" -Method Delete -Headers $Headers
```

Enrollment consumes the token once and returns a separate installation credential directly to the Agent. Revocation rejects future native sessions, uploads and reads. It does not revoke the student's browser session.

## Gates, persistence and rollout

`CLASSPILOT_NATIVE_VISIBILITY_MODE=on` and a valid `CLASSPILOT_NATIVE_VISIBILITY_SCHOOL_IDS` allowlist are both required. Other values or missing configuration are off. This permission is independent of shared-Chromebook login settings and browser capture policy. The synthetic helper enables only its newly generated schools locally.

Three school-scoped tables hold enrollment tokens, revocable installations and expiring native sessions. Migration `classpilot-native-visibility-20261026` installs same-school parents, active-session uniqueness and forced tenant policies. The new `classpilotNativeVisibilityPostExpand` target appends three tables to the immutable 129-table private-chat inventory, reaching 132. The ordered admission bundle is `classpilot_native_enrollment_tokens,classpilot_native_installations,classpilot_native_sessions`.

CI/current-target references follow 132; historical inventories, the generic 75-table default and observed production 121-table Terraform configuration stay preserved. No Terraform apply or production flag activation is part of this work. A separately authorized release must admit the complete reviewed bundle through the normal deployment machinery before activation. Production runtime configuration transport for these new flags must be reviewed before a pilot; do not hand-edit task definitions.

Disabling native visibility stops issuance and denies native reads/uploads. Keep the tables, tenant policies and cleanup semantics during containment or frontend rollback. Native changes do not establish a browser release or managed-device adoption claim.

## Verification status

The final local backend checks on October 26, 2026 passed: `npm run check`, `npm run build`, `npm run check:tests`, `npm run check:test-casts`, and the shared ClassPilotDesktop observed-policy fixture validator. The test-type ratchet reports 436 existing diagnostics against a 534-diagnostic ceiling, with zero application-source or syntax errors; it is not a claim that all historical test types are error-free.

The final focused native run passed **29/29**: 17 real API lifecycle/acceptance cases, seven protocol/image cases, and five forced-RLS cases. It ran serially on an isolated local database with the canonical 132-table RLS inventory and a restricted application role. Coverage includes browser/native coexistence, two-school isolation, independent viewers, current owner and administrator Observe permissions, supervision revisions, A-to-B-to-A identity changes, source-operation races, replay rejection, revocation, PIN isolation/rotation, and school/license expiry bounds. Disposable test roles were removed afterward.

The earlier complete backend run recorded **4,418 tests: 4,359 passed, 51 failed, eight skipped**. Every failure category subsequently passed a focused rerun; the complete suite was not rerun, so this is not a single fully green full-suite result:

| Initial failure category | Correction or fixture repair | Focused result |
| --- | --- | --- |
| Heartbeat foreground, inbox, screenshot evidence and installation | Canonical screenshot function/role ACLs and the required disposable database namespace | 77 passed |
| Cached heartbeat private-chat recovery | Same repaired heartbeat fixture | 4 passed |
| Rendered-load dependency closure | Restored pinned LF source bytes; all 19 affected files match HEAD exactly | 7 passed |
| Teacher-preferences migration ordering | Assert immutable relative ordering while allowing later migrations | 3 passed |
| Health sentinel integration | Use its required isolated component database namespace | 6 passed |

Content-free local evidence is consolidated in `%LOCALAPPDATA%\ClassPilotDesktop\validation\backend-completion-summary.json`; native results are in `native-completion.log`. These are local validation results. No production deployment, production flag activation, Terraform apply, or extension release was performed.

Automated native/backend/frontend results, real Windows picker/capture evidence and the 30-minute resource run are recorded with the final implementation report. macOS native capture is **NOT RUN** on this Windows host. Real lock/unlock, sleep/wake, user switching, HDR/display reconfiguration and managed-device rollout must retain their individual evidence status; passing mocked lifecycle tests does not establish native OS verification.
