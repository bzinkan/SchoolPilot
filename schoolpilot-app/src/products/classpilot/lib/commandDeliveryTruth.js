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
  'focus-tab',
  'stop-focus',
]);

const TRANSIENT_COMMANDS = new Set(['open-tab', 'close-tabs', 'timer', 'poll', 'activate-tab']);

export const MAX_TRACKED_TRANSIENT_COMMANDS = 200;

function countTargets(targets, statuses) {
  return (targets || []).filter((target) => statuses.has(target?.status)).length;
}

function nonNegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

// One-shot actions whose late stragglers leave nothing unenforced.
const EXPIRY_TOLERANT_TRANSIENT_COMMANDS = new Set(['timer', 'poll']);

// Expired targets are informational only for a timer or poll that most of the
// addressed devices acknowledged. When as many expired as acknowledged, most
// of the class missed it and nothing sends it again, so the teacher is told.
function expiredStragglersAreInformational(commandType, summary) {
  if (!EXPIRY_TOLERANT_TRANSIENT_COMMANDS.has(commandType)) return false;
  return summary.expired < Math.max(summary.acknowledged, summary.completed);
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

const UNSUPPORTED_CLIENT_PREFIX = 'Unsupported client:';

/**
 * Students the server refused because their ClassPilot extension lacks a
 * capability the command needs (for example preciseRestrictionResourcesV1).
 * They are not signed out: they need the extension update.
 */
export function unsupportedCommandStudentIds(value) {
  return [...new Set(
    (value?.command?.targets || value?.targets || [])
      .filter((target) => target?.status === 'unavailable'
        && typeof target?.errorMessage === 'string'
        && target.errorMessage.startsWith(UNSUPPORTED_CLIENT_PREFIX))
      .map((target) => target?.studentId)
      .filter(Boolean),
  )];
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

export function commandOutcomeBreakdown(value) {
  const summary = value?.requested === undefined ? normalizeCommandSummary(value) : value;
  return [
    summary.completed > 0 ? `${summary.completed} completed` : null,
    summary.received > 0 ? `${summary.received} received` : null,
    summary.pending > 0 ? `${summary.pending} pending` : null,
    summary.failed > 0 ? `${summary.failed} failed` : null,
    summary.unavailable > 0 ? `${summary.unavailable} unavailable` : null,
    summary.expired > 0 ? `${summary.expired} expired` : null,
  ].filter(Boolean).join(', ');
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

function commandDeliverySummaryFeedback(value, commandType) {
  const policy = commandDeliveryPolicy(commandType, value);
  const summary = normalizeCommandSummary(value);
  const expiresAt = value?.expiresAt ?? value?.command?.expiresAt;

  const requestFailures = (value?.command?.targets || value?.targets || []).filter((target) => target.requestFailed);
  if (summary.requested > 0 && requestFailures.length === summary.requested) {
    return { title: 'Failed', description: 'No command was accepted for the selected students.', variant: 'destructive' };
  }

  if (policy === 'persistent_control') {
    // An unavailable target is a student the restriction did NOT reach. Only
    // `pending` targets are genuinely awaiting a device acknowledgement, so
    // only they may be described as applying later. Counting the two together
    // told teachers a restriction was 'pending' for a signed-out student when
    // nothing had been delivered and, with late sign-in delivery off, nothing
    // had been stored either. That false reassurance cost a class period on
    // 2026-09-04, when three attempts to clear a Flight Path each reported
    // success and changed nothing.
    const nothingDelivered = summary.requested > 0 && summary.unavailable >= summary.requested;
    // A precise ("This resource only", section or resource) restriction is
    // refused per student when the extension cannot enforce it; those students
    // are online but need the ClassPilot update, not a sign-in.
    const unsupportedStudentIds = unsupportedCommandStudentIds(value);
    const unsupported = Math.min(unsupportedStudentIds.length, summary.unavailable);
    const signedOut = summary.unavailable - unsupported;
    const allFailed = summary.requested > 0 && summary.failed >= summary.requested;
    const pendingText = allFailed
      ? 'The desired restriction was saved, but no device confirmed applying it.'
      : summary.pending > 0
      ? `${plural(summary.pending, 'restriction is', 'restrictions are')} pending — will apply when monitoring resumes.`
      : summary.acknowledged > 0
        ? `${plural(summary.acknowledged, 'target')} device-reported acknowledgement.`
        : nothingDelivered
          ? null
          : 'The desired restriction was saved for the selected students.';
    return {
      title: allFailed ? 'Restriction not applied' : nothingDelivered
        ? unsupported > 0 && signedOut === 0 ? 'Extension update required' : 'Restriction not delivered'
        : 'Restriction saved',
      description: [
        pendingText,
        summary.failed > 0 ? `${plural(summary.failed, 'target')} failed.` : null,
        signedOut > 0
          ? `${plural(signedOut, 'student is', 'students are')} signed out, so the restriction was not delivered to them. Apply it again once they are signed in.`
          : null,
        unsupported > 0
          ? `${plural(unsupported, 'student needs', 'students need')} the ClassPilot update before this restriction can apply.`
          : null,
        Number(value?.skippedCurrentPageCount) > 0
          ? `${plural(Number(value.skippedCurrentPageCount), 'signed-out student was', 'signed-out students were')} skipped because current-page Focus needs a fresh online page.`
          : null,
        'Acknowledgements are device-reported and are not tamper proof.',
      ].filter(Boolean).join(' '),
      variant: summary.failed > 0 || nothingDelivered ? 'destructive' : undefined,
      ...(unsupportedStudentIds.length > 0 ? { unsupportedStudentIds } : {}),
    };
  }

  if (policy === 'durable_message') {
    const breakdown = commandOutcomeBreakdown(summary);
    const allFailed = summary.requested > 0 && summary.failed >= summary.requested;
    const remainingQueued = summary.pending + summary.unavailable;
    return {
      title: allFailed ? 'Message failed' : summary.failed > 0 ? 'Partially delivered' : summary.completed > 0 ? 'Acknowledged' : 'Message queued',
      description: summary.failed > 0
        ? [
            `${breakdown}.`,
            remainingQueued > 0 ? `${plural(remainingQueued, 'remaining recipient is', 'remaining recipients are')} queued.` : null,
            'Delivery to failed recipients was not confirmed.',
          ].filter(Boolean).join(' ')
        : summary.completed > 0
        ? `${breakdown}. Device acknowledgements are self-reported and are not tamper proof.`
        : [
            'The message is retained in the student inbox and will be delivered when the student reconnects.',
            breakdown ? `Current outcomes: ${breakdown}.` : null,
            summary.unavailable > 0 ? `${plural(summary.unavailable, 'student is', 'students are')} currently unavailable.` : null,
          ].filter(Boolean).join(' '),
      variant: summary.failed > 0 ? 'destructive' : undefined,
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

  // A failed ACK proves receipt, but is not a successful acknowledgement of
  // the action. Counting it as one labelled a single failed tab close as
  // "Partially delivered" even though no student's action succeeded.
  const successfulAcknowledgements = Math.max(summary.completed, summary.acknowledged - summary.failed);
  if (
    successfulAcknowledgements === 0
    && summary.completed === 0
    && summary.awaitingAck === 0
    && (summary.failed > 0 || summary.unavailable > 0 || summary.expired > 0)
  ) {
    const breakdown = commandOutcomeBreakdown(summary);
    return {
      title: summary.failed > 0 ? 'Failed' : summary.expired > 0 ? 'Not delivered' : 'Student unavailable',
      description: `${breakdown}. The action was not confirmed and will not be replayed later.`,
      variant: 'destructive',
    };
  }
  if (successfulAcknowledgements > 0) {
    const breakdown = commandOutcomeBreakdown(summary);
    return {
      title: summary.failed > 0 || summary.unavailable > 0 || summary.expired > 0 ? 'Partially delivered' : 'Acknowledged',
      description: `${breakdown || `${summary.acknowledged || summary.completed} acknowledged`}. Device acknowledgements are self-reported and are not tamper proof.`,
      // For a timer or poll, a few stragglers that expired while most of the
      // addressed devices acknowledged are informational: the class has it and
      // nothing is left unenforced. If as many expired as acknowledged, most of
      // the class missed it, so the toast stays destructive. For every other
      // one-shot action (a current-page lock, open tab, close tabs) an expired
      // target is a student the action did not reach, so that stays
      // destructive too. A device-reported failure is always destructive, and
      // zero acknowledgements are handled above.
      variant: summary.failed > 0
        || (summary.expired > 0 && !expiredStragglersAreInformational(commandType, summary))
        ? 'destructive'
        : undefined,
    };
  }

  const expiry = formattedExpiry(expiresAt);
  return {
    title: 'Delivery attempted',
    description: [
      `${plural(summary.attempted, 'target')} attempted; ${plural(summary.pending, 'target')} awaiting device acknowledgement.`,
      expiry ? `Unacknowledged delivery expires at ${expiry}.` : null,
      summary.unavailable > 0 ? `${plural(summary.unavailable, 'student is', 'students are')} unavailable.` : null,
      summary.failed > 0 ? `${plural(summary.failed, 'target')} failed.` : null,
    ].filter(Boolean).join(' '),
    variant: summary.failed > 0 ? 'destructive' : undefined,
  };
}

function commandFailureDescription(value, studentNames) {
  const targets = value?.command?.targets || value?.targets || [];
  const details = [];
  const seen = new Set();
  let omitted = 0;
  for (const target of targets) {
    if (!['failed', 'unavailable', 'expired'].includes(target?.status) || typeof target.errorMessage !== 'string') continue;
    // eslint-disable-next-line no-control-regex -- Device diagnostics deliberately strip control characters.
    const message = target.errorMessage.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
    if (!message) continue;
    const key = `${target.studentId}\u0000${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (details.length >= 5) { omitted += 1; continue; }
    // Names come only from the dashboard's authorized roster, never a device
    // ACK or an identifier supplied by the command target.
    const rosterName = Object.hasOwn(studentNames, target.studentId) ? studentNames[target.studentId] : null;
    const name = typeof rosterName === 'string' && rosterName.trim() ? rosterName.trim().slice(0, 100) : 'Student';
    details.push(`${name}: ${message}${/[.!?]$/.test(message) ? '' : '.'}`);
  }
  if (omitted > 0) details.push(`${plural(omitted, 'additional failure')} reported.`);
  return details.join(' ');
}

export function commandDeliveryFeedback(value, commandType = value?.command?.commandType, studentNames = {}) {
  const feedback = commandDeliverySummaryFeedback(value, commandType);
  const failures = commandFailureDescription(value, studentNames);
  return failures ? { ...feedback, description: `${failures} ${feedback.description}` } : feedback;
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

function trackedCommandEntry(current, value, commandType) {
  const id = commandId(value);
  const policy = commandDeliveryPolicy(commandType ?? value?.command?.commandType, value);
  if (!id) return null;

  const existing = current.get(id);
  const preserveObservedOutcome = existing?.updateObserved || existing?.expiredLocally;
  return {
    ...(existing || {}),
    commandId: id,
    commandType: commandType ?? value?.command?.commandType,
    deliveryPolicy: policy,
    expiresAtMs: commandExpiry(value) ?? existing?.expiresAtMs ?? null,
    // A scoped socket update is a later delivery milestone than the initiating
    // HTTP response, even if network scheduling delivers that response last.
    summary: preserveObservedOutcome
      ? existing.summary
      : normalizeCommandSummary(value),
    command: preserveObservedOutcome
      ? {
          ...(value?.command || {}),
          ...(existing.command || {}),
        }
      : {
          ...(existing?.command || {}),
          ...(value?.command || {}),
        },
  };
}

function entryResponse(entry) {
  return { command: entry.command, summary: entry.summary };
}

function replaceBatchResponse(batch, entry) {
  return { ...batch, responses: batch.responses.map((response) => (
    commandId(response) === entry.commandId ? entryResponse(entry) : response
  )) };
}

function attachFeedbackBatch(entries, batch) {
  for (const response of batch.responses) {
    const id = commandId(response);
    const entry = entries.get(id);
    if (entry) entries.set(id, { ...entry, feedbackBatch: batch });
  }
  return entries;
}

function storeCommandEntry(current, entry) {
  const next = new Map(current);
  next.set(entry.commandId, entry);
  if (entry.feedbackBatch) attachFeedbackBatch(next, replaceBatchResponse(entry.feedbackBatch, entry));
  return next;
}

function feedbackBatchResponse(batch) {
  const summaries = batch.responses.map((response) => response.summary);
  const summary = Object.fromEntries(Object.keys(normalizeCommandSummary({})).map((key) => [key,
    summaries.reduce((count, value) => count + value[key], 0)]));
  // A rejected context request has no device receipt or delivery attempt.
  // Keep those original failures beside every later child-command outcome.
  for (const target of batch.fixedTargets) {
    summary.requested += 1;
    if (Object.hasOwn(summary, target.status)) summary[target.status] += 1;
  }
  return {
    command: { commandType: batch.commandType, deliveryPolicy: batch.deliveryPolicy,
      expiresAt: batch.responses.map((response) => response.command?.expiresAt).filter(Boolean).sort()[0],
      targets: [...batch.fixedTargets, ...batch.responses.flatMap((response) => (
        (response.command?.targets || []).map((target) => ({ ...target, commandId: commandId(response) }))
      ))] },
    summary,
  };
}

// The legacy export name is retained for callers. Every command policy needs
// later ACK/error feedback; only the expiry helpers below are transient-only.
export function trackTransientCommandResponse(current, value, commandType) {
  const commands = (value?.commands || []).filter((command) => commandId(command));
  if (commands.length === 0) {
    const entry = trackedCommandEntry(current, value, commandType);
    return entry ? bounded(storeCommandEntry(current, entry)) : current;
  }

  const next = new Map(current);
  const ids = new Set(commands.map((command) => commandId(command)));
  const responses = commands.map((command) => {
    const result = value.results?.find((row) => commandId(row) === command.id);
    const entry = trackedCommandEntry(next, { ...result, command }, commandType);
    next.set(entry.commandId, entry);
    return entryResponse(entry);
  });
  const batch = {
    commandType: commandType ?? value.command?.commandType,
    deliveryPolicy: commandDeliveryPolicy(commandType, value),
    fixedTargets: (value.command?.targets || value.targets || []).filter((target) => !ids.has(target.commandId)),
    responses,
  };
  return bounded(attachFeedbackBatch(next, batch));
}

export function applyTransientCommandUpdate(current, message) {
  const id = commandId(message);
  if (!id || !current.has(id)) return current;
  const value = message?.command ? message : { ...message, command: message };
  const existing = current.get(id);
  const entry = {
    ...existing,
    commandType: value?.command?.commandType ?? existing.commandType,
    expiresAtMs: commandExpiry(value) ?? existing.expiresAtMs,
    summary: normalizeCommandSummary(value),
    command: {
      ...(existing.command || {}),
      ...(value.command || {}),
    },
    updateObserved: true,
    expiredLocally: false,
  };
  return bounded(storeCommandEntry(current, entry));
}

function acknowledgedTransientAction(entry) {
  const targets = entry?.command?.targets;
  const hasCurrentTargetOutcome = Array.isArray(targets) && targets.length > 0
    ? targets.some((target) => target?.status === 'received' || target?.status === 'completed')
    : entry?.summary?.received > 0 || entry?.summary?.completed > 0;
  return Boolean(
    entry?.deliveryPolicy === 'transient_action'
    && entry?.updateObserved
    && hasCurrentTargetOutcome,
  );
}

export function transientClassroomUiEffect(entry) {
  if (!acknowledgedTransientAction(entry)) return null;
  const payload = entry.command?.commandPayload || entry.command?.payload || {};

  if (entry.commandType === 'timer') {
    if (payload.action !== 'start' && payload.action !== 'stop') return null;
    const endsAt = payload.deadline || payload.endsAt;
    const legacyEnd = Date.parse(entry.command?.createdAt || '') + Number(payload.seconds || payload.durationSeconds) * 1000;
    return {
      commandId: entry.commandId,
      control: 'timer',
      active: payload.action === 'start',
      ...(payload.action === 'start' && (endsAt || Number.isFinite(legacyEnd)) ? { timer: { ...payload, endsAt: endsAt || new Date(legacyEnd).toISOString() } } : {}),
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

/**
 * A timer or poll control stays locked only until the first device of that
 * command type acknowledges the frame (received or completed). Waiting for
 * every target let one Chromebook that was briefly off its socket hold every
 * control for the full 15 s TTL (2026-10-09 connection audit, finding #1).
 * The straggler target stays tracked and still expires on its own clock.
 */
export function hasPendingTransientAction(current, commandType) {
  for (const entry of current.values()) {
    if (entry.commandType !== commandType) continue;
    const { summary } = entry;
    if (summary.awaitingAck > 0 && summary.acknowledged === 0 && summary.completed === 0) return true;
  }
  return false;
}

export function expireTransientCommands(current, nowMs = Date.now()) {
  let next = current;
  for (const [id, originalEntry] of current) {
    const entry = next.get(id) || originalEntry;
    if (
      entry.deliveryPolicy !== 'transient_action'
      || entry.summary.awaitingAck <= 0
      || entry.expiresAtMs === null
      || nowMs < entry.expiresAtMs
    ) continue;
    next = storeCommandEntry(next, {
      ...entry,
      command: { ...entry.command, targets: entry.command?.targets?.map((target) => (
        ['requested', 'sent', 'pending'].includes(target.status)
          ? { ...target, status: 'expired', errorMessage: 'The student did not acknowledge this action before it expired.' }
          : target
      )) },
      summary: {
        ...entry.summary,
        expired: entry.summary.expired + entry.summary.awaitingAck,
        pending: Math.max(0, entry.summary.pending - entry.summary.awaitingAck),
        awaitingAck: 0,
      },
      expiredLocally: true,
    });
  }
  return next;
}

export function findNextTransientExpiry(current, nowMs = Date.now()) {
  let earliest = null;
  for (const entry of current.values()) {
    if (
      entry.deliveryPolicy !== 'transient_action'
      || entry.summary.awaitingAck <= 0
      || entry.expiresAtMs === null
      || entry.expiresAtMs <= nowMs
    ) continue;
    if (earliest === null || entry.expiresAtMs < earliest) earliest = entry.expiresAtMs;
  }
  return earliest;
}

export function transientEntryFeedback(entry, studentNames = {}) {
  const value = entry.feedbackBatch ? feedbackBatchResponse(entry.feedbackBatch) : {
    commandId: entry.commandId,
    command: {
      ...(entry.command || {}),
      commandType: entry.commandType,
      deliveryPolicy: entry.deliveryPolicy,
      expiresAt: entry.expiresAtMs === null ? null : new Date(entry.expiresAtMs).toISOString(),
    },
    summary: entry.summary,
  };
  return commandDeliveryFeedback(value, entry.commandType, studentNames);
}
