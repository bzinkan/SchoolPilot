import test from 'node:test';
import assert from 'node:assert/strict';

import {
  combineCommandSettlements,
  deriveDashboardCapabilities,
  exactTabCloseCapability,
  flightPathApplyCapability,
  mergeCommandUpdateIntoBatches,
  normalizeSessionFabState,
  parseTabSelectionKey,
  resolveCommandTargets,
  studentSupportsCapability,
  studentTileFlightPathReleaseCommand,
  studentTileScreenToggleCommand,
  studentSignOutCommandPayload,
  sessionFabSettingsPayload,
  tabSelectionKey,
} from '../src/products/classpilot/lib/dashboardCommandContext.js';
import { commandDeliveryFeedback } from '../src/products/classpilot/lib/commandDeliveryTruth.js';

const classStudents = [
  { studentId: 'a', commandable: true },
  { studentId: 'b', commandable: true },
  { studentId: 'c', commandable: false },
];

test('strict command helpers reject empty Flight Paths and keep sign-out payload empty', () => {
  assert.deepEqual(studentSignOutCommandPayload(), {});
  assert.equal(flightPathApplyCapability({ allowedDomains: [] }).enabled, false);
  assert.equal(flightPathApplyCapability({ allowedDomains: ['  '] }).enabled, false);
  assert.deepEqual(flightPathApplyCapability({ allowedDomains: ['classroom.example'] }), {
    enabled: true,
    reason: '',
  });
});

test('class targets are narrowed only by explicit selection, subgroup, or tile override', () => {
  assert.deepEqual(resolveCommandTargets({
    mode: 'owned-class',
    sessionStudents: classStudents,
  }).targetStudentIds, ['a', 'b']);

  assert.deepEqual(resolveCommandTargets({
    mode: 'owned-class',
    sessionStudents: classStudents,
    selectedStudentIds: ['b'],
  }), {
    mode: 'owned-class',
    targetScope: 'students',
    targetStudentIds: ['b'],
    targetStudents: [classStudents[1]],
    groups: [{ kind: 'class', id: null, targetStudentIds: ['b'] }],
    targetCount: 1,
    contextCount: 1,
  });

  const subgroup = resolveCommandTargets({
    mode: 'owned-class',
    sessionStudents: classStudents,
    selectedSubgroupId: 'group-1',
    subgroupStudentIds: ['a'],
  });
  assert.equal(subgroup.targetScope, 'subgroup');
  assert.equal(subgroup.subgroupId, 'group-1');
  assert.deepEqual(subgroup.targetStudentIds, ['a']);

  const override = resolveCommandTargets({
    mode: 'owned-class',
    sessionStudents: classStudents,
    selectedStudentIds: ['a'],
    overrideStudentIds: ['b'],
  });
  assert.deepEqual(override.targetStudentIds, ['b']);
});

test('claimed targets always use the full claimed cohort when there is no explicit selection', () => {
  const claimed = [
    { studentId: 'a', contextId: 'ctx-1' },
    { studentId: 'b', contextId: 'ctx-2' },
  ];
  const target = resolveCommandTargets({ mode: 'claimed-coverage', claimedStudents: claimed });
  assert.deepEqual(target.targetStudentIds, ['a', 'b']);
  assert.equal(target.contextCount, 2);
  assert.deepEqual(target.groups, [
    { kind: 'coverage', id: 'ctx-1', targetStudentIds: ['a'] },
    { kind: 'coverage', id: 'ctx-2', targetStudentIds: ['b'] },
  ]);
});

test('claimed target validation fails before dispatch for missing and conflicting contexts', () => {
  assert.throws(() => resolveCommandTargets({
    mode: 'claimed-coverage',
    claimedStudents: [{ studentId: 'a' }],
  }), /missing a claimed supervision context/);
  assert.throws(() => resolveCommandTargets({
    mode: 'claimed-coverage',
    claimedStudents: [
      { studentId: 'a', contextId: 'ctx-1' },
      { studentId: 'a', contextId: 'ctx-2' },
    ],
  }), /conflicting supervision contexts/);
  assert.throws(() => resolveCommandTargets({
    mode: 'observe-read-only',
    sessionStudents: classStudents,
  }), /not available/);
});

test('admin observation is read-only and Teacher FAB is owned-class-only', () => {
  const observed = deriveDashboardCapabilities({
    studentView: 'class',
    isAdmin: true,
    currentUserId: 'admin-1',
    activeSession: { id: 'own-session', teacherId: 'admin-1' },
    observedSession: { id: 'other-session', teacherId: 'teacher-2' },
  });
  assert.equal(observed.mode, 'observe-read-only');
  assert.equal(observed.canUseRemoteControls, false);
  assert.equal(observed.canUseTeacherFab, false);

  const owned = deriveDashboardCapabilities({
    studentView: 'class',
    isTeacher: true,
    currentUserId: 'teacher-1',
    activeSession: { id: 'session-1', teacherId: 'teacher-1' },
  });
  assert.equal(owned.mode, 'owned-class');
  assert.equal(owned.canUseTeacherFab, true);
  assert.equal(owned.allows('temp-unblock'), true);

  const claimed = deriveDashboardCapabilities({ studentView: 'claimed', isTeacher: true });
  assert.equal(claimed.canUseTeacherFab, false);
  assert.equal(claimed.allows('open-tab'), true);
  assert.equal(claimed.allows('temp-unblock'), false);
});

test('allSettled aggregation preserves successful side effects and failed-context rows', () => {
  const combined = combineCommandSettlements([
    {
      status: 'fulfilled',
      value: {
        command: { id: 'cmd-1', commandType: 'open-tab', targets: [{ studentId: 'a', status: 'completed' }] },
        summary: { requested: 1, attempted: 1, acknowledged: 1, completed: 1 },
      },
    },
    { status: 'rejected', reason: new Error('network down') },
  ], [
    { id: 'ctx-1', targetStudentIds: ['a'] },
    { id: 'ctx-2', targetStudentIds: ['b', 'c'] },
  ], 'open-tab');

  assert.equal(combined.partial, true);
  assert.equal(combined.summary.requested, 3);
  assert.equal(combined.summary.completed, 1);
  assert.equal(combined.summary.failed, 2);
  assert.deepEqual(combined.command.targets.map((row) => [row.studentId, row.status]), [
    ['a', 'completed'],
    ['b', 'failed'],
    ['c', 'failed'],
  ]);
});

test('exact tab selection requires opaque tabRef and observed revision', () => {
  const first = { studentId: 'a', tabRef: 'opaque-1', observedRevision: 7, url: 'https://same.example', clientProtocolVersion: 2, capabilities: { exactTabCloseV1: true } };
  const duplicateUrl = { studentId: 'a', tabRef: 'opaque-2', observedRevision: 7, url: 'https://same.example', extensionCapabilities: ['exactTabCloseV1'] };
  assert.notEqual(tabSelectionKey(first), tabSelectionKey(duplicateUrl));
  assert.deepEqual(parseTabSelectionKey(tabSelectionKey(first)), {
    studentId: 'a',
    tabRef: 'opaque-1',
    observedRevision: 7,
  });
  assert.equal(exactTabCloseCapability(first).enabled, true);
  assert.match(exactTabCloseCapability({ studentId: 'a', url: first.url }).reason, /older extension/i);
  assert.equal(exactTabCloseCapability({ ...first, capabilities: { exactTabCloseV1: false } }).enabled, false);
  assert.equal(exactTabCloseCapability({
    ...first,
    clientProtocolVersion: 3,
    capabilities: { exactTabCloseV1: true, exactTabCloseV2: false },
  }).enabled, false);
  assert.match(exactTabCloseCapability({
    ...first,
    clientProtocolVersion: 3,
    capabilities: { exactTabCloseV1: true, exactTabCloseV2: false },
  }).reason, /ClassPilot update required/i);
  assert.equal(exactTabCloseCapability({
    ...first,
    clientProtocolVersion: 3,
    capabilities: { exactTabCloseV2: true },
  }).enabled, true);
  assert.equal(studentSupportsCapability({ extensionCapabilities: ['screenOnlyUnlockV1'] }, 'screenOnlyUnlockV1'), true);
  assert.equal(studentSupportsCapability({ capabilities: { screenOnlyUnlockV1: false } }, 'screenOnlyUnlockV1'), false);
});

test('mixed delivery feedback never hides adverse outcomes behind an acknowledgement', () => {
  const feedback = commandDeliveryFeedback({
    command: { commandType: 'open-tab', deliveryPolicy: 'transient_action' },
    summary: {
      requested: 4,
      attempted: 2,
      acknowledged: 1,
      completed: 1,
      pending: 0,
      failed: 1,
      unavailable: 1,
      expired: 1,
    },
  }, 'open-tab');
  assert.equal(feedback.title, 'Partially delivered');
  assert.match(feedback.description, /1 completed/);
  assert.match(feedback.description, /1 failed/);
  assert.match(feedback.description, /1 unavailable/);
  assert.match(feedback.description, /1 expired/);
});

test('student tile unlock and Flight Path actions retain distinct semantics', () => {
  assert.deepEqual(studentTileScreenToggleCommand({
    studentId: 'a',
    screenLocked: true,
    capabilities: { screenOnlyUnlockV1: true },
  }), {
    commandType: 'unlock-screen',
    commandPayload: { screenOnly: true },
    studentIds: ['a'],
  });
  assert.equal(studentTileScreenToggleCommand({ studentId: 'legacy', screenLocked: true }), null);
  assert.deepEqual(studentTileFlightPathReleaseCommand({ studentId: 'a' }), {
    commandType: 'remove-flight-path',
    commandPayload: {},
    studentIds: ['a'],
  });
});

test('websocket acknowledgements refresh the matching command result without discarding mixed rows', () => {
  const batches = [{
    command: {
      commandType: 'open-tab',
      targets: [
        { studentId: 'a', commandId: 'cmd-1', status: 'sent' },
        { studentId: 'b', status: 'failed', error: 'context request failed' },
      ],
    },
    commands: [{ id: 'cmd-1' }],
    summary: { requested: 2, sent: 1, failed: 1 },
  }];
  const updated = mergeCommandUpdateIntoBatches(batches, {
    commandId: 'cmd-1',
    command: { id: 'cmd-1', commandType: 'open-tab', targets: [{ studentId: 'a', status: 'completed' }] },
  });
  assert.equal(updated[0].command.targets[0].status, 'completed');
  assert.equal(updated[0].command.targets[1].status, 'failed');
  assert.equal(updated[0].summary.completed, 1);
  assert.equal(updated[0].summary.failed, 1);
});

test('session FAB toggles round-trip authoritative revision from off to on', () => {
  const fresh = normalizeSessionFabState({
    activeSessionId: 'session-1',
    handRaisingEnabled: true,
    studentMessagingEnabled: true,
    sessionFabRevision: 0,
  }, 'session-1');
  assert.deepEqual(sessionFabSettingsPayload(fresh, { chatEnabled: false }), {
    chatEnabled: false,
    expectedRevision: 0,
  });

  const disabled = normalizeSessionFabState({
    teachingSessionId: 'session-1',
    handRaisingEnabled: false,
    messagingEnabled: false,
    lifecycleRevision: 4,
  }, 'session-1');
  assert.equal(disabled.handRaisingEnabled, false);
  assert.deepEqual(sessionFabSettingsPayload(disabled, { raiseHandEnabled: true }), {
    raiseHandEnabled: true,
    expectedRevision: 4,
  });

  const enabled = normalizeSessionFabState({
    teachingSessionId: 'session-1',
    handRaisingEnabled: true,
    messagingEnabled: false,
    revision: 5,
  }, 'session-1');
  assert.equal(enabled.handRaisingEnabled, true);
  assert.deepEqual(sessionFabSettingsPayload(enabled, { raiseHandEnabled: false }), {
    raiseHandEnabled: false,
    expectedRevision: 5,
  });
  assert.equal(normalizeSessionFabState(enabled, 'different-session'), null);

  const replacement = normalizeSessionFabState({
    activeSessionId: 'session-2',
    handRaisingEnabled: false,
    studentMessagingEnabled: true,
    sessionFabRevision: 0,
  }, 'session-2');
  assert.equal(replacement.teachingSessionId, 'session-2');
  assert.equal(replacement.handRaisingEnabled, false);
});
