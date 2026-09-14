const INTENT_KEY = 'classpilotSupervisionDashboard';
const consumedIntents = new Set();

// Navigation is a one-use display request, never supervision authority. The
// destination still obtains its roster and command permissions from the API.
export function createSupervisionDashboardIntent({ schoolId, viewerId, contexts = [] }) {
  return {
    [INTENT_KEY]: {
      id: globalThis.crypto.randomUUID(), schoolId, viewerId,
      contexts: contexts.filter(context => context?.id && context.assignedStaffId === viewerId)
        .map(context => ({
          id: context.id, name: context.name || 'Supervision',
          assignedStaffId: context.assignedStaffId, endsAt: context.endsAt,
        })),
    },
  };
}

export function consumeSupervisionDashboardIntent(state, { schoolId, viewerId }) {
  const intent = state?.[INTENT_KEY];
  if (!intent?.id || consumedIntents.has(intent.id)) return null;
  consumedIntents.add(intent.id);
  // Bound memory for a long-lived staff browser; consumed router state is also
  // removed from the current history entry by the destination.
  if (consumedIntents.size > 100) consumedIntents.delete(consumedIntents.values().next().value);
  if (intent.schoolId !== schoolId || intent.viewerId !== viewerId) return null;
  const contexts = (Array.isArray(intent.contexts) ? intent.contexts : []).filter(context => (
    context?.id && context.assignedStaffId === viewerId && Date.parse(context.endsAt) > Date.now()
  ));
  return contexts.length ? { ...intent, contexts } : null;
}

export function withoutSupervisionDashboardIntent(state) {
  const next = { ...state };
  delete next[INTENT_KEY];
  return next;
}

export function hasSupervisionDashboardIntent(state) {
  return !!state?.[INTENT_KEY];
}
