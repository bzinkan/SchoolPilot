const PERSISTENT_COMMANDS = new Set([
  'lock-screen',
  'unlock-screen',
  'apply-flight-path',
  'remove-flight-path',
  'apply-block-list',
  'remove-block-list',
  'attention-mode',
  'limit-tabs',
  'temp-unblock',
]);

const TRANSIENT_COMMANDS = new Set(['open-tab', 'close-tabs', 'timer', 'poll']);

export const MAX_TRACKED_TRANSIENT_COMMANDS = 200;

function countTargets(targets, statuses) {
  return (targets || []).filter((target) => statuses.has(target?.status)).length;
}

function nonNegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

export function commandDeliveryPolicy(commandType, value) {
  const supplied = value?.deliveryPolicy ?? value?.command?.deliveryPolicy;
  if (['persistent_control', 'transient_action', 'durable_message', 'server_authoritative'].includes(supplied)) {
    return supplied;
  }
  if (PERSISTENT_COMMANDS.has(commandType)) return 'persistent_control';
  if (TRANSIENT_COMMANDS.has(commandType)) return 'transient_action';
  if (commandType === 'teacher-message') return 'durable_message';
  if (commandType === 'student-sign-out') return 'server_authoritative';
  return 'transient_action';
}

export function normalizeCommandSummary(value) {
  const targets = value?.command?.targets || value?.targets || [];
  const summary = value?.summary || value?.command?.summary || {};
  const requested = nonNegative(summary.requested, targets.length);
  const completed = nonNegative(summary.completed, countTargets(targets, new Set(['completed'])));
  const failed = nonNegative(summary.failed, countTargets(targets, new Set(['failed'])));
  const unavailable = nonNegative(summary.unavailable, countTargets(targets, new Set(['unavailable'])));
  const expired = nonNegative(summary.expired, countTargets(targets, new Set(['expired'])));
  const received = nonNegative(summary.received, countTargets(targets, new Set(['received'])));
  const acknowledged = nonNegative(summary.acknowledged, received + completed + failed);
  const attempted = nonNegative(
    summary.attempted,
    summary.sent ?? countTargets(targets, new Set(['sent', 'received', 'completed', 'failed', 'expired'])),
  );
  const pending = nonNegative(
    summary.pending,
    summary.awaitingAck ?? Math.max(0, attempted - acknowledged),
  );
  return {
    requested,
    attempted,
    acknowledged,
    completed,
    pending,
    expired,
    failed,
    unavailable,
    // Mixed-version fields remain useful while the backend rolls out.
    sent: nonNegative(summary.sent, attempted),
    received,
    awaitingAck: nonNegative(summary.awaitingAck, pending),
  };
}

export function completedStudentIdsFromCommand(value) {
  return new Set(
    (value?.command?.targets || value?.targets || [])
      .filter((target) => target?.status === 'completed')
      .map((target) => target?.studentId)
      .filter(Boolean),
  );
}

function plural(count, singular, pluralValue = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralValue}`;
}

function formattedExpiry(expiresAt) {
  const time = Date.parse(expiresAt || '');
  if (!Number.isFinite(time)) return null;
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(time));
}

export function commandDeliveryFeedback(value, commandType = value?.command?.commandType) {
  const policy = commandDeliveryPolicy(commandType, value);
  const summary = normalizeCommandSummary(value);
  const expiresAt = value?.expiresAt ?? value?.command?.expiresAt;

  if (policy === 'persistent_control') {
    const pendingRestrictionCount = summary.pending || summary.unavailable;
    const pendingText = summary.pending > 0 || summary.unavailable > 0
      ? `${plural(pendingRestrictionCount, 'restriction is', 'restrictions are')} pending — will apply when monitoring resumes.`
      : summary.acknowledged > 0
        ? `${plural(summary.acknowledged, 'target')} device-reported acknowledgement.`
        : 'The desired restriction was saved for the selected students.';
    return {
      title: 'Restriction saved',
      description: [
        pendingText,
        summary.failed > 0 ? `${plural(summary.failed, 'target')} failed.` : null,
        summary.unavailable > 0 ? `${plural(summary.unavailable, 'student is', 'students are')} currently unavailable.` : null,
        'Acknowledgements are device-reported and are not tamper proof.',
      ].filter(Boolean).join(' '),
      variant: summary.failed > 0 ? 'destructive' : undefined,
    };
  }

  if (policy === 'durable_message') {
    return {
      title: summary.completed > 0 ? 'Acknowledged' : 'Message queued',
      description: summary.completed > 0
        ? `${plural(summary.completed, 'message')} received a device-reported completion acknowledgement.`
        : [
            'The message is retained in the student inbox and will be delivered when the student reconnects.',
            summary.unavailable > 0 ? `${plural(summary.unavailable, 'student is', 'students are')} currently unavailable.` : null,
          ].filter(Boolean).join(' '),
    };
  }

  if (policy === 'server_authoritative') {
    if (summary.completed > 0) {
      return {
        title: 'Sign-out completed',
        description: [
          `${plural(summary.completed, 'student session')} ended on the server. The browser will reflect sign-out now or when it reconnects.`,
          summary.unavailable > 0 ? `${plural(summary.unavailable, 'student was', 'students were')} already offline or unavailable.` : null,
          summary.failed > 0 ? `${plural(summary.failed, 'target')} failed.` : null,
        ].filter(Boolean).join(' '),
        variant: summary.failed > 0 ? 'destructive' : undefined,
      };
    }

    if (summary.unavailable > 0 && summary.failed === 0) {
      return {
        title: 'Student unavailable',
        description: `No student session completion was confirmed. ${plural(summary.unavailable, 'student was', 'students were')} already offline or unavailable.`,
        variant: 'destructive',
      };
    }

    return {
      title: 'Failed',
      description: [
        'No student session completion was confirmed.',
        summary.failed > 0 ? `${plural(summary.failed, 'target')} failed.` : null,
      ].filter(Boolean).join(' '),
      variant: 'destructive',
    };
  }

  if (summary.failed > 0 && summary.awaitingAck === 0) {
    return {
      title: 'Failed',
      description: `${plural(summary.failed, 'target')} reported a failed device outcome. Device acknowledgements are self-reported and are not tamper proof.`,
      variant: 'destructive',
    };
  }
  if (summary.unavailable > 0 && summary.attempted === 0 && summary.awaitingAck === 0) {
    return {
      title: 'Student unavailable',
      description: `${plural(summary.unavailable, 'student was', 'students were')} unavailable for delivery.`,
      variant: 'destructive',
    };
  }
  if (summary.expired > 0 && summary.awaitingAck === 0) {
    return {
      title: 'Not delivered',
      description: `${plural(summary.expired, 'target')} did not acknowledge the action before it expired. It will not be replayed later.`,
      variant: 'destructive',
    };
  }
  if (summary.completed > 0 || summary.acknowledged > 0) {
    return {
      title: 'Acknowledged',
      description: `${plural(summary.acknowledged || summary.completed, 'target')} acknowledged the action. This acknowledgement is device-reported and is not tamper proof.`,
    };
  }

  const expiry = formattedExpiry(expiresAt);
  return {
    title: 'Delivery attempted',
    description: [
      `${plural(summary.attempted, 'target')} attempted; ${plural(summary.pending, 'target')} awaiting device acknowledgement.`,
      expiry ? `Unacknowledged delivery expires at ${expiry}.` : null,
      summary.unavailable > 0 ? `${plural(summary.unavailable, 'student is', 'students are')} unavailable.` : null,
    ].filter(Boolean).join(' '),
  };
}

function commandId(value) {
  const id = value?.commandId ?? value?.command?.id ?? value?.id;
  return typeof id === 'string' && id ? id : null;
}

function commandExpiry(value) {
  const raw = value?.expiresAt ?? value?.command?.expiresAt;
  const parsed = Date.parse(raw || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function bounded(entries) {
  if (entries.size <= MAX_TRACKED_TRANSIENT_COMMANDS) return entries;
  const trimmed = new Map(entries);
  while (trimmed.size > MAX_TRACKED_TRANSIENT_COMMANDS) {
    trimmed.delete(trimmed.keys().next().value);
  }
  return trimmed;
}

export function trackTransientCommandResponse(current, value, commandType) {
  const id = commandId(value);
  const policy = commandDeliveryPolicy(commandType ?? value?.command?.commandType, value);
  if (!id || policy !== 'transient_action') return current;

  const existing = current.get(id);
  const next = new Map(current);
  next.set(id, {
    ...(existing || {}),
    commandId: id,
    commandType: commandType ?? value?.command?.commandType,
    deliveryPolicy: policy,
    expiresAtMs: commandExpiry(value) ?? existing?.expiresAtMs ?? null,
    // A scoped socket update is a later delivery milestone than the initiating
    // HTTP response, even if network scheduling delivers that response last.
    summary: existing?.updateObserved
      ? existing.summary
      : normalizeCommandSummary(value),
    command: existing?.updateObserved
      ? {
          ...(value?.command || {}),
          ...(existing.command || {}),
        }
      : {
          ...(existing?.command || {}),
          ...(value?.command || {}),
        },
  });
  return bounded(next);
}

export function applyTransientCommandUpdate(current, message) {
  const id = commandId(message);
  if (!id || !current.has(id)) return current;
  const value = message?.command ? message : { ...message, command: message };
  const existing = current.get(id);
  const next = new Map(current);
  next.set(id, {
    ...existing,
    commandType: value?.command?.commandType ?? existing.commandType,
    expiresAtMs: commandExpiry(value) ?? existing.expiresAtMs,
    summary: normalizeCommandSummary(value),
    command: {
      ...(existing.command || {}),
      ...(value.command || {}),
    },
    updateObserved: true,
  });
  return bounded(next);
}

function acknowledgedTransientAction(entry) {
  const targets = entry?.command?.targets;
  const hasCurrentTargetOutcome = Array.isArray(targets) && targets.length > 0
    ? targets.some((target) => target?.status === 'received' || target?.status === 'completed')
    : entry?.summary?.received > 0 || entry?.summary?.completed > 0;
  return Boolean(
    entry?.updateObserved
    && hasCurrentTargetOutcome,
  );
}

export function transientClassroomUiEffect(entry) {
  if (!acknowledgedTransientAction(entry)) return null;
  const payload = entry.command?.commandPayload || entry.command?.payload || {};

  if (entry.commandType === 'timer') {
    if (payload.action !== 'start' && payload.action !== 'stop') return null;
    return {
      commandId: entry.commandId,
      control: 'timer',
      active: payload.action === 'start',
    };
  }

  if (entry.commandType === 'poll') {
    if (payload.action === 'close') {
      return {
        commandId: entry.commandId,
        control: 'poll',
        active: false,
        pollId: payload.pollId || null,
      };
    }
    if (payload.action === 'start' && payload.pollId) {
      return {
        commandId: entry.commandId,
        control: 'poll',
        active: true,
        poll: {
          id: payload.pollId,
          question: payload.question || '',
          options: Array.isArray(payload.options) ? payload.options : [],
        },
      };
    }
  }

  return null;
}

export function latestTransientClassroomUiEffect(current, commandType) {
  let latest = null;
  let latestCreatedAtMs = null;
  for (const entry of current.values()) {
    if (entry.commandType !== commandType) continue;
    const effect = transientClassroomUiEffect(entry);
    if (!effect) continue;
    const createdAtMs = Date.parse(entry.command?.createdAt || '');
    const validCreatedAtMs = Number.isFinite(createdAtMs) ? createdAtMs : null;
    if (
      !latest
      || validCreatedAtMs === null
      || latestCreatedAtMs === null
      || validCreatedAtMs >= latestCreatedAtMs
    ) {
      latest = effect;
      latestCreatedAtMs = validCreatedAtMs;
    }
  }
  return latest;
}

export function hasPendingTransientAction(current, commandType) {
  for (const entry of current.values()) {
    if (entry.commandType === commandType && entry.summary.awaitingAck > 0) return true;
  }
  return false;
}

export function expireTransientCommands(current, nowMs = Date.now()) {
  let next = current;
  for (const [id, entry] of current) {
    if (
      entry.summary.awaitingAck <= 0
      || entry.expiresAtMs === null
      || nowMs < entry.expiresAtMs
    ) continue;
    if (next === current) next = new Map(current);
    next.set(id, {
      ...entry,
      summary: {
        ...entry.summary,
        expired: entry.summary.expired + entry.summary.awaitingAck,
        pending: Math.max(0, entry.summary.pending - entry.summary.awaitingAck),
        awaitingAck: 0,
      },
    });
  }
  return next;
}

export function findNextTransientExpiry(current, nowMs = Date.now()) {
  let earliest = null;
  for (const entry of current.values()) {
    if (
      entry.summary.awaitingAck <= 0
      || entry.expiresAtMs === null
      || entry.expiresAtMs <= nowMs
    ) continue;
    if (earliest === null || entry.expiresAtMs < earliest) earliest = entry.expiresAtMs;
  }
  return earliest;
}

export function transientEntryFeedback(entry) {
  return commandDeliveryFeedback({
    commandId: entry.commandId,
    command: {
      ...(entry.command || {}),
      commandType: entry.commandType,
      deliveryPolicy: entry.deliveryPolicy,
      expiresAt: entry.expiresAtMs === null ? null : new Date(entry.expiresAtMs).toISOString(),
    },
    summary: entry.summary,
  }, entry.commandType);
}
