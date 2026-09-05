// A denied read is scoped to authority, not to a query's error state. Privacy
// scrubs legitimately write successful empty data into that same query cache.
export function classpilotSessionAuthorityKey({ schoolId, viewerId, session }) {
  return JSON.stringify([
    schoolId || '', viewerId || '', session?.id || '',
    session?.sessionMode || '', session?.endTime || '',
    session?.rosterSnapshotCompletedAt || '',
  ]);
}

export function classpilotObservationSessionEligible(session) {
  return Boolean(session?.id && session.sessionMode === 'live'
    && !session.endTime && session.rosterSnapshotCompletedAt);
}

export function isClasspilotSessionUnavailable(error, sessionId) {
  if (!sessionId || Number(error?.response?.status) !== 404) return false;
  const code = error?.response?.data?.code;
  return !code || code === 'CLASSPILOT_SESSION_UNAVAILABLE';
}

export function tileStudentReadAuthorityKey(contextKey, student) {
  const supervision = student?.supervisionContext;
  return JSON.stringify([
    contextKey, student?.studentId || '', student?.realtimeBinding || '',
    student?.classroomState?.revision ?? student?.classroomStateRevision ?? null,
    student?.isLoggedIn ?? null, student?.loginState || '',
    student?.contextId || '', student?.supervisionState || '',
    supervision?.type || supervision?.kind || '', supervision?.id || '',
    supervision?.assignedStaffId || '',
  ]);
}

export function tileReadAuthorityMap(contextKey, students) {
  return new Map((students || []).map((student) => [
    student.studentId, tileStudentReadAuthorityKey(contextKey, student),
  ]));
}

export function deniedTileStudentIds(denials, kind, authorities) {
  const denied = new Set();
  for (const [studentId, authority] of authorities) {
    if (denials.has(`${kind}:${authority}`)) denied.add(studentId);
  }
  return denied;
}

export function recordTileReadDenial(denials, kind, authorities, studentIds) {
  let changed = false;
  for (const studentId of studentIds) {
    const authority = authorities.get(studentId);
    if (!authority) continue;
    const key = `${kind}:${authority}`;
    if (!denials.has(key)) {
      denials.add(key);
      changed = true;
    }
  }
  return changed;
}

export function clearTileReadDenials(denials, kind, authorities) {
  for (const authority of authorities.values()) denials.delete(`${kind}:${authority}`);
}

export function tileRequestWithoutDeniedStudents(request, denials, authorities) {
  const denied = deniedTileStudentIds(denials, request.kind, authorities);
  const studentIds = request.body.studentIds.filter((id) => !denied.has(id));
  return studentIds.length === request.body.studentIds.length
    ? request
    : { ...request, body: { ...request.body, studentIds } };
}

export function unavailableClassCapabilities(capabilities, unavailable) {
  if (!unavailable) return capabilities;
  return {
    ...capabilities,
    mode: 'read-only', ownedClassSession: false,
    canSelectStudents: false, canUseRemoteControls: false,
    canUseTeacherFab: false, canUseLiveView: false, canChangeFabSettings: false,
    allowedCommands: new Set(), allows: () => false,
    reason: 'This class session is no longer available. Refresh the class before sending commands.',
  };
}

// Focus, pageshow, online and visibility commonly arrive together. Share one
// request. Do not suppress a later event after completion: a real sign-in or
// supervision transition can occur immediately after the preceding response.
export function createCoalescedClasspilotRefresh() {
  const entries = new Map();
  return (key, refresh) => {
    const previous = entries.get(key);
    if (previous) return previous;
    const pending = Promise.resolve().then(refresh).finally(() => {
      if (entries.get(key) === pending) entries.delete(key);
    });
    entries.set(key, pending);
    return pending;
  };
}
