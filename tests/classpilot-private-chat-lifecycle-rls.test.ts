import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { CLASSPILOT_PRIVATE_CHAT_LIFECYCLE_SQL } from "../src/db/classpilotPrivateChatLifecycleMigration.js";

// Real invoker policies and triggers, including the ordinary DB lane. The
// hermetic role owns no relations and the complete fixture rolls back.
test("private thread ownership and old-writer fences hold under a non-owner FORCE-RLS role", async context => {
  assert.ok(process.env.ADMIN_DATABASE_URL, "Local privileged bootstrap URL is required");
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(new URL(process.env.ADMIN_DATABASE_URL).hostname));
  const client = new pg.Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await client.connect();
  const tag = randomUUID().replaceAll("-", ""), role = `private_chat_rls_${tag}`;
  const rows = [0, 1].map(() => ({ school: randomUUID(), teacher: randomUUID(), student: randomUUID(),
    group: randomUUID(), teaching: randomUUID(), assignment: randomUUID(), thread: randomUUID() }));
  try {
    await client.query(CLASSPILOT_PRIVATE_CHAT_LIFECYCLE_SQL);
    await client.query("BEGIN");
    await client.query(`CREATE ROLE ${role} NOSUPERUSER NOBYPASSRLS NOINHERIT NOLOGIN`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    // Match the restricted application writer's grants; FORCE RLS and invoker
    // parent guards remain active on the actual non-owner role.
    await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await client.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    await client.query("SELECT set_config('app.is_super','on',true)");
    for (const row of rows) {
      await client.query("INSERT INTO schools(id,name,domain,status,plan_status) VALUES($1,'Private RLS',$2,'active','active')", [row.school, `${row.school}.example.edu`]);
      await client.query("INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'Private','RLS')", [row.teacher, `${row.teacher}@example.edu`]);
      await client.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,'teacher','active')", [row.school, row.teacher]);
      await client.query("INSERT INTO students(id,school_id,first_name,last_name,status) VALUES($1,$2,'Private','RLS','active')", [row.student, row.school]);
      await client.query("INSERT INTO groups(id,school_id,teacher_id,name,group_type,status) VALUES($1,$2,$3,'Private RLS','admin_class','active')", [row.group, row.school, row.teacher]);
      await client.query("INSERT INTO group_teachers(group_id,teacher_id,role) VALUES($1,$2,'primary')", [row.group, row.teacher]);
      await client.query("INSERT INTO teaching_sessions(id,school_id,group_id,teacher_id) VALUES($1,$2,$3,$4)", [row.teaching, row.school, row.group, row.teacher]);
      await client.query("INSERT INTO classpilot_session_students(id,school_id,teaching_session_id,group_id,student_id,captured_at) VALUES($1,$2,$3,$4,$5,now())", [row.assignment, row.school, row.teaching, row.group, row.student]);
      await client.query("INSERT INTO settings(school_id,school_name,ws_shared_key,private_chat_lifecycle_required) VALUES($1,'Private RLS','synthetic',true)", [row.school]);
      await client.query("INSERT INTO session_settings(school_id,session_id) VALUES($1,$2)", [row.school, row.teaching]);
      await client.query("INSERT INTO classpilot_private_chat_threads(id,school_id,student_id,teaching_session_id,authority_assignment_id) VALUES($1,$2,$3,$4,$5)", [row.thread, row.school, row.student, row.teaching, row.assignment]);
    }
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query("SELECT set_config('app.is_super','',true),set_config('app.school_id','',true)");
    const assertSqlError = async (code: string, query: string, values: unknown[]) => {
      await client.query("SAVEPOINT expected_failure");
      try { await assert.rejects(client.query(query, values), { code }); }
      finally { await client.query("ROLLBACK TO SAVEPOINT expected_failure"); }
    };
    await context.test("the actual role cannot bypass or own the forced invoker policy", async () => {
      const roleState = await client.query("SELECT rolsuper,rolbypassrls,(SELECT count(*)::int FROM pg_tables WHERE schemaname='public' AND tableowner=current_user) AS owned FROM pg_roles WHERE rolname=current_user");
      assert.deepEqual(roleState.rows, [{ rolsuper: false, rolbypassrls: false, owned: 0 }]);
      const policy = await client.query("SELECT c.relrowsecurity,c.relforcerowsecurity,p.polqual IS NOT NULL AS has_using,p.polwithcheck IS NOT NULL AS has_check FROM pg_class c JOIN pg_policy p ON p.polrelid=c.oid WHERE c.oid='classpilot_private_chat_threads'::regclass AND p.polname='tenant_isolation'");
      assert.deepEqual(policy.rows, [{ relrowsecurity: true, relforcerowsecurity: true, has_using: true, has_check: true }]);
      const triggers = await client.query("SELECT DISTINCT p.prosecdef FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgname IN ('cp_private_chat_thread_parent','cp_private_chat_message_lifecycle','cp_private_chat_settings_epoch')");
      assert.deepEqual(triggers.rows, [{ prosecdef: false }]);
    });
    await context.test("no GUC reveals no protected thread, and an explicit school only reveals its own row", async () => {
      assert.deepEqual((await client.query("SELECT id FROM classpilot_private_chat_threads WHERE id=ANY($1::varchar[])", [rows.map(row => row.thread)])).rows, []);
      await client.query("SELECT set_config('app.school_id',$1,true)", [rows[0]!.school]);
      assert.deepEqual((await client.query("SELECT id FROM classpilot_private_chat_threads WHERE id=ANY($1::varchar[])", [rows.map(row => row.thread)])).rows, [{ id: rows[0]!.thread }]);
      assert.equal((await client.query("UPDATE classpilot_private_chat_threads SET generation=generation WHERE id=$1", [rows[1]!.thread])).rowCount, 0);
      assert.equal((await client.query("DELETE FROM classpilot_private_chat_threads WHERE id=$1", [rows[1]!.thread])).rowCount, 0);
    });
    await context.test("the invoker parent guard refuses a hidden foreign tenant and immutable ownership refuses reassignment", async () => {
      const own = rows[0]!, foreign = rows[1]!;
      // The BEFORE trigger reads the tenant-filtered assignment and rejects
      // before PostgreSQL reaches the already catalog-verified WITH CHECK.
      await assertSqlError("23514", "INSERT INTO classpilot_private_chat_threads(school_id,student_id,teaching_session_id,authority_assignment_id) VALUES($1,$2,$3,$4)", [foreign.school, foreign.student, foreign.teaching, foreign.assignment]);
      await assertSqlError("23514", "UPDATE classpilot_private_chat_threads SET school_id=$1 WHERE id=$2", [foreign.school, own.thread]);
      await assertSqlError("23514", "UPDATE classpilot_private_chat_threads SET authority_assignment_id=$1 WHERE id=$2", [foreign.assignment, own.thread]);
      await assertSqlError("23514", "UPDATE classpilot_private_chat_threads SET generation=generation+2 WHERE id=$1", [own.thread]);
    });
    await context.test("an old image cannot insert unstamped private rows or clear the sticky writer fence", async () => {
      const own = rows[0]!;
      await assertSqlError("23514", "INSERT INTO chat_messages(school_id,session_id,student_id,sender_id,sender_type,content) VALUES($1,$2,$3,$4,'teacher','Old image')", [own.school, own.teaching, own.student, own.teacher]);
      await assertSqlError("23514", "UPDATE settings SET private_chat_lifecycle_required=false WHERE school_id=$1", [own.school]);
    });
    await context.test("current stamped writes succeed but another tenant's tuple and retired epochs fail", async () => {
      const own = rows[0]!, foreign = rows[1]!;
      const insert = "INSERT INTO chat_messages(school_id,session_id,student_id,sender_id,sender_type,message_type,content,private_chat_thread_id,private_chat_school_epoch,private_chat_activity_epoch,private_chat_generation) VALUES($1,$2,$3,$4,'teacher','message','Protected', $5,1,1,1) RETURNING id";
      assert.equal((await client.query(insert, [own.school, own.teaching, own.student, own.teacher, own.thread])).rowCount, 1);
      await assertSqlError("23514", insert, [own.school, own.teaching, own.student, own.teacher, foreign.thread]);
      await client.query("UPDATE settings SET student_messaging_enabled=false WHERE school_id=$1", [own.school]);
      await client.query("UPDATE settings SET student_messaging_enabled=true WHERE school_id=$1", [own.school]);
      await assertSqlError("23514", insert, [own.school, own.teaching, own.student, own.teacher, own.thread]);
    });
  } finally { await client.query("ROLLBACK").catch(() => {}); await client.end(); }
});
