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
  createProductLicense,
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
import { classpilotSessionUsage } from "../dist/schema/classpilot.js";

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
      top_activities JSONB,
      first_seen TIMESTAMPTZ,
      last_seen TIMESTAMPTZ,
      computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT classpilot_session_usage_session_student_date_unique UNIQUE (teaching_session_id, student_id, local_date)
    )
  `);
  await db.execute(sql`
    ALTER TABLE classpilot_session_usage
      ADD COLUMN IF NOT EXISTS top_activities JSONB
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

async function createUsageClass(name: string, studentIds: string[] = [studentA.id, studentB.id]) {
  return inSchool(school.id, async () => {
    const group = await createGroup({
      schoolId: school.id,
      teacherId: teacherA.id,
      name: `${TAG}_${name}`,
      groupType: "admin_class",
      status: "active",
    });
    await addGroupStudents(group.id, studentIds);
    return group;
  });
}

async function insertRecordedUsage(
  group: { id: string; schoolId: string; teacherId: string },
  localDate: string,
  students: Array<{ studentId: string; totalSeconds: number }>
) {
  await inSchool(group.schoolId, async () => {
    const session = await createTeachingSession({ groupId: group.id, teacherId: group.teacherId });
    const startTime = new Date(`${localDate}T15:00:00.000Z`);
    const durationSeconds = Math.max(4200, ...students.map((student) => student.totalSeconds));
    const endTime = new Date(startTime.getTime() + durationSeconds * 1000);
    await db.execute(sql`
      UPDATE teaching_sessions SET start_time = ${ts(startTime)}, end_time = ${ts(endTime)}
      WHERE id = ${session.id} AND school_id = ${group.schoolId}
    `);
    await db.insert(classpilotSessionUsage).values(students.map((student) => ({
      schoolId: group.schoolId,
      teachingSessionId: session.id,
      groupId: group.id,
      localDate,
      ...student,
    })));
  });
}

async function readUsageClass(groupId: string, period = "7d", now = new Date("2026-01-15T18:00:00.000Z")) {
  const result = await inSchool(school.id, () => getClasspilotAdminAnalyticsByGroup(school.id, period, { now }));
  const row = result.groups.find((group) => group.groupId === groupId);
  assert.ok(row, "Recorded class must appear in analytics");
  return row;
}

before(async () => {
  await asSystem(ensureAnalyticsTables);
  school = await createSchool({
    name: `${TAG}_School`,
    domain: `${TAG}.example.edu`,
    slug: TAG,
    schoolTimezone: "America/New_York",
  } as any);
  await createProductLicense({
    schoolId: school.id,
    product: "CLASSPILOT",
    status: "active",
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
      await db.execute(sql`DELETE FROM product_licenses WHERE school_id = ${school.id}`);
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
    for (const row of activeOfficialRows) {
      assert.equal(row.avgDailyMinutesPerActiveStudent, null);
      assert.equal(row.activeStudentDayCount, null);
      assert.equal(row.activeClassDayCount, null);
    }
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
      await insertHeartbeat(studentA, `${TAG}-outside-before`, new Date("2026-01-15T13:59:50.000Z"));
      await insertHeartbeat(studentA, `${TAG}-outside-end`, new Date("2026-01-15T15:00:00.000Z"));
      await insertHeartbeat(studentA, `${TAG}-outside-after`, new Date("2026-01-15T15:00:10.000Z"));
      await db.execute(sql`
        UPDATE teaching_sessions
        SET start_time = ${ts(new Date("2026-01-15T14:00:00.000Z"))},
            end_time = ${ts(new Date("2026-01-15T15:00:00.000Z"))}
        WHERE id = ${session.id}
      `);
      const firstUsage = await aggregateClasspilotSessionUsage(session.id);
      assert.equal(firstUsage.length, 1);
      assert.equal(firstUsage[0]?.studentId, studentA.id);
      assert.equal(firstUsage[0]?.localDate, "2026-01-15");
      assert.equal(firstUsage[0]?.heartbeatCount, 6);
      assert.equal(firstUsage[0]?.totalSeconds, 60);
      assert.deepEqual(firstUsage[0]?.topDomains, [
        { domain: "session.edu", seconds: 60, visits: 6 },
      ]);

      const repeatedUsage = await aggregateClasspilotSessionUsage(session.id);
      assert.equal(repeatedUsage.length, 1);
      assert.equal(repeatedUsage[0]?.heartbeatCount, 6);
      assert.equal(repeatedUsage[0]?.totalSeconds, 60);
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
    assert.ok(rowA);
    assert.equal(rowA.totalBrowsingMinutes, 1);
    assert.equal(rowA.activeStudentCount, 1);
    assert.equal(rowA.avgDailyMinutesPerActiveStudent, 1);
    assert.equal(rowA.activeStudentDayCount, 1);
    assert.equal(rowA.activeClassDayCount, 1);
    assert.equal(rowB, undefined);
  });

  it("shows 42 daily minutes for 80h 1m across 23 students and five recorded class days", async () => {
    const studentIds: string[] = [];
    for (let i = 0; i < 23; i++) {
      const student = await inSchool(school.id, () => createStudent({
        schoolId: school.id,
        firstName: "Daily",
        lastName: `Student ${i}`,
        email: `daily-${i}@${TAG}.example.edu`,
      }));
      studentIds.push(student.id);
    }
    const group = await createUsageClass("Screenshot", studentIds);
    const dates = ["2026-01-09", "2026-01-12", "2026-01-13", "2026-01-14", "2026-01-15"];
    const totalSeconds = (80 * 60 + 1) * 60;
    const studentDays = studentIds.length * dates.length;
    for (const [dayIndex, date] of dates.entries()) {
      await insertRecordedUsage(group, date, studentIds.map((studentId, studentIndex) => ({
        studentId,
        totalSeconds: Math.floor(totalSeconds / studentDays)
          + (dayIndex * studentIds.length + studentIndex < totalSeconds % studentDays ? 1 : 0),
      })));
    }
    const row = await readUsageClass(group.id);
    assert.equal(row.totalBrowsingMinutes, 4801);
    assert.equal(row.activeStudentCount, 23);
    assert.equal(row.avgMinutesPerStudent, 209, "Legacy cumulative average remains available");
    assert.equal(row.activeStudentDayCount, 115);
    assert.equal(row.activeClassDayCount, 5);
    assert.equal(row.avgDailyMinutesPerActiveStudent, 42);
  });

  it("keeps full 70-minute usage at 70 minutes for Today, Last 7 days, and Last 30 days", async () => {
    const group = await createUsageClass("Full_Lessons");
    for (const date of ["2026-01-09", "2026-01-12", "2026-01-13", "2026-01-14", "2026-01-15"]) {
      await insertRecordedUsage(group, date, [studentA, studentB].map((student) => ({ studentId: student.id, totalSeconds: 4200 })));
    }
    for (const period of ["today", "7d", "30d"]) {
      const row = await readUsageClass(group.id, period);
      assert.equal(row.avgDailyMinutesPerActiveStudent, 70);
      assert.equal(row.activeClassDayCount, period === "today" ? 1 : 5);
      assert.equal(row.activeStudentDayCount, period === "today" ? 2 : 10);
    }
  });

  it("weights changing attendance by active student-days and excludes zero-usage days and students", async () => {
    const group = await createUsageClass("Changing_Attendance");
    await insertRecordedUsage(group, "2026-01-12", [
      { studentId: studentA.id, totalSeconds: 4200 },
      { studentId: studentB.id, totalSeconds: 0 },
    ]);
    await insertRecordedUsage(group, "2026-01-14", [
      { studentId: studentA.id, totalSeconds: 600 },
      { studentId: studentB.id, totalSeconds: 600 },
    ]);
    await insertRecordedUsage(group, "2026-01-15", [
      { studentId: studentA.id, totalSeconds: 0 },
      { studentId: studentB.id, totalSeconds: 0 },
    ]);
    const row = await readUsageClass(group.id);
    assert.equal(row.totalBrowsingMinutes, 90);
    assert.equal(row.activeStudentDayCount, 3);
    assert.equal(row.activeClassDayCount, 2);
    assert.equal(row.avgDailyMinutesPerActiveStudent, 30);
  });

  it("combines repeated sessions into one student-day and rounds only the final daily average", async () => {
    const group = await createUsageClass("Repeated_Sessions");
    await insertRecordedUsage(group, "2026-01-14", [{ studentId: studentA.id, totalSeconds: 44 }]);
    await insertRecordedUsage(group, "2026-01-14", [{ studentId: studentA.id, totalSeconds: 45 }]);
    await insertRecordedUsage(group, "2026-01-15", [{ studentId: studentA.id, totalSeconds: 90 }]);
    const row = await readUsageClass(group.id);
    assert.equal(row.totalBrowsingMinutes, 3);
    assert.equal(row.activeStudentDayCount, 2);
    assert.equal(row.activeClassDayCount, 2);
    assert.equal(row.avgDailyMinutesPerActiveStudent, 1, "179 seconds / 2 / 60 rounds to 1, without first rounding the total");
  });

  it("returns an unavailable daily average when no student-days have positive usage", async () => {
    const group = await createUsageClass("No_Usage");
    await insertRecordedUsage(group, "2026-01-15", [{ studentId: studentA.id, totalSeconds: 0 }]);
    const row = await readUsageClass(group.id);
    assert.equal(row.totalBrowsingMinutes, 0);
    assert.equal(row.activeStudentDayCount, 0);
    assert.equal(row.activeClassDayCount, 0);
    assert.equal(row.avgDailyMinutesPerActiveStudent, null);
  });

  it("uses recorded local dates and inclusive date ranges even near UTC midnight", async () => {
    const group = await createUsageClass("Local_Date_Ranges");
    for (const [date, totalSeconds] of [
      ["2025-12-16", 4200], ["2025-12-17", 1800], ["2026-01-08", 1200],
      ["2026-01-09", 600], ["2026-01-15", 4200], ["2026-01-16", 4200],
    ] as const) {
      await insertRecordedUsage(group, date, [{ studentId: studentA.id, totalSeconds }]);
    }
    const now = new Date("2026-01-16T04:30:00.000Z"); // Still January 15 in New York.
    for (const [period, days, totalMinutes, average] of [
      ["today", 1, 70, 70], ["7d", 2, 80, 40], ["30d", 4, 130, 33],
    ] as const) {
      const row = await readUsageClass(group.id, period, now);
      assert.equal(row.totalBrowsingMinutes, totalMinutes);
      assert.equal(row.activeClassDayCount, days);
      assert.equal(row.activeStudentDayCount, days);
      assert.equal(row.avgDailyMinutesPerActiveStudent, average);
    }
  });

  it("does not impose a fixed 70-minute cap on classes with longer recorded lessons", async () => {
    const group = await createUsageClass("Longer_Lesson");
    await insertRecordedUsage(group, "2026-01-15", [{ studentId: studentA.id, totalSeconds: 5400 }]);
    assert.equal((await readUsageClass(group.id)).avgDailyMinutesPerActiveStudent, 90);
  });

  it("does not expose another school's usage even with system database access", async () => {
    const otherSchool = await createSchool({ name: `${TAG}_Other`, domain: `other-${TAG}.example.edu`, slug: `other-${TAG}` });
    try {
      const result = await asSystem(() => getClasspilotAdminAnalyticsByGroup(otherSchool.id, "30d", {
        now: new Date("2026-01-15T18:00:00.000Z"),
      }));
      assert.deepEqual(result.groups, []);
    } finally {
      // School history is retained by the staff identity lifecycle contract.
      await db.execute(sql`UPDATE schools SET deleted_at = now(), is_active = false WHERE id = ${otherSchool.id}`);
    }
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
