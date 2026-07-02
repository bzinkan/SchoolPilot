import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import db, { pool } from "../dist/db.js";
import { runWithTenantContext } from "../dist/middleware/tenantContext.js";
import {
  addGroupStudents,
  aggregateClasspilotSessionUsage,
  createGroup,
  createMembership,
  createSchool,
  createStudent,
  createTeachingSession,
  createUser,
} from "../dist/services/storage.js";
import {
  getClasspilotAdminAnalyticsByGroup,
  getClasspilotAdminAnalyticsByTeacher,
  getClasspilotAdminAnalyticsSummary,
  resolveSchoolLocalPeriod,
} from "../dist/services/classpilotAdminAnalytics.js";
import { coerceSchedulerTimestamp } from "../dist/util/schedulerTimestamp.js";

const TAG = `admin_analytics_${Date.now()}`;

let school: any;
let admin: any;
let teacherA: any;
let teacherB: any;
let studentA: any;
let studentB: any;
let officialA: any;
let officialB: any;

function inSchool<T>(schoolId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ schoolId }, fn);
}

function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuper: true }, fn);
}

async function ensureAnalyticsTables() {
  await db.execute(sql`ALTER TABLE teaching_sessions ADD COLUMN IF NOT EXISTS session_mode TEXT NOT NULL DEFAULT 'live'`);
  await db.execute(sql`ALTER TABLE teaching_sessions ADD COLUMN IF NOT EXISTS scheduled_conflict_id TEXT`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS teaching_sessions_session_mode_idx ON teaching_sessions (session_mode)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS teaching_sessions_scheduled_conflict_idx ON teaching_sessions (scheduled_conflict_id)`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS classpilot_session_students (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      school_id TEXT NOT NULL,
      teaching_session_id VARCHAR NOT NULL,
      group_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT classpilot_session_students_session_student_unique UNIQUE (teaching_session_id, student_id)
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS classpilot_session_usage (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      school_id TEXT NOT NULL,
      teaching_session_id VARCHAR NOT NULL,
      group_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      local_date TEXT NOT NULL,
      total_seconds INTEGER NOT NULL DEFAULT 0,
      heartbeat_count INTEGER NOT NULL DEFAULT 0,
      top_domains JSONB,
      first_seen TIMESTAMPTZ,
      last_seen TIMESTAMPTZ,
      computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT classpilot_session_usage_session_student_date_unique UNIQUE (teaching_session_id, student_id, local_date)
    )
  `);
}

function ts(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

async function insertHeartbeat(student: any, deviceId: string, timestamp: Date, url = "https://example.edu/lesson") {
  await db.execute(sql`
    INSERT INTO heartbeats (device_id, student_id, student_email, school_id, active_tab_title, active_tab_url, timestamp)
    VALUES (${deviceId}, ${student.id}, ${student.email}, ${school.id}, 'Lesson', ${url}, ${ts(timestamp)})
  `);
}

before(async () => {
  await asSystem(ensureAnalyticsTables);
  school = await createSchool({
    name: `${TAG}_School`,
    domain: `${TAG}.example.edu`,
    slug: TAG,
    schoolTimezone: "America/New_York",
  } as any);
  admin = await createUser({ email: `admin@${TAG}.example.edu`, firstName: "Ada", lastName: "Admin" } as any);
  teacherA = await createUser({ email: `teacher-a@${TAG}.example.edu`, firstName: "Tara", lastName: "Alpha" } as any);
  teacherB = await createUser({ email: `teacher-b@${TAG}.example.edu`, firstName: "Terry", lastName: "Beta" } as any);
  await createMembership({ userId: admin.id, schoolId: school.id, role: "admin", status: "active" } as any);
  await createMembership({ userId: teacherA.id, schoolId: school.id, role: "teacher", status: "active" } as any);
  await createMembership({ userId: teacherB.id, schoolId: school.id, role: "teacher", status: "active" } as any);
  studentA = await inSchool(school.id, () => createStudent({
    schoolId: school.id,
    firstName: "Student",
    lastName: "One",
    email: `one@${TAG}.example.edu`,
    gradeLevel: "8",
  } as any));
  studentB = await inSchool(school.id, () => createStudent({
    schoolId: school.id,
    firstName: "Student",
    lastName: "Two",
    email: `two@${TAG}.example.edu`,
    gradeLevel: "8",
  } as any));
  officialA = await inSchool(school.id, () => createGroup({
    schoolId: school.id,
    teacherId: teacherA.id,
    name: `${TAG}_Official_A`,
    groupType: "admin_class",
    status: "active",
  } as any));
  officialB = await inSchool(school.id, () => createGroup({
    schoolId: school.id,
    teacherId: teacherA.id,
    name: `${TAG}_Official_B`,
    groupType: "admin_class",
    status: "active",
  } as any));
  await inSchool(school.id, () => addGroupStudents(officialA.id, [studentA.id]));
  await inSchool(school.id, () => addGroupStudents(officialB.id, [studentA.id]));
});

after(async () => {
  try {
    await asSystem(async () => {
      await db.execute(sql`DELETE FROM classpilot_session_usage WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM classpilot_session_students WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM heartbeats WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM daily_usage WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM teaching_sessions WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM group_students WHERE group_id IN (SELECT id FROM groups WHERE school_id = ${school.id})`);
      await db.execute(sql`DELETE FROM group_teachers WHERE group_id IN (SELECT id FROM groups WHERE school_id = ${school.id})`);
      await db.execute(sql`DELETE FROM groups WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM students WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM school_memberships WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM schools WHERE id = ${school.id}`);
      await db.execute(sql`DELETE FROM users WHERE email LIKE ${`%@${TAG}.example.edu`}`);
    });
  } catch {
    /* best-effort cleanup */
  }
  await pool.end();
});

describe("ClassPilot admin analytics", () => {
  it("coerces scheduler aggregate timestamps before daily usage writes", () => {
    assert.equal(
      coerceSchedulerTimestamp("2026-01-14 15:04:05.123")?.toISOString(),
      "2026-01-14T15:04:05.123Z"
    );
    const date = new Date("2026-01-14T15:04:05.123Z");
    assert.equal(coerceSchedulerTimestamp(date), date);
    assert.equal(coerceSchedulerTimestamp(null), null);
  });

  it("resolves school-local periods without off-by-one dates", () => {
    const now = new Date("2026-01-15T17:30:00.000Z");
    const today = resolveSchoolLocalPeriod("24h", "America/New_York", now);
    assert.equal(today.period, "today");
    assert.equal(today.todayLocalDate, "2026-01-15");
    assert.equal(today.startLocalDate, "2026-01-15");
    assert.equal(today.currentDayStartUtc.toISOString(), "2026-01-15T05:00:00.000Z");

    const week = resolveSchoolLocalPeriod("7d", "America/New_York", now);
    assert.equal(week.startLocalDate, "2026-01-09");
    assert.equal(week.completedStartDate, "2026-01-09");
    assert.equal(week.completedEndDate, "2026-01-14");
    assert.equal(week.rangeStartUtc.toISOString(), "2026-01-09T05:00:00.000Z");

    const month = resolveSchoolLocalPeriod("30d", "America/New_York", now);
    assert.equal(month.startLocalDate, "2025-12-17");
  });

  it("unions historical and live active students without double-counting today", async () => {
    await inSchool(school.id, async () => {
      await db.execute(sql`
        INSERT INTO daily_usage (school_id, student_id, date, total_seconds, heartbeat_count, top_domains)
        VALUES (${school.id}, ${studentA.id}, '2026-01-14', 120, 12, ${JSON.stringify([{ domain: "history.edu", seconds: 120, visits: 12 }])}::jsonb)
        ON CONFLICT (student_id, date) DO UPDATE SET total_seconds = EXCLUDED.total_seconds, heartbeat_count = EXCLUDED.heartbeat_count, top_domains = EXCLUDED.top_domains
      `);
      await insertHeartbeat(studentB, `${TAG}-summary-device`, new Date("2026-01-15T16:00:00.000Z"), "https://live.edu/page");
    });

    const result = await inSchool(school.id, () =>
      getClasspilotAdminAnalyticsSummary(school.id, "7d", { now: new Date("2026-01-15T18:00:00.000Z") })
    );

    assert.equal(result.summary.activeStudents, 2);
    assert.equal(result.summary.totalBrowsingMinutes, 2);
    assert.deepEqual(result.topWebsites.map((site: any) => site.domain).sort(), ["history.edu", "live.edu"].sort());
    assert.equal(result.hourlyActivity.find((row: any) => row.hour === 11)?.count, 1);
  });

  it("filters roster-mode browsing to active official classes", async () => {
    const archived = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: teacherA.id,
      name: `${TAG}_Archived`,
      groupType: "admin_class",
      status: "archived",
    } as any));
    const teacherCreated = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: teacherA.id,
      name: `${TAG}_Teacher_Created`,
      groupType: "teacher_created",
      status: "active",
    } as any));
    const smallGroup = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: teacherA.id,
      name: `${TAG}_Small_Group`,
      groupType: "teacher_small_group",
      status: "active",
    } as any));
    await inSchool(school.id, () => addGroupStudents(archived.id, [studentA.id]));
    await inSchool(school.id, () => addGroupStudents(teacherCreated.id, [studentA.id]));
    await inSchool(school.id, () => addGroupStudents(smallGroup.id, [studentA.id]));

    const result = await inSchool(school.id, () =>
      getClasspilotAdminAnalyticsByGroup(school.id, "7d", {
        now: new Date("2026-01-15T18:00:00.000Z"),
        attributionMode: "roster",
      })
    );

    assert.equal(result.attributionMode, "roster");
    const names = result.groups.map((group: any) => group.groupName);
    assert(names.includes(officialA.name));
    assert(names.includes(officialB.name));
    assert(!names.includes(archived.name));
    assert(!names.includes(teacherCreated.name));
    assert(!names.includes(smallGroup.name));

    const activeOfficialRows = result.groups.filter((group: any) => [officialA.name, officialB.name].includes(group.groupName));
    assert(activeOfficialRows.every((group: any) => group.totalBrowsingMinutes === 2));
  });

  it("attributes class usage to session snapshots, not current rosters", async () => {
    const session = await inSchool(school.id, () =>
      createTeachingSession({ groupId: officialA.id, teacherId: teacherA.id })
    );
    await inSchool(school.id, () => addGroupStudents(officialA.id, [studentB.id]));

    await inSchool(school.id, async () => {
      for (let i = 0; i < 6; i++) {
        await insertHeartbeat(studentA, `${TAG}-session-a-${i}`, new Date(Date.UTC(2026, 0, 15, 14, i, 0)), "https://session.edu/a");
        await insertHeartbeat(studentB, `${TAG}-session-b-${i}`, new Date(Date.UTC(2026, 0, 15, 14, i, 0)), "https://session.edu/b");
      }
      await db.execute(sql`
        UPDATE teaching_sessions
        SET start_time = ${ts(new Date("2026-01-15T14:00:00.000Z"))},
            end_time = ${ts(new Date("2026-01-15T15:00:00.000Z"))}
        WHERE id = ${session.id}
      `);
      await aggregateClasspilotSessionUsage(session.id);
    });

    const result = await inSchool(school.id, () =>
      getClasspilotAdminAnalyticsByGroup(school.id, "today", {
        now: new Date("2026-01-15T18:00:00.000Z"),
        attributionMode: "session",
      })
    );

    assert.equal(result.attributionMode, "session");
    const rowA = result.groups.find((group: any) => group.groupId === officialA.id);
    const rowB = result.groups.find((group: any) => group.groupId === officialB.id);
    assert.equal(rowA.totalBrowsingMinutes, 1);
    assert.equal(rowA.activeStudentCount, 1);
    assert.equal(rowB, undefined);
  });

  it("clamps teacher session duration to the selected school-local period", async () => {
    const longGroup = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: teacherB.id,
      name: `${TAG}_Long_Class`,
      groupType: "admin_class",
      status: "active",
    } as any));
    const session = await inSchool(school.id, () =>
      createTeachingSession({ groupId: longGroup.id, teacherId: teacherB.id })
    );
    await inSchool(school.id, () =>
      db.execute(sql`
        UPDATE teaching_sessions
        SET start_time = ${ts(new Date("2026-01-14T12:00:00.000Z"))},
            end_time = ${ts(new Date("2026-01-15T07:00:00.000Z"))}
        WHERE id = ${session.id}
      `)
    );

    const result = await inSchool(school.id, () =>
      getClasspilotAdminAnalyticsByTeacher(school.id, "today", { now: new Date("2026-01-15T17:00:00.000Z") })
    );
    const teacher = result.teachers.find((row: any) => row.id === teacherB.id);
    assert.equal(teacher.totalSessionMinutes, 120);
    assert.equal(teacher.groupCount, 1);
  });
});
