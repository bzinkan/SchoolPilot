export const AUTOMATIC_FLIGHT_PATH_SESSION_KEY = '/api/classpilot/automatic-flight-path-session';
export const automaticFlightPathPolicyKey = (groupId, schoolId, viewerId) => ['/api/groups', groupId, 'automatic-flight-path', schoolId, viewerId];
export const automaticFlightPathSessionKey = (sessionId, schoolId, viewerId, authorityRevision) =>
  [AUTOMATIC_FLIGHT_PATH_SESSION_KEY, schoolId, viewerId, sessionId, authorityRevision ?? null];

export function automaticFlightPathChoices(paths, { viewerId, primaryTeacherId, sharedPathsEnabled }) {
  if (viewerId && viewerId === primaryTeacherId) return paths;
  return sharedPathsEnabled ? paths.filter(path => path.visibility === 'school' || path.official === true) : [];
}

export function automaticFlightPathStopBody(sessionId, revision) {
  if (!sessionId || !Number.isInteger(revision) || revision < 0) throw new Error('Refresh this class before turning off its automatic Flight Path.');
  return { teachingSessionId: sessionId, targetScope: 'class', commandType: 'remove-flight-path', commandPayload: {},
    stopAutomaticFlightPath: { expectedRevision: revision } };
}

export function automaticFlightPathBadge(entry) {
  if (!entry) return null;
  const labels = { applied: 'Automatic · Applied', pending: 'Automatic · Pending', failed: 'Automatic · Failed', unavailable: 'Automatic · Unavailable', overridden: 'Manual override', off: 'Automatic · Off', 'status-unavailable': 'Automatic · Status unavailable' };
  return labels[entry.status] || null;
}

export function automaticFlightPathReason(reason) {
  if (reason === 'AUTOMATIC_FLIGHT_PATH_MONITORING_UNAVAILABLE') return 'Automatic Flight Paths can start only during the school’s allowed monitoring hours.';
  if (reason === 'AUTOMATIC_FLIGHT_PATH_SCHEDULED_CLASS_REQUIRED') return 'Choose a teaching class with an active class schedule.';
  if (reason === 'NOT_OFFICIAL_CLASS' || reason === 'OFFICIAL_CLASS_REQUIRED') return 'Automatic Flight Paths are available for official classes.';
  if (reason === 'NOT_SCHEDULED' || reason === 'SCHEDULE_REQUIRED' || reason === 'AUTOMATIC_FLIGHT_PATH_SCHEDULED_CLASS_REQUIRED') return 'Automatic Flight Paths require a scheduled teaching class. Add a schedule in class setup first.';
  return 'Automatic Flight Path is unavailable for this class. Check its schedule and saved Flight Path.';
}
