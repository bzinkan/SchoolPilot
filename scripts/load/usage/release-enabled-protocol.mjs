import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const lifecycleTokenFields = ['threadId', 'schoolEpoch', 'activityEpoch', 'threadGeneration'];
export const lifecycleToken = value => Object.fromEntries(lifecycleTokenFields.map(key => [key, value?.[key]]));

export function commandTransportAcknowledgement(frame, school, index, type, commandId) {
  assert.equal(frame.commandId, commandId); assert.equal(frame.command?.commandId, commandId);
  assert.equal(frame.studentId, school.students[index]); assert.equal(frame.studentSessionId, school.studentSessions[index]);
  const binding = frame.exactBinding ?? frame.command?.exactBinding;
  if (['lock-screen', 'focus-tab', 'stop-focus'].includes(type)) assert.ok(binding, `${type} needs exact transport binding`);
  if (binding) for (const [key, value] of Object.entries({ schoolId: school.id, studentId: school.students[index], studentSessionId: school.studentSessions[index], deviceId: school.devices[index] })) assert.equal(binding[key], value);
  const controlRevision = binding?.controlRevision ?? frame.classroomState?.revision;
  assert.ok(Number.isSafeInteger(controlRevision), 'ACK revision must come from the received student transport');
  const appliedAuthPolicyRevision = frame.classroomState?.authPassThroughPolicyRevision
    ?? frame.command?.authPassThrough?.policyRevision;
  return { controlRevision, ...(Number.isSafeInteger(appliedAuthPolicyRevision) ? { appliedAuthPolicyRevision } : {}) };
}

export function assertPrivateLifecycleAdvanced(before, after) {
  assert.deepEqual(lifecycleToken(after), { ...lifecycleToken(before), threadGeneration: before.threadGeneration + 1 });
}

// This models the packaged client wire payload; it never claims browser enforcement.
export function focusClassroomAcknowledgement(frame, school, index, type, commandId) {
  assert.ok(['focus-tab', 'stop-focus'].includes(type));
  const transport = commandTransportAcknowledgement(frame, school, index, type, commandId);
  const state = frame.classroomState;
  assert.ok(state, 'Enabled Focus lifecycle requires its delivered classroom snapshot');
  assert.equal(state.revision, transport.controlRevision, 'Classroom revision must match the exact delivered binding');
  assert.equal(state.teachingSessionId, school.currentSession);
  assert.ok(!state.supervisionContextId, 'Teaching fixture must not accept a supervision replacement');
  const focus = state.restrictions?.focus;
  let focusStatus;
  if (type === 'focus-tab') {
    assert.equal(focus?.active, true);
    assert.ok(typeof focus.assignmentId === 'string' && focus.assignmentId.trim().length > 0,
      'Focus assignment must come from the delivered snapshot');
    assert.equal(focus.tabRef, 'synthetic-tab-' + index);
    assert.equal(focus.observedRevision, 9);
    focusStatus = { state: 'active', assignmentId: focus.assignmentId };
  } else {
    assert.notEqual(focus?.active, true, 'Stop Focus must deliver a cleared Focus restriction');
    focusStatus = { state: 'inactive' };
  }
  return { transport, focusStatus, studentId: frame.studentId,
    realtimeBinding: createHash('sha256').update('classpilot:public-realtime-binding:v1').update('\u0000').update(frame.studentSessionId).digest('base64url'),
    classroomAck: {
    type: 'classroom-state-ack', appliedRevision: state.revision,
    ...(transport.appliedAuthPolicyRevision !== undefined
      ? { appliedAuthPolicyRevision: transport.appliedAuthPolicyRevision } : {}),
    outcome: 'applied', focusStatus, teachingSessionId: state.teachingSessionId,
    extensionVersion: '2.9.7', timestamp: new Date().toISOString(),
  } };
}

export function publicFocusProjectionMatches(row, expected) {
  const state = row?.classroomState;
  if (row?.studentId !== expected.studentId || row.realtimeBinding !== expected.realtimeBinding
    || state?.teachingSessionId !== expected.classroomAck.teachingSessionId || state.supervisionContextId
    || state.revision !== expected.classroomAck.appliedRevision || row.enforcementHealth !== 'synced') return false;
  const focus = state.restrictions?.focus;
  return expected.focusStatus.state === 'active'
    ? focus?.active === true && focus.assignmentId === expected.focusStatus.assignmentId
    : focus?.active !== true;
}
