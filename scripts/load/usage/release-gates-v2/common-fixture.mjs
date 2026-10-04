import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { moduleFromApplication, requireFromApplication } from './application.mjs';
const uuid = label => { const value = createHash('sha256').update('release297-common-v2:' + label).digest('hex'); return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20, 32)}`; };
export function commonFixture(today) {
  return { schemaVersion: 2, kind: 'small-common-blackbox', today,
    schools: [0, 1].map(index => { const id = uuid(`school:${index}`), staff = uuid(`staff:${index}`);
      return { index, id, staff, email: `scale-${staff}@example.test`, teachers: Array.from({ length: 100 }, (_, n) => uuid(`teacher:${index}:${n}`)),
        groups: Array.from({ length: 100 }, (_, n) => uuid(`group:${index}:${n}`)), students: Array.from({ length: 500 }, (_, n) => uuid(`student:${index}:${n}`)),
        devices: Array.from({ length: 500 }, (_, n) => `synthetic-scale-${uuid(`device:${index}:${n}`)}`), studentSessions: Array.from({ length: 500 }, (_, n) => uuid(`session:${index}:${n}`)) }; }) };
}
export async function seedCommonFixture() {
  const pg = requireFromApplication('pg');
  assert.equal(process.env.NODE_ENV, 'test'); assert.match(new URL(process.env.ADMIN_DATABASE_URL).pathname, /^\/schoolpilot_redesign_usage_scale_[a-f0-9]{12}$/);
  const time = await moduleFromApplication('util/schoolTime.js');
  const today = time.localDateInTimeZone(new Date(), 'America/New_York'), fixture = commonFixture(today);
  const admin = new pg.Pool({ connectionString: process.env.ADMIN_DATABASE_URL, max: 2, statement_timeout: 15_000 });
  const password = process.env.RELEASE297_FIXTURE_PASSWORD, { hash } = requireFromApplication('bcryptjs');
  assert.ok(password?.length >= 32); const passwordHash = await hash(password, 10);
  try {
    assert.equal(Number((await admin.query('SELECT COUNT(*) FROM schools')).rows[0].count), 0, 'Never seed an existing school database');
    for (const school of fixture.schools) {
      await admin.query("INSERT INTO schools(id,name,domain,status,is_active,plan_status,school_timezone) VALUES($1,$2,'example.test','active',true,'active','America/New_York')", [school.id, 'Synthetic Blackbox ' + school.index]);
      await admin.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')", [school.id]);
      await admin.query("INSERT INTO settings(school_id,school_name,ws_shared_key,retention_hours,enable_tracking_hours,grade_levels) VALUES($1,'Synthetic Blackbox','synthetic',8760,false,'{6,7,8,9,10}')", [school.id]);
      await admin.query("INSERT INTO users(id,email,first_name,last_name,password) SELECT id,'scale-'||id||'@example.test','Synthetic','Scale',$2 FROM unnest($1::text[]) id", [[school.staff, ...school.teachers], passwordHash]);
      await admin.query("INSERT INTO school_memberships(school_id,user_id,role,status) SELECT $1,id,CASE WHEN id=$2 THEN 'school_admin' ELSE 'teacher' END,'active' FROM unnest($3::text[]) id", [school.id, school.staff, [school.staff, ...school.teachers]]);
      await admin.query("INSERT INTO students(id,school_id,first_name,last_name,status,grade_level,email) SELECT id,$2,'Synthetic','Scale','active',(6+(ordinality-1)%5)::text,'scale-'||id||'@example.test' FROM unnest($1::text[]) WITH ORDINALITY student(id,ordinality)", [school.students, school.id]);
      const writer = await admin.connect();
      try { await writer.query('BEGIN');
        await writer.query("INSERT INTO groups(id,school_id,teacher_id,name,group_type) SELECT id,$2,($3::text[])[ordinality::int],'Synthetic Class '||ordinality,'admin_class' FROM unnest($1::text[]) WITH ORDINALITY class(id,ordinality)", [school.groups, school.id, school.teachers]);
        await writer.query("INSERT INTO group_teachers(group_id,teacher_id,role) SELECT id,($2::text[])[ordinality::int],'primary' FROM unnest($1::text[]) WITH ORDINALITY class(id,ordinality)", [school.groups, school.teachers]);
        await writer.query('COMMIT');
      } catch (error) { await writer.query('ROLLBACK'); throw error; } finally { writer.release(); }
      await admin.query("INSERT INTO group_students(student_id,group_id) SELECT id,($2::text[])[((ordinality-1)/5)::int+1] FROM unnest($1::text[]) WITH ORDINALITY student(id,ordinality)", [school.students, school.groups]);
      await admin.query("INSERT INTO devices(device_id,school_id,class_id) SELECT id,$2,($3::text[])[((ordinality-1)/5)::int+1] FROM unnest($1::text[]) WITH ORDINALITY device(id,ordinality)", [school.devices, school.id, school.groups]);
      await admin.query("INSERT INTO student_sessions(id,student_id,device_id,auth_kind,is_active) SELECT id,($2::text[])[ordinality::int],($3::text[])[ordinality::int],'managed_profile',true FROM unnest($1::text[]) WITH ORDINALITY session(id,ordinality)", [school.studentSessions, school.students, school.devices]);
      const start = new Date(Date.now() - 3600_000).toISOString().replace('T', ' ').replace('Z', '');
      const sessions = school.groups.map((group, n) => ({ id: uuid(`teaching:${school.index}:${n}`), group, teacher: school.teachers[n] }));
      await admin.query('INSERT INTO teaching_sessions(id,school_id,group_id,teacher_id,start_time,end_time) SELECT id,$1,"group",teacher,$3::timestamp,NULL FROM jsonb_to_recordset($2::jsonb) AS item(id text,"group" text,teacher text)', [school.id, JSON.stringify(sessions), start]);
      await admin.query('INSERT INTO classpilot_session_students(school_id,teaching_session_id,group_id,student_id,captured_at) SELECT $1,item.id,item."group",($3::text[])[item.ordinal*5+member.n+1],$4::timestamptz FROM jsonb_to_recordset($2::jsonb) AS item(id text,"group" text,ordinal int) CROSS JOIN generate_series(0,4) member(n)', [school.id, JSON.stringify(sessions.map((row, ordinal) => ({ ...row, ordinal }))), school.students, start]);
      school.currentSession = sessions[0].id;
    }
    const [{ default: db }, storage, tenant, context] = await Promise.all([moduleFromApplication('db.js'), moduleFromApplication('services/storage.js'), moduleFromApplication('middleware/tenantContext.js'), moduleFromApplication('db/tenantContext.js')]);
    for (const school of fixture.schools) await tenant.runWithTenantContext({ schoolId: school.id }, async () => {
      const client = context.getTenantStore().client;
      const role = (await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
      assert.equal(role.rolsuper, false); assert.equal(role.rolbypassrls, false);
      assert.equal(await storage.backfillOpenTeachingSessionRosterSnapshots(db, school.id), 100);
      assert.equal(Number((await client.query('SELECT COUNT(*) FROM students WHERE school_id<>$1', [school.id])).rows[0].count), 0);
      assert.equal(Number((await client.query('SELECT COUNT(*) FROM classpilot_session_staff WHERE school_id=$1', [school.id])).rows[0].count), 100);
      assert.equal(Number((await client.query('SELECT COUNT(*) FROM classpilot_student_control_states WHERE school_id=$1', [school.id])).rows[0].count), 500);
    });
    await admin.query('ANALYZE'); await tenant.drainTenantContextReleases?.();
    const dbModule = await moduleFromApplication('db.js'); await Promise.all([dbModule.pool.end(), dbModule.sessionPool.end()]);
    return { ...fixture, logicalFixtureSha256: createHash('sha256').update(JSON.stringify(fixture.schools)).digest('hex'), password };
  } finally { await admin.end(); }
}
