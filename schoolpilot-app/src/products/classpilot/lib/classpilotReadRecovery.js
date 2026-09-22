// A denied read is scoped to authority, not to a query's error state. Privacy
// scrubs legitimately write successful empty data into that same query cache.
export function classpilotSessionAuthorityKey({ schoolId, viewerId, session }) {
  return JSON.stringify([
    schoolId || '', viewerId || '', session?.id || '',
    session?.authority?.supervisionContextId || '',
    session?.contextAuthorityRevision ?? '',
    session?.sessionMode || '', session?.endTime || '',
    session?.rosterSnapshotCompletedAt || '',
  ]);
}

export function classpilotSessionSubscriptionEligible(session) {
  if (session?.authority?.supervisionContextId) return session.status === 'active';
  return Boolean(session?.id && session.sessionMode === 'live'
    && !session.endTime && session.rosterSnapshotCompletedAt);
}

export function classpilotObservationSessionEligible(session) {
  return classpilotSessionSubscriptionEligible(session)
    && (!session?.authority?.supervisionContextId || session.capabilities?.screenshots === true);
}

// Navigation summaries are hints only. The personal claimed roster carries
// the current authority revision used by leases and screenshot reads.
export function claimedPreviewContextsFromRoster(contexts, students) {
  const revisions = new Map();
  for (const student of students || []) {
    const id = student.contextId || student.supervisionContext?.id;
    if (!id) continue;
    const value = student.contextAuthorityRevision;
    const revision = value != null && /^(0|[1-9]\d*)$/.test(String(value))
      && Number.isSafeInteger(Number(value)) ? String(value) : null;
    if (!revisions.has(id)) revisions.set(id, revision);
    else if (revisions.get(id) !== revision) revisions.set(id, null);
  }
  return (contexts || []).flatMap(context => {
    const revision = revisions.get(context.id);
    return revision == null ? [] : [{ ...context, contextAuthorityRevision: revision }];
  });
}

export function isClasspilotSessionUnavailable(error, sessionId) {
  if (!sessionId || Number(error?.response?.status) !== 404) return false;
  const code = error?.response?.data?.code;
  return !code || code === 'CLASSPILOT_SESSION_UNAVAILABLE' || code === 'CLASSROOM_ACTIVITY_UNAVAILABLE';
}

export function tileStudentReadAuthorityKey(contextKey, student) {
  const supervision = student?.supervisionContext;
  return JSON.stringify([
    contextKey, student?.studentId || '', student?.realtimeBinding || '',
    student?.classroomState?.revision ?? student?.classroomStateRevision ?? null,
    student?.isLoggedIn ?? null, student?.loginState || '',
    student?.contextId || '', student?.supervisionState || '',
    supervision?.type || supervision?.kind || '', supervision?.id || '',
    supervision?.assignedStaffId || '', student?.contextAuthorityRevision ?? null,
  ]);
}

export function tileReadAuthorityMap(contextKey, students) {
  return new Map((students || []).map((student) => [
    student.studentId, tileStudentReadAuthorityKey(contextKey, student),
  ]));
}

// Absence of telemetry is not absence of authentication. Keep unknown and
// reconnecting rows eligible; only explicit current privacy state excludes them.
export function isStudentScreenshotReadEligible(student, monitoringSuppressed = false) {
  return !monitoringSuppressed
    && student?.loginState !== 'not_logged_in'
    && student?.isLoggedIn !== false
    && student?._realtimeSignedOut !== true
    && student?.activityState !== 'delegated'
    && student?._realtimeSuppressed !== true;
}

export function isCurrentScreenshotRead(snapshot, current) {
  return Boolean(snapshot?.enabled && current?.enabled
    && snapshot.fenceKey === current.fenceKey
    && snapshot.fenceGeneration === current.fenceGeneration);
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

export function retireChangedTileReadDenials(denials, kind, previous, current) {
  let changed = false;
  for (const [studentId, authority] of previous) {
    if (current.has(studentId) && current.get(studentId) !== authority) {
      changed = denials.delete(`${kind}:${authority}`) || changed;
    }
  }
  return changed;
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
