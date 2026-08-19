const CLASS_COMMANDS = Object.freeze([
  'open-tab',
  'close-tabs',
  'lock-screen',
  'unlock-screen',
  'apply-flight-path',
  'remove-flight-path',
  'apply-block-list',
  'remove-block-list',
  'attention-mode',
  'timer',
  'poll',
  'teacher-message',
  'student-sign-out',
  'temp-unblock',
  'limit-tabs',
]);

export const DEFAULT_COVERAGE_COMMANDS = Object.freeze([
  'open-tab',
  'close-tabs',
  'lock-screen',
  'unlock-screen',
  'teacher-message',
  'apply-flight-path',
  'apply-block-list',
]);

function normalizedIds(values) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function studentId(row) {
  return String(row?.studentId || row?.id || '').trim();
}

export function studentSupportsCapability(student, capabilityName) {
  if (!student || !capabilityName) return false;
  if (student.capabilities?.[capabilityName] === true) return true;
  const advertised = Array.isArray(student.extensionCapabilities)
    ? student.extensionCapabilities
    : Array.isArray(student.capabilities)
      ? student.capabilities
      : [];
  return advertised.includes(capabilityName);
}

export function studentTileScreenToggleCommand(student) {
  const targetStudentId = studentId(student);
  if (!targetStudentId) return null;
  if (student.screenLocked) {
    if (!studentSupportsCapability(student, 'screenOnlyUnlockV1')) return null;
    return {
      commandType: 'unlock-screen',
      commandPayload: { screenOnly: true },
      studentIds: [targetStudentId],
    };
  }
  return {
    commandType: 'lock-screen',
    commandPayload: { url: 'CURRENT_URL' },
    studentIds: [targetStudentId],
  };
}

export function studentTileFlightPathReleaseCommand(student) {
  const targetStudentId = studentId(student);
  return targetStudentId ? {
    commandType: 'remove-flight-path',
    commandPayload: {},
    studentIds: [targetStudentId],
  } : null;
}

function studentRowsByIds(rows, ids) {
  const wanted = new Set(normalizedIds(ids));
  return (rows || []).filter((row) => wanted.has(studentId(row)));
}

export function deriveDashboardCapabilities({
  studentView,
  isTeacher,
  isAdmin,
  currentUserId,
  activeSession,
  observedSession,
  coverageCommandTypes = DEFAULT_COVERAGE_COMMANDS,
}) {
  const observedOtherClass = Boolean(
    isAdmin
    && observedSession
    && String(observedSession.teacherId || '') !== String(currentUserId || ''),
  );
  const effectiveSession = isAdmin ? (observedSession || activeSession) : activeSession;
  const ownedClassSession = Boolean(
    studentView === 'class'
    && effectiveSession?.id
    && !observedOtherClass
    && (
      isTeacher
      || (
        isAdmin
        && (
          String(effectiveSession.teacherId || '') === String(currentUserId || '')
          || String(effectiveSession.id) === String(activeSession?.id || '')
        )
      )
    ),
  );
  const claimedCoverage = studentView === 'claimed' && !observedOtherClass;
  const allowedCommands = new Set(
    ownedClassSession
      ? CLASS_COMMANDS
      : claimedCoverage
        ? coverageCommandTypes
        : [],
  );

  return {
    mode: observedOtherClass
      ? 'observe-read-only'
      : ownedClassSession
        ? 'owned-class'
        : claimedCoverage
          ? 'claimed-coverage'
          : studentView === 'available'
            ? 'available'
            : 'read-only',
    effectiveSession,
    observedOtherClass,
    ownedClassSession,
    claimedCoverage,
    canSelectStudents: ownedClassSession || claimedCoverage,
    canUseRemoteControls: allowedCommands.size > 0,
    canUseTeacherFab: ownedClassSession,
    canUseLiveView: ownedClassSession,
    canChangeFabSettings: ownedClassSession,
    allowedCommands,
    allows(commandType) {
      return allowedCommands.has(commandType);
    },
    reason: observedOtherClass
      ? 'Observe mode is read-only. Return to your own class to control student devices.'
      : studentView === 'available'
        ? 'Claim students before sending classroom commands.'
        : !effectiveSession?.id && !claimedCoverage
          ? 'Start a class before sending classroom commands.'
          : '',
  };
}

export function resolveCommandTargets({
  mode,
  sessionStudents = [],
  claimedStudents = [],
  selectedStudentIds = [],
  selectedSubgroupId = null,
  subgroupStudentIds = [],
  overrideStudentIds = null,
}) {
  if (mode !== 'owned-class' && mode !== 'claimed-coverage') {
    throw new Error('Classroom commands are not available in this view.');
  }

  const overrideIds = overrideStudentIds === null ? null : normalizedIds(overrideStudentIds);
  const selectedIds = normalizedIds(selectedStudentIds);

  if (mode === 'owned-class') {
    const cohort = (sessionStudents || []).filter((student) => student?.commandable !== false);
    let rows;
    let targetScope = 'class';
    let subgroupId;

    if (overrideIds !== null) {
      if (overrideIds.length === 0) throw new Error('Select at least one student.');
      rows = studentRowsByIds(cohort, overrideIds);
      targetScope = 'students';
    } else if (selectedIds.length > 0) {
      rows = studentRowsByIds(cohort, selectedIds);
      targetScope = 'students';
    } else if (selectedSubgroupId) {
      rows = studentRowsByIds(cohort, subgroupStudentIds);
      targetScope = 'subgroup';
      subgroupId = String(selectedSubgroupId);
    } else {
      rows = cohort;
    }

    const targetStudentIds = normalizedIds(rows.map(studentId));
    if (targetStudentIds.length === 0) throw new Error('No controllable students are in this target.');

    return {
      mode,
      targetScope,
      ...(subgroupId ? { subgroupId } : {}),
      targetStudentIds,
      targetStudents: rows,
      groups: [{ kind: 'class', id: null, targetStudentIds }],
      targetCount: targetStudentIds.length,
      contextCount: 1,
    };
  }

  const cohort = claimedStudents || [];
  const rows = overrideIds !== null
    ? studentRowsByIds(cohort, overrideIds)
    : selectedIds.length > 0
      ? studentRowsByIds(cohort, selectedIds)
      : cohort;
  if (rows.length === 0) throw new Error('Select at least one claimed student.');

  const contextsByStudent = new Map();
  const groups = new Map();
  for (const row of rows) {
    const id = studentId(row);
    const contextId = String(row?.contextId || row?.supervisionContext?.id || '').trim();
    if (!id || !contextId) throw new Error('A selected student is missing a claimed supervision context.');
    const previousContext = contextsByStudent.get(id);
    if (previousContext && previousContext !== contextId) {
      throw new Error('A selected student belongs to conflicting supervision contexts. Refresh and try again.');
    }
    contextsByStudent.set(id, contextId);
    const group = groups.get(contextId) || new Set();
    group.add(id);
    groups.set(contextId, group);
  }

  const targetStudentIds = [...contextsByStudent.keys()];
  return {
    mode,
    targetScope: 'students',
    targetStudentIds,
    targetStudents: rows.filter((row, index, all) => (
      all.findIndex((candidate) => studentId(candidate) === studentId(row)) === index
    )),
    groups: [...groups.entries()].map(([id, ids]) => ({
      kind: 'coverage',
      id,
      targetStudentIds: [...ids],
    })),
    targetCount: targetStudentIds.length,
    contextCount: groups.size,
  };
}

function errorMessage(reason) {
  return reason?.response?.data?.error || reason?.data?.error || reason?.message || 'Command request failed';
}

export function combineCommandSettlements(settlements, targetGroups, commandType) {
  const results = [];
  const targets = [];
  const commands = [];
  const summaryKeys = [
    'requested',
    'attempted',
    'acknowledged',
    'completed',
    'pending',
    'expired',
    'failed',
    'unavailable',
    'sent',
    'received',
    'awaitingAck',
  ];
  const summary = Object.fromEntries(summaryKeys.map((key) => [key, 0]));

  settlements.forEach((settlement, index) => {
    const group = targetGroups[index];
    if (settlement.status === 'fulfilled') {
      const value = settlement.value || {};
      results.push(value);
      if (value.command) commands.push(value.command);
      targets.push(...(value.command?.targets || value.targets || []).map((target) => ({
        ...target,
        ...(value.command?.id ? { commandId: value.command.id } : {}),
      })));
      for (const key of summaryKeys) summary[key] += Number(value.summary?.[key] || 0);
      return;
    }

    const message = errorMessage(settlement.reason);
    const failedTargets = group.targetStudentIds.map((targetStudentId) => ({
      studentId: targetStudentId,
      status: 'failed',
      error: message,
      errorCode: settlement.reason?.response?.data?.code || settlement.reason?.code || 'CONTEXT_REQUEST_FAILED',
      supervisionContextId: group.id,
    }));
    targets.push(...failedTargets);
    summary.requested += failedTargets.length;
    summary.failed += failedTargets.length;
    results.push({
      error: message,
      contextId: group.id,
      command: { commandType, targets: failedTargets },
      summary: { requested: failedTargets.length, failed: failedTargets.length },
    });
  });

  if (summary.requested === 0) summary.requested = targets.length;
  return {
    partial: settlements.some((entry) => entry.status === 'fulfilled')
      && settlements.some((entry) => entry.status === 'rejected'),
    results,
    commands,
    command: {
      id: commands.length === 1 ? commands[0].id : undefined,
      commandType,
      deliveryPolicy: commands[0]?.deliveryPolicy,
      expiresAt: commands.map((command) => command?.expiresAt).filter(Boolean).sort()[0],
      targets,
    },
    summary,
  };
}

function summaryFromTargets(targets) {
  const summary = {
    requested: targets.length,
    attempted: 0,
    acknowledged: 0,
    completed: 0,
    pending: 0,
    expired: 0,
    failed: 0,
    unavailable: 0,
    sent: 0,
    received: 0,
    awaitingAck: 0,
  };
  for (const target of targets) {
    const status = String(target.status || 'requested');
    if (Object.hasOwn(summary, status)) summary[status] += 1;
    if (!['requested', 'unavailable'].includes(status)) summary.attempted += 1;
    if (status === 'received' || status === 'completed') summary.acknowledged += 1;
    if (status === 'sent' || status === 'pending') summary.awaitingAck += 1;
  }
  return summary;
}

export function mergeCommandUpdateIntoBatches(batches, message) {
  const command = message?.command || {};
  const commandId = String(message?.commandId || command.id || '').trim();
  if (!commandId) return batches;

  let changed = false;
  const next = (batches || []).map((batch) => {
    const batchTargets = batch?.command?.targets || batch?.targets || [];
    const batchCommandIds = new Set([
      batch?.command?.id,
      ...(batch?.commands || []).map((entry) => entry?.id),
      ...batchTargets.map((target) => target?.commandId),
    ].filter(Boolean).map(String));
    if (!batchCommandIds.has(commandId)) return batch;

    const updates = new Map((command.targets || message.targets || []).map((target) => [
      String(target.studentId || ''),
      { ...target, commandId },
    ]));
    const targets = batchTargets.map((target) => (
      String(target.commandId || batch?.command?.id || '') === commandId
      && updates.has(String(target.studentId || ''))
        ? { ...target, ...updates.get(String(target.studentId || '')) }
        : target
    ));
    changed = true;
    return {
      ...batch,
      command: {
        ...batch.command,
        ...(batch.command?.id === commandId ? command : {}),
        targets,
      },
      summary: summaryFromTargets(targets),
      updatedAt: new Date().toISOString(),
    };
  });
  return changed ? next : batches;
}

export function tabSelectionKey(tab) {
  const student = String(tab?.studentId || '').trim();
  const tabRef = String(tab?.tabRef || '').trim();
  const observedRevision = Number(tab?.observedRevision ?? tab?.snapshotRevision);
  if (!student || !tabRef || !Number.isSafeInteger(observedRevision) || observedRevision <= 0) return null;
  return JSON.stringify({ studentId: student, tabRef, observedRevision });
}

export function parseTabSelectionKey(key) {
  try {
    const value = JSON.parse(key);
    const normalized = tabSelectionKey(value);
    return normalized ? JSON.parse(normalized) : null;
  } catch {
    return null;
  }
}

export function exactTabCloseCapability(tab) {
  const key = tabSelectionKey(tab);
  if (!key) {
    return {
      enabled: false,
      reason: 'This tab was reported by an older extension. Update the student extension to close it individually.',
    };
  }
  if (!studentSupportsCapability(tab, 'exactTabCloseV1')) {
    return {
      enabled: false,
      reason: 'Extension update required for exact tab closing.',
    };
  }
  return { enabled: true, reason: '' };
}

export function flightPathApplyCapability(flightPath) {
  const allowedDomains = Array.isArray(flightPath?.allowedDomains)
    ? flightPath.allowedDomains.filter((domain) => String(domain || '').trim().length > 0)
    : [];
  if (allowedDomains.length === 0) {
    return {
      enabled: false,
      reason: 'Add at least one allowed domain before applying this Flight Path.',
    };
  }
  return { enabled: true, reason: '' };
}

export function studentSignOutCommandPayload() {
  // The server owns the canonical sign-out reason. Keeping this payload empty
  // makes the teacher UI match the strict command boundary.
  return {};
}

export function normalizeSessionFabState(value, teachingSessionId) {
  const sessionId = String(teachingSessionId || '').trim();
  const stateSessionId = String(value?.teachingSessionId || value?.activeSessionId || '').trim();
  if (!sessionId || stateSessionId !== sessionId) return null;
  const revisionValue = Number(value?.revision ?? value?.lifecycleRevision ?? value?.sessionFabRevision);
  return {
    teachingSessionId: sessionId,
    handRaisingEnabled: value?.handRaisingEnabled !== false,
    messagingEnabled: (value?.messagingEnabled ?? value?.studentMessagingEnabled) !== false,
    revision: Number.isSafeInteger(revisionValue) && revisionValue >= 0 ? revisionValue : 0,
  };
}

export function sessionFabSettingsPayload(state, patch) {
  if (!state || !Number.isSafeInteger(state.revision) || state.revision < 0) {
    throw new Error('Authoritative session FAB settings are still loading.');
  }
  return { ...patch, expectedRevision: state.revision };
}
