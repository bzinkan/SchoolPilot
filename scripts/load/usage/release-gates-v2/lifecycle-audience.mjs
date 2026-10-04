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

export function verifyClassroomBindings({ commands, messages, deliveries,threads,schoolSettings,activitySettings,memberships,staff,fixture,profile }) {
  const audience = lifecycleAudience(profile, fixture.schools);
  const evidence = { declaredSchoolIndices: audience.schoolIndices, repetitions: audience.repetitions,
    observedCommands: commands.length, expectedCommands: audience.commands,
    observedMessages: messages.length, expectedMessages: audience.messages };
  const require = (condition, predicate) => {
    if (!condition) throw Object.assign(new Error('Classroom oracle failed'), {
      code: 'CLASSROOM_ORACLE_' + predicate, publicOracleEvidence: { ...evidence, predicate } });
  };
  const commandCounts = new Map(), deliveryCounts = new Map(),generationCounts=new Map();let attemptedExpiredMessages=0,unattemptedExpiredMessages=0;
  require([deliveries,threads,schoolSettings,activitySettings,memberships,staff].every(Array.isArray),'PARENT_SNAPSHOT');
  const childByMessage=new Map(),messagesById=new Map(messages.map(row=>[row.id,row]));
  require(messagesById.size===messages.length,'MESSAGE_IDENTITIES');
  for(const child of deliveries){
    require(messagesById.has(child.chat_message_id),'DELIVERY_PARENT');
    const children=childByMessage.get(child.chat_message_id)??[];children.push(child);childByMessage.set(child.chat_message_id,children);
  }
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
    require(row.session_id === school.currentSession && row.supervision_context_id===null && row.sender_id === school.teachers[0]
      &&staff.some(parent=>parent.school_id===row.school_id&&parent.teaching_session_id===row.session_id&&parent.staff_id===row.sender_id), 'MESSAGE_AUTHORITY');
    require(row.student_id === school.students[2]&&row.student_session_id===null,'MESSAGE_TARGET_BINDING');
    const children=childByMessage.get(row.id)??[];require(children.length===1,'DELIVERY_CARDINALITY');const child=children[0];
    require(child.school_id===row.school_id&&child.student_id===row.student_id&&child.teaching_session_id===row.session_id&&child.supervision_context_id===null,'DELIVERY_PARENT');
    require(Number.isSafeInteger(child.attempt_count)&&child.attempt_count>=0
      &&(child.attempt_count===0?child.last_attempt_at===null:child.last_attempt_at!=null&&Number.isFinite(Date.parse(child.last_attempt_at))),'DELIVERY_ATTEMPT');
    // A never-attempted expired message has no claimed transport binding.
    // It remains distinct from delivered or attempted-expired history.
    const attempted=child.attempt_count>0;
    require(attempted?(child.last_attempt_student_session_id===school.studentSessions[2]&&child.last_attempt_device_id===school.devices[2]
      &&row.device_id===school.devices[2]&&row.recipient_id===school.devices[2]):
      (child.last_attempt_student_session_id===null&&child.last_attempt_device_id===null&&row.device_id===null&&row.recipient_id===null),'MESSAGE_TARGET_BINDING');
    const matchingThreads=threads.filter(parent=>parent.id===row.private_chat_thread_id);require(matchingThreads.length===1,'LIFECYCLE_PARENT');const thread=matchingThreads[0];
    require(thread.school_id===row.school_id&&thread.student_id===row.student_id&&thread.teaching_session_id===row.session_id&&thread.supervision_context_id===null
      &&memberships.some(parent=>parent.id===thread.authority_assignment_id&&parent.school_id===row.school_id&&parent.student_id===row.student_id&&parent.teaching_session_id===row.session_id),'LIFECYCLE_PARENT');
    const schools=schoolSettings.filter(parent=>parent.school_id===row.school_id),activities=activitySettings.filter(parent=>parent.school_id===row.school_id&&parent.session_id===row.session_id&&parent.supervision_context_id===null);
    require(schools.length===1&&activities.length===1,'LIFECYCLE_PARENT');
    require(Number.isSafeInteger(row.private_chat_generation)&&row.private_chat_generation>=1&&row.private_chat_generation<=audience.repetitions
      &&thread.generation===audience.repetitions+1&&Number.isSafeInteger(row.private_chat_school_epoch)&&row.private_chat_school_epoch>=1
      &&row.private_chat_school_epoch===schools[0].private_chat_epoch&&Number.isSafeInteger(row.private_chat_activity_epoch)&&row.private_chat_activity_epoch>=1
      &&row.private_chat_activity_epoch===activities[0].private_chat_epoch&&schools[0].student_messaging_enabled===true&&activities[0].chat_enabled===true,'LIFECYCLE_FENCE');
    const status=row.delivery_status==='delivered'?'delivered':'expired';
    if(status==='delivered')require(attempted&&child.state==='delivered'&&row.delivered_at!=null&&child.delivered_at!=null,'MESSAGE_STATUS');
    else require(row.delivery_status==='sent'&&row.delivered_at===null&&child.delivered_at===null
      &&['queued','leased','attempted','retry','expired'].includes(child.state)&&thread.generation>row.private_chat_generation,'MESSAGE_STATUS');
    if(status==='expired'){if(attempted)attemptedExpiredMessages++;else unattemptedExpiredMessages++;}
    const generationKey=school.index+':'+row.private_chat_generation+':'+status;
    generationCounts.set(generationKey,(generationCounts.get(generationKey)??0)+1);
    const key = school.index + ':' + status;
    deliveryCounts.set(key, (deliveryCounts.get(key) ?? 0) + 1);
  }
  require(commands.length === audience.commands, 'COMMAND_CARDINALITY');
  require(messages.length === audience.messages, 'MESSAGE_CARDINALITY');
  for (const index of audience.schoolIndices) {
    require(['lock-screen', 'unlock-screen', 'focus-tab', 'stop-focus'].every(type => commandCounts.get(index + ':' + type) === audience.repetitions), 'COMMAND_TYPE_COUNTS');
    require(['delivered', 'expired'].every(status => deliveryCounts.get(index + ':' + status) === audience.repetitions), 'DELIVERY_COUNTS');
    for(let generation=1;generation<=audience.repetitions;generation++)require(['delivered','expired'].every(status=>generationCounts.get(index+':'+generation+':'+status)===1),'GENERATION_COUNTS');
  }
  return { passed: true, ...evidence, commandTargetsChecked: commands.length,
    privateBindingsChecked: messages.length,attemptedExpiredMessages,unattemptedExpiredMessages,exactRecipientOnly: true };
}

const oraclePredicates = new Set(['DECLARED_AUDIENCE', 'COMMAND_TYPE', 'COMMAND_AUTHORITY',
  'COMMAND_RECIPIENT_COUNT', 'COMMAND_TARGET_BINDING', 'COMMAND_TARGET_STATUS',
  'MESSAGE_AUTHORITY', 'MESSAGE_TARGET_BINDING', 'MESSAGE_STATUS','PARENT_SNAPSHOT','MESSAGE_IDENTITIES','DELIVERY_PARENT','DELIVERY_CARDINALITY','DELIVERY_ATTEMPT',
  'LIFECYCLE_PARENT','LIFECYCLE_FENCE','DECLARED_LIVE_ATTEMPT','GENERATION_COUNTS',
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
