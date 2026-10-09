const SOURCES = new Set(['class', 'scheduled_class', 'scheduled_testing', 'scheduled_coverage', 'ad_hoc_supervision']);

export function activityRequestHeaders(schoolId, contextAuthorityRevision) {
  return { ...(schoolId ? { 'X-School-Id': schoolId } : {}),
    ...(contextAuthorityRevision != null ? { 'X-ClassPilot-Context-Authority-Revision': String(contextAuthorityRevision) } : {}) };
}

// An activity is a displayable assignment. It is never a fabricated teaching
// session: all network requests carry exactly its real parent authority.
export function activityAuthority(value) {
  const candidate = value?.authority || value;
  if (typeof candidate === 'string' && candidate) return { teachingSessionId: candidate };
  const teachingSessionId = candidate?.teachingSessionId;
  const supervisionContextId = candidate?.supervisionContextId;
  if (Boolean(teachingSessionId) === Boolean(supervisionContextId)) return null;
  const key = teachingSessionId ? 'teachingSessionId' : 'supervisionContextId';
  const id = candidate[key];
  return typeof id === 'string' && id.trim() && id.length <= 256 ? { [key]: id } : null;
}

export function activityAuthorityKey(value) {
  const authority = activityAuthority(value);
  return authority ? JSON.stringify(authority) : '';
}

export function activityAuthorityQuery(value, legacySessionKey = false) {
  const authority = activityAuthority(value);
  if (!authority) throw new Error('The classroom assignment is unavailable. Refresh the Dashboard.');
  return new URLSearchParams(legacySessionKey && authority.teachingSessionId
    ? { sessionId: authority.teachingSessionId } : authority).toString();
}

export function activityParentPath(value, suffix) {
  const authority = activityAuthority(value);
  if (!authority) throw new Error('The classroom assignment is unavailable.');
  return authority.supervisionContextId
    ? `/classpilot/supervision-contexts/${encodeURIComponent(authority.supervisionContextId)}/${suffix}`
    : `/classpilot/teaching-sessions/${encodeURIComponent(authority.teachingSessionId)}/${suffix}`;
}

export function activityLegacyBody(value) {
  const authority = activityAuthority(value);
  if (!authority) throw new Error('The classroom assignment is unavailable.');
  return authority.teachingSessionId ? { sessionId: authority.teachingSessionId } : authority;
}

export function activityTransitionKey(current) {
  if (!current) return 'idle';
  return JSON.stringify([current.source, activityAuthorityKey(current), current.startsAt, current.contextAuthorityRevision ?? null]);
}

export function normalizeDashboardActivity(data, schoolId, viewerId, now = Date.now()) {
  if (data?.schoolId !== schoolId || data?.viewerId !== viewerId || data.enabled !== true) return null;
  const current = data.current;
  if (current && (!SOURCES.has(current.source) || !activityAuthority(current) || current.status !== 'active'
    || !Number.isFinite(Date.parse(current.startsAt))
    || !(current.endsAt == null && current.source === 'class') && !Number.isFinite(Date.parse(current.endsAt))
    || !Number.isSafeInteger(current.studentCount) || current.studentCount < 0)) {
    throw new Error('The classroom assignment response is incomplete.');
  }
  const endsAt = current?.endsAt ? Date.parse(current.endsAt) : null;
  // The deadline revokes display authority. Only a newer server read may
  // activate the incoming class; a browser timer never grants it locally.
  const expired = current && endsAt !== null && endsAt <= now;
  const room = data.room;
  if (room && (!activityAuthority(room)?.supervisionContextId || room.contextType !== 'temporary_room'
    || room.purpose !== 'claim' || room.status !== 'active' || room.teacherId !== viewerId
    || room.source !== 'ad_hoc_supervision' || !Array.isArray(room.staffIds) || !room.staffIds.includes(viewerId)
    || !room.capabilities || typeof room.capabilities !== 'object' || !Array.isArray(room.capabilities.commands)
    || room.capabilities.commands.some(command => typeof command !== 'string')
    || ['fab', 'liveView', 'settings', 'screenshots'].some(key => typeof room.capabilities[key] !== 'boolean')
    || !Number.isFinite(Date.parse(room.startsAt)) || !Number.isFinite(Date.parse(room.endsAt))
    || !Number.isSafeInteger(room.studentCount) || room.studentCount < 0
    || !/^(0|[1-9]\d*)$/.test(String(room.contextAuthorityRevision ?? room.authority?.contextAuthorityRevision)))) {
    throw new Error('The temporary room response is incomplete.');
  }
  const activeRoom = room && Date.parse(room.startsAt) <= now && Date.parse(room.endsAt) > now ? room : null;
  return { ...data, current: expired ? null : current, room: activeRoom,
    transitionKey: expired ? `${activityTransitionKey(current)}:ended` : activityTransitionKey(current),
    pending: Boolean(expired || data.status === 'pending') };
}

export function resolveActivityView({ selection, scopeKey, transitionKey, scheduledEnabled, defaultView, room = null }) {
  if (selection?.scopeKey === scopeKey && (room ? selection.roomId === room.id : !selection.roomId && (!scheduledEnabled || selection.transitionKey === transitionKey))) {
    return selection.view || defaultView;
  }
  return room ? 'claimed' : scheduledEnabled ? 'class' : defaultView;
}

export function matchesActivityAuthority(message, authority) {
  const expected = activityAuthority(authority);
  if (!expected) return false;
  const actual = activityAuthority(message?.authority || {
    teachingSessionId: message?.teachingSessionId || message?.sessionId || message?.data?.teachingSessionId,
    supervisionContextId: message?.supervisionContextId || message?.data?.supervisionContextId,
  });
  return activityAuthorityKey(expected) === activityAuthorityKey(actual);
}

// Purpose is server-derived. Saved group names never establish testing authority.
export function activityPurpose(activity) {
  if (['class', 'testing', 'coverage', 'supervision', 'claim'].includes(activity?.purpose)) return activity.purpose;
  if (activity?.source === 'scheduled_testing' || activity?.contextType === 'state_testing') return 'testing';
  if (activity?.source === 'scheduled_coverage' || activity?.scheduledConflictId) return 'coverage';
  if (activity?.contextType === 'direct_pickup') return 'claim';
  return activityAuthority(activity)?.supervisionContextId ? 'supervision' : 'class';
}

export function activityPurposeLabel(activity) {
  if (activity?.contextType === 'temporary_room') return 'My room';
  return { class: 'Class', testing: 'Testing', coverage: 'Coverage', supervision: 'Supervising', claim: 'Claimed students' }[activityPurpose(activity)];
}

export function activityTitle(activity) {
  const label = activityPurposeLabel(activity);
  const name = activity?.name || activity?.groupName;
  return !name || name === label ? label : `${label}: ${name}`;
}

export function activityEndLabel(activity) {
  if (activity?.contextType === 'temporary_room') return 'End room';
  return { class: 'End class', testing: 'End testing', coverage: 'End coverage', supervision: 'End supervision', claim: 'Release all' }[activityPurpose(activity)];
}

export function activityEndRequest(target, currentStudentIds) {
  const body = { studentIds: [], releaseReason: 'returned_to_class' };
  if (target?.contextType !== 'temporary_room') return body;
  const expected = target.expectedStudentIds;
  if (!Array.isArray(expected) || expected.length === 0
    || expected.some(id => typeof id !== 'string' || !id)
    || new Set(expected).size !== expected.length) {
    throw new Error('The room roster is unavailable. Close the confirmation and refresh.');
  }
  const current = new Set(currentStudentIds);
  if (current.size !== expected.length || expected.some(id => !current.has(id))) {
    throw new Error('The room roster changed. Close the confirmation and review it again.');
  }
  return { ...body, expectedStudentIds: [...expected] };
}

export function normalizeObservableActivities(data) {
  return (Array.isArray(data?.activities) ? data.activities : []).flatMap(activity => {
    const authority = activityAuthority(activity);
    const revision = activity.contextAuthorityRevision ?? activity.authority?.contextAuthorityRevision;
    if (!activity.id || !authority || activity.capabilities?.observe !== true
      || authority.supervisionContextId && (revision == null || !/^(0|[1-9]\d*)$/.test(String(revision)))) return [];
    return [{ ...activity, authority, contextAuthorityRevision: revision ?? null,
      status: 'active', groupName: activity.name, teacherId: activity.owner?.id, accessMode: 'observe' }];
  });
}
