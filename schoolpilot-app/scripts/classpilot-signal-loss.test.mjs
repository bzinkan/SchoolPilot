import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  MONITORING_SIGNAL_LOSS_MS,
  SCREENSHOT_STALE_MS,
  deriveScreenshotDisplay,
  deriveStudentMonitoringDisplay,
  deriveUnavailablePreview,
  findNextStudentFreshnessBoundary,
  removeStoppedLiveStream,
} from '../src/products/classpilot/lib/studentMonitoringDisplay.js';
import {
  MAX_TRACKED_TRANSIENT_COMMANDS,
  applyTransientCommandUpdate,
  completedStudentIdsFromCommand,
  commandDeliveryFeedback,
  expireTransientCommands,
  findNextTransientExpiry,
  hasPendingTransientAction,
  latestTransientClassroomUiEffect,
  trackTransientCommandResponse,
  transientClassroomUiEffect,
} from '../src/products/classpilot/lib/commandDeliveryTruth.js';

const observedAt = Date.parse('2026-08-13T12:00:00.000Z');
const monitoredStudent = (overrides = {}) => ({
  studentId: 'student-1',
  status: 'online',
  loginState: 'logged_in',
  isLoggedIn: true,
  activityState: 'active',
  monitoringState: 'healthy',
  activityFresh: true,
  realtimeBinding: 'binding-a',
  realtimeRevision: 3,
  realtimeObservedAt: new Date(observedAt).toISOString(),
  activeTabUrl: 'https://example.test/lesson',
  aiClassification: { category: 'non-educational' },
  ...overrides,
});

test('monitoring changes exactly at the 60-second local boundary without a refetch', () => {
  assert.equal(
    deriveStudentMonitoringDisplay(monitoredStudent(), observedAt + MONITORING_SIGNAL_LOSS_MS - 1).kind,
    'online',
  );
  assert.equal(
    deriveStudentMonitoringDisplay(monitoredStudent(), observedAt + MONITORING_SIGNAL_LOSS_MS).kind,
    'signal_lost',
  );
});

test('signed-out and delegated rows never enter a freshness timer', () => {
  const signedOut = monitoredStudent({ loginState: 'not_logged_in', isLoggedIn: false });
  const delegated = monitoredStudent({ activityState: 'delegated', _realtimeSuppressed: true });
  assert.equal(deriveStudentMonitoringDisplay(signedOut, observedAt).label, 'Not logged in');
  assert.equal(
    deriveStudentMonitoringDisplay(delegated, observedAt).label,
    'Monitoring handled by assigned staff',
  );
  assert.equal(findNextStudentFreshnessBoundary([signedOut, delegated], new Map(), observedAt), null);
});

test('unavailable previews preserve signed-out, delegated, and signal-loss truth', () => {
  const signedOutPreview = deriveUnavailablePreview({ kind: 'signed_out' });
  assert.equal(signedOutPreview.reason, 'Not logged in');
  assert.equal(signedOutPreview.showLastObservation, true);
  assert.equal(signedOutPreview.warning, false);

  const delegatedPreview = deriveUnavailablePreview({ kind: 'delegated' });
  assert.equal(delegatedPreview.reason, 'Monitoring handled by assigned staff');
  assert.equal(delegatedPreview.showLastObservation, false);
  assert.equal(delegatedPreview.warning, false);

  const signalLossPreview = deriveUnavailablePreview({ kind: 'signal_lost' });
  assert.equal(signalLossPreview.reason, 'Monitoring signal lost — cause unknown');
  assert.equal(signalLossPreview.showLastObservation, true);
  assert.equal(signalLossPreview.warning, true);
});

test('missing timestamps and explicit server loss fail closed to signal lost', () => {
  const missingTime = monitoredStudent({ realtimeObservedAt: null });
  assert.equal(deriveStudentMonitoringDisplay(missingTime, observedAt).kind, 'signal_lost');

  const explicitLoss = monitoredStudent({
    monitoringState: 'signal_lost',
    activityFresh: false,
    monitoringLostAt: new Date(observedAt + 1_000).toISOString(),
  });
  assert.equal(deriveStudentMonitoringDisplay(explicitLoss, observedAt + 2_000).kind, 'signal_lost');
});

test('a same-binding higher-revision observation clears signal loss immediately', () => {
  const lost = deriveStudentMonitoringDisplay(monitoredStudent(), observedAt + 60_000);
  assert.equal(lost.kind, 'signal_lost');
  const recovered = monitoredStudent({
    realtimeRevision: 4,
    realtimeObservedAt: new Date(observedAt + 60_000).toISOString(),
  });
  assert.equal(deriveStudentMonitoringDisplay(recovered, observedAt + 60_000).kind, 'online');
});

test('screenshots become stale at 75 seconds independently of healthy URL telemetry', () => {
  const screenshot = { screenshot: 'data:image/jpeg;base64,test', timestamp: observedAt };
  assert.equal(deriveScreenshotDisplay(screenshot, observedAt + SCREENSHOT_STALE_MS - 1).fresh, true);
  assert.equal(deriveScreenshotDisplay(screenshot, observedAt + SCREENSHOT_STALE_MS).fresh, false);

  const student = monitoredStudent({ realtimeObservedAt: new Date(observedAt + 70_000).toISOString() });
  assert.equal(deriveStudentMonitoringDisplay(student, observedAt + SCREENSHOT_STALE_MS).telemetryCurrent, true);
});

test('a stopped WebRTC stream cannot bypass the signal-loss preview', () => {
  const frozenStream = { id: 'frozen-stream' };
  const current = new Map([['student-1', frozenStream]]);
  const cleared = removeStoppedLiveStream(current, 'student-1');
  const display = deriveStudentMonitoringDisplay(
    monitoredStudent(),
    observedAt + MONITORING_SIGNAL_LOSS_MS,
  );

  assert.notEqual(cleared, current);
  assert.equal(cleared.has('student-1'), false);
  assert.equal(current.get('student-1'), frozenStream, 'state updates remain immutable');
  assert.equal(display.kind, 'signal_lost');
  assert.equal(deriveUnavailablePreview(display).reason, 'Monitoring signal lost — cause unknown');

  const webRtcSource = readFileSync(
    new URL('../src/hooks/useWebRTC.js', import.meta.url),
    'utf8',
  );
  assert.match(webRtcSource, /export function useWebRTC\(ws, onStreamStopped\)/);
  assert.match(webRtcSource, /event\.track\.onended = \(\) => stopLiveView\(studentId\)/);
  assert.match(webRtcSource, /pc\.connectionState === 'failed'[\s\S]*pc\.connectionState === 'disconnected'[\s\S]*pc\.connectionState === 'closed'/);
  assert.match(webRtcSource, /connectionsRef\.current\.delete\(studentId\);[\s\S]*onStreamStopped\?\.\(studentId\);/);

  const dashboardSource = readFileSync(
    new URL('../src/products/classpilot/pages/Dashboard.jsx', import.meta.url),
    'utf8',
  );
  assert.match(dashboardSource, /useWebRTC\(wsRef\.current, handleLiveStreamStopped\)/);
  assert.match(dashboardSource, /message\.type === 'student-signed-out'[\s\S]*webrtc\.stopLiveView\(message\.studentId\)/);
  assert.match(dashboardSource, /for \(const studentId of signedOutStudentIds\)[\s\S]*webrtc\.stopLiveView\(studentId\)/);
});

test('an 800-student cohort plans one earliest timeout in O(n) semantics', () => {
  const students = Array.from({ length: 800 }, (_, index) => monitoredStudent({
    studentId: `student-${index}`,
    realtimeObservedAt: new Date(observedAt + index).toISOString(),
  }));
  const screenshots = new Map(students.map((student, index) => [
    student.studentId,
    { screenshot: `image-${index}`, timestamp: observedAt + 20_000 + index },
  ]));
  assert.equal(
    findNextStudentFreshnessBoundary(students, screenshots, observedAt),
    observedAt + MONITORING_SIGNAL_LOSS_MS,
  );
});

function transientResponse(index = 1) {
  return {
    command: {
      id: `command-${index}`,
      commandType: 'open-tab',
      deliveryPolicy: 'transient_action',
      expiresAt: new Date(observedAt + 15_000 + index).toISOString(),
      targets: [{ studentId: `student-${index}`, status: 'sent' }],
    },
    summary: { attempted: 1, pending: 1, acknowledged: 0, completed: 0, expired: 0, failed: 0, unavailable: 0 },
  };
}

test('transient delivery uses one earliest expiry and never claims completion', () => {
  const tracked = trackTransientCommandResponse(new Map(), transientResponse(), 'open-tab');
  assert.equal(findNextTransientExpiry(tracked, observedAt), observedAt + 15_001);
  assert.equal(commandDeliveryFeedback(transientResponse(), 'open-tab').title, 'Delivery attempted');
});

test('an acknowledgement before expiry prevents local expiration', () => {
  const tracked = trackTransientCommandResponse(new Map(), transientResponse(), 'open-tab');
  const updated = applyTransientCommandUpdate(tracked, {
    type: 'classpilot-command-update',
    commandId: 'command-1',
    command: {
      ...transientResponse().command,
      targets: [{ studentId: 'student-1', status: 'received' }],
    },
    summary: { attempted: 1, acknowledged: 1, pending: 1, received: 1, awaitingAck: 0 },
  });
  assert.equal(expireTransientCommands(updated, observedAt + 30_000), updated);
  assert.equal(findNextTransientExpiry(updated, observedAt), null);
  assert.equal(updated.get('command-1').summary.pending, 1, 'received work may finish after expiry');
});

test('an unacknowledged transient becomes not delivered at expiry', () => {
  const tracked = trackTransientCommandResponse(new Map(), transientResponse(), 'open-tab');
  const expired = expireTransientCommands(tracked, observedAt + 15_001);
  const entry = expired.get('command-1');
  assert.equal(entry.summary.pending, 0);
  assert.equal(entry.summary.expired, 1);
  assert.equal(commandDeliveryFeedback({
    command: transientResponse().command,
    summary: entry.summary,
  }, 'open-tab').title, 'Not delivered');
});

function classroomTransientResponse({ commandId, commandType, action, pollId, createdAtOffset = 0 }) {
  const commandPayload = {
    action,
    ...(pollId ? { pollId, question: 'Ready?', options: ['Yes', 'No'] } : {}),
  };
  return {
    command: {
      id: commandId,
      commandType,
      commandPayload,
      createdAt: new Date(observedAt + createdAtOffset).toISOString(),
      deliveryPolicy: 'transient_action',
      expiresAt: new Date(observedAt + 15_000).toISOString(),
      targets: [{ studentId: 'student-1', status: 'sent' }],
    },
    summary: { attempted: 1, pending: 1, awaitingAck: 1 },
  };
}

function acknowledgeClassroomTransient(current, response) {
  return applyTransientCommandUpdate(current, {
    type: 'classpilot-command-update',
    commandId: response.command.id,
    command: {
      ...response.command,
      targets: [{ studentId: 'student-1', status: 'received' }],
    },
    summary: {
      attempted: 1,
      acknowledged: 1,
      received: 1,
      pending: 1,
      awaitingAck: 0,
    },
  });
}

test('timer starts only after an ACK update and an expired start remains inactive', () => {
  const start = classroomTransientResponse({
    commandId: 'timer-start',
    commandType: 'timer',
    action: 'start',
  });
  const pending = trackTransientCommandResponse(new Map(), start, 'timer');
  assert.equal(hasPendingTransientAction(pending, 'timer'), true);
  assert.equal(transientClassroomUiEffect(pending.get('timer-start')), null);

  const expired = expireTransientCommands(pending, observedAt + 15_000);
  assert.equal(hasPendingTransientAction(expired, 'timer'), false);
  assert.equal(latestTransientClassroomUiEffect(expired, 'timer'), null);

  const acknowledged = acknowledgeClassroomTransient(pending, start);
  assert.deepEqual(latestTransientClassroomUiEffect(acknowledged, 'timer'), {
    commandId: 'timer-start',
    control: 'timer',
    active: true,
  });
  const lateHttpResponse = trackTransientCommandResponse(acknowledged, start, 'timer');
  assert.equal(hasPendingTransientAction(lateHttpResponse, 'timer'), false);
  assert.equal(latestTransientClassroomUiEffect(lateHttpResponse, 'timer')?.active, true);

  const failedAfterReceipt = applyTransientCommandUpdate(acknowledged, {
    type: 'classpilot-command-update',
    commandId: start.command.id,
    command: {
      ...start.command,
      targets: [{ studentId: 'student-1', status: 'failed' }],
    },
    summary: { attempted: 1, acknowledged: 1, received: 1, failed: 1, pending: 0, awaitingAck: 0 },
  });
  assert.equal(latestTransientClassroomUiEffect(failedAfterReceipt, 'timer'), null);
});

test('an expired timer stop or poll close preserves the last acknowledged active state', () => {
  const timerStart = classroomTransientResponse({
    commandId: 'timer-start',
    commandType: 'timer',
    action: 'start',
  });
  let timerCommands = trackTransientCommandResponse(new Map(), timerStart, 'timer');
  timerCommands = acknowledgeClassroomTransient(timerCommands, timerStart);

  const timerStop = classroomTransientResponse({
    commandId: 'timer-stop',
    commandType: 'timer',
    action: 'stop',
  });
  timerCommands = trackTransientCommandResponse(timerCommands, timerStop, 'timer');
  timerCommands = expireTransientCommands(timerCommands, observedAt + 15_000);
  assert.equal(latestTransientClassroomUiEffect(timerCommands, 'timer')?.active, true);

  timerCommands = trackTransientCommandResponse(timerCommands, timerStop, 'timer');
  timerCommands = acknowledgeClassroomTransient(timerCommands, timerStop);
  assert.equal(latestTransientClassroomUiEffect(timerCommands, 'timer')?.active, false);

  const pollStart = classroomTransientResponse({
    commandId: 'poll-start',
    commandType: 'poll',
    action: 'start',
    pollId: 'poll-1',
  });
  let pollCommands = trackTransientCommandResponse(new Map(), pollStart, 'poll');
  pollCommands = acknowledgeClassroomTransient(pollCommands, pollStart);
  assert.equal(latestTransientClassroomUiEffect(pollCommands, 'poll')?.poll?.id, 'poll-1');

  const pollClose = classroomTransientResponse({
    commandId: 'poll-close',
    commandType: 'poll',
    action: 'close',
    pollId: 'poll-1',
  });
  pollCommands = trackTransientCommandResponse(pollCommands, pollClose, 'poll');
  pollCommands = expireTransientCommands(pollCommands, observedAt + 15_000);
  assert.equal(latestTransientClassroomUiEffect(pollCommands, 'poll')?.active, true);

  pollCommands = trackTransientCommandResponse(pollCommands, pollClose, 'poll');
  pollCommands = acknowledgeClassroomTransient(pollCommands, pollClose);
  assert.equal(latestTransientClassroomUiEffect(pollCommands, 'poll')?.active, false);
});

test('late updates for an older start cannot resurrect a stopped timer or closed poll', () => {
  const timerStart = classroomTransientResponse({
    commandId: 'ordered-timer-start',
    commandType: 'timer',
    action: 'start',
    createdAtOffset: 1_000,
  });
  const timerStop = classroomTransientResponse({
    commandId: 'ordered-timer-stop',
    commandType: 'timer',
    action: 'stop',
    createdAtOffset: 2_000,
  });
  let timerCommands = trackTransientCommandResponse(new Map(), timerStart, 'timer');
  timerCommands = acknowledgeClassroomTransient(timerCommands, timerStart);
  timerCommands = trackTransientCommandResponse(timerCommands, timerStop, 'timer');
  timerCommands = acknowledgeClassroomTransient(timerCommands, timerStop);
  assert.equal(latestTransientClassroomUiEffect(timerCommands, 'timer')?.active, false);
  timerCommands = trackTransientCommandResponse(timerCommands, timerStart, 'timer');
  timerCommands = acknowledgeClassroomTransient(timerCommands, timerStart);
  assert.equal(latestTransientClassroomUiEffect(timerCommands, 'timer')?.active, false);

  const pollStart = classroomTransientResponse({
    commandId: 'ordered-poll-start',
    commandType: 'poll',
    action: 'start',
    pollId: 'ordered-poll',
    createdAtOffset: 3_000,
  });
  const pollClose = classroomTransientResponse({
    commandId: 'ordered-poll-close',
    commandType: 'poll',
    action: 'close',
    pollId: 'ordered-poll',
    createdAtOffset: 4_000,
  });
  let pollCommands = trackTransientCommandResponse(new Map(), pollStart, 'poll');
  pollCommands = acknowledgeClassroomTransient(pollCommands, pollStart);
  pollCommands = trackTransientCommandResponse(pollCommands, pollClose, 'poll');
  pollCommands = acknowledgeClassroomTransient(pollCommands, pollClose);
  assert.equal(latestTransientClassroomUiEffect(pollCommands, 'poll')?.active, false);
  pollCommands = trackTransientCommandResponse(pollCommands, pollStart, 'poll');
  pollCommands = acknowledgeClassroomTransient(pollCommands, pollStart);
  assert.equal(latestTransientClassroomUiEffect(pollCommands, 'poll')?.active, false);
});

test('Dashboard does not hydrate timer or poll activity from attempted active-state rows', () => {
  const dashboardSource = readFileSync(
    new URL('../src/products/classpilot/pages/Dashboard.jsx', import.meta.url),
    'utf8',
  );
  const activeStateEffect = dashboardSource.slice(
    dashboardSource.indexOf('const hasAttention = activeClassroomStates.some'),
    dashboardSource.indexOf('const performLogout'),
  );
  assert.doesNotMatch(activeStateEffect, /stateType === ['"]timer['"]/);
  assert.doesNotMatch(activeStateEffect, /stateType === ['"]poll['"]/);

  const timerMutation = dashboardSource.slice(
    dashboardSource.indexOf('const timerMutation = useMutation'),
    dashboardSource.indexOf('const handleAttentionMode'),
  );
  assert.doesNotMatch(timerMutation, /setTimerActive/);

  const pollMutation = dashboardSource.slice(
    dashboardSource.indexOf('const pollMutation = useMutation'),
    dashboardSource.indexOf('const dismissHandMutation'),
  );
  assert.doesNotMatch(pollMutation, /setActivePoll/);

  const teacherFabSource = readFileSync(
    new URL('../src/products/classpilot/components/TeacherFab.jsx', import.meta.url),
    'utf8',
  );
  assert.match(teacherFabSource, /pollPending \? "Poll pending"/);
  assert.match(teacherFabSource, /timerPending \? "Timer pending"/);
});

test('persistent-control dispatches do not mutate observed device-control badges', () => {
  const dashboardSource = readFileSync(
    new URL('../src/products/classpilot/pages/Dashboard.jsx', import.meta.url),
    'utf8',
  );
  const dashboardLockMutations = dashboardSource.slice(
    dashboardSource.indexOf('const lockScreenMutation = useMutation'),
    dashboardSource.indexOf('const handleOpenTab'),
  );
  const dashboardFlightPathMutations = dashboardSource.slice(
    dashboardSource.indexOf('const applyFlightPathMutation = useMutation'),
    dashboardSource.indexOf('const handleApplyFlightPath'),
  );
  for (const mutationSource of [dashboardLockMutations, dashboardFlightPathMutations]) {
    assert.doesNotMatch(mutationSource, /\bonMutate\b/);
    assert.doesNotMatch(mutationSource, /setQueryData/);
    assert.doesNotMatch(mutationSource, /screenLocked\s*:/);
    assert.doesNotMatch(mutationSource, /flightPathActive\s*:/);
    assert.doesNotMatch(mutationSource, /summary\??\.sent/);
  }
  assert.doesNotMatch(dashboardSource, /preserveOptimisticControls/);
  assert.doesNotMatch(dashboardSource, /reconcileOptimisticStudentState/);
  assert.doesNotMatch(dashboardSource, /optimisticUpdateUntilRef/);

  const tileSource = readFileSync(
    new URL('../src/products/classpilot/components/StudentTile.jsx', import.meta.url),
    'utf8',
  );
  const tileControlMutations = tileSource.slice(
    tileSource.indexOf('const unblockForClassMutation = useMutation'),
    tileSource.indexOf('const getStatusLabel'),
  );
  assert.doesNotMatch(tileControlMutations, /\bonMutate\b/);
  assert.doesNotMatch(tileControlMutations, /setQueryData/);
  assert.doesNotMatch(tileControlMutations, /screenLocked\s*:/);
  assert.doesNotMatch(tileControlMutations, /summary\??\.sent/);
});

test('offline persistent controls and durable messages keep their truthful policy result', () => {
  const unavailable = {
    command: { targets: [{ studentId: 'student-1', status: 'unavailable' }] },
    summary: { requested: 1, unavailable: 1, attempted: 0, pending: 0 },
  };
  assert.equal(commandDeliveryFeedback(unavailable, 'lock-screen').title, 'Restriction saved');
  assert.equal(commandDeliveryFeedback(unavailable, 'teacher-message').title, 'Message queued');
});

test('server-authoritative sign-out requires completed targets before claiming completion', () => {
  const attemptedOnly = {
    command: {
      commandType: 'student-sign-out',
      deliveryPolicy: 'server_authoritative',
      targets: [{ studentId: 'student-1', status: 'sent' }],
    },
    summary: { requested: 1, attempted: 1, completed: 0, pending: 1 },
  };
  const attemptedFeedback = commandDeliveryFeedback(attemptedOnly, 'student-sign-out');
  assert.equal(attemptedFeedback.title, 'Failed');
  assert.equal(attemptedFeedback.description.includes('ended on the server'), false);
  assert.deepEqual([...completedStudentIdsFromCommand(attemptedOnly)], []);

  const completed = {
    command: {
      commandType: 'student-sign-out',
      deliveryPolicy: 'server_authoritative',
      targets: [
        { studentId: 'student-1', status: 'completed' },
        { studentId: 'student-2', status: 'unavailable' },
      ],
    },
    summary: { requested: 2, attempted: 1, completed: 1, unavailable: 1 },
  };
  const completedFeedback = commandDeliveryFeedback(completed, 'student-sign-out');
  assert.equal(completedFeedback.title, 'Sign-out completed');
  assert.match(completedFeedback.description, /1 student session ended on the server/);
  assert.deepEqual([...completedStudentIdsFromCommand(completed)], ['student-1']);
});

test('the transient dashboard map remains bounded', () => {
  let tracked = new Map();
  for (let index = 1; index <= MAX_TRACKED_TRANSIENT_COMMANDS + 5; index += 1) {
    tracked = trackTransientCommandResponse(tracked, transientResponse(index), 'open-tab');
  }
  assert.equal(tracked.size, MAX_TRACKED_TRANSIENT_COMMANDS);
  assert.equal(tracked.has('command-1'), false);
  assert.equal(tracked.has(`command-${MAX_TRACKED_TRANSIENT_COMMANDS + 5}`), true);
});
