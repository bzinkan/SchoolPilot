import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertClassroomCommandSelectionIsolation,
  buildStudentSignOutCommandRequest,
  combineCommandSettlements,
  CONSERVATIVE_DOMAIN_RESTRICTION_MESSAGE,
  DEFAULT_COVERAGE_COMMANDS,
  DOMAIN_PRESERVING_RESTRICTION_MESSAGE,
  DOMAIN_RESTRICTION_URL_HELP,
  deriveDashboardCapabilities,
  domainRestrictionMessageForStudents,
  exactTabCloseCapability,
  flightPathApplyCapability,
  isStudentUrlOffTask,
  mergeCommandUpdateIntoBatches,
  normalizeSessionFabState,
  parseTabSelectionKey,
  resolveCommandTargets,
  resolveStudentSignOutTargets,
  studentSignOutSelectionBinding,
  studentSupportsCapability,
  studentTileFlightPathReleaseCommand,
  studentTileScreenToggleCommand,
  studentSignOutCommandPayload,
  sessionFabSettingsPayload,
  tabSelectionKey,
  toolbarScreenCommand,
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

test('domain-preservation copy fails closed for mixed, offline, stale, and unknown clients', () => {
  assert.equal(
    DOMAIN_PRESERVING_RESTRICTION_MESSAGE,
    'Students already on the selected site keep their current page; other students go to the landing page.',
  );
  assert.equal(
    CONSERVATIVE_DOMAIN_RESTRICTION_MESSAGE,
    'Some selected Chromebooks may reload or move to the landing page when this restriction is applied.',
  );
  assert.equal(
    DOMAIN_RESTRICTION_URL_HELP,
    'The full URL is the landing page. Browsing remains allowed on its hostname and subdomains; it is not an exact-page lock.',
  );
  const current = (student) => student.telemetryCurrent === true;
  const version277Targets = [
    {
      studentId: 'student-a',
      extensionVersion: '2.7.7',
      telemetryCurrent: true,
      capabilities: { domainPreservingRestrictionsV1: true },
    },
    {
      studentId: 'student-b',
      extensionVersion: '2.7.7',
      telemetryCurrent: true,
      extensionCapabilities: ['domainPreservingRestrictionsV1'],
    },
  ];

  assert.equal(
    domainRestrictionMessageForStudents(version277Targets, current),
    DOMAIN_PRESERVING_RESTRICTION_MESSAGE,
  );
  assert.equal(
    domainRestrictionMessageForStudents([
      version277Targets[0],
      { studentId: 'student-legacy', extensionVersion: '2.7.6', telemetryCurrent: true },
    ], current),
    CONSERVATIVE_DOMAIN_RESTRICTION_MESSAGE,
    'one 2.7.6 client without the raw capability keeps mixed-version copy conservative',
  );
  assert.equal(
    domainRestrictionMessageForStudents([
      { ...version277Targets[0], telemetryCurrent: false },
    ], current),
    CONSERVATIVE_DOMAIN_RESTRICTION_MESSAGE,
    'a stale or offline 2.7.7 client must not support the stronger promise',
  );
  assert.equal(
    domainRestrictionMessageForStudents([], current),
    CONSERVATIVE_DOMAIN_RESTRICTION_MESSAGE,
    'an unknown target cohort must fail closed',
  );
  assert.equal(
    domainRestrictionMessageForStudents([{
      status: 'online',
      capabilities: { domainPreservingRestrictionsV1: true },
    }]),
    CONSERVATIVE_DOMAIN_RESTRICTION_MESSAGE,
    'raw online status alone must not support the stronger promise without explicit freshness',
  );
});

test('teacher auto-allow covers exact hosts and subdomains before both off-task branches', () => {
  const baseStudent = {
    activeTabUrl: 'https://app.ixl.com/math',
  };
  const policy = {
    teacherAllowedDomains: ['ixl.com'],
    schoolAllowedDomains: ['school.example'],
    flightPaths: [],
  };

  assert.equal(isStudentUrlOffTask({
    ...policy,
    student: { ...baseStudent, aiClassification: { category: 'non-educational' } },
  }), false, 'teacher approval must override the AI off-task branch for a subdomain');
  assert.equal(isStudentUrlOffTask({
    ...policy,
    student: baseStudent,
  }), false, 'teacher approval must override the school-allowlist branch for a subdomain');

  const lookalike = { activeTabUrl: 'https://notixl.com/math' };
  assert.equal(isStudentUrlOffTask({
    ...policy,
    student: { ...lookalike, aiClassification: { category: 'non-educational' } },
  }), true, 'teacher approval must not cover a lookalike in the AI branch');
  assert.equal(isStudentUrlOffTask({
    ...policy,
    student: lookalike,
  }), true, 'teacher approval must not cover a lookalike in the school-allowlist branch');
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

test('stale authoritative sessions are selectable only by the explicit owned-class sign-out resolver', () => {
  const selectionContext = {
    schoolId: 'school-1',
    viewerId: 'teacher-1',
    mode: 'owned-class',
    teachingSessionId: 'session-1',
  };
  const rows = [
    { studentId: 'fresh', realtimeBinding: 'binding-fresh', commandable: true, signOutEligible: true },
    { studentId: 'stale', realtimeBinding: 'binding-stale', commandable: false, signOutEligible: true },
    { studentId: 'signed-out', realtimeBinding: 'binding-signed-out', commandable: false, signOutEligible: false },
  ].map((student) => ({
    ...student,
    signOutBindingSnapshot: studentSignOutSelectionBinding({ ...selectionContext, student }),
  }));

  assert.deepEqual(resolveCommandTargets({
    mode: 'owned-class',
    sessionStudents: rows,
  }).targetStudentIds, ['fresh']);

  const staleTarget = resolveStudentSignOutTargets({
    mode: 'owned-class',
    sessionStudents: rows,
    selectedStudentIds: ['stale'],
    selectedStudentBindings: [{
      studentId: 'stale',
      bindingSnapshot: rows[1].signOutBindingSnapshot,
    }],
  });
  assert.deepEqual(staleTarget, {
    mode: 'owned-class',
    targetScope: 'students',
    targetStudentIds: ['stale'],
    targetStudents: [rows[1]],
    groups: [{ kind: 'class', id: null, targetStudentIds: ['stale'] }],
    targetCount: 1,
    contextCount: 1,
  });
  assert.deepEqual(buildStudentSignOutCommandRequest('session-1', staleTarget), {
    teachingSessionId: 'session-1',
    targetScope: 'students',
    targetStudentIds: ['stale'],
    commandType: 'student-sign-out',
    commandPayload: {},
  });

  assert.throws(() => resolveStudentSignOutTargets({
    mode: 'observe-read-only',
    sessionStudents: rows,
    selectedStudentIds: ['stale'],
  }), /only for your active class/i);
  assert.throws(() => resolveStudentSignOutTargets({
    mode: 'owned-class',
    sessionStudents: rows,
    selectedStudentIds: ['stale', 'signed-out'],
  }), /can no longer be signed out/i);
  assert.throws(() => resolveStudentSignOutTargets({
    mode: 'owned-class',
    sessionStudents: rows,
    selectedStudentIds: [],
  }), /select at least one/i);
});

test('sign-out selection is invalidated when the same student receives a new realtime binding', () => {
  const context = {
    schoolId: 'school-1',
    viewerId: 'teacher-1',
    mode: 'owned-class',
    teachingSessionId: 'session-1',
  };
  const priorStudent = { studentId: 'stale', realtimeBinding: 'binding-old' };
  const replacementStudent = {
    studentId: 'stale',
    realtimeBinding: 'binding-new',
    signOutEligible: true,
  };
  const priorBindingSnapshot = studentSignOutSelectionBinding({ ...context, student: priorStudent });
  const replacementBindingSnapshot = studentSignOutSelectionBinding({ ...context, student: replacementStudent });
  assert.notEqual(priorBindingSnapshot, replacementBindingSnapshot);

  assert.throws(() => resolveStudentSignOutTargets({
    mode: 'owned-class',
    sessionStudents: [{
      ...replacementStudent,
      signOutBindingSnapshot: replacementBindingSnapshot,
    }],
    selectedStudentIds: ['stale'],
    selectedStudentBindings: [{ studentId: 'stale', bindingSnapshot: priorBindingSnapshot }],
  }), /student session changed/i);
  assert.equal(studentSignOutSelectionBinding({
    ...context,
    mode: 'observe-read-only',
    student: replacementStudent,
  }), null);
});

test('sign-out-only selection blocks every non-sign-out classroom command before target fallback', () => {
  for (const commandType of ['open-tab', 'teacher-message', 'timer', 'lock-screen', 'unlock-screen']) {
    assert.throws(
      () => assertClassroomCommandSelectionIsolation(commandType, 1),
      /clear the sign-out-only selection/i,
    );
  }
  assert.doesNotThrow(() => assertClassroomCommandSelectionIsolation('student-sign-out', 1));
  assert.doesNotThrow(() => assertClassroomCommandSelectionIsolation('open-tab', 0));
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

test('explicit claimed selections remain partitioned into their exact supervision contexts', () => {
  const claimed = [
    { studentId: 'a', contextId: 'ctx-1' },
    { studentId: 'b', contextId: 'ctx-2' },
    { studentId: 'c', contextId: 'ctx-1' },
  ];
  const target = resolveCommandTargets({
    mode: 'claimed-coverage',
    claimedStudents: claimed,
    selectedStudentIds: ['b', 'c'],
  });
  assert.deepEqual(target.targetStudentIds, ['b', 'c']);
  assert.deepEqual(target.groups, [
    { kind: 'coverage', id: 'ctx-2', targetStudentIds: ['b'] },
    { kind: 'coverage', id: 'ctx-1', targetStudentIds: ['c'] },
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

test('late-sign-in feedback sums pending and unavailable and reports current-page skips', () => {
  const feedback = commandDeliveryFeedback({
    command: { commandType: 'lock-screen', deliveryPolicy: 'persistent_control' },
    summary: {
      requested: 5,
      attempted: 1,
      acknowledged: 0,
      completed: 0,
      pending: 2,
      failed: 0,
      unavailable: 2,
      expired: 0,
    },
    skippedCurrentPageCount: 1,
  }, 'lock-screen');
  assert.equal(feedback.title, 'Restriction saved');
  assert.match(feedback.description, /4 restrictions are pending/);
  assert.match(feedback.description, /1 signed-out student was skipped/);
});

test('Coverage command contract includes persistent restriction removal', () => {
  assert.equal(DEFAULT_COVERAGE_COMMANDS.includes('remove-flight-path'), true);
  assert.equal(DEFAULT_COVERAGE_COMMANDS.includes('remove-block-list'), true);
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

test('toolbar Lock and Unlock require explicit students and keep exact payload semantics', () => {
  assert.deepEqual(toolbarScreenCommand('lock-screen', [' student-a ']), {
    commandType: 'lock-screen',
    commandPayload: { url: 'CURRENT_URL' },
    studentIds: ['student-a'],
  });
  assert.deepEqual(toolbarScreenCommand('lock-screen', ['student-b', 'student-a', 'student-b', '']), {
    commandType: 'lock-screen',
    commandPayload: { url: 'CURRENT_URL' },
    studentIds: ['student-b', 'student-a'],
  });
  assert.deepEqual(toolbarScreenCommand('unlock-screen', new Set(['student-a', 'student-b'])), {
    commandType: 'unlock-screen',
    commandPayload: { screenOnly: true },
    studentIds: ['student-a', 'student-b'],
  });

  for (const invalidSelection of [undefined, null, [], new Set(), 'student-a', { studentId: 'student-a' }]) {
    assert.equal(toolbarScreenCommand('lock-screen', invalidSelection), null);
    assert.equal(toolbarScreenCommand('unlock-screen', invalidSelection), null);
  }
  assert.equal(toolbarScreenCommand('open-tab', ['student-a']), null);

  const submittedCommands = [];
  const descriptor = toolbarScreenCommand('lock-screen', []);
  if (descriptor) submittedCommands.push(descriptor);
  assert.deepEqual(submittedCommands, [], 'an empty selection must not produce a command request');
});

test('toolbar Unlock capability gating fails closed for a mixed selection', () => {
  const selectedStudents = [
    { studentId: 'student-a', capabilities: { screenOnlyUnlockV1: true } },
    { studentId: 'student-b', extensionCapabilities: ['screenOnlyUnlockV1'] },
  ];
  assert.equal(
    selectedStudents.every((student) => studentSupportsCapability(student, 'screenOnlyUnlockV1')),
    true,
  );

  const mixedSelection = [
    ...selectedStudents,
    { studentId: 'student-c', capabilities: { screenOnlyUnlockV1: false } },
  ];
  assert.equal(
    mixedSelection.every((student) => studentSupportsCapability(student, 'screenOnlyUnlockV1')),
    false,
    'one unsupported selected student must disable the combined Unlock action',
  );
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
