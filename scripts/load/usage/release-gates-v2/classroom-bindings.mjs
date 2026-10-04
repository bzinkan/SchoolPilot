import assert from 'node:assert/strict';
import {writeFileSync,readFileSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,relative,isAbsolute} from 'node:path';
import {profileFor} from './contracts.mjs';

// The private observer owns a repeatable, read-only native snapshot. Durable
// delivery and lifecycle parents carry different facts than message history.
export async function readClassroomBindings(pool) {
  const client=await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const queries={
      commands:`SELECT command.id,command.school_id,command.teacher_id,command.teaching_session_id,command.target_scope,
        command.command_type,target.student_id,target.student_session_id,target.device_id,target.status,
        COUNT(target.id) OVER(PARTITION BY command.id)::int AS target_count
        FROM classpilot_commands command LEFT JOIN classpilot_command_targets target ON target.command_id=command.id ORDER BY command.id`,
      messages:`SELECT id,school_id,session_id,supervision_context_id,student_id,student_session_id,device_id,recipient_id,sender_id,delivery_status,delivered_at,
        private_chat_thread_id,private_chat_school_epoch,private_chat_activity_epoch,private_chat_generation
        FROM chat_messages WHERE sender_type='teacher' ORDER BY school_id,id`,
      deliveries:`SELECT id,chat_message_id,school_id,teaching_session_id,supervision_context_id,student_id,state,attempt_count,
        last_attempt_at,last_attempt_student_session_id,last_attempt_device_id,delivered_at FROM classpilot_chat_deliveries ORDER BY school_id,id`,
      threads:`SELECT id,school_id,student_id,teaching_session_id,supervision_context_id,authority_assignment_id,generation
        FROM classpilot_private_chat_threads ORDER BY school_id,id`,
      schoolSettings:`SELECT school_id,private_chat_epoch,student_messaging_enabled FROM settings ORDER BY school_id`,
      activitySettings:`SELECT school_id,session_id,supervision_context_id,private_chat_epoch,chat_enabled FROM session_settings ORDER BY school_id,id`,
      memberships:`SELECT id,school_id,teaching_session_id,student_id FROM classpilot_session_students ORDER BY school_id,id`,
      staff:`SELECT school_id,teaching_session_id,staff_id FROM classpilot_session_staff ORDER BY school_id,id`,
    };
    const snapshot={};
    for(const [name,sql] of Object.entries(queries))snapshot[name]=(await client.query(sql)).rows;
    await client.query('COMMIT');
    const bytes=JSON.stringify(snapshot)+'\n';
    writeFileSync('/control/classroom-bindings.private.json',bytes,{flag:'wx',mode:0o600});
    return{snapshot,nativeRowsSha256:createHash('sha256').update(bytes).digest('hex')};
  } catch(error) {await client.query('ROLLBACK');throw error;}
  finally{client.release();}
}

export function verifyClassroomNativeCustody(privateDirectory,metrics){
  const profile=profileFor(metrics.profile);if(!profile.classroomBindingOracle)return;
  const evidence=metrics.preparationSmoke?[metrics.preparationSmokeResult?.classroomBindings]:profile.kind==='mixed'?
    [metrics.continuous?.classroom,...metrics.rounds.map(row=>row.continuousGlobal?.classroom)]:metrics.rounds.map(row=>row.classroomBindings);
  assert.ok(evidence.length>0&&evidence.every(row=>row?.passed===true&&/^[a-f0-9]{64}$/.test(row.nativeRowsSha256??'')));
  const root=realpathSync(privateDirectory),file=realpathSync(join(root,'observer','classroom-bindings.private.json')),rel=relative(root,file);
  assert.ok(!isAbsolute(rel)&&!rel.startsWith('..'),'Native classroom rows escaped private custody');
  const bytes=readFileSync(file),digest=createHash('sha256').update(bytes).digest('hex');
  assert.ok(evidence.every(row=>row.nativeRowsSha256===digest),'Native classroom rows changed or went missing');
  const snapshot=JSON.parse(bytes);assert.ok(['commands','messages','deliveries','threads','schoolSettings','activitySettings','memberships','staff'].every(key=>Array.isArray(snapshot[key])));
  return{verified:true,nativeRowsSha256:digest};
}
