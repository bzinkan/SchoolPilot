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
          purpose: context.purpose, contextType: context.contextType,
          startsAt: context.startsAt, source: context.source,
          scheduledConflictId: context.scheduledConflictId || null,
          scheduleProfileApplicationId: context.scheduleProfileApplicationId || null,
          scheduleProfileDate: context.scheduleProfileDate || null,
          scheduleProfileBlockId: context.scheduleProfileBlockId || null,
          authority: { teachingSessionId: null, supervisionContextId: context.id,
            contextAuthorityRevision: context.authority?.contextAuthorityRevision ?? context.classroomAuthorityRevision ?? context.contextAuthorityRevision ?? null },
        })),
    },
  };
}

export function createDashboardWorkspaceIntent({ schoolId, viewerId, view }) {
  return { [INTENT_KEY]: { id: globalThis.crypto.randomUUID(), schoolId, viewerId, view } };
}

export function createObservedActivityDashboardIntent({ schoolId, viewerId, activity }) {
  // Carry only a selection hint. The dashboard must load the current activity
  // and authorize its authority before requesting tiles or a preview lease.
  return { [INTENT_KEY]: {
    id: globalThis.crypto.randomUUID(), schoolId, viewerId, mode: 'observe',
    activity: activity?.id ? {
      id: activity.id, name: activity.name, purpose: activity.purpose,
      authority: {
        teachingSessionId: activity.authority?.teachingSessionId || null,
        supervisionContextId: activity.authority?.supervisionContextId || null,
        contextAuthorityRevision: activity.authority?.contextAuthorityRevision ?? activity.contextAuthorityRevision ?? null,
      },
    } : null,
  } };
}

export function consumeSupervisionDashboardIntent(state, { schoolId, viewerId, isAdmin = false }) {
  const intent = state?.[INTENT_KEY];
  if (!intent?.id || consumedIntents.has(intent.id)) return null;
  consumedIntents.add(intent.id);
  // Bound memory for a long-lived staff browser; consumed router state is also
  // removed from the current history entry by the destination.
  if (consumedIntents.size > 100) consumedIntents.delete(consumedIntents.values().next().value);
  if (intent.schoolId !== schoolId || intent.viewerId !== viewerId) return null;
  if (intent.mode === 'observe') {
    const authority = intent.activity?.authority;
    if (!isAdmin || !intent.activity?.id || !authority || !!authority.teachingSessionId === !!authority.supervisionContextId) return null;
    return { ...intent, mode: 'observe', activity: intent.activity };
  }
  if (['available', 'claimed', 'class'].includes(intent.view)) return { ...intent, view: intent.view };
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
