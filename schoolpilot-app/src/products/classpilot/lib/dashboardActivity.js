const SOURCES = new Set(['class', 'scheduled_class', 'scheduled_testing', 'scheduled_coverage']);

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
  return { ...data, current: expired ? null : current,
    transitionKey: expired ? `${activityTransitionKey(current)}:ended` : activityTransitionKey(current),
    pending: Boolean(expired || data.status === 'pending') };
}

export function resolveActivityView({ selection, scopeKey, transitionKey, scheduledEnabled, defaultView }) {
  if (selection?.scopeKey === scopeKey && (!scheduledEnabled || selection.transitionKey === transitionKey)) {
    return selection.view || defaultView;
  }
  return scheduledEnabled ? 'class' : defaultView;
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
