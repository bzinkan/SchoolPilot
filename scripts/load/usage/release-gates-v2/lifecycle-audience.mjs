import assert from 'node:assert/strict';

// Positive classroom actions follow only the explicitly offered audience.
// Idle tenant records remain available to negative and RLS checks.
export function lifecycleAudience(profile, schools) {
  const offering = profile.continuousOffering ?? profile.offering;
  assert.ok(Array.isArray(offering?.schoolDevices));
  const schoolIndices = offering.schoolDevices.flatMap((count, index) => {
    assert.ok(Number.isSafeInteger(count) && count >= 0);
    if (count === 0) return [];
    assert.ok(count >= 3, 'Lifecycle requires its three declared control recipients');
    if (schools) {
      const school = schools[index];
      assert.equal(school?.index, index);
      for (const key of ['students', 'devices', 'studentSessions']) {
        assert.ok(Array.isArray(school[key]) && school[key].length >= count);
      }
    }
    return [index];
  });
  assert.ok(schoolIndices.length > 0);
  const repetitions = profile.kind === 'mixed' ? profile.rounds : 1;
  assert.ok(Number.isSafeInteger(repetitions) && repetitions > 0);
  return { schoolIndices, repetitions, commands: schoolIndices.length * repetitions * 4,
    messages: schoolIndices.length * repetitions * 2,
    deliveredMessages: schoolIndices.length * repetitions,
    expiredMessages: schoolIndices.length * repetitions };
}

export function verifyClassroomBindings({ commands, messages, fixture, profile }) {
  const audience = lifecycleAudience(profile, fixture.schools);
  const evidence = { declaredSchoolIndices: audience.schoolIndices, repetitions: audience.repetitions,
    observedCommands: commands.length, expectedCommands: audience.commands,
    observedMessages: messages.length, expectedMessages: audience.messages };
  const require = (condition, predicate) => {
    if (!condition) throw Object.assign(new Error('Classroom oracle failed'), {
      code: 'CLASSROOM_ORACLE_' + predicate, publicOracleEvidence: { ...evidence, predicate } });
  };
  const commandCounts = new Map(), deliveryCounts = new Map();
  for (const row of commands) {
    const school = fixture.schools.find(item => item.id === row.school_id);
    require(school && audience.schoolIndices.includes(school.index), 'DECLARED_AUDIENCE');
    const index = ['lock-screen', 'unlock-screen'].includes(row.command_type) ? 0 : ['focus-tab', 'stop-focus'].includes(row.command_type) ? 1 : null;
    require(index !== null, 'COMMAND_TYPE');
    require(row.teacher_id === school.teachers[0] && row.teaching_session_id === school.currentSession, 'COMMAND_AUTHORITY');
    require(row.target_scope === 'students' && row.target_count === 1, 'COMMAND_RECIPIENT_COUNT');
    require(row.student_id === school.students[index] && row.student_session_id === school.studentSessions[index] && row.device_id === school.devices[index], 'COMMAND_TARGET_BINDING');
    require(row.status === 'completed', 'COMMAND_TARGET_STATUS');
    const key = school.index + ':' + row.command_type;
    commandCounts.set(key, (commandCounts.get(key) ?? 0) + 1);
  }
  for (const row of messages) {
    const school = fixture.schools.find(item => item.id === row.school_id);
    require(school && audience.schoolIndices.includes(school.index), 'DECLARED_AUDIENCE');
    require(row.session_id === school.currentSession && row.sender_id === school.teachers[0], 'MESSAGE_AUTHORITY');
    require(row.student_id === school.students[2] && row.recipient_id === school.students[2] && row.student_session_id === school.studentSessions[2] && row.device_id === school.devices[2], 'MESSAGE_TARGET_BINDING');
    require(['delivered', 'expired'].includes(row.delivery_status), 'MESSAGE_STATUS');
    const key = school.index + ':' + row.delivery_status;
    deliveryCounts.set(key, (deliveryCounts.get(key) ?? 0) + 1);
  }
  require(commands.length === audience.commands, 'COMMAND_CARDINALITY');
  require(messages.length === audience.messages, 'MESSAGE_CARDINALITY');
  for (const index of audience.schoolIndices) {
    require(['lock-screen', 'unlock-screen', 'focus-tab', 'stop-focus'].every(type => commandCounts.get(index + ':' + type) === audience.repetitions), 'COMMAND_TYPE_COUNTS');
    require(['delivered', 'expired'].every(status => deliveryCounts.get(index + ':' + status) === audience.repetitions), 'DELIVERY_COUNTS');
  }
  return { passed: true, ...evidence, commandTargetsChecked: commands.length,
    privateBindingsChecked: messages.length, exactRecipientOnly: true };
}

const oraclePredicates = new Set(['DECLARED_AUDIENCE', 'COMMAND_TYPE', 'COMMAND_AUTHORITY',
  'COMMAND_RECIPIENT_COUNT', 'COMMAND_TARGET_BINDING', 'COMMAND_TARGET_STATUS',
  'MESSAGE_AUTHORITY', 'MESSAGE_TARGET_BINDING', 'MESSAGE_STATUS',
  'COMMAND_CARDINALITY', 'MESSAGE_CARDINALITY', 'COMMAND_TYPE_COUNTS', 'DELIVERY_COUNTS']);
export function sanitizedClassroomOracleFailure(error) {
  const value = error.oracle;
  assert.ok(value && oraclePredicates.has(value.predicate));
  assert.equal(error.code, 'CLASSROOM_ORACLE_' + value.predicate);
  assert.ok(Array.isArray(value.declaredSchoolIndices) && value.declaredSchoolIndices.length >= 1 && value.declaredSchoolIndices.length <= 2);
  assert.equal(new Set(value.declaredSchoolIndices).size, value.declaredSchoolIndices.length);
  assert.ok(value.declaredSchoolIndices.every(index => index === 0 || index === 1));
  const result = { code: error.code, predicate: value.predicate, declaredSchoolIndices: [...value.declaredSchoolIndices] };
  for (const key of ['repetitions', 'observedCommands', 'expectedCommands', 'observedMessages', 'expectedMessages']) {
    assert.ok(Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 1_000_000);
    result[key] = value[key];
  }
  return result;
}
