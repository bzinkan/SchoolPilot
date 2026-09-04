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
  const storage = source("../src/services/storage.ts");
  const resolver = section(
    dispatcher,
    "async function resolveCurrentUrlLockTargets",
    "function applyOfflineRestrictionPolicy",
  );
  const dispatchStart = dispatcher.indexOf("export async function executeClasspilotCommand");
  assert.notEqual(dispatchStart, -1);
  const dispatch = dispatcher.slice(dispatchStart);
  const persistentClassState = section(
    dispatcher,
    "async function persistActiveState",
    "async function persistActiveSupervisionState",
  );
  const persistentCoverageState = section(
    dispatcher,
    "async function persistActiveSupervisionState",
    "export async function executeClasspilotCommand",
  );

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
  assert.match(
    dispatch,
    /shouldPersistBeforeDelivery = deliveryPolicy === "persistent_control"[\s\S]*&& !currentPageRequested/,
  );
  assert.match(
    dispatch,
    /!shouldPersistBeforeDelivery[\s\S]*&& !currentPageRequested[\s\S]*persistActiveState\(/,
  );
  assert.match(
    dispatch,
    /payloadByStudent\?\.get\(target\.studentId\)\?\.url[\s\S]*url: payloadByStudent\.get\(target\.studentId\)!\.url/,
  );
  assert.match(
    dispatch,
    /withClasspilotStudentControlDeliveryAuthority\([\s\S]*if \(!deliveryAuthority\.authorized\) return null;[\s\S]*sendToStudentBindingLocal\(exactTarget, message/,
    "the process-local observed URL may leave only after exact binding revalidation",
  );
  assert.match(
    dispatch,
    /lockClasspilotSsoPolicyDeliveryAuthority\([\s\S]*getClasspilotSsoPolicyForSchool\(options\.schoolId, transactionDb\)[\s\S]*currentControlState\.revision !== target\.controlRevision[\s\S]*classpilotSsoPolicyApprovesObservedUrl\([\s\S]*currentPageUrl,[\s\S]*currentSsoPolicy\.policy/,
    "transient auth policy and control revision must be frozen inside exact delivery authority",
  );
  assert.match(
    dispatch,
    /currentPage: true,[\s\S]*exactBindingControlRevision:[\s\S]*restrictionExpiresAt:[\s\S]*authPassThrough:/,
  );
  assert.match(
    dispatch,
    /authPassThrough[\s\S]*acceptedCapabilities\.includes\([\s\S]*restrictionAuthPassThroughV1[\s\S]*authCapabilityMissing/,
    "an active sign-in policy withholds the whole transient restriction from an unsupported binding",
  );
  assert.doesNotMatch(persistentClassState, /payloadByStudent|CURRENT_URL/);
  assert.doesNotMatch(persistentCoverageState, /payloadByStudent|CURRENT_URL/);
  assert.doesNotMatch(dispatch, /commandPayload:\s*\{[^}]*url:\s*"CURRENT_URL"/);
  assert.match(
    storage,
    /freezesCurrentPageAuthority[\s\S]*commandPayload\.currentPage === true[\s\S]*frozenControlRevision/,
  );
  const commandAck = section(
    storage,
    "export async function persistClasspilotCommandTargetAck",
    "/** Compatibility adapter for existing internal callers",
  );
  assert.match(
    commandAck,
    /transientCurrentPage[\s\S]*hasCurrentClasspilotStudentControlAuthority[\s\S]*lockClasspilotSsoPolicyDeliveryAuthority[\s\S]*classpilotRestrictionAuthProjectionRevision[\s\S]*appliedAuthPolicyRevision/,
    "a transient Waypoint ACK must prove current control and SSO policy authority",
  );
});

test("persistent teacher Waypoints reject query and fragment persistence", () => {
  const validation = source("../src/services/classpilotCommandValidation.ts");
  assert.match(
    validation,
    /persistentWaypointUrl[\s\S]*parsed\.protocol !== "https:"[\s\S]*parsed\.search \|\| parsed\.hash[\s\S]*return `\$\{parsed\.origin\}\$\{parsed\.pathname\}`/,
  );
  assert.match(
    validation,
    /case "lock-screen":[\s\S]*value\.url === "CURRENT_URL"[\s\S]*persistentWaypointUrl\(value\.url\)/,
  );
});

test("persistence serializes transfer races and rejects changed or expired bindings", () => {
  const storage = source("../src/services/storage.ts");
  const dispatcher = source("../src/services/classpilotCommandDispatcher.ts");
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
      writer.indexOf(".orderBy(devices.deviceId)")
        < writer.indexOf(".orderBy(studentSessions.studentId, studentSessions.id)"),
      "writers must keep device-before-session lock ordering",
    );
    assert.match(writer, /manualLeaseExpiresAt} > clock_timestamp\(\)/);
    assert.match(writer, /expectation\.kind === "signed_out"[\s\S]*!active/);
    assert.match(
      writer,
      /active\.schoolId === options\.(?:studentSnapshots\.)?schoolId[\s\S]*active\.studentSessionId === expectation\.studentSessionId[\s\S]*active\.deviceId === expectation\.deviceId/,
    );
    assert.ok(
      writer.lastIndexOf('isClasspilotCapabilityActive(\n        "lateSignInRestrictionSsoV1"')
        > writer.indexOf("activeByStudent"),
      "the operator gate must be rechecked after locked binding revalidation",
    );
    assert.match(writer, /lateSignInGateRequiredStudentIds/);
  }
  const ack = section(
    storage,
    "export async function acknowledgeClasspilotStudentControlState",
    "export async function persistClasspilotControlCommandState",
  );
  assert.match(
    ack,
    /lockClasspilotStudentControlAuthorities[\s\S]*getClasspilotSsoPolicyForSchool\([\s\S]*transactionDb[\s\S]*acceptedCapabilities\?\.includes\([\s\S]*"restrictionAuthPassThroughV1"[\s\S]*classpilotRestrictionAuthCapabilityRequired/,
    "a delayed pre-rollout ACK must be re-evaluated against current sign-in-safe projection",
  );
  assert.equal(
    dispatcher.match(/lateSignInGateRequiredStudentIds: \[\.\.\.\(options\.deferredStudentIds \?\? \[\]\)\]/g)?.length,
    2,
    "class and Coverage persistence must identify every gate-required deferred target",
  );
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
  assert.match(ack, /active_session\.manual_lease_expires_at > clock_timestamp\(\)/);
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
    /withClasspilotStudentControlDeliveryAuthority\([\s\S]*getClasspilotStudentControlState\([\s\S]*transactionDb[\s\S]*\(_claimed, delivery\) => \{[\s\S]*ws\.send\(JSON\.stringify\(classpilotClassroomStatePushFrame/,
  );
  assert.match(wsRequest, /controlRevision: delivered\?\.revision \?\? 0/);
  assert.match(wsRequest, /classroomState: delivered/);
  assert.match(wsRequest, /authPassThrough:[\s\S]*restrictionAuthPassThroughV1/);
  assert.doesNotMatch(wsRequest, /getActiveSessionsForStudents/);

  assert.match(
    lifecycle,
    /current\.revision !== state\.revision[\s\S]*classpilotControlStateHasLateSignInOrigin\([\s\S]*isClasspilotCapabilityActive\([\s\S]*lateSignInRestrictionSsoV1[\s\S]*requiredCapability[\s\S]*serializeClasspilotStudentControlStateForDelivery/,
  );
  assert.match(
    delivery,
    /classpilotControlStateHasLateSignInOrigin\(state\.desiredState\)[\s\S]*isClasspilotCapabilityActive\([\s\S]*lateSignInRestrictionSsoV1[\s\S]*requiredCapability[\s\S]*serializeClasspilotStudentControlStateForDelivery/,
  );
  assert.match(
    websocket,
    /fab: \{[\s\S]*\.\.\.prepared\.fab,[\s\S]*ownershipRevision: prepared\.classroomState\?\.revision \?\? 0/,
  );
  assert.match(
    devices,
    /deliveredFab: finalFab[\s\S]*ownershipRevision: finalClassroomState\?\.revision \?\? 0/,
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
    /controlStateIds\.has\(target\.studentId\)[\s\S]*!classroomStateByStudent\.has\(target\.studentId\)[\s\S]*return null/,
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

test("student login withholds the SSO pass-through envelope that heartbeat still delivers", () => {
  const devices = source("../src/routes/classpilot/devices.ts");
  const login = section(
    devices,
    "async function completeStudentDeviceLogin",
    "async function recordRemoteActionTimeline",
  );
  const loginDelivery = section(
    login,
    "const loginDelivery = controlState",
    "const classroomState = loginDelivery.classroomState",
  );

  // 2026-09-04 sign-in lockout. The extension adopts the classroom restriction
  // carried by the student-login response inside its own authentication commit
  // window, where hasStudentAuth() is still false. The full-authority binding
  // check that guards the pass-through envelope cannot resolve a control
  // revision there, so it throws and the extension rejects the sign-in it had
  // just completed and releases the session. Every login body carrying the
  // envelope was released; every login body without it was not. The envelope
  // must therefore be withheld at login and delivered moments later by
  // heartbeat and WebSocket, after the commit window closes.
  assert.match(
    loginDelivery,
    /serializeClasspilotStudentControlStateForDelivery\(\{/,
    "login still serializes control state for delivery",
  );
  assert.doesNotMatch(
    loginDelivery,
    /authPassThrough:/,
    "the login serializer must not be handed a pass-through envelope option",
  );
  assert.doesNotMatch(
    login,
    /authPassThrough:/,
    "no login surface may build a pass-through envelope for the login body",
  );
  assert.doesNotMatch(
    login,
    /authPassThroughPolicyRevision/,
    "withholding the envelope must also withhold its ordering revision",
  );

  const withheldRationale = loginDelivery
    .split("\n")
    .filter((line) => line.trim().startsWith("//"))
    .join("\n");
  assert.match(
    withheldRationale,
    /authPassThrough/,
    "a comment must name the withheld envelope so the omission is not read as an oversight",
  );
  assert.match(
    withheldRationale,
    /hasStudentAuth\(\)/,
    "the comment must record that the extension's commit window has no student auth yet",
  );
  assert.match(
    withheldRationale,
    /[Hh]eartbeat[\s\S]*WebSocket/,
    "the comment must record which surfaces deliver the envelope instead",
  );

  // The SSO policy is still read under the shared delivery lock, so a
  // concurrent policy PATCH stays serialized against this login even though
  // the login body no longer carries the policy forward.
  assert.match(
    login,
    /await lockClasspilotSsoPolicyDeliveryAuthority\(\s*options\.schoolId,\s*transactionDb\s*\)/,
  );
  assert.match(login, /getClasspilotSsoPolicyForSchool\(options\.schoolId, transactionDb\)/);
  assert.ok(
    login.indexOf("lockClasspilotSsoPolicyDeliveryAuthority")
      < login.indexOf("getClasspilotSsoPolicyForSchool(options.schoolId, transactionDb)"),
    "the policy read must remain inside the shared SSO delivery lock",
  );
  assert.ok(
    login.indexOf("getClasspilotSsoPolicyForSchool(options.schoolId, transactionDb)")
      < login.indexOf("serializeClasspilotStudentControlStateForDelivery({"),
    "the locked policy read must still precede login serialization",
  );

  // Contrast: the heartbeat re-materialization runs after the extension's
  // commit window, where the identical binding check passes, so it must keep
  // delivering the envelope. This proves the withholding is scoped to login.
  const finalHeartbeat = section(
    devices,
    "const finalDelivery = await runWithTenantContext",
    "return finalDelivery.value;",
  );
  const heartbeatSerializer = section(
    finalHeartbeat,
    "const serialized = finalControlState",
    "const finalClassroomState = serialized.classroomState",
  );
  assert.match(
    heartbeatSerializer,
    /authPassThrough: \{[\s\S]*?"restrictionAuthPassThroughV1"[\s\S]*?policyRevision: finalSsoPolicy\.revision,[\s\S]*?policy: finalSsoPolicy\.policy,/,
    "heartbeat must still deliver the gated pass-through envelope",
  );
  assert.match(
    finalHeartbeat,
    /await lockClasspilotSsoPolicyDeliveryAuthority\(schoolId, transactionDb\)/,
  );
  assert.match(finalHeartbeat, /getClasspilotSsoPolicyForSchool\(schoolId, transactionDb\)/);
  assert.equal(
    devices.match(/authPassThrough: \{/g)?.length,
    1,
    "only the locked heartbeat re-materialization may build a pass-through envelope in this file",
  );
});

test("deferred command frames and WebSocket auth revalidate exact binding authority", () => {
  const dispatcher = source("../src/services/classpilotCommandDispatcher.ts");
  const websocket = source("../src/realtime/websocket.ts");
  const websocketBroadcast = source("../src/realtime/ws-broadcast.ts");
  const websocketRedis = source("../src/realtime/ws-redis.ts");
  const chat = source("../src/routes/classpilot/chat.ts");
  const storage = source("../src/services/storage.ts");
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
    /delivery\.requiredCapability[\s\S]*delivery\.requiredCapabilities\?\.length[\s\S]*exactBinding: classpilotControlStateExactBinding\([\s\S]*controlRevision: exactBindingControlRevision/,
  );
  assert.match(
    frame,
    /type: "remote-control"[\s\S]*\.\.\.bindingEnvelope,[\s\S]*\.\.\.deferredExactBindingEnvelope,[\s\S]*classroomState/,
  );
  const normalFrame = frame.slice(frame.lastIndexOf('\n  return {'));
  assert.match(
    normalFrame,
    /command:\s*\{[\s\S]*\.\.\.deferredExactBindingEnvelope/,
    "the extension validates the same frozen exact binding inside the command payload",
  );
  assert.equal(
    studentAuth.match(/runWithTenantContext\(\{ schoolId \}/g)?.length,
    1,
    "student WebSocket bootstrap must use one tenant lease",
  );
  const bootstrapFence = section(
    storage,
    "export async function withClasspilotStudentControlDeliveryAuthority",
    "export async function withClasspilotStudentWebSocketBootstrapAuthority",
  );
  assert.equal(
    bootstrapFence.match(/hasExactClasspilotTelemetryBinding\(options, transactionDb\)/g)?.length,
    2,
    "bootstrap authority must validate the exact binding before work and again before delivery",
  );
  assert.ok(
    bootstrapFence.indexOf("lockClasspilotStudentControlAuthorities")
      < bootstrapFence.indexOf("prepareAuthorized(transactionDb)"),
    "state preparation must occur under the shared transfer/control lock",
  );
  assert.ok(
    bootstrapFence.indexOf("prepareAuthorized(transactionDb)")
      < bootstrapFence.lastIndexOf("hasExactClasspilotTelemetryBinding(options, transactionDb)"),
    "database-clock binding authority must be rechecked after preparation",
  );
  assert.ok(
    bootstrapFence.lastIndexOf("hasExactClasspilotTelemetryBinding(options, transactionDb)")
      < bootstrapFence.indexOf("onAuthorized(claimed, prepared)"),
    "delivery must occur only after the final exact-binding check",
  );
  assert.match(
    studentAuth,
    /withClasspilotStudentWebSocketBootstrapAuthority\([\s\S]*getClasspilotStudentControlState\([\s\S]*transactionDb[\s\S]*getClasspilotScreenshotAuthorityProjection\([\s\S]*transactionDb[\s\S]*\(teacherReplies, prepared\) => \{[\s\S]*authenticateWsClient\(ws[\s\S]*type: "auth-success"[\s\S]*type: "teacher-message"/,
  );
  assert.ok(
    studentAuth.indexOf("withClasspilotStudentWebSocketBootstrapAuthority")
      < studentAuth.indexOf("authenticateWsClient(ws"),
    "socket registration must be inside the transaction-fenced authority callback",
  );
  assert.match(studentAuth, /studentBootstrapAuthenticated[\s\S]*removeWsClient\(ws\)/);
  assert.doesNotMatch(staleHeartbeat, /classroomState/);
  assert.doesNotMatch(staleHeartbeat, /screenshotPolicy/);
  const finalHeartbeat = section(
    devices,
    "const finalDelivery = await runWithTenantContext",
    "return finalDelivery.value;",
  );
  assert.match(
    finalHeartbeat,
    /withClasspilotStudentControlDeliveryAuthority\([\s\S]*getClasspilotStudentControlState\([\s\S]*transactionDb[\s\S]*\(_claimed, prepared\) => \{[\s\S]*return res\.json\([\s\S]*classroomState: prepared\.classroomState/,
  );
  assert.match(finalHeartbeat, /controlRevision: prepared\.classroomState\?\.revision \?\? 0/);
  assert.doesNotMatch(finalHeartbeat, /getActiveSessionsForStudents/);

  const teacherReplyRecovery = section(
    devices,
    "const teacherReplyCheckKey",
    "// All work after the initial heartbeat transaction",
  );
  assert.match(
    teacherReplyRecovery,
    /withClasspilotStudentWebSocketBootstrapAuthority\([\s\S]*\(teacherReplies\) => teacherReplies\.map[\s\S]*sendToStudentBindingLocal\(exactTarget, replyPayload\)[\s\S]*publishWS\(exactTarget, replyPayload\)/,
  );
  assert.match(teacherReplyRecovery, /kind: "student-binding" as const/);
  assert.doesNotMatch(teacherReplyRecovery, /claimDueTeacherChatDeliveriesForBinding/);
  assert.match(
    websocketRedis,
    /kind: "student-binding";[\s\S]*studentId: string;[\s\S]*studentSessionId: string;[\s\S]*deviceId: string;[\s\S]*requiredCapability\?:[\s\S]*"lateSignInRestrictionSsoV1"[\s\S]*"restrictionAuthPassThroughV1"[\s\S]*"screenshotActiveObservationCadenceV1";[\s\S]*requiredCapabilities\?: Array</,
  );
  const redisDeviceCase = section(websocket, 'case "device":', 'case "student-binding":');
  assert.match(
    redisDeviceCase,
    /msgType === "teacher-message"[\s\S]*Dropping teacher message without an exact student binding[\s\S]*deliverClasspilotStudentBindingRedisMessage/,
  );
  assert.doesNotMatch(redisDeviceCase, /sendToStudentBindingLocal/);
  const redisStudentBindingCase = section(
    websocket,
    'case "student-binding":',
    'case "student-disconnect":',
  );
  assert.match(
    redisStudentBindingCase,
    /deliverClasspilotStudentBindingRedisMessage\(target, message\)/,
  );
  assert.doesNotMatch(redisStudentBindingCase, /sendToStudentBindingLocal/);
  assert.match(
    websocketBroadcast,
    /sendToStudentBindingLocal[\s\S]*client\.deviceId === binding\.deviceId[\s\S]*client\.studentId === binding\.studentId[\s\S]*client\.studentSessionId === binding\.studentSessionId/,
  );
  assert.match(
    websocket,
    /deliverClasspilotStudentBindingRedisMessage[\s\S]*withClasspilotStudentControlDeliveryAuthority\([\s\S]*sendToStudentBindingLocal\(target, message,[\s\S]*requiredCapability: target\.requiredCapability/,
    "cross-process exact-binding envelopes require durable receiver-side revalidation",
  );
  const immediateReply = section(
    chat,
    'router.post("/teacher/reply"',
    '// DELETE /api/classpilot/teacher/messages/:messageId',
  );
  assert.match(
    immediateReply,
    /withClasspilotStudentControlDeliveryAuthority\([\s\S]*claimTeacherChatDeliveries: true[\s\S]*sendToStudentBindingLocal\(exactTarget, replyPayload\)[\s\S]*publishWS\(exactTarget, replyPayload\)/,
    "immediate teacher replies must claim and send under exact binding authority",
  );
  assert.doesNotMatch(immediateReply, /markTeacherChatDeliveryAttempt|sendToDeviceLocal/);

  const commandDelivery = section(
    dispatcher,
    "const authorizedDeliveries = await Promise.all",
    "const redisPublishStartedAt",
  );
  assert.match(
    commandDelivery,
    /withClasspilotStudentControlDeliveryAuthority\([\s\S]*sendToStudentBindingLocal\(exactTarget, message,[\s\S]*requiredCapability: exactTarget\.requiredCapability/,
    "post-persistence command delivery must remain inside exact binding authority",
  );
  assert.match(commandDelivery, /kind: "student-binding" as const/);
  assert.match(
    commandDelivery,
    /deferredIds\.has\(target\.studentId\)[\s\S]*\["lateSignInRestrictionSsoV1" as const\][\s\S]*requiredCapabilities/,
  );
  assert.match(commandDelivery, /deliveryAuthority\.authorized[\s\S]*remotePublications\.push/);
  assert.doesNotMatch(commandDelivery, /sendToDeviceLocal|kind: "device"/);
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
    compat,
    /acceptedCapabilities = normalizeClasspilotPublicCapabilities\([\s\S]*capabilityRealtime\?\.acceptedCapabilities[\s\S]*studentSessionId: snapshot\.studentSessionId/,
  );
  assert.match(
    aggregate,
    /classpilotRestrictionAuthCapabilityRequired\([\s\S]*operatorCapabilities\.restrictionAuthPassThroughV1[\s\S]*acceptedCapabilities\.includes\("restrictionAuthPassThroughV1"\)[\s\S]*restrictionAuthCapabilityRequired/,
  );
  assert.match(
    compat,
    /enforcementUnavailableReason:\s*restrictionAuthUpdateRequired[\s\S]*Extension update required for sign-in-safe Waypoint or Flight Path/,
  );
  assert.match(compat, /getClasspilotSsoPolicyForSchool\(schoolId\)/);
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
    storage,
    /countClasspilotLateSignInStampedStates[\s\S]*scheduledEndAt}[\s\S]*clock_timestamp\(\)[\s\S]*hardExpiresAt}[\s\S]*clock_timestamp\(\)/,
  );
  assert.match(
    storage,
    /countClasspilotLateSignInStampedStates[\s\S]*restorableClassState,desiredState,lateSignInDelivery,origin[\s\S]*deferred/,
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

test("public realtime projections expose the accepted active-view cadence capability without leaking identifiers", () => {
  const devices = source("../src/routes/classpilot/devices.ts");
  const compat = source("../src/routes/compat.ts");
  const deviceProjection = section(
    devices,
    "function publicRealtimeFields",
    "type ClasspilotRealtimeControlAuthority",
  );
  const compatContract = section(
    compat,
    "function publicClasspilotExtensionContract",
    "async function loadAuthorizedRealtimeStatuses",
  );
  for (const projection of [deviceProjection, compatContract]) {
    assert.match(
      projection,
      /acceptedCapabilities: \{[\s\S]*?restrictionAuthPassThroughV1: acceptedCapabilities\.has\([\s\S]*?screenshotActiveObservationCadenceV1: acceptedCapabilities\.has\(\s*"screenshotActiveObservationCadenceV1"\s*\)/,
    );
    assert.doesNotMatch(
      projection,
      /screenshotActiveObservationCadenceV1: extensionCapabilities\.has/,
      "the cadence flag must reflect the server-accepted negotiation, not the extension's advertisement",
    );
    const acceptedBlock = section(projection, "acceptedCapabilities: {", "},");
    assert.doesNotMatch(acceptedBlock, /deviceId|studentSessionId|schoolId/);
  }
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
