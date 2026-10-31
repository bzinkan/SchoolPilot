import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { CLASSPILOT_TODAY_SCHEDULE_SQL, CLASSPILOT_TODAY_CONTRACT_MIGRATION_ID } from "../src/db/classpilotTodayScheduleMigration.js";
import { CLASSPILOT_TODAY_SCHEDULE_CONTRACT_SQL, classpilotTodayScheduleContractMigration, verifyClasspilotTodayScheduleContract } from "../src/db/classpilotTodayScheduleContractMigration.js";

test("Today schedule identities enforce FORCE RLS, immutable history and distinct same-day meetings", async context => {
  const url = process.env.ADMIN_DATABASE_URL;
  assert.ok(url, "A disposable local bootstrap connection is required");
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname));
  const client = new pg.Client({ connectionString: url });
  const role = `today_rls_${randomUUID().replaceAll("-", "")}`;
  const own = { school: randomUUID(), teacher: randomUUID(), group: randomUUID(), change: randomUUID(), occurrence: randomUUID() };
  const other = { school: randomUUID(), teacher: randomUUID(), group: randomUUID(), change: randomUUID(), occurrence: randomUUID() };
  const date = "2026-10-31", zone = "America/New_York";
  const starts = "2026-10-31T13:00:00Z", ends = "2026-10-31T14:00:00Z";
  const insertChange = `INSERT INTO classpilot_today_changes(id,school_id,scheduled_date,timezone_snapshot,status,generation,
    requested_by_user_id,idempotency_key,request_hash,review_snapshot,plan_snapshot,affected_group_ids,cutoff_at,applied_at,applied_by_user_id)
    VALUES($1::text,$2,$3,$4,'applied',1,$5,$1::text,$6,'{}','{}',$7, $8,now(),$5)`;
  const insertOccurrence = `INSERT INTO classpilot_today_occurrences(id,school_id,change_id,scheduled_date,group_id,generation,
    kind,scheduled_start_at,scheduled_end_at,source,primary_teacher_id_snapshot,class_name_snapshot,timezone_snapshot)
    VALUES($1,$2,$3,$4,$5,1,'meeting',$6,$7,'{}',$8,'Synthetic today',$9)`;
  const insertSession = `INSERT INTO teaching_sessions(id,school_id,group_id,teacher_id,scheduled_occurrence_id,scheduled_date,
    scheduled_timezone,scheduled_start_at,scheduled_end_at,scheduled_state,start_time,class_name_snapshot,timezone_snapshot)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9,'active',$8::timestamptz,'Synthetic today',$7)`;
  await client.connect();
  try {
    await client.query("BEGIN");
    // Recreate the expansion posture only inside this rolled-back fixture.
    await client.query("DELETE FROM schema_migrations WHERE id=$1", [CLASSPILOT_TODAY_CONTRACT_MIGRATION_ID]);
    await client.query(CLASSPILOT_TODAY_SCHEDULE_SQL);
    await client.query(CLASSPILOT_TODAY_SCHEDULE_SQL); // bootstrap repeat is safe
    await client.query(`CREATE ROLE ${role} NOSUPERUSER NOBYPASSRLS NOINHERIT NOLOGIN`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await client.query("SELECT set_config('app.is_super','on',true)");
    for (const row of [own, other]) {
      await client.query("INSERT INTO schools(id,name,domain,status,plan_status) VALUES($1,'Synthetic today',$2,'active','active')", [row.school, `${row.school}.example.edu`]);
      await client.query("INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'Synthetic','Today')", [row.teacher, `${row.teacher}@example.edu`]);
      await client.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,'teacher','active')", [row.school, row.teacher]);
      await client.query("INSERT INTO groups(id,school_id,teacher_id,name,group_type,status) VALUES($1,$2,$3,'Synthetic today','admin_class','active')", [row.group, row.school, row.teacher]);
      await client.query("INSERT INTO group_teachers(group_id,teacher_id,role) VALUES($1,$2,'primary')", [row.group, row.teacher]);
      await client.query(insertChange, [row.change, row.school, date, zone, row.teacher, "a".repeat(64), JSON.stringify([row.group]), ends]);
      await client.query(insertOccurrence, [row.occurrence, row.school, row.change, date, row.group, starts, ends, row.teacher, zone]);
    }
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query("SELECT set_config('app.is_super','',true),set_config('app.school_id','',true)");
    const denied = async (code: string, statement: string, values: unknown[] = []) => {
      await client.query("SAVEPOINT expected_today_denial");
      try { await assert.rejects(client.query(statement, values), { code }); }
      finally { await client.query("ROLLBACK TO SAVEPOINT expected_today_denial"); }
    };
    await context.test("actual non-owner role cannot bypass either forced tenant policy", async () => {
      assert.deepEqual((await client.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows, [{ rolsuper: false, rolbypassrls: false }]);
      const policies = await client.query("SELECT c.relrowsecurity,c.relforcerowsecurity,p.polqual IS NOT NULL AS read_policy,p.polwithcheck IS NOT NULL AS write_policy FROM pg_class c JOIN pg_policy p ON p.polrelid=c.oid WHERE c.relname=ANY($1::text[]) AND p.polname='tenant_isolation'", [["classpilot_today_changes", "classpilot_today_occurrences"]]);
      assert.equal(policies.rowCount, 2);
      assert.ok(policies.rows.every(row => row.relrowsecurity && row.relforcerowsecurity && row.read_policy && row.write_policy));
      for (const table of ["classpilot_today_changes", "classpilot_today_occurrences"]) assert.equal((await client.query(`SELECT id FROM ${table}`)).rowCount, 0);
      await client.query("SELECT set_config('app.school_id',$1,true)", [own.school]);
      assert.deepEqual((await client.query("SELECT id FROM classpilot_today_changes")).rows, [{ id: own.change }]);
      assert.equal((await client.query("UPDATE classpilot_today_changes SET revision=revision+1 WHERE id=$1", [other.change])).rowCount, 0);
      await denied("42501", insertChange, [randomUUID(), other.school, date, zone, other.teacher, "b".repeat(64), JSON.stringify([other.group]), ends]);
    });
    await context.test("reviewed identity and occurrence history cannot be rewritten", async () => {
      await denied("23514", "UPDATE classpilot_today_changes SET plan_snapshot='{\"changed\":true}' WHERE id=$1", [own.change]);
      await denied("23514", "UPDATE classpilot_today_changes SET generation=2 WHERE id=$1", [own.change]);
      await denied("23514", "UPDATE classpilot_today_occurrences SET scheduled_end_at=scheduled_end_at+interval '1 minute' WHERE id=$1", [own.occurrence]);
      assert.equal((await client.query("UPDATE classpilot_today_changes SET status='superseded',revision=revision+1 WHERE id=$1", [own.change])).rowCount, 1);
      await denied("23514", "UPDATE classpilot_today_changes SET revision=0 WHERE id=$1", [own.change]);
    });
    await context.test("the old deployed conflict upsert remains compatible during expansion", async () => {
      const id = randomUUID();
      const statement = `INSERT INTO classpilot_scheduled_conflicts(id,school_id,group_id,teacher_id,scheduled_date,block_start_time,block_end_time)
        VALUES($1,$2,$3,$4,'2026-11-01','09:00','10:00')
        ON CONFLICT(school_id,group_id,scheduled_date,block_start_time) DO UPDATE SET status='resolved' RETURNING id`;
      await client.query(statement, [id, own.school, own.group, own.teacher]);
      assert.deepEqual((await client.query(statement, [randomUUID(), own.school, own.group, own.teacher])).rows, [{ id }]);
    });
    await context.test("new rows require an applied same-school/date/generation parent and reviewed group", async () => {
      await denied("23514", insertOccurrence, [randomUUID(), own.school, other.change, date, own.group, starts, ends, own.teacher, zone]);
      await denied("23514", insertOccurrence, [randomUUID(), own.school, own.change, date, own.group, starts, ends, own.teacher, zone]); // superseded header
      const change = randomUUID();
      await client.query(insertChange, [change, own.school, date, zone, own.teacher, "c".repeat(64), JSON.stringify([own.group]), ends]);
      await denied("23514", insertOccurrence, [randomUUID(), own.school, change, "2026-11-01", own.group, starts, ends, own.teacher, zone]);
      await denied("23514", insertOccurrence, [randomUUID(), own.school, change, date, other.group, starts, ends, own.teacher, zone]);
      await denied("23514", insertOccurrence, [randomUUID(), own.school, change, date, own.group, ends, starts, own.teacher, zone]);
    });
    await context.test("second same-day meeting coexists with immutable legacy history and retains one session per meeting", async () => {
      const legacy = randomUUID();
      await client.query(insertSession, [legacy, own.school, own.group, own.teacher, null, date, zone, starts, ends]);
      await client.query("UPDATE teaching_sessions SET end_time=$2,scheduled_state='finalized' WHERE id=$1", [legacy, ends]);
      await denied("23505", insertSession, [randomUUID(), own.school, own.group, own.teacher, null, date, zone, starts, ends]);
      const session = randomUUID();
      await client.query(insertSession, [session, own.school, own.group, own.teacher, own.occurrence, date, zone, starts, ends]);
      await denied("23505", insertSession, [randomUUID(), own.school, own.group, own.teacher, own.occurrence, date, zone, starts, ends]);
      await denied("23514", insertSession, [randomUUID(), own.school, own.group, own.teacher, other.occurrence, date, zone, starts, ends]);
      await denied("23514", "UPDATE teaching_sessions SET scheduled_end_at=scheduled_end_at+interval '1 minute' WHERE id=$1", [session]);
      await denied("23514", "UPDATE teaching_sessions SET scheduled_occurrence_id=$1 WHERE id=$2", [own.occurrence, legacy]);
      assert.equal((await client.query("UPDATE teaching_sessions SET end_time=$2,scheduled_state='finalized' WHERE id=$1", [session, ends])).rowCount, 1);
      assert.equal((await client.query("SELECT id FROM teaching_sessions WHERE school_id=$1 AND group_id=$2 AND scheduled_date=$3", [own.school, own.group, date])).rowCount, 2);
    });
    await context.test("suppression generations cannot masquerade as live meetings", async () => {
      const change = randomUUID(), occurrence = randomUUID();
      await client.query(insertChange, [change, own.school, date, zone, own.teacher, "d".repeat(64), JSON.stringify([own.group]), ends]);
      await client.query("INSERT INTO classpilot_today_occurrences(id,school_id,change_id,scheduled_date,group_id,generation,kind,source,primary_teacher_id_snapshot,class_name_snapshot,timezone_snapshot) VALUES($1,$2,$3,$4,$5,1,'suppression','{}',$6,'Synthetic today',$7)", [occurrence, own.school, change, date, own.group, own.teacher, zone]);
      await denied("23514", insertSession, [randomUUID(), own.school, own.group, own.teacher, occurrence, date, zone, starts, ends]);
    });
    await context.test("coverage conflicts keep separate exact meeting identities even in the same minute", async () => {
      await client.query("RESET ROLE");
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      // A different index layout must fail before dropping the old writer index.
      await client.query("SAVEPOINT expected_contract_drift");
      await client.query("DROP INDEX classpilot_scheduled_conflicts_legacy_unique");
      await client.query("CREATE UNIQUE INDEX classpilot_scheduled_conflicts_legacy_unique ON classpilot_scheduled_conflicts(school_id,group_id,block_start_time,scheduled_date) WHERE scheduled_occurrence_id IS NULL");
      await assert.rejects(client.query(CLASSPILOT_TODAY_SCHEDULE_CONTRACT_SQL), { code: "23514" });
      await client.query("ROLLBACK TO SAVEPOINT expected_contract_drift");
      assert.ok((await client.query("SELECT to_regclass('public.classpilot_scheduled_conflicts_unique') AS name")).rows[0]?.name);
      await client.query(CLASSPILOT_TODAY_SCHEDULE_CONTRACT_SQL);
      await client.query("INSERT INTO schema_migrations(id,checksum,mode,status,application_sha) VALUES($1,$2,'transactional','complete','synthetic-contract-test')",
        [classpilotTodayScheduleContractMigration.id, classpilotTodayScheduleContractMigration.checksum]);
      await verifyClasspilotTodayScheduleContract(client);
      await client.query(CLASSPILOT_TODAY_SCHEDULE_SQL); // bootstrap never recreates the contracted index
      await verifyClasspilotTodayScheduleContract(client);
      await client.query(`SET LOCAL ROLE ${role}`);
      const insertConflict = `INSERT INTO classpilot_scheduled_conflicts(id,school_id,group_id,teacher_id,scheduled_date,
        scheduled_occurrence_id,block_start_time,block_end_time) VALUES($1,$2,$3,$4,$5,$6,'09:00','10:00')`;
      const legacy = randomUUID(), current = randomUUID(), second = randomUUID(), change = randomUUID();
      await client.query(insertConflict, [legacy, own.school, own.group, own.teacher, date, null]);
      await denied("23505", insertConflict, [randomUUID(), own.school, own.group, own.teacher, date, null]);
      await client.query(insertConflict, [current, own.school, own.group, own.teacher, date, own.occurrence]);
      await denied("23505", insertConflict, [randomUUID(), own.school, own.group, own.teacher, date, own.occurrence]);
      await client.query(insertChange, [change, own.school, date, zone, own.teacher, "e".repeat(64), JSON.stringify([own.group]), ends]);
      await client.query(insertOccurrence, [second, own.school, change, date, own.group, starts, ends, own.teacher, zone]);
      await client.query(insertConflict, [randomUUID(), own.school, own.group, own.teacher, date, second]);
      await denied("23514", insertConflict, [randomUUID(), own.school, own.group, own.teacher, date, other.occurrence]);
      await denied("23514", "UPDATE classpilot_scheduled_conflicts SET scheduled_occurrence_id=$1 WHERE id=$2", [second, current]);
      await denied("23514", "UPDATE classpilot_scheduled_conflicts SET scheduled_occurrence_id=$1 WHERE id=$2", [second, legacy]);
      await denied("23514", "UPDATE classpilot_scheduled_conflicts SET block_start_time='09:01' WHERE id=$1", [current]);
      assert.equal((await client.query("SELECT id FROM classpilot_scheduled_conflicts WHERE school_id=$1 AND group_id=$2 AND scheduled_date=$3", [own.school, own.group, date])).rowCount, 3);
    });
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
});
