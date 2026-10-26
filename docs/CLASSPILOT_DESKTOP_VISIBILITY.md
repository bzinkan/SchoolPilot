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

The initial focused native run passed **29/29**: 17 real API lifecycle/acceptance cases, seven protocol/image cases, and five forced-RLS cases. It ran serially on an isolated local database with the canonical 132-table RLS inventory and a restricted application role. Coverage includes browser/native coexistence, two-school isolation, independent viewers, current owner and administrator Observe permissions, supervision revisions, A-to-B-to-A identity changes, source-operation races, replay rejection, revocation, PIN isolation/rotation, and school/license expiry bounds. Disposable test roles were removed afterward.

The earlier complete backend run recorded **4,418 tests: 4,359 passed, 51 failed, eight skipped**. Every failure category subsequently passed a focused rerun; those results did not establish a single fully green full-suite result. A separate reliability run is recorded below:

| Initial failure category | Correction or fixture repair | Focused result |
| --- | --- | --- |
| Heartbeat foreground, inbox, screenshot evidence and installation | Canonical screenshot function/role ACLs and the required disposable database namespace | 77 passed |
| Cached heartbeat private-chat recovery | Same repaired heartbeat fixture | 4 passed |
| Rendered-load dependency closure | Restored pinned LF source bytes; all 19 affected files match HEAD exactly | 7 passed |
| Teacher-preferences migration ordering | Assert immutable relative ordering while allowing later migrations | 3 passed |
| Health sentinel integration | Use its required isolated component database namespace | 6 passed |

Content-free local evidence is consolidated in `%LOCALAPPDATA%\ClassPilotDesktop\validation\backend-completion-summary.json`; native results are in `native-completion.log`. These are local validation results. No production deployment, production flag activation, Terraform apply, or extension release was performed.

Automated native/backend/frontend results, real Windows picker/capture evidence and the 30-minute resource run are recorded with the final implementation report. macOS native capture is **NOT RUN** on this Windows host. Real lock/unlock, sleep/wake, user switching, HDR/display reconfiguration and managed-device rollout must retain their individual evidence status; passing mocked lifecycle tests does not establish native OS verification.

### Local Windows delivery, October 26, 2026

The measured Windows session completed 1,817 seconds with 361 process samples and 29 accepted uploads inside that interval. It included a teacher-read HTTP 503, an upload timeout, explicit source/viewer recovery and expired-image clearing; it is not evidence of uninterrupted viewing. The final client then delivered fresh frames with monotonic capture timing and passed a selected-source closure check: tile and enlarged images and foreground-app content cleared while Desktop remained selected.

After the operator's Ctrl+Alt+Delete/unlock sequence, the native guard cleared identity and preview, Resume required a PIN, and fresh PIN authentication alone did not start collection. This confirms input-desktop invalidation and reauthentication; the precise lock-versus-secure-desktop transition and OS-event-to-clear latency were not independently measured. Sleep/wake, user switching, RDP/HDR and macOS native testing remain unverified.

The source/build hashes, exact resource numbers, test results and these limitations are recorded in `ClassPilotDesktop/docs/WINDOWS_VALIDATION_2026-10-26.md`. Its development ZIP is unsigned and framework-dependent; production signing, managed deployment and fleet validation remain a later milestone.

### Backend reliability follow-up

The recorded teacher-read 503 cannot be assigned a definitive cause because the earlier request trace omitted its response code and phase. In the nearby Redis interval, one command exceeded the 250 ms shared coordination budget and was accepted late at 443 ms. A controlled real RESP test reproduced that failure with a 350 ms reply. Native image/lease operations now allow a bounded 750 ms reply within their request deadline; browser coordination retains its 250 ms behavior. Uncertain commands are never replayed and there is no local authority fallback.

A separate real HTTP regression confirmed that staff native requests held the authentication tenant client while acquiring a second pool client. The native router now releases the completed authentication lease before its own tenant transaction and rechecks current authority there. Authority locks remain intact. Native transactions use a one-second lock timeout and two-second statement timeout, and check a four-second request deadline before publication. Contention produces a fixed denial code instead of waiting through the client's five-second upload timeout. Slow, failed and disconnected native requests emit fixed operation/phase/outcome fields without identities, URLs, credentials or image content.

Redis Lua uses execution-time `TIME` checks and absolute `PXAT` deadlines for viewer leases, grants, images and sequence retention. A delayed command cannot extend the original expiry, publish an expired capture, or replace/delete an image from a newer binding. Stop may additionally supply its exact `sourceGeneration`: this clears that same source after a lost policy response while rejecting a replacement source or a future revision. Revision-only callers retain strict compare-and-swap behavior.

The follow-up passed **41/41 native tests** (29 API/reliability, seven protocol/image and five forced-RLS) and **15/15 bounded Redis tests**, including controlled delayed execution, lock contention, and failures after a response has already ended. The native handler delegates late errors without attempting a second response; a deadline crossed during successful serialization cannot retroactively deny the sent response. A final synchronous batch check removes expired pixels, app observations and image timing/sequence fields if an earlier image expires while a later student's read awaits completion. Build, application type checking and both test ratchets passed without increasing existing debt. Local evidence is in `native-batch-deadline-final.log`, `native-response-guard.log`, `native-reliability-transport.log` and `backend-reliability-summary.json` under the private validation directory. These results do not by themselves establish uninterrupted Windows viewing or a production load qualification.

The existing worker/private-chat suites passed **73/73** with a restricted runtime role and the canonical heartbeat-function installation plus its exact scoped EXECUTE grant. A first fixture attempt passed 69 and failed four because that disposable role lacked EXECUTE; no application or SQL-definition change was required. The initial PR backend CI unit lane exposed one stale total-migration-count assertion (57 versus the newly appended 58). The historical index and immutable checksum guards are preserved while allowing append-only additions; all **31** installation-contract tests pass after that correction.

### Windows reliability follow-up

The Windows client at `1caea17143bfb3bc6118cfba7d7ab13509a85aff` passed 120 assertions in both Debug and Release. Production lifecycle components received controlled WTS, power, session and source-race inputs; these are simulated results. The operator confirmed this PC remains unlocked and does not sleep. Physical lock/unlock, sleep/wake and user switching were not triggered during this pass. A headed Chromium minimize command did not produce a hidden document, so actual page hiding remains unverified; controlled visibility and expired/failed-view tests passed.

The live synthetic check used the real API, restricted tenant role, production frontend preview, normal Windows capture picker and a synthetic window. Loading the teacher roster and selecting a native source did not start capture. One explicitly injected policy 503 suspended capture until a bounded second policy check succeeded. The same source then uploaded successfully. Taking the teacher browser offline cleared both image surfaces and both foreground-app labels; reconnecting did not regrant observation until explicit Retry. A separately injected selected-image read 503 also cleared all four surfaces and released the viewer.

Withdrawing the real Agent consent checkbox cancelled its loop, retained the verified student, and completed server cleanup in 149 ms. The teacher's four surfaces were empty at the next recorded sample about 2.8 seconds later. Checking consent again left sharing stopped; explicit Resume and source selection were required. A private loopback proxy then delayed an already accepted upload response by 5,500 ms: the client timed out after 5,016 ms, attempted the upload once, cleared the source with HTTP 204, and kept no queue. The teacher briefly displayed that authorized image before cleanup; no enlarged preview was opened for this timeout case. Explicit recovery restored viewing. Closing the selected synthetic window then cancelled capture, completed cleanup in 68 ms and cleared all four teacher surfaces at a sample about 1.6 seconds after closure. These sampled timings are local observations, not general performance guarantees.

The lifecycle harness records operation/status/latency, timer gaps, viewer ordinals, sequence/expiry and surface-presence booleans without recording screenshots, identities, request bodies or credentials. Native source/build identifiers, package identity and detailed evidence are maintained in the sibling repository's `docs/WINDOWS_RELIABILITY_2026-10-26.md`. Synthetic sessions were signed out and their installation was revoked after testing. Native visibility remains default-off with an empty school allowlist in the committed configuration.

Frontend verification passed 25 focused tests, the six required dashboard regression gates, lint (zero errors, 32 existing warnings) and the production build. Two real teacher sessions delivered 14 frames without page errors or saved screenshots. The final Windows package was built from clean native commit `8a6a4a293f55b1278de9deebd466f6fbb79838ab` (documentation added after the tested client commit above): `windows-dev-20261026-154943.zip`, 21,419,972 bytes, SHA-256 `8030CB7B0BA2B7ACFA73117FA0B79C7BDC3F6043B6B0403A93C4F34F98105E43`. Locked restore, Release build and all 120 assertions passed during packaging; all 39 manifest hashes were checked against the ZIP. The unsigned package remains local and contains no credentials, raw captures or private logs.
