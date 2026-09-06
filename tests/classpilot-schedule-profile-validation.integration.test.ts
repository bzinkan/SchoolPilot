import { before, beforeEach, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { validateScheduleProfileTestingWindows } from "../src/services/classpilotScheduleProfileValidation.js";
import { emptySchoolSchedulingConfig } from "../src/services/classpilotSchedulingRules.js";

process.env.REDIS_URL = "";
const schoolId = randomUUID(), otherSchoolId = randomUUID(), proctor = randomUUID(), teacher = randomUUID();
const classId = randomUUID(), pairClassId = randomUUID(), foreignClass = randomUUID();
const firstStudent = randomUUID(), secondStudent = randomUUID(), foreignStudent = randomUUID();
const now = new Date("2026-09-01T12:00:00.000Z");
let pool: import("pg").Pool;
let database: typeof import("../src/db.js").default;
let withTenant: typeof import("../src/middleware/tenantContext.js").runWithTenantContext;
const system = <T>(fn: () => Promise<T>) => withTenant({ isSuper: true }, fn);
const run = (date = "2026-09-01", studentIds = [firstStudent], staffId = proctor) => withTenant({ schoolId }, () => validateScheduleProfileTestingWindows({ schoolId, dbInstance: database, now,
  config: emptySchoolSchedulingConfig(), calendar: {}, testingWindows: [{ date, blockId: "reading", name: "MAP reading", coverageGroupId: "group-reference", assignedStaffId: staffId, studentIds, startTime: "10:00", endTime: "11:00" }] }));

before(async () => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.DATABASE_URL || "").hostname), "Testing validation integration requires a local fixture database.");
  const module = await import("../src/db.js"); pool = module.pool; database = module.default;
  ({ runWithTenantContext: withTenant } = await import("../src/middleware/tenantContext.js"));
  await pool.query("INSERT INTO schools (id,name,school_timezone) VALUES ($1,'Profile validation','America/New_York'),($2,'Other profile validation','America/New_York')", [schoolId, otherSchoolId]);
  await pool.query("INSERT INTO users (id,email,first_name,last_name) VALUES ($1,$2,'Testing','Proctor'),($3,$4,'Class','Teacher')", [proctor, `${proctor}@example.edu`, teacher, `${teacher}@example.edu`]);
  await pool.query("INSERT INTO school_memberships (school_id,user_id,role,status) VALUES ($1,$2,'teacher','active'),($1,$3,'teacher','active'),($4,$2,'teacher','active')", [schoolId, proctor, teacher, otherSchoolId]);
  await system(async () => {
    await database.execute(sql`INSERT INTO settings (school_id,school_name,ws_shared_key,enable_tracking_hours,tracking_start_time,tracking_end_time,school_timezone,after_hours_mode,tracking_days,instructional_calendar) VALUES
      (${schoolId},'Profile validation','fixture',true,'08:00','15:00','UTC','limited','{Monday,Tuesday,Wednesday,Thursday,Friday}'::text[],'{}'::jsonb)`);
    await database.execute(sql`INSERT INTO students (id,school_id,first_name,last_name) VALUES (${firstStudent},${schoolId},'First','Student'),(${secondStudent},${schoolId},'Second','Student'),(${foreignStudent},${otherSchoolId},'Other','Student')`);
    await database.execute(sql`INSERT INTO groups (id,school_id,teacher_id,name,group_type,status,schedule_enabled,block_start_time,block_end_time) VALUES
      (${classId},${schoolId},${proctor},'Morning Math','admin_class','active',true,'08:00','09:00'),
      (${pairClassId},${schoolId},${teacher},'Pair Class','admin_class','active',true,'10:00','11:00'),
      (${foreignClass},${otherSchoolId},${proctor},'Foreign Conflict','admin_class','active',true,'10:00','11:00')`);
    await database.execute(sql`INSERT INTO group_students (group_id,student_id) VALUES (${classId},${firstStudent}),(${classId},${secondStudent}),(${foreignClass},${foreignStudent})`);
  });
});

async function reset() {
  await system(() => database.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM classpilot_session_students WHERE school_id=${schoolId}`);
    await tx.execute(sql`DELETE FROM classpilot_session_staff WHERE school_id=${schoolId}`);
    await tx.execute(sql`DELETE FROM teaching_sessions WHERE school_id=${schoolId}`);
    await tx.execute(sql`DELETE FROM classpilot_schedule_change_legs WHERE school_id=${schoolId}`);
    await tx.execute(sql`DELETE FROM classpilot_schedule_changes WHERE school_id=${schoolId}`);
    await tx.execute(sql`DELETE FROM classpilot_schedule_change_pairs WHERE school_id=${schoolId}`);
    await tx.execute(sql`UPDATE groups SET teacher_id=${proctor}, status='active', schedule_enabled=true, block_start_time='08:00', block_end_time='09:00' WHERE id=${classId}`);
    await tx.execute(sql`UPDATE settings SET tracking_start_time='08:00',tracking_end_time='15:00' WHERE school_id=${schoolId}`);
  }));
}
beforeEach(reset);
after(async () => {
  if (!pool) return;
  await reset();
  await system(async () => {
    await database.execute(sql`DELETE FROM group_students WHERE group_id IN (${classId},${pairClassId},${foreignClass})`);
    await database.execute(sql`DELETE FROM groups WHERE id IN (${classId},${pairClassId},${foreignClass})`);
    await database.execute(sql`DELETE FROM students WHERE school_id IN (${schoolId},${otherSchoolId})`);
    await database.execute(sql`DELETE FROM settings WHERE school_id IN (${schoolId},${otherSchoolId})`);
  });
  await pool.query("DELETE FROM school_memberships WHERE school_id IN ($1,$2)", [schoolId, otherSchoolId]);
  await pool.query("DELETE FROM users WHERE id IN ($1,$2)", [proctor, teacher]);
  await pool.query("DELETE FROM schools WHERE id IN ($1,$2)", [schoolId, otherSchoolId]);
  const { sessionPool } = await import("../src/db.js");
  await Promise.all([pool.end(), sessionPool.end()]);
});

describe("Testing validation queries", () => {
  it("uses canonical school hours, fingerprints settings edits, and excludes another school's same proctor", async () => {
    const initial = await run();
    assert.deepEqual(initial.blockers, []);
    assert.equal((await run()).fingerprint, initial.fingerprint);
    await system(() => database.execute(sql`UPDATE settings SET tracking_start_time='10:30' WHERE school_id=${schoolId}`));
    const changed = await run();
    assert.ok(changed.blockers.some((b) => b.code === "SCHEDULE_PROFILE_MONITORING_NOT_FULL"));
    assert.notEqual(changed.fingerprint, initial.fingerprint);
  });

  it("loads an approved swap's effective window and exact active class roster", async () => {
    const pairId = randomUUID(), changeId = randomUUID();
    const [first, second] = [classId, pairClassId].sort();
    await system(() => database.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO classpilot_schedule_change_pairs (id,school_id,first_group_id,second_group_id,created_by) VALUES (${pairId},${schoolId},${first},${second},${proctor})`);
      await tx.execute(sql`INSERT INTO classpilot_schedule_changes (id,school_id,pair_id,scheduled_date,timezone_snapshot,status,reason,requested_by_user_id,requested_by_role,requires_admin_approval) VALUES (${changeId},${schoolId},${pairId},'2026-09-01','America/New_York','approved','Fixture',${proctor},'admin',false)`);
      await tx.execute(sql`INSERT INTO classpilot_schedule_change_legs (school_id,schedule_change_id,scheduled_date,leg_order,group_id,primary_teacher_id_snapshot,class_name_snapshot,original_start_time,original_end_time,effective_start_time,effective_end_time) VALUES
        (${schoolId},${changeId},'2026-09-01',1,${classId},${proctor},'Morning Math','08:00','09:00','10:00','11:00'),
        (${schoolId},${changeId},'2026-09-01',2,${pairClassId},${teacher},'Pair Class','10:00','11:00','08:00','09:00')`);
    }));
    assert.ok((await run()).blockers.some((b) => b.code === "SCHEDULE_PROFILE_PROCTOR_CLASS_CONFLICT"));
    assert.deepEqual((await run("2026-09-01", [firstStudent, secondStudent])).blockers, []);
  });

  it("finds immutable co-teacher obligations even after a class is archived and reassigned", async () => {
    const sessionId = randomUUID();
    await system(async () => {
      await database.execute(sql`UPDATE groups SET teacher_id=${teacher},status='archived' WHERE id=${classId}`);
      await database.execute(sql`INSERT INTO teaching_sessions (id,school_id,group_id,teacher_id,scheduled_date,scheduled_timezone,scheduled_start_at,scheduled_end_at,scheduled_state,roster_snapshot_completed_at,class_name_snapshot) VALUES
        (${sessionId},${schoolId},${classId},${teacher},'2026-09-01','America/New_York','2026-09-01T14:00:00Z'::timestamptz,'2026-09-01T15:00:00Z'::timestamptz,'active',now(),'Frozen Math')`);
      await database.execute(sql`INSERT INTO classpilot_session_staff (school_id,teaching_session_id,staff_id,role) VALUES (${schoolId},${sessionId},${teacher},'primary'),(${schoolId},${sessionId},${proctor},'co_teacher')`);
      await database.execute(sql`INSERT INTO classpilot_session_students (school_id,teaching_session_id,group_id,student_id) VALUES (${schoolId},${sessionId},${classId},${firstStudent}),(${schoolId},${sessionId},${classId},${secondStudent})`);
    });
    assert.ok((await run()).blockers.some((b) => b.code === "SCHEDULE_PROFILE_PROCTOR_CLASS_CONFLICT"));
    assert.deepEqual((await run("2026-09-01", [firstStudent, secondStudent])).blockers, []);
  });

  it("checks an open manual session at launch today without reserving tomorrow", async () => {
    const sessionId = randomUUID();
    await system(async () => {
      await database.execute(sql`INSERT INTO teaching_sessions (id,school_id,group_id,teacher_id,start_time,roster_snapshot_completed_at) VALUES (${sessionId},${schoolId},${classId},${proctor},'2026-08-31T20:00:00'::timestamp,now())`);
      await database.execute(sql`INSERT INTO classpilot_session_staff (school_id,teaching_session_id,staff_id,role) VALUES (${schoolId},${sessionId},${proctor},'primary')`);
      await database.execute(sql`INSERT INTO classpilot_session_students (school_id,teaching_session_id,group_id,student_id) VALUES (${schoolId},${sessionId},${classId},${secondStudent})`);
    });
    assert.ok((await run()).blockers.some((b) => b.code === "SCHEDULE_PROFILE_PROCTOR_CLASS_CONFLICT"));
    assert.deepEqual((await run("2026-09-02")).blockers, []);
  });
});
