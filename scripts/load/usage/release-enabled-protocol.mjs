import assert from 'node:assert/strict';

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
