# ClassPilot classroom-state recovery

`classroom-state-request` uses the existing tenant-scoped student-control
delivery transaction. Each admitted request freezes the socket's exact
school/student/session/device identity, negotiated capabilities and server
authentication generation. Admission occurs before the serial frame queue;
one queued or running recovery is allowed for that connection and generation.
Duplicate requests coalesce without reordering commands or acknowledgements.

The handler checks current registration, authentication generation, socket
state and shutdown admission before execution, around awaited preparation and
immediately before synchronous sends. Close/error invalidates that connection.
A superseded attempt cannot clear a newer generation's admission token.

An ordinary disconnect or superseded identity throws a typed cancellation
inside the authority operation. The handler records it only after the
transaction has unwound. This preserves rollback of preparation, including
legacy tab Focus retirement, target changes, cleanup commands and audit rows.
It never turns a missed socket delivery into committed cleanup. SQL, commit,
serialization and synchronous/asynchronous send errors remain operational
failures, even if the peer also closes. Cancellation is not inferred from
error text, `AbortError`, or socket state after an unrelated error.

Socket sends are queued synchronously while the final exact-binding lock is
held. Every queued callback remains observed after the transaction unwinds,
including after a failed commit or later send, outside the serial command/ACK
queue and under the existing shutdown work tracker. A failed callback cannot
release shutdown ownership of another pending callback.
`classroomRecoveryTransmitted` means transaction completion and transport
write completion; it does not establish that the extension applied the state.
The existing exact-bound classroom-state ACK remains application evidence.
Authority denial and capability withholding are separate outcomes and never
produce a fabricated empty restriction state.

The existing `SchoolPilot/RuntimePerformance` minute summaries contain fixed
aggregate counters: `classroomRecoveryAdmitted`, `classroomRecoveryCoalesced`,
`classroomRecoveryCancelledClosed`, `classroomRecoveryCancelledSuperseded`,
`classroomRecoveryDenied`, `classroomRecoveryWithheld`,
`classroomRecoveryTransmitted`, `classroomRecoveryServiceFailed` and
`classroomRecoveryTransportFailed`, plus `classroomRecoveryMs` timing.
Quiet counters remain in the summary; only moved counters become metrics.
Failure logs contain fixed stage labels and safe error type/code only.
No identities, URLs, raw request reasons, or installed-client assumptions are
added to diagnostics. Existing disconnect metrics and genuine-error alarms
remain active; their thresholds are unchanged.

There is no new retry timer. A closed connection's prepared state is never
reused on another socket. Replacement authentication prepares current state;
the extension's existing heartbeat reconciliation supplies another snapshot.
The existing client heartbeat interval (10 seconds), classroom-state request
throttle (30 seconds), and reconnect backoff (10 seconds initially, capped at
120 seconds with 0–20% jitter) are unchanged. This server change does not
publish a ClassPilot extension or establish managed-device adoption.

Verification uses deterministic coordinator and real request-handler tests,
plus the restricted local-database retirement suite. Its cancellation case
asserts unchanged control state, target, command and audit rows after rollback,
then verifies that a fresh connection retires and queues cleanup once and
subsequent recovery does not repeat retirement. Production commands or load
tests are unnecessary for this verification.
