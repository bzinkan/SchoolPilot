# ClassPilot private chat readiness

Private chat readiness describes whether a new teacher reply can safely be sent
to the current student. It is separate from classroom authority, the private
chat lifecycle token, and whether a student still has an active login. A lost
monitoring signal does not establish that the extension needs an update.

## Teacher response contract

When private chat lifecycle enforcement is required, each row in
`GET /api/classpilot/teacher/messages`'s `privateChatLifecycles` retains its
`studentId`, classroom authority, `privateChatLifecycle` token and conservative
`supported` boolean. The additive `readiness` field has these values:

| Readiness | Meaning | `supported` |
| --- | --- | --- |
| `ready` | Current binding and fresh accepted capability evidence permit a new reply. | `true` |
| `update_required` | Fresh current-client evidence lacks accepted `privateChatLifecycleV1`. | `false` |
| `reconnecting` | Telemetry is stale, absent, expired, or does not match the current binding. | `false` |
| `signed_out` | No current student binding exists, or the matching snapshot records sign-out. | `false` |
| `unavailable` | Shared readiness telemetry could not be read reliably. | `false` |
| `disabled` | Capability issuance is disabled after lifecycle adoption. | `false` |

The response adds no device IDs or student-session identifiers. Teaching-session
or supervision-context authority and the opaque lifecycle token retain their
existing purpose. Readiness never grants authority, broadens recipients, or
replaces entitlement, immutable staff, frozen-roster, ownership and lifecycle
revision checks. A blocked new send creates no queued private reply. Closing an
existing conversation remains available under its existing authorization rules.

## Evidence and compatibility

Chromebook readiness resolves the current exact student/session/device binding
internally, then reads its matching shared realtime snapshot. An active snapshot
must be less than 60 seconds old before its accepted capabilities can establish
`ready` or `update_required`. A Redis miss, binding mismatch or stale snapshot
means reconnecting; a shared-cache outage means temporarily unavailable.
Extension version text is not the capability decision.

A fresh legacy or partial snapshot with no accepted-capability array is unknown,
so it reports `unavailable`, not `update_required`. Internally, a writer that
receives an authoritative empty negotiated array records
`acceptedCapabilitiesEmpty: true`; that marker permits an unsupported diagnosis
only after the binding, sign-out and freshness checks. It never grants support.
Only literal `true` is accepted, and a present malformed capability list cannot
use the marker. Capable snapshots carry their accepted array and no empty marker,
so loss of that array cannot turn a partial row into an update diagnosis.
The marker stays internal. Existing omission of an empty `acceptedCapabilities`
list and both screenshot compatibility selectors remain unchanged.

With Windows browser integration enabled, readiness uses the existing live
browser/Guard authority resolver. Every returned browser must have a valid,
fresh `lastSeenAt` before capabilities establish a readiness diagnosis. The
freshness window is also 60 seconds; missing/invalid timestamps and timestamps
more than 60 seconds in the future require reconnection. All current browsers
must accept the private chat capability. One stale browser cannot borrow fresh
evidence from its sibling, and stale unsupported metadata cannot require an
update. The existing Chromebook fallback is unchanged when the resolver returns
no live Windows browsers.

`privateChatBindingReadiness()` serves teacher projection and new-send checks.
`privateChatBindingSupported()` remains the existing durable-delivery predicate:
Windows recovery still uses its Guard/capability authority without adding the
new browser-readiness freshness requirement. Exact recipient binding, current
classroom authority, lifecycle fences and acknowledgement rules remain enforced.

## Send errors and older servers

New-send readiness failures return HTTP 409 with distinct codes:

| Code | Updated dashboard behavior |
| --- | --- |
| `PRIVATE_CHAT_CLIENT_UPDATE_REQUIRED` | Show the update instruction for confirmed unsupported clients. |
| `PRIVATE_CHAT_RECONNECT_REQUIRED` | Explain that private chat resumes when the student reconnects. |
| `PRIVATE_CHAT_SIGN_IN_REQUIRED` | Explain that the student must sign in. |
| `PRIVATE_CHAT_READINESS_UNAVAILABLE` | Show a synchronization/retry message. |

Existing `PRIVATE_CHAT_DISABLED`, `PRIVATE_CHAT_LIFECYCLE_STALE` and hard
messaging-switch errors retain their checks. The updated dashboard refreshes
authoritative lifecycle state after readiness errors.

Older servers used `PRIVATE_CHAT_UPDATE_REQUIRED` for both unsupported clients
and lost telemetry. The updated dashboard therefore treats that legacy error
as synchronization uncertainty, never proof that an update is needed. For an
older DTO with no `readiness`, `supported: true` retains the established positive
decision; `supported: false` shows synchronization copy. Unknown readiness
values or contradictory rows cannot enable Send; only explicit
`update_required` with `supported: false` establishes an update diagnosis.
Lifecycle tokens must still be valid and match the selected student and
classroom authority.

## Recovery and verification

The existing canonical-history poll refreshes readiness every 15 seconds while
the staff WebSocket is authenticated and every 30 seconds otherwise. Polling is
paused in the background; window focus and WebSocket reauthentication also
refresh history. A fresh authorized snapshot can enable the existing composer
without a page reload. Scope/request generations and monotonic lifecycle tokens
prevent another student's, another class's or an older conversation's response
from granting permission to send.

Run frontend regressions from `schoolpilot-app/`:

```powershell
node --test scripts/chat-threads.test.mjs scripts/private-chat-lifecycle.test.mjs
node --test scripts/classpilot-messages-roster-browser.test.mjs
```

For backend coverage, prepare an isolated current-schema local database and
Redis fixture using the repository's CI/local test posture. Supply local
`DATABASE_URL`, `ADMIN_DATABASE_URL` and `TEST_REDIS_URL`; restricted roles also
need the reviewed per-role execution grant for
`classpilot_heartbeat_screenshot_evidence_v1`, without granting it to `PUBLIC`.
Build first because the Windows suite exercises `dist`:

```powershell
npm run build
node --import ./tests/test-environment.mjs --import tsx --test --test-concurrency=1 tests/classpilot-private-chat-lifecycle.integration.test.ts tests/classpilot-windows-integration.test.ts
```

These suites cover readiness/error classification, blocked sends, exact-scope
recovery, signed-out cleanup, Windows freshness and delivery compatibility, and
rendered composer behavior. Run the broader gates in `CLAUDE.md` as well.
Disposable-browser and synthetic service tests do not establish managed-device
adoption or physical Chromebook acceptance.
