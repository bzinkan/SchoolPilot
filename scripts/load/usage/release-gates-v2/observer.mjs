import assert from 'node:assert/strict';
import { requireFromApplication, moduleFromApplication } from './application.mjs';
import { seedCommonFixture } from './common-fixture.mjs';
import { profileFor } from './contracts.mjs';
const pg = requireFromApplication('pg');
const pool = new pg.Pool({ connectionString: process.env.ADMIN_DATABASE_URL, max: 2, statement_timeout: 15_000 });
let fixture;
const wall = value => new Date(value).toISOString().replace('T', ' ').replace('Z', '');
process.send({ kind: 'ready', pid: process.pid, pools: { observer: 2 } });
process.on('message', async request => {
  try {
    let value;
    if (request.operation === 'seed') value = fixture = await seedCommonFixture();
    else if (request.operation === 'initialize') {
      fixture = request.value;
      const { hash } = requireFromApplication('bcryptjs'); const passwordHash = await hash(fixture.password, 10);
      for (const school of fixture.schools) {
        await pool.query('UPDATE users SET password=$1 WHERE id=ANY($2::text[])', [passwordHash, [school.staff, school.teachers[0]]]);
        const rows = (await pool.query('SELECT id FROM teaching_sessions WHERE school_id=$1 AND group_id=$2 AND end_time IS NULL', [school.id, school.groups[0]])).rows;
        assert.equal(rows.length, 1); school.currentSession = rows[0].id;
      }
      value = fixture;
    } else if (request.operation === 'snapshot') {
      const expected = fixture.schools.flatMap(school => school.students.map((student_id, n) => ({ school_id: school.id,
        student_id, device_id: school.devices[n], session_id: school.studentSessions[n] })));
      const rows = (await pool.query(`SELECT h.school_id,h.student_id,COUNT(*)::int AS count,
        COUNT(*) FILTER(WHERE s.id IS NULL OR s.school_id<>h.school_id OR d.device_id IS NULL OR d.school_id<>h.school_id
          OR expected.device_id IS DISTINCT FROM h.device_id OR session.id IS NULL OR session.is_active IS DISTINCT FROM true)::int AS invalid
        FROM heartbeats h LEFT JOIN students s ON s.id=h.student_id LEFT JOIN devices d ON d.device_id=h.device_id
        LEFT JOIN jsonb_to_recordset($2::jsonb) AS expected(school_id text,student_id text,device_id text,session_id text)
          ON expected.school_id=h.school_id AND expected.student_id=h.student_id
        LEFT JOIN student_sessions session ON session.id=expected.session_id AND session.student_id=h.student_id AND session.device_id=h.device_id
        WHERE h.timestamp >= $1::timestamp GROUP BY h.school_id,h.student_id ORDER BY h.school_id,h.student_id`, [wall(request.value.since), JSON.stringify(expected)])).rows;
      value = { observedAt: new Date().toISOString(), rows, total: rows.reduce((sum, row) => sum + row.count, 0), invalid: rows.reduce((sum, row) => sum + row.invalid, 0) };
    } else if (request.operation === 'verify') {
      assert.equal(fixture.schools.length, 2);
      const expectedTables = process.env.RLS_ENABLED_TABLES.split(',').sort();
      const catalog = (await pool.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY($1::text[]) ORDER BY relname", [expectedTables])).rows;
      assert.deepEqual(catalog.map(row => row.relname), expectedTables); assert.ok(catalog.every(row => row.relrowsecurity && row.relforcerowsecurity));
      const migrations = (await pool.query('SELECT id,checksum,status FROM schema_migrations ORDER BY id')).rows;
      assert.ok(migrations.every(row => row.status === 'complete'));
      const app = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, statement_timeout: 15_000 });
      try {
        const client = await app.connect();
        try {
          const role = (await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
          assert.equal(role.rolsuper, false); assert.equal(role.rolbypassrls, false);
          assert.equal(Number((await client.query('SELECT COUNT(*) FROM students')).rows[0].count), 0);
          for (const school of fixture.schools) {
            await client.query("SELECT set_config('app.school_id',$1,false)", [school.id]);
            assert.equal(Number((await client.query('SELECT COUNT(*) FROM students WHERE school_id<>$1', [school.id])).rows[0].count), 0);
            assert.equal(Number((await client.query('SELECT COUNT(*) FROM students')).rows[0].count), 500);
          }
          await client.query('RESET app.school_id');
          assert.equal(Number((await client.query('SELECT COUNT(*) FROM students')).rows[0].count), 0);
        } finally { client.release(); }
      } finally { await app.end(); }
      value = { passed: true, catalog, migrations, restrictedRole: true, crossSchool: true, resetScope: true };
    } else if (request.operation === 'queryPlans') {
      const {recordUsageReportCosts}=await import('./report-cost.mjs');
      value=await recordUsageReportCosts({pool,fixture,request:request.value});
    } else if (request.operation === 'correctness') {
      if(request.value.classroom){
        const commands=(await pool.query(`SELECT command.id,command.school_id,command.teacher_id,command.teaching_session_id,command.target_scope,
          command.command_type,target.student_id,target.student_session_id,target.device_id,target.status,
          COUNT(target.id) OVER(PARTITION BY command.id)::int AS target_count
          FROM classpilot_commands command LEFT JOIN classpilot_command_targets target ON target.command_id=command.id ORDER BY command.id`)).rows;
        assert.ok(commands.length>0);
        for(const row of commands){
          const school=fixture.schools.find(item=>item.id===row.school_id);assert.ok(school);
          const index=['lock-screen','unlock-screen'].includes(row.command_type)?0:['focus-tab','stop-focus'].includes(row.command_type)?1:null;
          assert.notEqual(index,null);assert.equal(row.teacher_id,school.teachers[0]);assert.equal(row.teaching_session_id,school.currentSession);
          assert.equal(row.target_scope,'students');assert.equal(row.target_count,1);assert.equal(row.student_id,school.students[index]);
          assert.equal(row.student_session_id,school.studentSessions[index]);assert.equal(row.device_id,school.devices[index]);assert.equal(row.status,'completed');
        }
        const messages=(await pool.query(`SELECT school_id,session_id,student_id,student_session_id,device_id,recipient_id,sender_id,delivery_status
          FROM chat_messages WHERE sender_type='teacher' ORDER BY school_id,id`)).rows;
        assert.ok(messages.length>0);
        for(const row of messages){const school=fixture.schools.find(item=>item.id===row.school_id);assert.ok(school);
          assert.equal(row.session_id,school.currentSession);assert.equal(row.sender_id,school.teachers[0]);assert.equal(row.student_id,school.students[2]);
          assert.equal(row.recipient_id,school.students[2]);assert.equal(row.student_session_id,school.studentSessions[2]);assert.equal(row.device_id,school.devices[2]);
          assert.ok(['delivered','expired'].includes(row.delivery_status));}
        const currentProfile=profileFor(process.env.RELEASE297_PROFILE),repetitions=currentProfile.kind==='mixed'?currentProfile.rounds:1;
        assert.equal(commands.length,repetitions*8);assert.equal(messages.length,repetitions*4);
        assert.equal(messages.filter(row=>row.delivery_status==='delivered').length,repetitions*2);
        assert.equal(messages.filter(row=>row.delivery_status==='expired').length,repetitions*2);
        process.send({id:request.id,value:{passed:true,commandTargetsChecked:commands.length,privateBindingsChecked:messages.length,exactRecipientOnly:true}});return;
      }
      if (request.value.audit) {
        const records = (await pool.query(`SELECT school_id,user_id,entity_type,entity_id,metadata FROM audit_logs
          WHERE action='classpilot.usage.export' ORDER BY school_id,entity_type`)).rows;
        assert.equal(records.length, 8);
        for (const school of fixture.schools) for (const scope of ['school','grade','class','student']) {
          const entityId = ({ school: school.id, grade: '6', class: school.groups[0], student: school.students[0] })[scope];
          const matches = records.filter(row => row.school_id === school.id && row.user_id === school.staff
            && row.entity_type === 'classpilot_usage_' + scope && row.entity_id === entityId && row.metadata.scope === scope
            && row.metadata.from === fixture.from && row.metadata.to === fixture.today);
          assert.equal(matches.length, 1);
        }
        const coverage = (await pool.query(`SELECT school_id,usage_date::text,processed_through,is_final FROM classpilot_usage_rollup_days
          WHERE usage_date=ANY($1::date[]) ORDER BY school_id,usage_date`, [[fixture.today,fixture.heavyDate,fixture.emptyDate,fixture.gapDate]])).rows;
        for (const school of fixture.schools) {
          const schoolRows = coverage.filter(row => row.school_id === school.id);
          assert.equal(schoolRows.some(row => row.usage_date === fixture.gapDate), false);
          assert.equal(schoolRows.find(row => row.usage_date === fixture.emptyDate)?.is_final, true);
          assert.equal(schoolRows.find(row => row.usage_date === fixture.heavyDate)?.is_final, true);
          const live = schoolRows.find(row => row.usage_date === fixture.today);
          assert.equal(live?.is_final, false); assert.equal(new Date(live.processed_through).toISOString(), request.value.cutoff);
        }
        process.send({ id: request.id, value: { passed: true, auditRecords: records, coverage } }); return;
      }
      const { currentObservationSeconds, currentObservationDiagnostics, currentObservationFixtureViolations } = await import('/diagnostic/scripts/load/usage/local-usage-scale.mjs');
      const time = await moduleFromApplication('util/schoolTime.js'), cutoff = new Date(request.value.cutoff), rows = [];
      for (const school of fixture.schools) {
        const bounds = [school.id, wall(time.localDateStartUtc(fixture.today, 'America/New_York')), wall(cutoff)];
        const raw = (await pool.query(`SELECT student_id,(EXTRACT(EPOCH FROM timestamp)*1000000)::bigint::text AS timestamp_microseconds,
          active_tab_url IS NOT DISTINCT FROM 'https://ixl.com/lesson' AS expected_url,
          ai_category IS NOT DISTINCT FROM 'educational' AS expected_classification,
          NULLIF(teacher_intent_source,'') IS NULL AS expected_teacher_intent
          FROM heartbeats WHERE school_id=$1 AND timestamp >= $2::timestamp AND timestamp < $3::timestamp ORDER BY student_id,timestamp,id`, bounds)).rows;
        const counts = (await pool.query(`WITH observed AS (SELECT student_id,MIN(timestamp) AS first_at,MAX(timestamp) AS last_at
          FROM heartbeats WHERE school_id=$1 AND timestamp >= $2::timestamp AND timestamp < $3::timestamp GROUP BY student_id),
          expected AS (SELECT student_id,group_id FROM jsonb_to_recordset($4::jsonb) AS item(student_id text,group_id text)),
          roster AS (SELECT member.student_id,member.group_id,member.captured_at,session.start_time,session.end_time,session.scheduled_end_at
            FROM classpilot_session_students member JOIN teaching_sessions session ON session.id=member.teaching_session_id AND session.school_id=member.school_id
            WHERE member.school_id=$1 AND session.start_time >= $2::timestamp-interval '12 hours' AND session.start_time < $3::timestamp AND (session.end_time IS NULL OR session.end_time >= $2::timestamp)),
          checked AS (SELECT observed.student_id,COUNT(roster.student_id) AS memberships,
            BOOL_AND(roster.group_id=expected.group_id AND roster.start_time<=observed.first_at AND roster.captured_at AT TIME ZONE 'UTC'<=observed.first_at
              AND (roster.end_time IS NULL OR roster.end_time>observed.last_at) AND (roster.scheduled_end_at IS NULL OR roster.scheduled_end_at AT TIME ZONE 'UTC'>observed.last_at)
              AND roster.start_time+interval '12 hours'>observed.last_at) AS covers_observations
            FROM observed LEFT JOIN expected USING(student_id) LEFT JOIN roster USING(student_id) GROUP BY observed.student_id)
          SELECT (SELECT COUNT(*)::int FROM classpilot_ai_decisions WHERE school_id=$1 AND created_at >= $2::timestamp) AS "currentAiDecisionRows",
            (SELECT COUNT(*)::int FROM checked WHERE memberships<>1 OR covers_observations IS DISTINCT FROM true) AS "invalidRosterStudents"`,
          [...bounds, JSON.stringify(school.students.map((student_id, index) => ({ student_id, group_id: school.groups[Math.floor(index / 5)] })))] )).rows[0];
        const violations = currentObservationFixtureViolations(raw, school.students, counts);
        assert.ok(Object.values(violations).every(n => n === 0));
        const totals = currentObservationSeconds(raw, cutoff);
        rows.push({ schoolIndex: school.index, violations, secondsByStudent: [...totals], expectedSeconds: [...totals.values()].reduce((a, b) => a + b, 0), timestampPrecision: currentObservationDiagnostics(raw, cutoff) });
      }
      value = { cutoff: cutoff.toISOString(), schools: rows };
    } else if (request.operation === 'shutdown') { await pool.end(); await (await moduleFromApplication('services/errorMonitor.js')).default.disposeAndWait(); process.send({ id: request.id, value: true }, () => process.exit(0)); return; }
    else throw Error('Unknown observer operation');
    process.send({ id: request.id, value });
  } catch (error) { process.send({ id: request.id, error: { code: error.code || 'OBSERVER_FAILED', name: error.name } }); }
});
