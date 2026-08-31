import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

function section(value: string, start: string, end: string): string {
  const startIndex = value.indexOf(start);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  const endIndex = value.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return value.slice(startIndex, endIndex);
}

test("gate-off and signal-loss paths cannot author deferred restrictions", () => {
  const routes = source("../src/routes/classpilot/commands.ts");
  const dispatcher = source("../src/services/classpilotCommandDispatcher.ts");
  const resolution = section(
    routes,
    "async function resolveTargets",
    'router.post("/commands"',
  );
  const offlinePolicy = section(
    dispatcher,
    "function applyOfflineRestrictionPolicy",
    "function restrictionsAreEmpty",
  );

  assert.match(
    resolution,
    /lateSignInAuthoringAllowed = lateSignInGateActive[\s\S]*LATE_SIGN_IN_PERSISTENT_COMMANDS\.has\(commandType\)[\s\S]*!currentPageWaypoint/,
  );
  assert.match(
    resolution,
    /deviceReachable = !!studentSession[\s\S]*!!realtimeSnapshot[\s\S]*classpilotRealtimeFresh\(realtimeSnapshot\)/,
  );
  assert.match(resolution, /explicitlySignedOut = !studentSession/);
  assert.match(resolution, /deferredAuthorized = explicitlySignedOut && lateSignInAuthoringAllowed/);
  assert.match(
    resolution,
    /Student signal is unavailable; restriction was not changed/,
  );
  assert.match(offlinePolicy, /isClasspilotCapabilityActive\([\s\S]*"lateSignInRestrictionSsoV1"/);
  assert.match(
    offlinePolicy,
    /target\.stateAuthorized === false[\s\S]*!target\.lateSignInEligible[\s\S]*!gateActive[\s\S]*!allowlisted[\s\S]*stateAuthorized: false/,
  );
});

test("CURRENT_URL remains an exact live lookup and never durable command metadata", () => {
  const dispatcher = source("../src/services/classpilotCommandDispatcher.ts");
  const coverage = source("../src/routes/classpilot/coverage.ts");
  const resolver = section(
    dispatcher,
    "async function resolveCurrentUrlLockTargets",
    "function applyOfflineRestrictionPolicy",
  );
  const dispatchStart = dispatcher.indexOf("export async function executeClasspilotCommand");
  assert.notEqual(dispatchStart, -1);
  const dispatch = dispatcher.slice(dispatchStart);

  assert.match(resolver, /readClasspilotRealtimeStatusBatch\(options\.schoolId, bindings\)/);
  assert.match(resolver, /snapshot && classpilotRealtimeFresh\(snapshot\)/);
  assert.match(resolver, /current_page_requires_online_student/);
  assert.match(resolver, /current_page_unavailable/);
  assert.match(
    dispatcher,
    /skippedCurrentPageCount: countClasspilotCurrentPageSignedOutSkips\(policyTargets\)/,
  );
  assert.doesNotMatch(
    dispatcher,
    /unavailableReason === "Current-page Waypoint skipped because the student is signed out"/,
  );
  assert.match(
    coverage,
    /currentPageWaypoint[\s\S]*classpilotCurrentPageSignedOutSkipReason\([\s\S]*explicitlySignedOut/,
  );
  assert.doesNotMatch(
    coverage,
    /Current-page Waypoint skipped because the student is signed out/,
  );
  assert.match(
    dispatch,
    /storedCommandPayload = currentPageRequested[\s\S]*Object\.fromEntries\(Object\.entries\(commandPayload\)\.filter\(\(\[key\]\) => key !== "url"\)\)/,
  );
  assert.match(dispatch, /storedCommandPayload\.currentPage = true/);
  assert.match(dispatch, /payloadByStudent,[\s\S]*bindingExpectationByStudent/);
  assert.match(
    dispatch,
    /payloadByStudent\?\.get\(target\.studentId\)\?\.url[\s\S]*url: payloadByStudent\.get\(target\.studentId\)!\.url/,
  );
  assert.doesNotMatch(dispatch, /commandPayload:\s*\{[^}]*url:\s*"CURRENT_URL"/);
});

test("persistence serializes transfer races and rejects changed or expired bindings", () => {
  const storage = source("../src/services/storage.ts");
  const persist = section(
    storage,
    "export async function persistClasspilotControlCommandState",
    "export async function upsertClasspilotClassroomStates",
  );
  const supervision = section(
    storage,
    "export async function replaceClasspilotSupervisionControlSnapshots",
    "export async function persistClasspilotControlCommandState",
  );
  const unavailable = section(
    storage,
    "export async function markClasspilotCommandTargetsUnavailable",
    "export async function markClasspilotCommandTargetsServerCompleted",
  );

  for (const writer of [persist, supervision]) {
    assert.ok(
      writer.indexOf("lockClasspilotStudentControlAuthorities") < writer.indexOf("expectedDeviceIds"),
      "shared student authority must precede exact device/session locks",
    );
    assert.ok(
      writer.indexOf(".from(devices)") < writer.indexOf(".from(studentSessions)"),
      "writers must keep device-before-session lock ordering",
    );
    assert.match(writer, /manualLeaseExpiresAt} > now\(\)/);
    assert.match(writer, /expectation\.kind === "signed_out"[\s\S]*!active/);
    assert.match(
      writer,
      /active\.schoolId === options\.(?:studentSnapshots\.)?schoolId[\s\S]*active\.studentSessionId === expectation\.studentSessionId[\s\S]*active\.deviceId === expectation\.deviceId/,
    );
  }
  assert.match(persist, /rejectedStudentIds\.push\(studentId\)/);
  assert.match(persist, /acceptedStudentIds\.length === 0[\s\S]*rejectedStudentIds/);
  assert.match(unavailable, /status: "unavailable"/);
  assert.match(unavailable, /updateClasspilotCommandSummary\(commandId\)/);
});

test("deferred ACK requires gate, capability, exact active binding, and a live manual lease", () => {
  const storage = source("../src/services/storage.ts");
  const ack = section(
    storage,
    "export async function acknowledgeClasspilotStudentControlState",
    "export async function persistClasspilotControlCommandState",
  );

  assert.match(ack, /readClasspilotLateSignInDeliveryProvenance\(current\.desiredState\)/);
  assert.match(ack, /isClasspilotCapabilityActive\([\s\S]*"lateSignInRestrictionSsoV1"/);
  assert.match(ack, /acceptedCapabilities\?\.includes\("lateSignInRestrictionSsoV1"\)/);
  assert.match(ack, /recordClasspilotLateSignInAppliedBinding/);
  assert.match(ack, /active_session\.id = \$\{options\.studentSessionId\}/);
  assert.match(ack, /active_session\.student_id = \$\{options\.studentId\}/);
  assert.match(ack, /active_session\.device_id = \$\{options\.deviceId\}/);
  assert.match(ack, /active_device\.school_id = \$\{options\.schoolId\}/);
  assert.match(ack, /active_session\.manual_lease_expires_at > now\(\)/);
  assert.doesNotMatch(ack, /delete\([^)]*lateSignInDelivery/);

  const devices = source("../src/routes/classpilot/devices.ts");
  const heartbeatAck = section(
    devices,
    "const [heartbeat, controlState] = await Promise.all",
    "const screenshotTrackingAuthority",
  );
  assert.match(
    heartbeatAck,
    /classpilotLateSignInRevisionAppliedToBinding[\s\S]*!deferredBindingAlreadyApplied[\s\S]*classpilotControlStateHasLateSignInOrigin[\s\S]*acknowledgeClasspilotStudentControlState/,
  );
});

test("mixed-version delivery and every unauthenticated fallback hide deferred revisions", () => {
  const devices = source("../src/routes/classpilot/devices.ts");
  const websocket = source("../src/realtime/websocket.ts");
  const screenshotPolicy = source("../src/services/classpilotScreenshotPolicy.ts");
  const lifecycle = source("../src/services/classpilotSessionLifecycle.ts");
  const delivery = source("../src/services/classpilotControlStateDelivery.ts");
  const fab = source("../src/services/classpilotFab.ts");
  const dispatcher = source("../src/services/classpilotCommandDispatcher.ts");

  const settings = section(
    devices,
    'router.get("/extension/settings"',
    'router.post("/extension/student-login"',
  );
  assert.match(settings, /classpilotControlStateHasLateSignInOrigin\(controlState\.desiredState\)/);
  assert.match(settings, /settingsControlRevision[\s\S]*:\s*0/);
  assert.match(settings, /controlRevision: settingsControlRevision/);
  assert.match(settings, /ownershipRevision: settingsControlRevision/);

  const wsRequest = section(
    websocket,
    'message.type === "classroom-state-request"',
    'message.type === "command-ack"',
  );
  assert.match(wsRequest, /serializeClasspilotStudentControlStateForDelivery/);
  assert.match(wsRequest, /acceptedCapabilities: client\.acceptedCapabilities \?\? \[\]/);
  assert.match(
    wsRequest,
    /finalSessions = await getActiveSessionsForStudents[\s\S]*exactBindingStillActive[\s\S]*if \(!exactBindingStillActive\) return \{ active: false as const, state: null \}/,
  );
  assert.match(wsRequest, /controlRevision: reconciliation\.state\?\.revision \?\? 0/);

  assert.match(lifecycle, /classpilotControlStateHasLateSignInOrigin\(state\.desiredState\)[\s\S]*return/);
  assert.match(
    delivery,
    /state && classpilotControlStateHasLateSignInOrigin\(state\.desiredState\)[\s\S]*continue/,
  );
  assert.match(
    websocket,
    /fab: \{[\s\S]*\.\.\.bootstrap\.fab,[\s\S]*ownershipRevision: classroomState\?\.revision \?\? 0/,
  );
  assert.match(
    devices,
    /deliveredFab = fab[\s\S]*ownershipRevision: classroomState\?\.revision \?\? 0/,
  );
  assert.match(
    websocket,
    /trackingAuthority: classpilotScreenshotAuthorityForDeliveredControl\([\s\S]*deliveredControlRevision: classroomState\?\.revision \?\? 0/,
  );
  assert.match(
    devices,
    /trackingAuthority: classpilotScreenshotAuthorityForDeliveredControl\([\s\S]*deliveredControlRevision: classroomState\?\.revision \?\? 0/,
  );
  assert.match(
    devices,
    /revalidateClasspilotSafetyExactBinding\([\s\S]*expectedControlRevision: controlState\?\.revision \?\? 0,[\s\S]*deliveredControlRevision: classroomState\?\.revision \?\? 0/,
  );
  assert.match(
    source("../src/services/storage.ts"),
    /controlRevision === options\.expectedControlRevision[\s\S]*controlRevision: deliveredControlRevision/,
  );
  assert.match(
    screenshotPolicy,
    /projection\.authority\.controlRevision === deliveredControlRevision[\s\S]*kind: "student_session"[\s\S]*controlRevision: deliveredControlRevision/,
  );
  assert.match(
    fab,
    /classpilotControlStateHasLateSignInOrigin\(controlState\.desiredState\)[\s\S]*const fullState = await buildStudentFabState/,
  );
  assert.match(
    dispatcher,
    /deferredIds\.has\(target\.studentId\) && !classroomStateByStudent\.has\(target\.studentId\)[\s\S]*continue/,
  );
  assert.match(dispatcher, /delivered\.withheld[\s\S]*lateSignInDeliveryWithheld/);
});

test("registration responses return the exact accepted-capability negotiation used for delivery", () => {
  const devices = source("../src/routes/classpilot/devices.ts");
  const login = section(
    devices,
    "async function completeStudentDeviceLogin",
    "async function recordRemoteActionTimeline",
  );
  assert.match(login, /const loginProtocol = negotiateClasspilotSurfaceProtocol/);
  assert.match(login, /acceptedCapabilities: loginProtocol\.acceptedCapabilities/);
  assert.match(login, /return \{[\s\S]*\.\.\.loginProtocol,[\s\S]*classroomState/);
});

test("deferred command frames and WebSocket auth revalidate exact binding authority", () => {
  const dispatcher = source("../src/services/classpilotCommandDispatcher.ts");
  const websocket = source("../src/realtime/websocket.ts");
  const devices = source("../src/routes/classpilot/devices.ts");
  const frame = section(
    dispatcher,
    "export function classpilotCommandFrameForTarget",
    "async function endStudentSessionsForSignOut",
  );
  const studentAuth = section(
    websocket,
    '// --- Auth handling ---',
    '} else {\n              ws.send(JSON.stringify({ type: "auth-error", message: "Student token required"',
  );
  const staleHeartbeatStart = devices.indexOf('realtimeStatusMutation.status === "stale"');
  assert.notEqual(staleHeartbeatStart, -1);
  const staleHeartbeat = devices.slice(staleHeartbeatStart, staleHeartbeatStart + 750);

  assert.match(
    frame,
    /classroomState\?\.deliveryContext\?\.lateSignInRestrictionSso === true[\s\S]*exactBinding: classpilotControlStateExactBinding\([\s\S]*controlRevision: classroomState\.revision/,
  );
  assert.match(
    frame,
    /type: "remote-control"[\s\S]*\.\.\.bindingEnvelope,[\s\S]*\.\.\.deferredExactBindingEnvelope,[\s\S]*classroomState/,
  );
  const normalFrame = frame.slice(frame.lastIndexOf('\n  return {'));
  assert.doesNotMatch(
    normalFrame,
    /command:\s*\{[\s\S]*\.\.\.deferredExactBindingEnvelope/,
    "the exact binding has one canonical outer envelope",
  );
  assert.match(studentAuth, /const finalAuthority = await runWithTenantContext/);
  assert.match(
    studentAuth,
    /beforeClaim = await resolveActiveStudentTokenSession\(payload\)[\s\S]*claimDueTeacherChatDeliveriesForBinding[\s\S]*afterClaim = await resolveActiveStudentTokenSession\(payload\)/,
  );
  assert.ok(
    studentAuth.indexOf("if (!finalAuthority)") < studentAuth.indexOf("authenticateWsClient(ws"),
    "final exact authority must be checked before socket authentication",
  );
  assert.doesNotMatch(staleHeartbeat, /classroomState/);
  assert.doesNotMatch(staleHeartbeat, /screenshotPolicy/);
  const finalHeartbeat = section(
    devices,
    "const deliveredFab = fab",
    "// --- Return planStatus",
  );
  assert.match(
    finalHeartbeat,
    /getActiveSessionsForStudents\(schoolId, \[studentId\]\)[\s\S]*session\.id === studentSessionId[\s\S]*session\.deviceId === deviceId[\s\S]*if \(!finalExactBindingActive\)/,
  );
});

test("Dashboard rollback projection cannot masquerade a deferred revision as applied realtime state", () => {
  const compat = source("../src/routes/compat.ts");
  const aggregate = section(
    compat,
    "const ownedDesiredControlState",
    "const publicExtensionContract",
  );

  assert.match(
    aggregate,
    /deferredDesiredStateHidden = !!ownedDesiredControlState[\s\S]*classpilotControlStateHasLateSignInOrigin\(ownedDesiredControlState\.desiredState\)[\s\S]*!operatorCapabilities\.lateSignInRestrictionSsoV1/,
  );
  assert.match(aggregate, /visibleOwnedDesiredControlState = deferredDesiredStateHidden[\s\S]*undefined/);
  assert.match(aggregate, /scopedRealtimeClassroomState = deferredDesiredStateHidden[\s\S]*undefined/);
  assert.match(aggregate, /effectiveClasspilotControlEnforcementHealth\([\s\S]*visibleOwnedDesiredControlState/);
  assert.match(
    aggregate,
    /acceptedCapabilities: normalizeClasspilotPublicCapabilities\([\s\S]*capabilityRealtime\?\.acceptedCapabilities[\s\S]*studentSessionId: snapshot\.studentSessionId/,
  );
  assert.match(
    compat,
    /const capabilityRealtime = delegatedAway \? null : rt[\s\S]*publicClasspilotExtensionContract\(capabilityRealtime\)/,
  );
});

test("clear-before-sign-in, expiry, and identifier-free rollback metrics have active paths", () => {
  const dispatcher = source("../src/services/classpilotCommandDispatcher.ts");
  const classroom = source("../src/services/classpilotClassroomState.ts");
  const metrics = source("../src/services/heartbeatHotPathMetrics.ts");
  const clear = section(
    dispatcher,
    "async function authorizeScreenOnlyUnlock",
    "const OFFLINE_PERSISTENCE_COMMAND_TYPES",
  );

  assert.match(clear, /lateSignInEligible !== true/);
  assert.match(clear, /restrictions\?\.screenLock\?\.active/);
  assert.match(clear, /screen_only_unlock_pending_clear/);
  assert.match(dispatcher, /"unlock-screen",[\s\S]*"remove-flight-path",[\s\S]*"remove-block-list"/);
  assert.match(classroom, /const expired = !!effectiveExpiry[\s\S]*restrictions: expired[\s\S]*emptyClasspilotRestrictions\(\)/);
  assert.match(classroom, /recordHeartbeatHotPathCounter\("lateSignInStampedInspection"\)/);
  assert.match(classroom, /!options\.gateActive[\s\S]*recordHeartbeatHotPathCounter\("lateSignInRollback"\)/);
  assert.match(metrics, /\| "lateSignInRollback"/);
  assert.match(metrics, /\| "lateSignInStampedInspection"/);
  assert.doesNotMatch(metrics, /lateSignInStampedRemaining/);
  const storage = source("../src/services/storage.ts");
  const monitoring = source("../src/routes/classpilot/monitoring.ts");
  assert.match(
    storage,
    /countClasspilotLateSignInStampedStates[\s\S]*lateSignInDelivery[\s\S]*restorableClassState,desiredState,lateSignInDelivery,origin[\s\S]*deferred/,
  );
  assert.match(
    monitoring,
    /late-signin-rollout-status[\s\S]*stampedStateCount[\s\S]*safeForBackendRollback/,
  );
  assert.doesNotMatch(
    classroom,
    /recordHeartbeatHotPathCounter\("lateSignIn(?:Rollback|StampedRemaining)",[^)]*\{/,
    "rollback/backlog metrics must remain aggregate and identifier-free",
  );
});

test("Coverage clear preserves the nested restorable class provenance", () => {
  const dispatcher = source("../src/services/classpilotCommandDispatcher.ts");
  const storage = source("../src/services/storage.ts");
  const coveragePersistence = section(
    dispatcher,
    "async function persistActiveSupervisionState",
    "export async function executeClasspilotCommand",
  );
  const restore = section(
    storage,
    "export async function restoreClasspilotStudentControlStatesAfterSupervision",
    "export async function getClasspilotStudentControlState",
  );

  assert.match(
    coveragePersistence,
    /const \{ lateSignInDelivery: _clearedCoverageOrigin, \.\.\.preserved \} = currentDesired[\s\S]*return \{ \.\.\.preserved, restrictions \}/,
  );
  assert.match(restore, /restorableClassState/);
  assert.match(restore, /restoredDesiredState[\s\S]*restorable\.desiredState/);
  assert.match(restore, /sourceCommandId: restorable\?\.sourceCommandId \|\| null/);
});
