const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const SESSION_ID_MAX_LENGTH = 200;

export type ClasspilotSessionSubscriptionAction = "subscribe" | "unsubscribe";

export type ParsedClasspilotSessionSubscription =
  | {
      ok: true;
      action: ClasspilotSessionSubscriptionAction;
      teachingSessionId: string;
      requestId?: string;
    }
  | {
      ok: false;
      code: "REQUEST_ID_INVALID" | "SESSION_ID_REQUIRED";
      requestId?: string;
    };

export type ClasspilotSessionSubscriptionMutationState = {
  sessionSubscriptionEpochs: Map<string, number>;
  sessionSubscriptionIdentityGeneration: number;
};

export type ClasspilotSessionSubscriptionMutation = {
  teachingSessionId: string;
  epoch: number;
  identityGeneration: number;
};

/**
 * Mark the arrival order before any asynchronous authorization. A later
 * mutation for the same session becomes authoritative even when an older
 * database check resolves afterward.
 */
export function beginClasspilotSessionSubscriptionMutation(
  state: ClasspilotSessionSubscriptionMutationState,
  teachingSessionId: string
): ClasspilotSessionSubscriptionMutation {
  const epoch = (state.sessionSubscriptionEpochs.get(teachingSessionId) ?? 0) + 1;
  state.sessionSubscriptionEpochs.set(teachingSessionId, epoch);
  return {
    teachingSessionId,
    epoch,
    identityGeneration: state.sessionSubscriptionIdentityGeneration,
  };
}

export function isCurrentClasspilotSessionSubscriptionMutation(
  state: ClasspilotSessionSubscriptionMutationState,
  mutation: ClasspilotSessionSubscriptionMutation
): boolean {
  return state.sessionSubscriptionIdentityGeneration === mutation.identityGeneration
    && state.sessionSubscriptionEpochs.get(mutation.teachingSessionId) === mutation.epoch;
}

export function parseClasspilotSessionSubscription(
  message: unknown
): ParsedClasspilotSessionSubscription {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return { ok: false, code: "SESSION_ID_REQUIRED" };
  }
  const candidate = message as {
    type?: unknown;
    requestId?: unknown;
    sessionId?: unknown;
    teachingSessionId?: unknown;
  };
  const action = candidate.type === "subscribe-session"
    ? "subscribe"
    : "unsubscribe";

  let requestId: string | undefined;
  if (candidate.requestId !== undefined) {
    if (
      typeof candidate.requestId !== "string"
      || !REQUEST_ID_PATTERN.test(candidate.requestId)
    ) {
      return { ok: false, code: "REQUEST_ID_INVALID" };
    }
    requestId = candidate.requestId;
  }

  const rawSessionId = candidate.teachingSessionId ?? candidate.sessionId;
  const teachingSessionId = typeof rawSessionId === "string"
    ? rawSessionId.trim()
    : "";
  if (
    !teachingSessionId
    || teachingSessionId.length > SESSION_ID_MAX_LENGTH
  ) {
    return { ok: false, code: "SESSION_ID_REQUIRED", ...(requestId ? { requestId } : {}) };
  }
  return {
    ok: true,
    action,
    teachingSessionId,
    ...(requestId ? { requestId } : {}),
  };
}

/** Attach the server-authoritative session target to an object event. */
export function correlateClasspilotSessionMessage(
  teachingSessionId: string,
  message: unknown
): unknown {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return message;
  }
  return {
    ...(message as Record<string, unknown>),
    teachingSessionId,
  };
}
