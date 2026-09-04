import test from 'node:test';
import assert from 'node:assert/strict';

import {
  activeTemporaryAllows,
  assertClassroomCommandSelectionIsolation,
  buildStudentSignOutCommandRequest,
  commandSupportsLateSignInRestriction,
  combineCommandSettlements,
  CONSERVATIVE_DOMAIN_RESTRICTION_MESSAGE,
  coverageStudentCommandSelectionEligible,
  DEFAULT_COVERAGE_COMMANDS,
  DOMAIN_PRESERVING_RESTRICTION_MESSAGE,
  DOMAIN_RESTRICTION_URL_HELP,
  deriveDashboardCapabilities,
  deriveTabLimitChip,
  domainRestrictionMessageForStudents,
  effectiveStudentRestrictions,
  exactTabCloseCapability,
  flightPathApplyCapability,
  isStudentUrlOffTask,
  isLateSignInRestrictionTarget,
  lateSignInRestrictionGateEnabled,
  mergeCommandUpdateIntoBatches,
  normalizeSessionFabState,
  parseTabSelectionKey,
  partitionCoverageCurrentPageWaypointTargets,
  partitionCurrentPageWaypointTargets,
  resolveCommandTargets,
  resolveStudentSignOutTargets,
  studentSignOutSelectionBinding,
  studentSupportsCapability,
  studentTileFlightPathReleaseCommand,
  studentTileScreenToggleCommand,
  studentTileTempUnblockCommand,
  studentSignOutCommandPayload,
  sessionFabSettingsPayload,
  tabLimitCommandPayload,
  TEMP_UNBLOCK_DEFAULT_MINUTES,
  tabSelectionKey,
  toolbarScreenCommand,
  uniqueStudentsById,
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

test('late-sign-in restriction eligibility fails closed on the exact-school operator projection', () => {
  const signedOut = {
    studentId: 'signed-out',
    loginState: 'not_logged_in',
    isLoggedIn: false,
    lateSignInRestrictionSsoV1Enabled: true,
    capabilities: {},
  };
  assert.equal(lateSignInRestrictionGateEnabled([signedOut]), true);
  assert.equal(lateSignInRestrictionGateEnabled([]), false);
  assert.equal(lateSignInRestrictionGateEnabled([
    signedOut,
    { ...signedOut, studentId: 'missing-projection', lateSignInRestrictionSsoV1Enabled: undefined },
  ]), false, 'an inconsistent or missing row projection keeps the school UI off');

  assert.equal(isLateSignInRestrictionTarget({
    student: signedOut,
    operatorEnabled: true,
    structurallyCommandable: true,
  }), true, 'raw client capability is intentionally not required while the student is signed out');
  assert.equal(isLateSignInRestrictionTarget({
    student: signedOut,
    operatorEnabled: false,
    structurallyCommandable: true,
  }), false);
  assert.equal(isLateSignInRestrictionTarget({
    student: { ...signedOut, loginState: 'logged_in', isLoggedIn: true },
    operatorEnabled: true,
    structurallyCommandable: true,
  }), false, 'signal loss or stale reachability must not be treated as explicit sign-out');
  assert.equal(isLateSignInRestrictionTarget({
    student: signedOut,
    operatorEnabled: true,
    structurallyCommandable: false,
  }), false, 'supervision and ownership still fence signed-out selection');
});

test('only persistent restrictions can include deferred signed-out targets', () => {
  for (const commandType of [
    'unlock-screen',
    'apply-flight-path',
    'remove-flight-path',
    'apply-block-list',
    'remove-block-list',
  ]) {
    assert.equal(commandSupportsLateSignInRestriction(commandType), true, commandType);
  }
  assert.equal(
    commandSupportsLateSignInRestriction('lock-screen', { url: 'https://classroom.example/landing' }),
    true,
  );
  assert.equal(
    commandSupportsLateSignInRestriction('lock-screen', { url: 'CURRENT_URL' }),
    false,
    'current-page Waypoints cannot be authored for signed-out students',
  );
  for (const commandType of ['open-tab', 'close-tabs', 'teacher-message', 'attention-mode', 'timer', 'poll']) {
    assert.equal(commandSupportsLateSignInRestriction(commandType), false, commandType);
  }
});

test('Coverage selection admits current rows and only exact-gated explicit sign-outs', () => {
  const signedOut = {
    studentId: 'signed-out',
    loginState: 'not_logged_in',
    isLoggedIn: false,
    operatorCapabilities: { lateSignInRestrictionSsoV1: true },
    lateSignInRestrictionSsoV1Enabled: true,
  };
  assert.equal(coverageStudentCommandSelectionEligible({
    student: { studentId: 'online', loginState: 'logged_in', isLoggedIn: true },
    monitoringDisplay: { telemetryCurrent: true },
    structurallyCommandable: true,
  }), true);
  assert.equal(coverageStudentCommandSelectionEligible({
    student: signedOut,
    monitoringDisplay: { telemetryCurrent: false },
    structurallyCommandable: true,
  }), true);
  assert.equal(coverageStudentCommandSelectionEligible({
    student: { ...signedOut, operatorCapabilities: {} },
    monitoringDisplay: { telemetryCurrent: false },
    structurallyCommandable: true,
  }), false, 'a missing exact-school operator projection fails closed');
  assert.equal(coverageStudentCommandSelectionEligible({
    student: { ...signedOut, lateSignInRestrictionSsoV1Enabled: false },
    monitoringDisplay: { telemetryCurrent: false },
    structurallyCommandable: true,
  }), false, 'the row-level gate projection must also be active');
  assert.equal(coverageStudentCommandSelectionEligible({
    student: {
      ...signedOut,
      studentId: 'signal-lost',
      loginState: 'logged_in',
      isLoggedIn: true,
    },
    monitoringDisplay: { telemetryCurrent: false },
    structurallyCommandable: true,
  }), false, 'signal loss is not explicit sign-out');
  assert.equal(coverageStudentCommandSelectionEligible({
    student: signedOut,
    monitoringDisplay: { telemetryCurrent: false },
    structurallyCommandable: false,
  }), false, 'released or foreign-context rows remain structurally fenced');
});

test('Select All deduplicates students eligible through both current and late-sign-in lanes', () => {
  const signedOut = { studentId: 'signed-out', loginState: 'not_logged_in' };
  assert.deepEqual(
    uniqueStudentsById([
      { studentId: 'online' },
      signedOut,
      signedOut,
      { studentId: 'online' },
    ]).map((student) => student.studentId),
    ['online', 'signed-out'],
  );
});

test('Coverage current-page Waypoints skip explicit sign-outs but preserve signal-loss truth', () => {
  assert.deepEqual(partitionCoverageCurrentPageWaypointTargets([
    { studentId: 'online', loginState: 'logged_in', isLoggedIn: true },
    { studentId: 'signal-lost', loginState: 'logged_in', isLoggedIn: true },
    { studentId: 'signed-out', loginState: 'not_logged_in', isLoggedIn: false },
  ]), {
    targetStudentIds: ['online', 'signal-lost'],
    skippedStudentIds: ['signed-out'],
  });
});

test('deferred classroom state remains visible for clear-before-sign-in actions', () => {
  assert.deepEqual(effectiveStudentRestrictions({
    isLoggedIn: false,
    screenLocked: false,
    flightPathActive: false,
    activeFlightPathName: null,
    classroomState: {
      restrictions: {
        screenLock: { active: true },
        flightPath: { active: true, name: 'Deferred Path', allowedDomains: ['example.test'] },
        blockList: { active: true, name: 'Deferred Blocks', blockedDomains: ['blocked.test'] },
      },
    },
  }), {
    screenLockActive: true,
    flightPathActive: true,
    flightPathName: 'Deferred Path',
    blockListActive: true,
    blockListName: 'Deferred Blocks',
  });

  assert.equal(
    effectiveStudentRestrictions({
      flightPathActive: true,
      classroomState: { restrictions: { flightPath: { active: false } } },
    }).flightPathActive,
    false,
    'the authoritative snapshot must override stale realtime controls',
  );
});

test('current-page Waypoints report and skip every target without fresh telemetry', () => {
  assert.deepEqual(partitionCurrentPageWaypointTargets([
    { studentId: 'online', telemetryCurrent: true },
    { studentId: 'signed-out', telemetryCurrent: false },
    { studentId: 'signal-lost', telemetryCurrent: false },
  ]), {
    targetStudentIds: ['online'],
    skippedStudentIds: ['signed-out', 'signal-lost'],
  });
});

test('persistent restriction feedback keeps pending and undelivered outcomes distinct', () => {
  const feedback = commandDeliveryFeedback({
    command: { commandType: 'apply-flight-path' },
    summary: { requested: 5, completed: 2, pending: 2, unavailable: 1 },
  }, 'apply-flight-path');
  // 2 pending, not 3. The unavailable student was never delivered to, so
  // folding them into the pending count overstated what was on its way.
  assert.match(feedback.description, /2 restrictions are pending/);
  assert.doesNotMatch(feedback.description, /3 restrictions are pending/);
  assert.match(feedback.description, /1 student is signed out/);
  assert.equal(feedback.title, 'Restriction saved');
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

test('late-sign-in feedback separates pending from undelivered and reports current-page skips', () => {
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
  // Only the 2 genuinely awaiting a device acknowledgement may be called
  // pending. The 2 unavailable students were never delivered to, and
  // summing them told teachers a restriction was on its way when it was not.
  assert.match(feedback.description, /2 restrictions are pending/);
  assert.doesNotMatch(feedback.description, /4 restrictions are pending/);
  assert.match(
    feedback.description,
    /2 students are signed out, so the restriction was not delivered to them\. Apply it again once they are signed in\./,
  );
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

test('the tile temporary allow targets one student, one normalized domain, and a bounded duration', () => {
  assert.equal(TEMP_UNBLOCK_DEFAULT_MINUTES, 10);
  assert.deepEqual(studentTileTempUnblockCommand({ studentId: 'a' }, 'Blocked.Example.test'), {
    commandType: 'temp-unblock',
    commandPayload: { domain: 'blocked.example.test', durationMinutes: 10 },
    studentIds: ['a'],
  });
  assert.deepEqual(
    studentTileTempUnblockCommand({ studentId: 'a' }, ' www.blocked.example.test ', 5).commandPayload,
    { domain: 'blocked.example.test', durationMinutes: 5 },
  );
  assert.equal(studentTileTempUnblockCommand({ studentId: 'a' }, ''), null);
  assert.equal(studentTileTempUnblockCommand({ studentId: 'a' }, null), null);
  assert.equal(studentTileTempUnblockCommand({}, 'blocked.example.test'), null);
  assert.equal(studentTileTempUnblockCommand(null, 'blocked.example.test'), null);
  assert.equal(studentTileTempUnblockCommand({ studentId: 'a' }, 'blocked.example.test', 0), null);
  assert.equal(studentTileTempUnblockCommand({ studentId: 'a' }, 'blocked.example.test', 2.5), null);
  assert.equal(studentTileTempUnblockCommand({ studentId: 'a' }, 'blocked.example.test', 'ten'), null);
});

test('active temporary allows come only from unexpired authoritative classroom state, soonest first', () => {
  const now = Date.parse('2026-08-13T12:00:00.000Z');
  const student = {
    classroomState: {
      restrictions: {
        temporaryAllows: [
          { domain: 'later.example.test', expiresAt: '2026-08-13T12:20:00.000Z' },
          { domain: 'Soon.Example.test', expiresAt: '2026-08-13T12:05:00.000Z' },
          { domain: 'expired.example.test', expiresAt: '2026-08-13T11:59:59.000Z' },
          { domain: 'exact.example.test', expiresAt: '2026-08-13T12:00:00.000Z' },
          { domain: '', expiresAt: '2026-08-13T12:30:00.000Z' },
          { domain: 'broken.example.test', expiresAt: 'not a date' },
          { domain: 'missing.example.test' },
          { domain: 'numeric.example.test', expiresAt: now + 60_000 },
          null,
        ],
      },
    },
  };
  assert.deepEqual(activeTemporaryAllows(student, now), [
    { domain: 'numeric.example.test', expiresAtMs: now + 60_000 },
    { domain: 'soon.example.test', expiresAtMs: Date.parse('2026-08-13T12:05:00.000Z') },
    { domain: 'later.example.test', expiresAtMs: Date.parse('2026-08-13T12:20:00.000Z') },
  ]);
  assert.deepEqual(
    activeTemporaryAllows(student, Date.parse('2026-08-13T12:20:00.000Z')),
    [],
    'every allow expires at its exact boundary',
  );
  assert.deepEqual(activeTemporaryAllows({ classroomState: { restrictions: {} } }, now), []);
  assert.deepEqual(activeTemporaryAllows({ classroomState: { restrictions: { temporaryAllows: 'x' } } }, now), []);
  assert.deepEqual(activeTemporaryAllows(null, now), []);
  assert.deepEqual(activeTemporaryAllows(student, Number.NaN), []);
});

test('the tab-limit chip derives from authoritative classroom state and the realtime tab count', () => {
  assert.deepEqual(
    deriveTabLimitChip({ classroomState: { restrictions: { tabLimit: 5 } }, openTabCount: 7 }),
    { tabLimit: 5, openTabCount: 7, over: true },
  );
  assert.deepEqual(
    deriveTabLimitChip({ classroomState: { restrictions: { tabLimit: 5 } }, openTabCount: 5 }),
    { tabLimit: 5, openTabCount: 5, over: false },
  );
  assert.deepEqual(
    deriveTabLimitChip({ classroomState: { restrictions: { tabLimit: 3 } }, allOpenTabs: [{}, {}] }),
    { tabLimit: 3, openTabCount: 2, over: false },
    'a legacy snapshot without openTabCount falls back to the tab list length',
  );
  assert.deepEqual(
    deriveTabLimitChip({ classroomState: { restrictions: { tabLimit: 3 } } }),
    { tabLimit: 3, openTabCount: 0, over: false },
  );
  assert.equal(deriveTabLimitChip({ classroomState: { restrictions: { tabLimit: null } }, openTabCount: 7 }), null);
  assert.equal(deriveTabLimitChip({ classroomState: { restrictions: { tabLimit: 0 } }, openTabCount: 7 }), null);
  assert.equal(deriveTabLimitChip({ classroomState: { restrictions: { tabLimit: '5' } }, openTabCount: 7 }), null);
  assert.equal(deriveTabLimitChip({ openTabCount: 7 }), null);
  assert.equal(deriveTabLimitChip(null), null);
});

test('tab-limit payloads accept only whole numbers from 1 to 100 and clear on an empty draft', () => {
  assert.deepEqual(tabLimitCommandPayload('5'), { maxTabs: 5 });
  assert.deepEqual(tabLimitCommandPayload(' 100 '), { maxTabs: 100 });
  assert.deepEqual(tabLimitCommandPayload(1), { maxTabs: 1 });
  assert.deepEqual(tabLimitCommandPayload(''), { maxTabs: null });
  assert.deepEqual(tabLimitCommandPayload('   '), { maxTabs: null });
  assert.deepEqual(tabLimitCommandPayload(null), { maxTabs: null });
  assert.deepEqual(tabLimitCommandPayload(undefined), { maxTabs: null });
  assert.equal(tabLimitCommandPayload('0'), null);
  assert.equal(tabLimitCommandPayload('101'), null);
  assert.equal(tabLimitCommandPayload('2.5'), null);
  assert.equal(tabLimitCommandPayload('-3'), null);
  assert.equal(tabLimitCommandPayload('1e2'), null);
  assert.equal(tabLimitCommandPayload('abc'), null);
  assert.equal(tabLimitCommandPayload(Number.NaN), null);
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
