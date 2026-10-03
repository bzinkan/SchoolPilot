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
export function privateChatLifecycleError(error) {
  const code = error?.response?.data?.code || error?.data?.code || error?.code;
  return ['PRIVATE_CHAT_LIFECYCLE_STALE', 'PRIVATE_CHAT_UPDATE_REQUIRED', 'PRIVATE_CHAT_DISABLED'].includes(code) ? code : null;
}
