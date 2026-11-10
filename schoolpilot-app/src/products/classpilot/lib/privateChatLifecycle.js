// Teacher tokens are server authority. Validate their bounded wire shape,
// retain a monotonic generation, and echo them without deriving one locally.
export function privateChatLifecycleToken(value) {
  if (!value || typeof value.threadId !== 'string' || !value.threadId || value.threadId.length > 128
    || !['schoolEpoch', 'activityEpoch', 'threadGeneration'].every(key => Number.isSafeInteger(value[key]) && value[key] > 0)) return null;
  return Object.freeze({ threadId: value.threadId, schoolEpoch: value.schoolEpoch,
    activityEpoch: value.activityEpoch, threadGeneration: value.threadGeneration });
}
export function samePrivateChatLifecycle(left, right) {
  return Boolean(left && right && left.threadId === right.threadId && left.schoolEpoch === right.schoolEpoch
    && left.activityEpoch === right.activityEpoch && left.threadGeneration === right.threadGeneration);
}
export function privateChatLifecycleCanAdvance(previous, next) {
  return Boolean(next && (!previous || (next.threadId === previous.threadId
    && next.schoolEpoch >= previous.schoolEpoch && next.activityEpoch >= previous.activityEpoch
    && next.threadGeneration >= previous.threadGeneration)));
}
const PRIVATE_CHAT_UNAVAILABLE_STATES = new Set(['update_required', 'reconnecting', 'signed_out', 'unavailable', 'disabled']);

// Older servers only expose supported. A positive result already includes
// their freshness fence; a negative result never proved an outdated client.
export function privateChatReadiness(row) {
  if (row?.supported === true) return row.readiness === undefined || row.readiness === 'ready' ? 'ready' : 'syncing';
  if (row?.supported !== false) return 'syncing';
  return PRIVATE_CHAT_UNAVAILABLE_STATES.has(row.readiness) ? row.readiness : 'syncing';
}

export function privateChatReadinessNote(readiness) {
  switch (readiness) {
    case 'ready': return '';
    case 'update_required': return "Update ClassPilot on this student's device to use private chat.";
    case 'reconnecting': return 'Private chat will be available when this student reconnects.';
    case 'signed_out': return 'Private chat will be available after this student signs in.';
    case 'disabled': return 'Messaging is turned off for this class or your school.';
    default: return 'Private chat is syncing. Refresh messages before replying.';
  }
}
export function privateChatLifecycleError(error) {
  const code = error?.response?.data?.code || error?.data?.code || error?.code;
  return ['PRIVATE_CHAT_LIFECYCLE_STALE', 'PRIVATE_CHAT_UPDATE_REQUIRED', 'PRIVATE_CHAT_CLIENT_UPDATE_REQUIRED',
    'PRIVATE_CHAT_RECONNECT_REQUIRED', 'PRIVATE_CHAT_SIGN_IN_REQUIRED', 'PRIVATE_CHAT_READINESS_UNAVAILABLE', 'PRIVATE_CHAT_DISABLED'].includes(code) ? code : null;
}
