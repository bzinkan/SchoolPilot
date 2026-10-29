import { classroomCommands, waitForClassroomTargets } from './classroomActions.js';

const TERMINAL = new Set(['completed', 'failed', 'unavailable', 'expired']);
const ACTIONS = new Set(['focus-current-page', 'stop-focus']);

export function tileLockCommandOutcome(target, commandType, commandId) {
  const notApplied = target.status === 'completed'
    && target.result?.outcome !== undefined && target.result.outcome !== 'applied';
  return { status: notApplied ? 'failed' : target.status, commandType, commandId, result: target.result,
    error: target.errorMessage || target.error
      || (notApplied ? `The device did not apply this change (${target.result.outcome}).` : undefined) };
}

// Control revisions change as these commands are applied. Identity and owner
// changes, however, must cancel the remainder of a multi-command gesture.
export function tileLockAuthorityKey(scopeKey, student) {
  return JSON.stringify([scopeKey, student?.studentId, student?.realtimeBinding ?? null,
    student?.contextId ?? student?.supervisionContext?.id ?? null,
    student?.contextAuthorityRevision ?? student?.supervisionContext?.contextAuthorityRevision ?? null]);
}

export async function runTileLockAction({ action, studentId, postCommand, readCommand,
  signal, assertCurrent = () => {}, onUpdate = () => {}, waitOptions = {} }) {
  if (!ACTIONS.has(action) || typeof studentId !== 'string' || !studentId)
    throw new Error('Choose one student and a valid lock action.');
  let pending = true;
  let phase = '';
  const outcomes = {};
  const snapshot = () => ({ action, pending, phase,
    outcomes: Object.fromEntries(Object.entries(outcomes).map(([key, value]) => [key, { ...value }])) });
  const guard = () => {
    if (signal?.aborted) throw new DOMException('Classroom assignment changed', 'AbortError');
    assertCurrent();
  };
  const update = (field, value, nextPhase) => {
    guard();
    outcomes[field] = value;
    phase = nextPhase;
    onUpdate(snapshot());
  };
  async function send(field, commandType, payload, label) {
    guard();
    update(field, { status: 'requesting', commandType }, `${label}: sending`);
    let data;
    try {
      data = await postCommand(commandType, payload, [studentId]);
      guard();
    } catch (error) {
      guard();
      if (error?.name === 'AbortError') throw error;
      update(field, { status: 'failed', commandType, error: error.message || 'The command could not be sent.' }, `${label}: failed`);
      return outcomes[field];
    }
    const commands = classroomCommands(data);
    const command = commands.length === 1 ? commands[0] : null;
    if (!command || command.commandType !== commandType
      || command.targets.length === 0 || command.targets.some(target => target.studentId !== studentId)) {
      update(field, { status: 'pending', commandType, error: 'The command response could not be confirmed.' }, `${label}: awaiting confirmation`);
      return outcomes[field];
    }
    try {
      const rows = await waitForClassroomTargets(command, [studentId], {
        ...waitOptions, readCommand, signal, assertCurrent: guard,
        onUpdate: (targets) => {
          const target = targets[0];
          // Stateful commands may complete transport delivery with a stale or
          // expired snapshot. Only an applied outcome confirms the change.
          const outcome = tileLockCommandOutcome(target, commandType, command.id);
          update(field, outcome,
            `${label}: ${TERMINAL.has(outcome.status) ? outcome.status : 'awaiting confirmation'}`);
        },
      });
      guard();
      return outcomes[field] || rows[0];
    } catch (error) {
      guard();
      if (error?.name === 'AbortError') throw error;
      update(field, { status: 'pending', commandType, commandId: command.id,
        error: error.message || 'Device confirmation is unavailable.' }, `${label}: awaiting confirmation`);
      return outcomes[field];
    }
  }

  if (action === 'focus-current-page') await send('focus', 'lock-screen', { url: 'CURRENT_URL' }, 'Focus');
  else await send('focus', 'unlock-screen', { screenOnly: true }, 'Stop Focus');

  pending = false;
  guard(); onUpdate(snapshot());
  return snapshot();
}
