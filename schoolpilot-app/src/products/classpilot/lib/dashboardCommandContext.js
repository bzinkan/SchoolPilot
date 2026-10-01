import { isUrlAllowed } from '../../../lib/classpilot-utils.js';
import { activityAuthority, activityAuthorityKey } from './dashboardActivity.js';
import { activeFlightPathAllowedDomains } from './teachingResourceLibrary.js';
import { isUrlAllowedByStudentPreciseRestrictions } from './restrictionResourceMatcher.js';
import { compareStudentsByLastName } from './studentOrder.js';

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
  'lesson-activity',
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
  'remove-flight-path',
  'apply-block-list',
  'remove-block-list',
]);

export const LATE_SIGN_IN_RESTRICTION_COMMANDS = Object.freeze([
  'lock-screen',
  'unlock-screen',
  'apply-flight-path',
  'remove-flight-path',
  'apply-block-list',
  'remove-block-list',
]);

const LATE_SIGN_IN_RESTRICTION_COMMAND_SET = new Set(LATE_SIGN_IN_RESTRICTION_COMMANDS);

function normalizedIds(values) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function studentId(row) {
  return String(row?.studentId || row?.id || '').trim();
}

export function uniqueStudentsById(students) {
  const unique = new Map();
  for (const student of Array.isArray(students) ? students : []) {
    const id = studentId(student);
    if (id && !unique.has(id)) unique.set(id, student);
  }
  return [...unique.values()];
}

export function effectiveStudentRestrictions(student) {
  const snapshot = student?.classroomState?.restrictions;
  const snapshotScreenLock = snapshot?.screenLock;
  const snapshotFlightPath = snapshot?.flightPath;
  const snapshotBlockList = snapshot?.blockList;
  const hasSnapshotScreenLock = typeof snapshotScreenLock?.active === 'boolean';
  const hasSnapshotFlightPath = typeof snapshotFlightPath?.active === 'boolean';
  const hasSnapshotBlockList = typeof snapshotBlockList?.active === 'boolean';

  return {
    screenLockActive: hasSnapshotScreenLock
      ? snapshotScreenLock.active
      : student?.screenLocked === true,
    flightPathActive: hasSnapshotFlightPath
      ? snapshotFlightPath.active
      : student?.flightPathActive === true,
    flightPathName: hasSnapshotFlightPath && snapshotFlightPath.active
      ? String(snapshotFlightPath.name || student?.activeFlightPathName || '').trim()
      : String(student?.activeFlightPathName || '').trim(),
    blockListActive: hasSnapshotBlockList
      ? snapshotBlockList.active
      : student?.blockListActive === true,
    blockListName: hasSnapshotBlockList && snapshotBlockList.active
      ? String(snapshotBlockList.name || student?.activeBlockListName || '').trim()
      : String(student?.activeBlockListName || '').trim(),
  };
}

function boundedContextValue(value, maxLength = 256) {
  const normalized = String(value || '').trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

export function studentSignOutSelectionBinding({
  schoolId,
  viewerId,
  mode,
  teachingSessionId,
  supervisionContextId,
  student,
}) {
  const normalizedStudentId = boundedContextValue(studentId(student));
  const realtimeBinding = boundedContextValue(student?.realtimeBinding, 128);
  const context = {
    schoolId: boundedContextValue(schoolId),
    viewerId: boundedContextValue(viewerId),
    mode: boundedContextValue(mode, 64),
    teachingSessionId: boundedContextValue(teachingSessionId),
    ...(supervisionContextId ? { supervisionContextId: boundedContextValue(supervisionContextId) } : {}),
  };
  if (
    !normalizedStudentId
    || !realtimeBinding
    || !context.schoolId
    || !context.viewerId
    || !['owned-class', 'scheduled-supervision'].includes(context.mode)
    || !activityAuthority(context)
  ) return null;

  return JSON.stringify({
    ...context,
    studentId: normalizedStudentId,
    realtimeBinding,
  });
}

export function assertClassroomCommandSelectionIsolation(commandType, signOutOnlySelectionCount) {
  const count = Number(signOutOnlySelectionCount);
  if (commandType !== 'student-sign-out' && Number.isSafeInteger(count) && count > 0) {
    throw new Error('Clear the sign-out-only selection before using other ClassPilot controls.');
  }
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

export function studentSupportsScheduledClassroom(student) {
  // Full classroom tools need the accepted protocol, not a raw extension claim.
  // The server sends acceptedCapabilities as an object of booleans (it is the
  // same shape studentMonitoringDisplay reads for the capture cadence), so that
  // is the form that must be honoured here. The array form is kept for callers
  // that pass a bare negotiated list.
  return ['scheduledClassroomV1', 'scopedAuthorityChecksV1'].every(capability => (
    student?.capabilities?.[capability] === true
    || student?.acceptedCapabilities?.[capability] === true
    || Array.isArray(student?.acceptedCapabilities) && student.acceptedCapabilities.includes(capability)
  ));
}

export function isExplicitlySignedOutStudent(student) {
  return student?.loginState === 'not_logged_in'
    || student?.isLoggedIn === false
    || student?._realtimeSignedOut === true;
}

export function lateSignInRestrictionGateEnabled(students) {
  const rows = Array.isArray(students) ? students : [];
  return rows.length > 0 && rows.every((student) => (
    student?.lateSignInRestrictionSsoV1Enabled === true
  ));
}

export function commandSupportsLateSignInRestriction(commandType, commandPayload = {}) {
  if (!LATE_SIGN_IN_RESTRICTION_COMMAND_SET.has(commandType)) return false;
  return commandType !== 'lock-screen' || commandPayload?.url !== 'CURRENT_URL';
}

export function isLateSignInRestrictionTarget({
  student,
  operatorEnabled,
  structurallyCommandable,
}) {
  return operatorEnabled === true
    && structurallyCommandable === true
    && isExplicitlySignedOutStudent(student);
}

export function coverageStudentCommandSelectionEligible({
  student,
  monitoringDisplay,
  structurallyCommandable,
}) {
  if (structurallyCommandable !== true) return false;
  if (monitoringDisplay?.telemetryCurrent === true) return true;
  const operatorEnabled = student?.operatorCapabilities?.lateSignInRestrictionSsoV1 === true
    && student?.lateSignInRestrictionSsoV1Enabled === true;
  return isLateSignInRestrictionTarget({
    student,
    operatorEnabled,
    structurallyCommandable,
  });
}

export function partitionCurrentPageWaypointTargets(
  students,
  isTelemetryCurrent = defaultStudentTelemetryCurrent,
) {
  const targetStudentIds = [];
  const skippedStudentIds = [];
  for (const student of Array.isArray(students) ? students : []) {
    const id = studentId(student);
    if (!id) continue;
    if (isTelemetryCurrent(student) === true) targetStudentIds.push(id);
    else skippedStudentIds.push(id);
  }
  return { targetStudentIds, skippedStudentIds };
}

export function partitionCoverageCurrentPageWaypointTargets(students) {
  const targetStudentIds = [];
  const skippedStudentIds = [];
  for (const student of Array.isArray(students) ? students : []) {
    const id = studentId(student);
    if (!id) continue;
    if (isExplicitlySignedOutStudent(student)) skippedStudentIds.push(id);
    else targetStudentIds.push(id);
  }
  return { targetStudentIds, skippedStudentIds };
}

export const DOMAIN_PRESERVING_RESTRICTION_MESSAGE =
  'Students already on the selected site keep their current page; other students go to the landing page.';
export const CONSERVATIVE_DOMAIN_RESTRICTION_MESSAGE =
  'Some selected Chromebooks may reload or move to the landing page when this restriction is applied.';
export const DOMAIN_RESTRICTION_URL_HELP =
  'The full URL is the landing page. Browsing remains allowed on its hostname and subdomains; it is not an exact-page lock.';

function defaultStudentTelemetryCurrent(student) {
  return student?.telemetryCurrent === true;
}

export function domainRestrictionMessageForStudents(
  students,
  isStudentTelemetryCurrent = defaultStudentTelemetryCurrent,
) {
  const targets = Array.isArray(students) ? students : [];
  const allTargetsCanPreserve = targets.length > 0 && targets.every((student) => (
    isStudentTelemetryCurrent(student) === true
    && studentSupportsCapability(student, 'domainPreservingRestrictionsV1')
  ));
  return allTargetsCanPreserve
    ? DOMAIN_PRESERVING_RESTRICTION_MESSAGE
    : CONSERVATIVE_DOMAIN_RESTRICTION_MESSAGE;
}

export function isStudentUrlOffTask({
  student,
  teacherAllowedDomains = [],
  schoolAllowedDomains = [],
  flightPaths = [],
}) {
  const activeTabUrl = String(student?.activeTabUrl || '').trim();
  if (!activeTabUrl) return false;
  try {
    new URL(activeTabUrl);
  } catch {
    return false;
  }

  if (
    teacherAllowedDomains.length > 0
    && isUrlAllowed(activeTabUrl, teacherAllowedDomains)
  ) {
    return false;
  }
  if (schoolAllowedDomains.length > 0 && isUrlAllowed(activeTabUrl, schoolAllowedDomains)) return false;

  if (student?.aiClassification?.category === 'non-educational') {
    // A video, page or document the teacher allowed precisely (Flight Path
    // section/resource or a This-resource-only Waypoint) is on-task.
    if (isUrlAllowedByStudentPreciseRestrictions(activeTabUrl, student)) return false;
    if (student.flightPathActive) {
      // Never matches a School Library item by an ambiguous name.
      const allowedDomains = activeFlightPathAllowedDomains(student, flightPaths);
      if (allowedDomains.length > 0 && isUrlAllowed(activeTabUrl, allowedDomains)) {
        return false;
      }
    }
    return true;
  }

  if (schoolAllowedDomains.length === 0) return false;
  return !isUrlAllowed(activeTabUrl, schoolAllowedDomains);
}

export function toolbarScreenCommand(commandType, selectedStudentIds) {
  const selectedIds = normalizedIds(
    Array.isArray(selectedStudentIds)
      ? selectedStudentIds
      : selectedStudentIds instanceof Set
        ? [...selectedStudentIds]
        : [],
  );
  if (selectedIds.length === 0) return null;

  if (commandType === 'lock-screen') {
    return {
      commandType,
      commandPayload: { url: 'CURRENT_URL' },
      studentIds: selectedIds,
    };
  }
  if (commandType === 'unlock-screen') {
    return {
      commandType,
      commandPayload: { screenOnly: true },
      studentIds: selectedIds,
    };
  }
  return null;
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

export const TEMP_UNBLOCK_DEFAULT_MINUTES = 10;

function normalizedAllowDomain(value) {
  return String(value || '').trim().toLowerCase().replace(/^www\./, '');
}

// Tile-level "Allow 10 min": a persistent, self-expiring allow for exactly one
// student and one domain, dispatched through the same command path as every
// other tile action.
export function studentTileTempUnblockCommand(
  student,
  domain,
  durationMinutes = TEMP_UNBLOCK_DEFAULT_MINUTES,
) {
  const targetStudentId = studentId(student);
  const normalizedDomain = normalizedAllowDomain(domain);
  const minutes = Number(durationMinutes);
  if (!targetStudentId || !normalizedDomain || !Number.isInteger(minutes) || minutes < 1) return null;
  return {
    commandType: 'temp-unblock',
    commandPayload: { domain: normalizedDomain, durationMinutes: minutes },
    studentIds: [targetStudentId],
  };
}

function parsedExpiry(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Unexpired temporary allows from the authoritative classroom snapshot,
// soonest expiry first.
export function activeTemporaryAllows(student, nowMs = Date.now()) {
  const entries = student?.classroomState?.restrictions?.temporaryAllows;
  if (!Array.isArray(entries)) return [];
  const now = Number(nowMs);
  if (!Number.isFinite(now)) return [];
  const active = [];
  for (const entry of entries) {
    const domain = String(entry?.domain || '').trim().toLowerCase();
    const expiresAtMs = parsedExpiry(entry?.expiresAt);
    if (!domain || expiresAtMs === null || expiresAtMs <= now) continue;
    active.push({ domain, expiresAtMs });
  }
  active.sort((left, right) => left.expiresAtMs - right.expiresAtMs || left.domain.localeCompare(right.domain));
  return active;
}

export const TAB_LIMIT_MIN = 1;
export const TAB_LIMIT_MAX = 100;

// The authoritative tab limit lives in the public classroom-state snapshot;
// the open-tab count comes from the latest realtime heartbeat.
export function deriveTabLimitChip(student) {
  const tabLimit = student?.classroomState?.restrictions?.tabLimit;
  if (!Number.isInteger(tabLimit) || tabLimit < 1) return null;
  const reportedCount = student?.openTabCount ?? student?.allOpenTabs?.length ?? 0;
  const openTabCount = Number.isFinite(reportedCount) ? Math.max(0, Math.floor(reportedCount)) : 0;
  return { tabLimit, openTabCount, over: openTabCount > tabLimit };
}

// "" clears the limit; a whole number 1..100 sets it; anything else is invalid.
export function tabLimitCommandPayload(raw) {
  const text = typeof raw === 'number' ? String(raw) : String(raw ?? '').trim();
  if (text === '') return { maxTabs: null };
  if (!/^\d+$/.test(text)) return null;
  const maxTabs = Number(text);
  if (!Number.isInteger(maxTabs) || maxTabs < TAB_LIMIT_MIN || maxTabs > TAB_LIMIT_MAX) return null;
  return { maxTabs };
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
  scheduledActivity = null,
}) {
  const observedOtherClass = Boolean(
    isAdmin
    && observedSession
    && (observedSession.accessMode === 'observe'
      || String(observedSession.teacherId || '') !== String(currentUserId || '')),
  );
  const effectiveSession = isAdmin ? (observedSession || activeSession) : activeSession;
  const scheduledSupervision = Boolean(studentView === 'class' && !observedSession
    && scheduledActivity?.status === 'active' && activityAuthority(scheduledActivity)?.supervisionContextId
    && ['scheduled_testing', 'scheduled_coverage', 'ad_hoc_supervision'].includes(scheduledActivity.source));
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
    scheduledSupervision ? scheduledActivity.capabilities?.commands || [] : ownedClassSession
      ? CLASS_COMMANDS
      : claimedCoverage
        ? coverageCommandTypes
        : [],
  );

  return {
    mode: observedOtherClass
      ? 'observe-read-only'
      : scheduledSupervision ? 'scheduled-supervision' : ownedClassSession
        ? 'owned-class'
        : claimedCoverage
          ? 'claimed-coverage'
          : studentView === 'available'
            ? 'available'
            : 'read-only',
    effectiveSession,
    authority: scheduledSupervision ? activityAuthority(scheduledActivity)
      : activityAuthority(effectiveSession?.authority || { teachingSessionId: effectiveSession?.id }),
    scheduledSupervision,
    observedOtherClass,
    ownedClassSession,
    claimedCoverage,
    canSelectStudents: ownedClassSession || scheduledSupervision || claimedCoverage,
    canUseRemoteControls: allowedCommands.size > 0,
    canUseTeacherFab: scheduledSupervision ? scheduledActivity.capabilities?.fab === true : ownedClassSession,
    canUseLiveView: scheduledSupervision ? scheduledActivity.capabilities?.liveView === true : ownedClassSession,
    canChangeFabSettings: scheduledSupervision ? scheduledActivity.capabilities?.settings === true : ownedClassSession,
    allowedCommands,
    allows(commandType) {
      return allowedCommands.has(commandType);
    },
    reason: observedOtherClass
      ? 'Observe mode is read-only. Return to your own class to control student devices.'
      : studentView === 'available'
        ? 'Claim students before sending classroom commands.'
        : !effectiveSession?.id && !claimedCoverage && !scheduledSupervision
          ? 'Start a class before sending classroom commands.'
          : '',
  };
}

const NO_CONTROLLABLE_TARGET_MESSAGE = 'No controllable students are in this target.';
const NO_CLAIMED_TARGET_MESSAGE = 'Select at least one claimed student.';

export function resolveCommandTargets({
  mode,
  sessionStudents = [],
  claimedStudents = [],
  selectedStudentIds = [],
  selectedSubgroupId = null,
  subgroupStudentIds = [],
  overrideStudentIds = null,
}) {
  if (!['owned-class', 'scheduled-supervision', 'claimed-coverage'].includes(mode)) {
    throw new Error('Classroom commands are not available in this view.');
  }

  const overrideIds = overrideStudentIds === null ? null : normalizedIds(overrideStudentIds);
  const selectedIds = normalizedIds(selectedStudentIds);

  if (mode === 'owned-class' || mode === 'scheduled-supervision') {
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
    if (targetStudentIds.length === 0) throw new Error(NO_CONTROLLABLE_TARGET_MESSAGE);

    if (mode === 'scheduled-supervision') targetScope = 'students';
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
  if (rows.length === 0) throw new Error(NO_CLAIMED_TARGET_MESSAGE);

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

// Classroom dialogs (Send Message, Attention, Timer, Poll, Open URL) freeze
// their recipients when they open. Sending uses exactly those students, minus
// any who can no longer receive the command, as explicit studentIds. A lost or
// emptied list never widens to a subgroup or the whole class.
export const RECIPIENTS_UNAVAILABLE_MESSAGE = "Some selected students can't receive this right now. Nothing was sent.";
export const RECIPIENTS_SCOPE_CHANGED_MESSAGE = 'The class changed after this opened. Nothing was sent. Close it and try again.';
export const RECIPIENTS_MISSING_MESSAGE = 'No recipients are set for this. Nothing was sent. Close it and try again.';

const RECIPIENT_ALERT_NAME_LIMIT = 5;

function studentCountText(count) {
  return `${count} student${count === 1 ? '' : 's'}`;
}

export function recipientSnapshotLabel({ selectedCount = 0, subgroupName = null, view = 'class' } = {}) {
  const selected = Number(selectedCount);
  if (Number.isSafeInteger(selected) && selected > 0) {
    return `${selected} selected student${selected === 1 ? '' : 's'}`;
  }
  const group = String(subgroupName || '').trim();
  if (group) return `Group: ${group}`;
  return view === 'claimed' ? 'All claimed students' : 'Whole class';
}

// Class tools' footer: who a new action from the panel would reach right now,
// by the same precedence as the dialogs (ticks, then the subgroup, then the
// class), with a singular for one student.
export function classToolsRecipientLabel({ selectedCount = 0, subgroupSelected = false, subgroupMemberCount = 0, classCount = 0 } = {}) {
  const count = (value) => {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : 0;
  };
  const selected = count(selectedCount);
  if (selected > 0) return `${selected} selected student${selected === 1 ? '' : 's'}`;
  if (subgroupSelected) return `${studentCountText(count(subgroupMemberCount))} in selected group`;
  const total = count(classCount);
  if (total === 0) return 'no students';
  return total === 1 ? '1 student' : `all ${total} students`;
}

export function snapshotCommandRecipients({ target, students = [], label = '', scopeKey = null, view = null } = {}) {
  const ids = normalizedIds(target?.targetStudentIds);
  if (ids.length === 0) throw new Error('Choose at least one student.');
  const rowsById = new Map();
  for (const row of [
    ...(Array.isArray(students) ? students : []),
    ...(Array.isArray(target?.targetStudents) ? target.targetStudents : []),
  ]) {
    const id = studentId(row);
    if (id && !rowsById.has(id)) rowsById.set(id, row);
  }
  const entries = ids.map((id) => {
    const row = rowsById.get(id);
    const studentName = String(row?.studentName || '').trim();
    return {
      id,
      studentName,
      name: studentName || String(row?.studentEmail || '').trim() || 'Student unavailable',
    };
  }).sort(compareStudentsByLastName);
  return Object.freeze({
    ids: Object.freeze(entries.map((entry) => entry.id)),
    names: Object.freeze(entries.map((entry) => entry.name)),
    label: String(label || '').trim(),
    scopeKey,
    view,
  });
}

export function partitionSnapshotRecipients(snapshot, commandableIds) {
  const available = new Set(normalizedIds(
    commandableIds instanceof Set ? [...commandableIds] : commandableIds,
  ));
  const sendIds = [];
  const unavailableIds = [];
  for (const id of Array.isArray(snapshot?.ids) ? snapshot.ids : []) {
    if (available.has(id)) sendIds.push(id);
    else unavailableIds.push(id);
  }
  return { sendIds, unavailableIds };
}

function sameIdSet(left, right) {
  if (left.length !== right.length) return false;
  const rightIds = new Set(right);
  return left.every((id) => rightIds.has(id));
}

// What Send does with a dialog's frozen recipients, given who can receive the
// command now. It sends only what the dialog shows: the whole frozen list, or,
// on a separate confirmation, exactly the subset its "Send to N available"
// button named. Any other change updates the dialog and sends nothing.
//   { action: 'send', studentIds }
//   { action: 'ask', unavailableIds, confirmIds }  confirmIds is null when no one can receive it
//   { action: 'restored', restoredIds }            everyone left out is back; the next Send includes them
//   { action: 'ignore' }                           the repeat of a gesture that would confirm a partial send
export function planRecipientSend({ snapshot, confirmIds = null, commandableIds = [], repeatGesture = false } = {}) {
  const confirming = Array.isArray(confirmIds) && confirmIds.length > 0;
  if (confirming && repeatGesture) return { action: 'ignore' };
  const { sendIds, unavailableIds } = partitionSnapshotRecipients(snapshot, commandableIds);
  if (confirming && sameIdSet(sendIds, confirmIds)) return { action: 'send', studentIds: sendIds };
  if (sendIds.length === 0 || unavailableIds.length > 0) {
    return { action: 'ask', unavailableIds, confirmIds: sendIds.length > 0 ? sendIds : null };
  }
  if (confirming) {
    const confirmed = new Set(confirmIds);
    return { action: 'restored', restoredIds: sendIds.filter((id) => !confirmed.has(id)) };
  }
  return { action: 'send', studentIds: sendIds };
}

// The frozen names of `ids`, in the snapshot's last-name order.
export function snapshotRecipientNames(snapshot, ids) {
  const wanted = new Set(ids || []);
  const names = Array.isArray(snapshot?.names) ? snapshot.names : [];
  return (Array.isArray(snapshot?.ids) ? snapshot.ids : [])
    .flatMap((id, index) => (wanted.has(id) ? [names[index] || 'Student unavailable'] : []));
}

// A tick label ("2 selected students") already states its count; a group or
// the whole class does not.
function labelStatesCount(label, count) {
  return label.startsWith(`${count} `);
}

export function commandRecipientsHeadline(snapshot) {
  const count = Array.isArray(snapshot?.ids) ? snapshot.ids.length : 0;
  const label = String(snapshot?.label || '').trim();
  if (label && labelStatesCount(label, count)) return `Send to ${label}`;
  return `Send to ${studentCountText(count)}${label ? ` — ${label}` : ''}`;
}

// Who a send was addressed to. It never claims delivery: the toast's own title
// and outcome text report what the devices did.
export function commandRecipientsSummary({ count = 0, frozenCount = count, label = '' } = {}) {
  const trimmed = String(label || '').trim();
  const total = Math.max(count, frozenCount);
  const audience = trimmed && labelStatesCount(trimmed, total)
    ? trimmed
    : `${studentCountText(total)}${trimmed ? ` (${trimmed})` : ''}`;
  return `Recipients: ${count < total ? `${count} of ` : ''}${audience}.`;
}

function recipientNameList(names) {
  const list = (Array.isArray(names) ? names : [])
    .map((name) => String(name || '').trim() || 'Student unavailable');
  if (list.length === 0) return '';
  const shown = list.length > RECIPIENT_ALERT_NAME_LIMIT
    ? [
        ...list.slice(0, RECIPIENT_ALERT_NAME_LIMIT - 1),
        `${list.length - (RECIPIENT_ALERT_NAME_LIMIT - 1)} more students`,
      ]
    : list;
  return new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(shown);
}

// With `availableCount`, the dialog is waiting for "Send to N available", so
// the alert says how to send without the named students.
export function unavailableRecipientsMessage(names, { nothingSent = true, availableCount = 0 } = {}) {
  const subject = recipientNameList(names);
  if (!subject) return nothingSent ? 'Nothing was sent.' : '';
  const next = availableCount > 0
    ? ` Choose "Send to ${availableCount} available" to send without them, or Cancel.`
    : nothingSent ? ' Nothing was sent.' : '';
  return `${subject} can't receive this right now.${next}`;
}

export function recipientsRestoredMessage(names) {
  const subject = recipientNameList(names) || 'Everyone on this list';
  return `${subject} can receive this again. Nothing was sent. Send again to include them.`;
}

// Why a classroom dialog did not open. Nothing was attempted, so it never says
// "Nothing was sent", and it names the ticked students who can't receive it.
export function recipientDialogRefusalMessage(error, { blockedNames = [], view = 'class', subgroupSelected = false } = {}) {
  const message = String(error?.message || '').trim();
  if (![NO_CONTROLLABLE_TARGET_MESSAGE, NO_CLAIMED_TARGET_MESSAGE, RECIPIENTS_UNAVAILABLE_MESSAGE].includes(message)) {
    return message || 'This is not available right now.';
  }
  const blocked = recipientNameList(blockedNames);
  if (blocked) return `${blocked} can't receive this right now. Untick them and try again.`;
  if (message === RECIPIENTS_UNAVAILABLE_MESSAGE) return "Some selected students can't receive this right now. Untick them and try again.";
  if (view === 'claimed') return 'No claimed students can receive this right now.';
  return subgroupSelected
    ? 'No students in this group can receive this right now.'
    : 'No students in this class can receive this right now.';
}

export function resolveStudentSignOutTargets({
  mode,
  sessionStudents = [],
  selectedStudentIds = [],
  selectedStudentBindings = [],
}) {
  if (!['owned-class', 'scheduled-supervision'].includes(mode)) {
    throw new Error('Student sign out is available only for your active class.');
  }

  const selectedIds = normalizedIds(selectedStudentIds);
  if (selectedIds.length === 0) {
    throw new Error('Select at least one student to sign out.');
  }

  const eligibleRowsById = new Map(
    (sessionStudents || [])
      .filter((student) => student?.signOutEligible === true)
      .map((student) => [studentId(student), student])
      .filter(([id]) => id),
  );
  const selectedBindingsById = new Map(
    (selectedStudentBindings || [])
      .map((entry) => [
        boundedContextValue(entry?.studentId),
        boundedContextValue(entry?.bindingSnapshot, 1024),
      ])
      .filter(([id, bindingSnapshot]) => id && bindingSnapshot),
  );
  if (selectedIds.some((id) => !eligibleRowsById.has(id))) {
    throw new Error('One or more selected students can no longer be signed out. Refresh and try again.');
  }
  if (
    selectedBindingsById.size !== selectedIds.length
    || selectedIds.some((id) => (
      selectedBindingsById.get(id) !== eligibleRowsById.get(id)?.signOutBindingSnapshot
    ))
  ) {
    throw new Error('A selected student session changed. Select the student again before signing out.');
  }

  const targetStudents = selectedIds.map((id) => eligibleRowsById.get(id));
  return {
    mode,
    targetScope: 'students',
    targetStudentIds: selectedIds,
    targetStudents,
    groups: [{ kind: 'class', id: null, targetStudentIds: selectedIds }],
    targetCount: selectedIds.length,
    contextCount: 1,
  };
}

export function buildStudentSignOutCommandRequest(teachingSessionId, target) {
  const authority = activityAuthority(teachingSessionId);
  const targetStudentIds = normalizedIds(target?.targetStudentIds);
  if (!authority || target?.targetScope !== 'students' || targetStudentIds.length === 0) {
    throw new Error('Student sign out requires an active class and explicit student targets.');
  }
  return {
    ...authority,
    targetScope: 'students',
    targetStudentIds,
    commandType: 'student-sign-out',
    commandPayload: {},
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
  const protocolVersion = Number(tab?.clientProtocolVersion);
  const requiresV2 = protocolVersion === 3
    || studentSupportsCapability(tab, 'scopedAuthorityChecksV1')
    || studentSupportsCapability(tab, 'exactTabCloseV2');
  const exactCloseCapability = requiresV2 ? 'exactTabCloseV2' : 'exactTabCloseV1';
  if (!studentSupportsCapability(tab, exactCloseCapability)) {
    return {
      enabled: false,
      reason: requiresV2
        ? 'ClassPilot update required for exact tab closing.'
        : 'Extension update required for exact tab closing.',
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
  const authority = activityAuthority(teachingSessionId);
  const stateAuthority = activityAuthority(value?.supervisionContextId ? value
    : { teachingSessionId: value?.teachingSessionId || value?.activeSessionId });
  if (!authority || activityAuthorityKey(stateAuthority) !== activityAuthorityKey(authority)) return null;
  const revisionValue = Number(value?.revision ?? value?.lifecycleRevision ?? value?.sessionFabRevision);
  const chatPaused = value?.chatPaused === true;
  // The hard switch (chatEnabled) is what the teacher toggles; the effective
  // messagingEnabled the server reports is false while paused, so prefer the
  // channel flag whenever the response carries one.
  const messagingEnabled = (value?.chatEnabled ?? value?.messagingChannelEnabled
    ?? value?.messagingEnabled ?? value?.studentMessagingEnabled) !== false;
  const messagesPaused = value?.messagesPaused === true || chatPaused;
  const pauseReason = value?.pauseReason === 'testing' || value?.pauseReason === 'teacher'
    ? value.pauseReason : messagesPaused ? 'teacher' : null;
  return {
    ...authority,
    handRaisingEnabled: (value?.handRaisingEnabled ?? value?.raiseHandEnabled) !== false,
    messagingEnabled,
    chatPaused,
    messagesPaused,
    pauseReason,
    revision: Number.isSafeInteger(revisionValue) && revisionValue >= 0 ? revisionValue : 0,
  };
}

/**
 * Settings routes answer `{ settings, state }`: the stored row (chatEnabled,
 * chatPaused, lifecycleRevision, parent id) and the effective state (a testing
 * pause only exists there). Fold both into one value for normalizeSessionFabState.
 */
export function mergeFabSettingsResponse(data) {
  if (!data || typeof data !== 'object') return null;
  const settings = data.settings && typeof data.settings === 'object' ? data.settings : null;
  const state = data.state && typeof data.state === 'object' ? data.state : null;
  if (!settings && !state) return data;
  return {
    ...(state || {}),
    ...(settings || {}),
    ...(state && 'messagesPaused' in state ? { messagesPaused: state.messagesPaused, pauseReason: state.pauseReason ?? null } : {}),
  };
}

export function sessionFabSettingsPayload(state, patch) {
  if (!state || !Number.isSafeInteger(state.revision) || state.revision < 0) {
    throw new Error('Authoritative session FAB settings are still loading.');
  }
  return { ...patch, expectedRevision: state.revision };
}
