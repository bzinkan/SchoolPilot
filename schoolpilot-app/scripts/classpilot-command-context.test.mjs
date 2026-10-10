import test from 'node:test';
import assert from 'node:assert/strict';

import {
  activeTemporaryAllows,
  assertClassroomCommandSelectionIsolation,
  buildSelectionScopeKey,
  buildStudentSignOutCommandRequest,
  classToolsRecipientLabel,
  commandAudienceIsServerDerived,
  commandRecipientsHeadline,
  commandRecipientsSummary,
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
  mergeFabSettingsResponse,
  normalizeSessionFabState,
  parseTabSelectionKey,
  partitionCoverageCurrentPageWaypointTargets,
  partitionCurrentPageWaypointTargets,
  partitionSnapshotRecipients,
  planRecipientSend,
  RECIPIENTS_UNAVAILABLE_MESSAGE,
  recipientDialogRefusalMessage,
  recipientSnapshotLabel,
  recipientsRestoredMessage,
  recordSelectionLoss,
  resolveCommandTargets,
  resolveStudentSignOutTargets,
  SELECTION_LOST_CODE,
  selectionLossActionLabel,
  selectionLossBlocksFallback,
  selectionLostMessage,
  selectionScopeKeepsBoundary,
  signOutOnlySelectionLabel,
  snapshotCommandRecipients,
  snapshotRecipientNames,
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
  unavailableRecipientsMessage,
} from '../src/products/classpilot/lib/dashboardCommandContext.js';
import { commandDeliveryFeedback } from '../src/products/classpilot/lib/commandDeliveryTruth.js';
import { compareStudentsByLastName, studentLastName } from '../src/products/classpilot/lib/studentOrder.js';

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
  assert.equal(feedback.variant, 'destructive', 'a device-reported failure stays destructive');
});

test('transient partial delivery is destructive only for failures or zero acknowledgements', () => {
  // 2026-10-09 connection audit, finding #1: one straggler that expired after
  // the rest of the class acknowledged painted a red toast. Expired-only is
  // informational; failures and zero-acknowledgement sends stay destructive.
  const command = { commandType: 'poll', deliveryPolicy: 'transient_action' };
  const expiredOnly = commandDeliveryFeedback({
    command,
    summary: { requested: 5, attempted: 5, acknowledged: 4, completed: 0, received: 4, pending: 0, failed: 0, unavailable: 0, expired: 1, awaitingAck: 0 },
  }, 'poll');
  assert.equal(expiredOnly.title, 'Partially delivered');
  assert.equal(expiredOnly.variant, undefined);
  assert.match(expiredOnly.description, /4 received/);
  assert.match(expiredOnly.description, /1 expired/);

  const failed = commandDeliveryFeedback({
    command,
    summary: { requested: 5, attempted: 5, acknowledged: 4, completed: 0, received: 3, pending: 0, failed: 1, unavailable: 0, expired: 1, awaitingAck: 0 },
  }, 'poll');
  assert.equal(failed.title, 'Partially delivered');
  assert.equal(failed.variant, 'destructive');

  const zeroAck = commandDeliveryFeedback({
    command,
    summary: { requested: 5, attempted: 5, acknowledged: 0, completed: 0, received: 0, pending: 0, failed: 0, unavailable: 0, expired: 5, awaitingAck: 0 },
  }, 'poll');
  assert.equal(zeroAck.title, 'Not delivered');
  assert.equal(zeroAck.variant, 'destructive');
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

test('precise restriction feedback separates students who need the ClassPilot update from signed-out students', () => {
  const unsupportedReason = 'Unsupported client: preciseRestrictionResourcesV1 is required';
  const targets = [
    { studentId: 'capable', status: 'sent', errorMessage: null },
    { studentId: 'legacy-1', status: 'unavailable', errorMessage: unsupportedReason },
    { studentId: 'legacy-2', status: 'unavailable', errorMessage: unsupportedReason },
    { studentId: 'offline', status: 'unavailable', errorMessage: 'restriction_requires_online_student' },
  ];
  const summary = { requested: 4, attempted: 1, acknowledged: 0, completed: 0, pending: 1, failed: 0, unavailable: 3, expired: 0 };
  const feedback = commandDeliveryFeedback({
    command: { commandType: 'lock-screen', deliveryPolicy: 'persistent_control', targets },
    summary,
  }, 'lock-screen');
  assert.equal(feedback.title, 'Restriction saved');
  assert.match(feedback.description, /1 student is signed out, so the restriction was not delivered to them\./);
  assert.match(feedback.description, /2 students need the ClassPilot update before this restriction can apply\./);
  assert.deepEqual(feedback.unsupportedStudentIds, ['legacy-1', 'legacy-2']);

  const allUnsupported = commandDeliveryFeedback({
    command: {
      commandType: 'apply-flight-path',
      deliveryPolicy: 'persistent_control',
      targets: targets.filter((target) => target.studentId.startsWith('legacy')),
    },
    summary: { requested: 2, attempted: 0, acknowledged: 0, completed: 0, pending: 0, failed: 0, unavailable: 2, expired: 0 },
  }, 'apply-flight-path');
  assert.equal(allUnsupported.title, 'Extension update required');
  assert.equal(allUnsupported.variant, 'destructive');
  assert.doesNotMatch(allUnsupported.description, /signed out/);

  // Outcomes without a capability refusal keep exactly their previous shape.
  const signedOutOnly = commandDeliveryFeedback({
    command: { commandType: 'lock-screen', deliveryPolicy: 'persistent_control', targets: [targets[3]] },
    summary: { requested: 1, attempted: 0, acknowledged: 0, completed: 0, pending: 0, failed: 0, unavailable: 1, expired: 0 },
  }, 'lock-screen');
  assert.equal(signedOutOnly.title, 'Restriction not delivered');
  assert.equal('unsupportedStudentIds' in signedOutOnly, false);
  assert.match(signedOutOnly.description, /1 student is signed out/);
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

test('session FAB state carries the soft pause separately from the hard channel switch', () => {
  const paused = normalizeSessionFabState({
    teachingSessionId: 'session-1', chatEnabled: true, messagingEnabled: false, chatPaused: true, messagesPaused: true, pauseReason: 'teacher', lifecycleRevision: 3,
  }, 'session-1');
  assert.deepEqual([paused.messagingEnabled, paused.chatPaused, paused.messagesPaused, paused.pauseReason, paused.revision], [true, true, true, 'teacher', 3],
    'the channel stays on while paused; the effective flag the server reports does not flip the switch');
  const testing = normalizeSessionFabState({ supervisionContextId: 'ctx-1', chatEnabled: true, chatPaused: false, messagesPaused: true, pauseReason: 'testing', lifecycleRevision: 0 },
    { supervisionContextId: 'ctx-1' });
  assert.deepEqual([testing.chatPaused, testing.messagesPaused, testing.pauseReason], [false, true, 'testing']);
  const legacy = normalizeSessionFabState({ activeSessionId: 'session-1', studentMessagingEnabled: true, sessionFabRevision: 1 }, 'session-1');
  assert.deepEqual([legacy.messagingEnabled, legacy.chatPaused, legacy.messagesPaused, legacy.pauseReason], [true, false, false, null], 'older servers without pause fields read as not paused');
  const off = normalizeSessionFabState({ teachingSessionId: 'session-1', chatEnabled: false, messagesPaused: false, lifecycleRevision: 2 }, 'session-1');
  assert.equal(off.messagingEnabled, false);
  assert.deepEqual(sessionFabSettingsPayload(paused, { chatPaused: false }), { chatPaused: false, expectedRevision: 3 });
});

test('a settings response folds the stored row and the effective state into one FAB value', () => {
  const merged = mergeFabSettingsResponse({
    settings: { supervisionContextId: 'ctx-1', chatEnabled: true, raiseHandEnabled: true, chatPaused: false, lifecycleRevision: 2 },
    state: { messagingEnabled: false, handRaisingEnabled: true, messagesPaused: true, pauseReason: 'testing', lifecycleRevision: 2 },
  });
  assert.deepEqual(merged, { supervisionContextId: 'ctx-1', chatEnabled: true, raiseHandEnabled: true, chatPaused: false, lifecycleRevision: 2,
    messagingEnabled: false, handRaisingEnabled: true, messagesPaused: true, pauseReason: 'testing' });
  const normalized = normalizeSessionFabState(merged, { supervisionContextId: 'ctx-1' });
  assert.deepEqual([normalized.messagingEnabled, normalized.messagesPaused, normalized.pauseReason, normalized.revision], [true, true, 'testing', 2]);
  assert.deepEqual(mergeFabSettingsResponse({ settings: { chatEnabled: false, lifecycleRevision: 1 } }), { chatEnabled: false, lifecycleRevision: 1 });
  assert.deepEqual(mergeFabSettingsResponse({ teachingSessionId: 's', messagingEnabled: true }), { teachingSessionId: 's', messagingEnabled: true }, 'a bare state passes through');
  assert.equal(mergeFabSettingsResponse(null), null);
});

const recipientRoster = [
  { studentId: 'a', studentName: 'Zed Alpha', commandable: true },
  { studentId: 'b', studentName: 'Ann Zulu', commandable: true },
  { studentId: 'c', studentName: 'Cy Beta', commandable: true },
];

test('a classroom dialog freezes its recipients by last name and refuses an empty list', () => {
  const target = resolveCommandTargets({ mode: 'owned-class', sessionStudents: recipientRoster });
  const snapshot = snapshotCommandRecipients({
    target, students: recipientRoster, label: 'Whole class', scopeKey: 'scope-a', view: 'class',
  });
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.ids), true);
  assert.equal(Object.isFrozen(snapshot.names), true);
  assert.throws(() => { snapshot.ids.push('d'); }, TypeError, 'a frozen list cannot grow after the dialog opens');
  assert.deepEqual(snapshot.ids, ['a', 'c', 'b'], 'ids stay aligned with names in last-name order');
  assert.deepEqual(snapshot.names, ['Zed Alpha', 'Cy Beta', 'Ann Zulu']);
  assert.deepEqual([snapshot.label, snapshot.scopeKey, snapshot.view], ['Whole class', 'scope-a', 'class']);

  const unnamed = snapshotCommandRecipients({
    target: { targetStudentIds: ['x', 'y', 'y', ' '] },
    students: [{ studentId: 'y', studentEmail: 'y@example.edu' }],
  });
  assert.deepEqual(unnamed.ids, ['x', 'y'], 'ids are trimmed and de-duplicated');
  assert.deepEqual(unnamed.names, ['Student unavailable', 'y@example.edu']);

  for (const empty of [{ target: { targetStudentIds: [] } }, { target: null }, {}, undefined]) {
    assert.throws(() => snapshotCommandRecipients(empty), /^Error: Choose at least one student\.$/);
  }
});

test('a frozen send keeps only recipients who can still receive it and never adds anyone', () => {
  const snapshot = snapshotCommandRecipients({ target: { targetStudentIds: ['a', 'b', 'c'] }, students: recipientRoster });
  assert.deepEqual(snapshot.ids, ['a', 'c', 'b']);
  assert.deepEqual(partitionSnapshotRecipients(snapshot, ['b', 'a', 'c']), { sendIds: ['a', 'c', 'b'], unavailableIds: [] });
  assert.deepEqual(
    partitionSnapshotRecipients(snapshot, ['b', 'z', 'everyone-else']),
    { sendIds: ['b'], unavailableIds: ['a', 'c'] },
    'a currently commandable student outside the snapshot is never added',
  );
  assert.deepEqual(partitionSnapshotRecipients(snapshot, new Set(['c'])), { sendIds: ['c'], unavailableIds: ['a', 'b'] });
  assert.deepEqual(partitionSnapshotRecipients(snapshot, []), { sendIds: [], unavailableIds: ['a', 'c', 'b'] });
  assert.deepEqual(partitionSnapshotRecipients(snapshot, null), { sendIds: [], unavailableIds: ['a', 'c', 'b'] });
  assert.deepEqual(partitionSnapshotRecipients(null, ['a']), { sendIds: [], unavailableIds: [] });
  assert.deepEqual(snapshotRecipientNames(snapshot, ['b', 'a', 'z']), ['Zed Alpha', 'Ann Zulu'], 'names follow the frozen order');
  assert.deepEqual(snapshotRecipientNames(snapshot, null), []);
});

test('Send only ever sends what the dialog shows, and a partial send needs a separate confirmation', () => {
  const snapshot = snapshotCommandRecipients({ target: { targetStudentIds: ['a', 'b', 'c'] }, students: recipientRoster });
  assert.deepEqual(snapshot.ids, ['a', 'c', 'b']);
  const plan = (commandableIds, options = {}) => planRecipientSend({ snapshot, commandableIds, ...options });

  assert.deepEqual(plan(['b', 'c', 'a', 'outsider']), { action: 'send', studentIds: ['a', 'c', 'b'] }, 'a student outside the frozen list is never added');
  assert.deepEqual(plan(['a', 'b', 'c'], { repeatGesture: true }), { action: 'send', studentIds: ['a', 'c', 'b'] }, 'a repeat only matters while confirming');
  assert.deepEqual(plan(['c', 'b']), { action: 'ask', unavailableIds: ['a'], confirmIds: ['c', 'b'] }, 'a lost recipient is named first');
  assert.deepEqual(plan([]), { action: 'ask', unavailableIds: ['a', 'c', 'b'], confirmIds: null }, 'no one left: nothing to confirm');

  // Waiting on "Send to 2 available" (c and b).
  const confirming = { confirmIds: ['c', 'b'] };
  assert.deepEqual(plan(['c', 'b'], confirming), { action: 'send', studentIds: ['c', 'b'] }, 'the confirmation sends exactly the named students');
  assert.deepEqual(plan(['c', 'b'], { ...confirming, repeatGesture: true }), { action: 'ignore' }, 'a double click or held key cannot confirm');
  assert.deepEqual(plan(['a', 'c', 'b'], confirming), { action: 'restored', restoredIds: ['a'] }, 'a returning student is not silently skipped');
  assert.deepEqual(plan(['c'], confirming), { action: 'ask', unavailableIds: ['a', 'b'], confirmIds: ['c'] }, 'a confirmed student who drops is asked about again');
  assert.deepEqual(plan(['a', 'c'], confirming), { action: 'ask', unavailableIds: ['b'], confirmIds: ['a', 'c'] }, 'a changed subset is asked about again');
  assert.deepEqual(plan(['outsider'], confirming), { action: 'ask', unavailableIds: ['a', 'c', 'b'], confirmIds: null });
});

test('a dialog that cannot open says why without claiming a send', () => {
  const thrown = (fn) => { try { fn(); } catch (error) { return error; } assert.fail('expected a throw'); };
  const noClassTarget = thrown(() => resolveCommandTargets({ mode: 'owned-class', sessionStudents: [] }));
  const noClaimedTarget = thrown(() => resolveCommandTargets({ mode: 'claimed-coverage', claimedStudents: [] }));
  const ticksUnavailable = new Error(RECIPIENTS_UNAVAILABLE_MESSAGE);

  assert.equal(recipientDialogRefusalMessage(noClassTarget), 'No students in this class can receive this right now.');
  assert.equal(recipientDialogRefusalMessage(noClassTarget, { subgroupSelected: true }), 'No students in this group can receive this right now.');
  assert.equal(recipientDialogRefusalMessage(noClaimedTarget, { view: 'claimed' }), 'No claimed students can receive this right now.');
  assert.equal(
    recipientDialogRefusalMessage(noClassTarget, { blockedNames: ['Ada Student'] }),
    "Ada Student can't receive this right now. Untick them and try again.",
  );
  assert.equal(
    recipientDialogRefusalMessage(ticksUnavailable, { blockedNames: ['Ada Student', 'Ben Student'] }),
    "Ada Student and Ben Student can't receive this right now. Untick them and try again.",
  );
  assert.equal(recipientDialogRefusalMessage(ticksUnavailable), "Some selected students can't receive this right now. Untick them and try again.");
  const loading = 'Student targets are unavailable until the class roster finishes loading.';
  assert.equal(recipientDialogRefusalMessage(new Error(loading), { blockedNames: ['Ada Student'] }), loading, 'other reasons pass through');
  assert.equal(recipientDialogRefusalMessage(null), 'This is not available right now.');
  for (const error of [noClassTarget, noClaimedTarget, ticksUnavailable]) {
    assert.doesNotMatch(recipientDialogRefusalMessage(error), /sent/i, 'nothing was attempted when a dialog does not open');
  }
});

test('recipient copy names the frozen audience and who was left out', () => {
  assert.equal(recipientSnapshotLabel({ selectedCount: 2 }), '2 selected students');
  assert.equal(recipientSnapshotLabel({ selectedCount: 1, subgroupName: 'Reading table' }), '1 selected student', 'ticks win over a subgroup');
  assert.equal(recipientSnapshotLabel({ subgroupName: ' Reading table ' }), 'Group: Reading table');
  assert.equal(recipientSnapshotLabel({}), 'Whole class');
  assert.equal(recipientSnapshotLabel(), 'Whole class');
  assert.equal(recipientSnapshotLabel({ view: 'claimed' }), 'All claimed students');

  const one = snapshotCommandRecipients({ target: { targetStudentIds: ['a'] }, students: recipientRoster, label: '1 selected student' });
  const three = snapshotCommandRecipients({ target: { targetStudentIds: ['a', 'b', 'c'] }, students: recipientRoster, label: 'Group: Reading table' });
  const classSnapshot = snapshotCommandRecipients({ target: { targetStudentIds: ['a', 'b'] }, students: recipientRoster, label: 'Whole class' });
  assert.equal(commandRecipientsHeadline(one), 'Send to 1 selected student', 'a tick label already states the count');
  assert.equal(commandRecipientsHeadline(three), 'Send to 3 students — Group: Reading table');
  assert.equal(commandRecipientsHeadline(classSnapshot), 'Send to 2 students — Whole class');
  assert.equal(commandRecipientsHeadline(null), 'Send to 0 students');

  // The toast line names the audience; its title and outcome text report delivery.
  assert.equal(commandRecipientsSummary({ count: 2, label: '2 selected students' }), 'Recipients: 2 selected students.');
  assert.equal(commandRecipientsSummary({ count: 2, frozenCount: 2, label: 'Whole class' }), 'Recipients: 2 students (Whole class).');
  assert.equal(
    commandRecipientsSummary({ count: 1, frozenCount: 2, label: '2 selected students' }),
    'Recipients: 1 of 2 selected students.',
    'a confirmed partial send says how many of the frozen list it addressed',
  );
  assert.equal(commandRecipientsSummary({ count: 1, frozenCount: 3, label: 'Group: Reading table' }), 'Recipients: 1 of 3 students (Group: Reading table).');
  assert.equal(commandRecipientsSummary({ count: 1 }), 'Recipients: 1 student.');
  assert.equal(commandRecipientsSummary({ count: 1, label: '10 selected students' }), 'Recipients: 1 student (10 selected students).');
  for (const summary of [
    commandRecipientsSummary({ count: 2, label: 'Whole class' }),
    commandRecipientsSummary({ count: 1, frozenCount: 2, label: '2 selected students' }),
  ]) {
    assert.doesNotMatch(summary, /sent|deliver/i, 'a failed delivery toast must not read as sent');
  }

  assert.equal(unavailableRecipientsMessage(['Ada Student']), "Ada Student can't receive this right now. Nothing was sent.");
  assert.equal(
    unavailableRecipientsMessage(['Ada Student'], { availableCount: 1 }),
    `Ada Student can't receive this right now. Choose "Send to 1 available" to send without them, or Cancel.`,
    'a partial send says what to do next',
  );
  assert.equal(
    unavailableRecipientsMessage(['Ada Student', 'Ben Student'], { nothingSent: false }),
    "Ada Student and Ben Student can't receive this right now.",
  );
  assert.equal(
    unavailableRecipientsMessage(['A One', 'B Two', 'C Three', 'D Four', 'E Five', 'F Six']),
    "A One, B Two, C Three, D Four, and 2 more students can't receive this right now. Nothing was sent.",
  );
  assert.equal(
    recipientsRestoredMessage(['Ada Student']),
    'Ada Student can receive this again. Nothing was sent. Send again to include them.',
  );
  assert.equal(RECIPIENTS_UNAVAILABLE_MESSAGE, "Some selected students can't receive this right now. Nothing was sent.");
  assert.equal(
    unavailableRecipientsMessage(['Ada Student'], { availableCount: 1, offerCancel: false }),
    `Ada Student can't receive this right now. Choose "Send to 1 available" to send without them.`,
    'a dialog that closes with Done does not name a Cancel button',
  );
});

test('a selection the teacher did not clear is recorded per class and view and blocks only the fallback', () => {
  assert.equal(recordSelectionLoss(null, { previousIds: [], keptIds: [], scopeKey: 'class-a' }), null, 'nothing ticked, nothing lost');
  assert.equal(recordSelectionLoss(null, { previousIds: ['a'], keptIds: ['a'], scopeKey: 'class-a' }), null, 'nothing removed');
  assert.equal(recordSelectionLoss(undefined), null);

  const one = recordSelectionLoss(null, { previousIds: ['a', 'b'], keptIds: ['b'], scopeKey: 'class-a' });
  assert.deepEqual(one, { lostIds: ['a'], count: 1, scopeKey: 'class-a', reason: 'stopped-reporting' });
  assert.equal(Object.isFrozen(one), true);
  assert.equal(Object.isFrozen(one.lostIds), true);
  const both = recordSelectionLoss(one, { previousIds: ['b', ' '], keptIds: [], scopeKey: 'class-a' });
  assert.deepEqual(both, { lostIds: ['a', 'b'], count: 2, scopeKey: 'class-a', reason: 'stopped-reporting' }, 'losses in one class and view add up');
  assert.equal(recordSelectionLoss(both, { previousIds: ['a'], keptIds: [], scopeKey: 'class-a' }).count, 2, 'a student lost twice counts once');
  assert.equal(recordSelectionLoss(both, { previousIds: ['b'], keptIds: ['b'], scopeKey: 'class-a' }), both, 'unchanged when nothing is removed');
  assert.deepEqual(
    recordSelectionLoss(both, { previousIds: ['c'], keptIds: [], scopeKey: 'class-b', reason: 'session-changed' }),
    { lostIds: ['c'], count: 1, scopeKey: 'class-b', reason: 'session-changed' },
    'a loss in another class or view replaces the old one, cause included',
  );

  // Each cause is named; losses with more than one cause name none.
  const sessionChanged = recordSelectionLoss(null, { previousIds: ['a'], keptIds: [], scopeKey: 'class-a', reason: 'session-changed' });
  assert.equal(sessionChanged.reason, 'session-changed');
  assert.equal(recordSelectionLoss(sessionChanged, { previousIds: ['b'], keptIds: [], scopeKey: 'class-a', reason: 'session-changed' }).reason, 'session-changed');
  const mixed = recordSelectionLoss(sessionChanged, { previousIds: ['b'], keptIds: [], scopeKey: 'class-a', reason: 'stopped-reporting' });
  assert.deepEqual(mixed, { lostIds: ['a', 'b'], count: 2, scopeKey: 'class-a', reason: 'changed' });
  assert.equal(recordSelectionLoss(null, { previousIds: ['a'], scopeKey: 'class-a', reason: 'made-up' }).reason, 'changed');
  assert.deepEqual(
    recordSelectionLoss(null, { previousIds: ['group-1'], scopeKey: 'class-a', reason: 'group-removed' }),
    { lostIds: ['group-1'], count: 1, scopeKey: 'class-a', reason: 'group-removed' },
    'a removed group with nobody ticked is still a lost target',
  );

  assert.equal(selectionLossBlocksFallback(both, []), true, 'nothing left ticked: the fallback is refused');
  assert.equal(selectionLossBlocksFallback(both, new Set()), true);
  assert.equal(selectionLossBlocksFallback(both, ['c']), false, 'ticks that remain are an explicit target');
  assert.equal(selectionLossBlocksFallback(both, new Set(['c'])), false);
  assert.equal(selectionLossBlocksFallback(null, []), false);
  assert.equal(selectionLossBlocksFallback({ lostIds: [], count: 0 }, []), false);

  assert.equal(
    selectionLostMessage(1),
    'Your selection was cleared because 1 selected student stopped reporting. Choose students again, or use the whole class.',
  );
  assert.equal(
    selectionLostMessage(2, { scope: 'group', nothingSent: true }),
    'Your selection was cleared because 2 selected students stopped reporting. Nothing was sent. Choose students again, or use the whole group.',
  );
  assert.equal(
    selectionLostMessage(1, { scope: 'claimed' }),
    'Your selection was cleared because 1 selected student stopped reporting. Choose students again, or use all claimed students.',
  );
  assert.equal(selectionLostMessage(0, { scope: 'unknown' }), 'Your selection was cleared. Choose students again, or use the whole class.');
  assert.equal(
    selectionLostMessage(2, { reason: 'session-changed' }),
    'Your selection was cleared because the session changed for 2 selected students. Choose students again, or use the whole class.',
  );
  assert.equal(
    selectionLostMessage(3, { scope: 'claimed', reason: 'groups-changed', nothingSent: true }),
    'Your selection was cleared because your supervision groups changed. Nothing was sent. Choose students again, or use all claimed students.',
  );
  assert.equal(
    selectionLostMessage(1, { reason: 'group-removed' }),
    'Your selection was cleared because the group you chose was removed. Choose students again, or use the whole class.',
  );
  assert.equal(
    selectionLostMessage(2, { reason: 'changed' }),
    'Your selection was cleared. Choose students again, or use the whole class.',
    'more than one cause names none',
  );
  assert.deepEqual(
    ['class', 'group', 'claimed', 'unknown', undefined].map((scope) => selectionLossActionLabel(scope)),
    ['Use whole class', 'Use whole group', 'Use all claimed students', 'Use whole class', 'Use whole class'],
  );
});

test('a student lost twice keeps the first cause, and an unavailable class is named', () => {
  // A ticked student who signs out stops reporting (the telemetry trim) and
  // changes session (the binding check) in the same update.
  const stopped = recordSelectionLoss(null, { previousIds: ['a'], scopeKey: 'class-a', reason: 'stopped-reporting' });
  assert.equal(
    recordSelectionLoss(stopped, { previousIds: ['a'], scopeKey: 'class-a', reason: 'session-changed' }),
    stopped,
    'the same student recorded again changes nothing',
  );
  assert.equal(
    selectionLostMessage(stopped.count, { reason: stopped.reason }),
    'Your selection was cleared because 1 selected student stopped reporting. Choose students again, or use the whole class.',
  );
  // A new student with another cause still names none.
  assert.deepEqual(
    recordSelectionLoss(stopped, { previousIds: ['a', 'b'], scopeKey: 'class-a', reason: 'session-changed' }),
    { lostIds: ['a', 'b'], count: 2, scopeKey: 'class-a', reason: 'changed' },
  );
  // In another scope the same student is a new loss with its own cause.
  assert.deepEqual(
    recordSelectionLoss(stopped, { previousIds: ['a'], scopeKey: 'class-b', reason: 'session-changed' }),
    { lostIds: ['a'], count: 1, scopeKey: 'class-b', reason: 'session-changed' },
  );

  const unavailable = recordSelectionLoss(null, { previousIds: ['a', 'b'], scopeKey: 'class-a', reason: 'class-unavailable' });
  assert.deepEqual(unavailable, { lostIds: ['a', 'b'], count: 2, scopeKey: 'class-a', reason: 'class-unavailable' });
  assert.equal(
    selectionLostMessage(unavailable.count, { reason: unavailable.reason, nothingSent: true }),
    'Your selection was cleared because the class was unavailable. Nothing was sent. Choose students again, or use the whole class.',
  );
  // When the class is back, the cleared ticks still refuse the class fallback.
  assert.throws(
    () => resolveCommandTargets({ mode: 'owned-class', sessionStudents: classStudents, selectionLoss: unavailable }),
    (error) => error.code === SELECTION_LOST_CODE
      && error.message === 'Your selection was cleared because the class was unavailable. Nothing was sent. Choose students again, or use the whole class.',
  );
});

test('the Claimed view keeps its selection scope across class sessions, and only the view may change automatically', () => {
  const reader = JSON.stringify(['school-1', 'teacher-1']);
  const classA = JSON.stringify([['session', 'a'], '3']);
  const classB = JSON.stringify([['session', 'b'], '1']);
  const key = (overrides = {}) => buildSelectionScopeKey({ readerKey: reader, transitionKey: '', view: 'class', authorityKey: classA, ...overrides });

  assert.notEqual(key(), key({ authorityKey: classB }), 'a new class session or revision is a new Class-view scope');
  assert.equal(
    key({ view: 'claimed' }),
    key({ view: 'claimed', authorityKey: classB }),
    'claimed students are commanded through their own groups: a class session starting or ending keeps their scope',
  );
  assert.equal(key({ view: 'claimed' }), key({ view: 'claimed', authorityKey: null }));
  assert.notEqual(key({ view: 'claimed' }), key(), 'Class and Claimed are separate scopes');
  assert.notEqual(key({ transitionKey: 'boundary-2' }), key(), 'a scheduled boundary is a new scope');

  // The Dashboard can switch Class <-> Claimed by itself in one school and
  // boundary; a school, viewer or schedule change is never that switch.
  assert.equal(selectionScopeKeepsBoundary(key(), key({ view: 'claimed' })), true);
  assert.equal(selectionScopeKeepsBoundary(key({ view: 'claimed' }), key({ authorityKey: classB })), true);
  assert.equal(selectionScopeKeepsBoundary(key(), key()), true);
  assert.equal(selectionScopeKeepsBoundary(key(), key({ view: 'claimed', readerKey: JSON.stringify(['school-2', 'teacher-1']) })), false);
  assert.equal(selectionScopeKeepsBoundary(key(), key({ view: 'claimed', transitionKey: 'boundary-2' })), false);
  for (const invalid of [null, undefined, '', 'not json', '[]', JSON.stringify({ view: 'class' })]) {
    assert.equal(selectionScopeKeepsBoundary(invalid, key()), false, `${String(invalid)} is no scope`);
    assert.equal(selectionScopeKeepsBoundary(key(), invalid), false);
  }
});

test('a lost selection never falls back to the subgroup or class, while explicit students still resolve', () => {
  const thrown = (fn) => { try { fn(); } catch (error) { return error; } assert.fail('expected a throw'); };
  const lost = recordSelectionLoss(null, { previousIds: ['a'], keptIds: [], scopeKey: 'class-a' });
  const claimedRows = [
    { studentId: 'a', contextId: 'context-1' },
    { studentId: 'b', contextId: 'context-2' },
  ];

  const classRefusal = thrown(() => resolveCommandTargets({ mode: 'owned-class', sessionStudents: classStudents, selectionLoss: lost }));
  assert.equal(classRefusal.code, SELECTION_LOST_CODE);
  assert.equal(
    classRefusal.message,
    'Your selection was cleared because 1 selected student stopped reporting. Nothing was sent. Choose students again, or use the whole class.',
  );
  const groupRefusal = thrown(() => resolveCommandTargets({
    mode: 'owned-class', sessionStudents: classStudents, selectedSubgroupId: 'group-1', subgroupStudentIds: ['a', 'b'], selectionLoss: lost,
  }));
  assert.equal(groupRefusal.code, SELECTION_LOST_CODE);
  assert.match(groupRefusal.message, /Nothing was sent\. Choose students again, or use the whole group\.$/);
  assert.equal(
    thrown(() => resolveCommandTargets({ mode: 'scheduled-supervision', sessionStudents: classStudents, selectionLoss: lost })).code,
    SELECTION_LOST_CODE,
  );
  const claimedRefusal = thrown(() => resolveCommandTargets({ mode: 'claimed-coverage', claimedStudents: claimedRows, selectionLoss: lost }));
  assert.match(claimedRefusal.message, /use all claimed students\.$/);
  // The supervision groups changed under ticked claimed students.
  const groupsChanged = recordSelectionLoss(null, { previousIds: ['a'], scopeKey: 'claimed', reason: 'groups-changed' });
  const groupsRefusal = thrown(() => resolveCommandTargets({ mode: 'claimed-coverage', claimedStudents: claimedRows, selectionLoss: groupsChanged }));
  assert.equal(groupsRefusal.code, SELECTION_LOST_CODE);
  assert.deepEqual(groupsRefusal.selectionLoss, { count: 1, scope: 'claimed', reason: 'groups-changed' });
  assert.equal(
    groupsRefusal.message,
    'Your selection was cleared because your supervision groups changed. Nothing was sent. Choose students again, or use all claimed students.',
  );
  assert.equal(
    recipientDialogRefusalMessage(groupsRefusal),
    'Your selection was cleared because your supervision groups changed. Choose students again, or use all claimed students.',
  );
  // A removed group refuses the class fallback it would otherwise reach.
  const groupRemoved = recordSelectionLoss(null, { previousIds: ['group-1'], scopeKey: 'class-a', reason: 'group-removed' });
  assert.equal(
    thrown(() => resolveCommandTargets({ mode: 'owned-class', sessionStudents: classStudents, selectionLoss: groupRemoved })).message,
    'Your selection was cleared because the group you chose was removed. Nothing was sent. Choose students again, or use the whole class.',
  );

  assert.deepEqual(
    resolveCommandTargets({ mode: 'owned-class', sessionStudents: classStudents, selectedStudentIds: ['b'], selectionLoss: lost }).targetStudentIds,
    ['b'],
    'a remaining or new tick is an explicit target',
  );
  assert.deepEqual(
    resolveCommandTargets({ mode: 'owned-class', sessionStudents: classStudents, overrideStudentIds: ['a'], selectionLoss: lost }).targetStudentIds,
    ['a'],
    'a frozen dialog list or tile names its students and is unaffected',
  );
  assert.deepEqual(
    resolveCommandTargets({ mode: 'claimed-coverage', claimedStudents: claimedRows, overrideStudentIds: ['b'], selectionLoss: lost }).targetStudentIds,
    ['b'],
  );
  assert.deepEqual(resolveCommandTargets({ mode: 'owned-class', sessionStudents: classStudents, selectionLoss: null }).targetStudentIds, ['a', 'b']);
  assert.deepEqual(
    resolveCommandTargets({ mode: 'owned-class', sessionStudents: classStudents, selectionLoss: { lostIds: [], count: 0 } }).targetStudentIds,
    ['a', 'b'],
    'once the teacher chooses whole class the fallback is allowed again',
  );

  // A dialog that does not open explains the loss without claiming a send.
  assert.equal(
    recipientDialogRefusalMessage(classRefusal, { blockedNames: ['Ada Student'] }),
    'Your selection was cleared because 1 selected student stopped reporting. Choose students again, or use the whole class.',
  );
  assert.equal(
    recipientDialogRefusalMessage(groupRefusal),
    'Your selection was cleared because 1 selected student stopped reporting. Choose students again, or use the whole group.',
  );
});

test('only the controls of a running tool keep the audience the server froze', () => {
  for (const [commandType, commandPayload, serverDerived] of [
    ['poll', { action: 'close', pollId: 'poll-1' }, true],
    ['poll', { action: 'start', question: 'Ready?' }, false],
    ['poll', {}, false],
    ['attention-mode', { active: false }, true],
    ['attention-mode', { active: true, message: 'Eyes up' }, false],
    ['timer', { action: 'stop' }, true],
    ['timer', { action: 'pause' }, true],
    ['timer', { action: 'resume' }, true],
    ['timer', { action: 'extend', seconds: 60 }, true],
    ['timer', { action: 'start', seconds: 60 }, false],
    ['lesson-activity', { action: 'update' }, true],
    ['lesson-activity', { action: 'end' }, true],
    ['lesson-activity', { action: 'start', title: 'Work' }, false],
    ['teacher-message', { message: 'Hi' }, false],
    ['apply-flight-path', { flightPathId: 'fp-1' }, false],
    ['remove-flight-path', {}, false],
    ['close-tabs', { closeAll: true }, false],
  ]) {
    assert.equal(commandAudienceIsServerDerived(commandType, commandPayload), serverDerived, `${commandType} ${JSON.stringify(commandPayload)}`);
  }
  assert.equal(commandAudienceIsServerDerived('poll'), false);
});

test('the shared last-name comparator is the Dashboard grid rule', () => {
  // The rule the grid has always used inline: last word, lower-cased, localeCompare.
  const gridLastName = (fullName) => {
    if (!fullName) return '';
    const nameParts = fullName.trim().split(/\s+/);
    if (nameParts.length === 1) return nameParts[0].toLowerCase();
    return nameParts[nameParts.length - 1].toLowerCase();
  };
  const names = ['Ada Student', 'ben  zed', 'Cher', '  ', '', undefined, 'Dee de la Cruz', 'Émile Zola', 'zoe adams', 'Ann Student'];
  for (const left of names) {
    assert.equal(studentLastName(left), gridLastName(left));
    for (const right of names) {
      assert.equal(
        Math.sign(compareStudentsByLastName({ studentName: left }, { studentName: right })),
        Math.sign(gridLastName(left).localeCompare(gridLastName(right))),
        `${JSON.stringify(left)} vs ${JSON.stringify(right)}`,
      );
    }
  }
  const sorted = [{ studentName: 'Ben Student', id: 1 }, { studentName: 'zoe adams', id: 2 }, { studentName: 'Ada Student', id: 3 }]
    .sort(compareStudentsByLastName);
  assert.deepEqual(sorted.map((row) => row.id), [2, 1, 3], 'equal last names keep their incoming order');
});

test('the Class tools footer names who new actions reach, with a singular for one student', () => {
  assert.equal(classToolsRecipientLabel({ selectedCount: 1, subgroupSelected: true, subgroupMemberCount: 4, classCount: 20 }), '1 selected student', 'ticks win');
  assert.equal(classToolsRecipientLabel({ selectedCount: 3 }), '3 selected students');
  assert.equal(classToolsRecipientLabel({ subgroupSelected: true, subgroupMemberCount: 1, classCount: 20 }), '1 student in selected group');
  assert.equal(classToolsRecipientLabel({ subgroupSelected: true, subgroupMemberCount: 4 }), '4 students in selected group');
  assert.equal(classToolsRecipientLabel({ classCount: 20 }), 'all 20 students');
  assert.equal(classToolsRecipientLabel({ classCount: 1 }), '1 student');
  assert.equal(classToolsRecipientLabel({ classCount: 0 }), 'no students');
  assert.equal(classToolsRecipientLabel(), 'no students');
});

test('while a cleared selection stands, the Class tools footer never names the group or class it refuses', () => {
  const lost = 'no one until you choose students again';
  assert.equal(classToolsRecipientLabel({ selectionLost: true, classCount: 20 }), lost);
  assert.equal(classToolsRecipientLabel({ selectionLost: true, subgroupSelected: true, subgroupMemberCount: 4, classCount: 20 }), lost);
  assert.equal(classToolsRecipientLabel({ selectionLost: true, selectedCount: 2, classCount: 20 }), '2 selected students', 'new ticks are an explicit target again');
  assert.equal(classToolsRecipientLabel({ selectionLost: 'yes', classCount: 20 }), 'all 20 students', 'only a real loss narrows the label');
  // The Dashboard passes exactly the guard the command resolver applies.
  const loss = recordSelectionLoss(null, { previousIds: ['ada'], keptIds: [], scopeKey: 'scope', reason: 'stopped-reporting' });
  assert.equal(classToolsRecipientLabel({ selectionLost: selectionLossBlocksFallback(loss, new Set()), classCount: 20 }), lost);
  assert.equal(classToolsRecipientLabel({ selectionLost: selectionLossBlocksFallback(loss, new Set(['ben'])), selectedCount: 1, classCount: 20 }), '1 selected student');
});

test('while students are ticked for sign-out only, the Class tools footer names no one, as every new action is refused', () => {
  const blocked = 'no one until you clear the sign-out-only selection';
  assert.equal(classToolsRecipientLabel({ signOutOnlyCount: 1, classCount: 20 }), blocked, 'never the class');
  assert.equal(classToolsRecipientLabel({ signOutOnlyCount: 2, subgroupSelected: true, subgroupMemberCount: 4, classCount: 20 }), blocked, 'never the group');
  assert.equal(classToolsRecipientLabel({ signOutOnlyCount: 1, selectedCount: 3, classCount: 20 }), blocked, 'never the other ticks');
  assert.equal(classToolsRecipientLabel({ signOutOnlyCount: 1, selectionLost: true, classCount: 20 }), blocked, 'whatever was lost');
  assert.equal(classToolsRecipientLabel({ signOutOnlyCount: 0, selectionLost: true, classCount: 20 }), 'no one until you choose students again');
  assert.equal(classToolsRecipientLabel({ signOutOnlyCount: -1, classCount: 20 }), 'all 20 students', 'only a count changes the label');
  // The refusal those new actions meet, and the Target badge's wording.
  assert.throws(() => assertClassroomCommandSelectionIsolation('teacher-message', 1), /clear the sign-out-only selection/i);
  assert.doesNotThrow(() => assertClassroomCommandSelectionIsolation('student-sign-out', 1));
  assert.equal(signOutOnlySelectionLabel(1), '1 selected for sign-out only');
  assert.equal(signOutOnlySelectionLabel(3), '3 selected for sign-out only');
});
