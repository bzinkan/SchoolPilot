import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { CLASSPILOT_SCHEDULING_SQL } from "../src/db/classpilotSchedulingMigration.js";
import { datePlusDays, dateWeekday, defaultClassScheduleRule, emptySchoolSchedulingConfig } from "../src/services/classpilotSchedulingRules.js";

process.env.REDIS_URL = "";
const schoolId = randomUUID(), otherSchoolId = randomUUID(), teacherId = randomUUID(), coTeacherId = randomUUID(), groupId = randomUUID(), secondGroupId = randomUUID();
const makeupGroupId = randomUUID();
let pool: import("pg").Pool;
let database: typeof import("../src/db.js").default;
let withTenant: typeof import("../src/middleware/tenantContext.js").runWithTenantContext;
let scheduling: typeof import("../src/services/classpilotScheduling.js");
let today: string;
let config = emptySchoolSchedulingConfig();
const scoped = <T>(fn: () => Promise<T>) => withTenant({ schoolId }, fn);

before(async () => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.DATABASE_URL || "").hostname), "Scheduling integration tests require a local fixture database.");
  const dbModule = await import("../src/db.js"); pool = dbModule.pool; database = dbModule.default;
  ({ runWithTenantContext: withTenant } = await import("../src/middleware/tenantContext.js"));
  scheduling = await import("../src/services/classpilotScheduling.js");
  const { localDateInTimeZone } = await import("../src/util/schoolTime.js");
  today = localDateInTimeZone(new Date(), "America/New_York");
  let anchor = datePlusDays(today, 2);
  while ([0, 6].includes(dateWeekday(anchor))) anchor = datePlusDays(anchor, 1);
  config = { ...config, yearStart: today, yearEnd: datePlusDays(today, 360), cycleAnchorDate: anchor,
    periods: [{ id: "p1", name: "Period 1" }], profiles: [{ id: "regular", name: "Regular", periods: { p1: { startTime: "09:00", endTime: "09:50" } } }], defaultProfileId: "regular" };
  await pool.query(CLASSPILOT_SCHEDULING_SQL);
  await pool.query("INSERT INTO schools (id, name, school_timezone) VALUES ($1, 'Scheduling test', 'America/New_York'), ($2, 'Other scheduling test', 'America/New_York')", [schoolId, otherSchoolId]);
  await pool.query("INSERT INTO users (id, email, first_name, last_name) VALUES ($1, $2, 'Schedule', 'Teacher')", [teacherId, `${teacherId}@test.example.edu`]);
  await pool.query("INSERT INTO users (id, email, first_name, last_name) VALUES ($1, $2, 'Schedule', 'CoTeacher')", [coTeacherId, `${coTeacherId}@test.example.edu`]);
  await pool.query("INSERT INTO school_memberships (user_id, school_id, role, status) VALUES ($1, $2, 'teacher', 'active')", [teacherId, schoolId]);
  await withTenant({ isSuper: true }, async () => {
    const { sql } = await import("drizzle-orm");
    await database.execute(sql`INSERT INTO settings (school_id, school_name, ws_shared_key, instructional_calendar) VALUES (${schoolId}, 'Scheduling test', 'test-only-key', '{}'::jsonb), (${otherSchoolId}, 'Other scheduling test', 'test-only-key', '{}'::jsonb)`);
  });
  await pool.query("INSERT INTO product_licenses (school_id, product, status) VALUES ($1, 'CLASSPILOT', 'active')", [schoolId]);
});

after(async () => {
  if (!pool) return;
  await withTenant({ isSuper: true }, async () => {
    const { sql } = await import("drizzle-orm");
    await database.execute(sql`DELETE FROM classpilot_school_schedules WHERE school_id IN (${schoolId}, ${otherSchoolId})`);
    await database.execute(sql`DELETE FROM teaching_sessions WHERE school_id = ${schoolId}`);
    await database.execute(sql`DELETE FROM group_teachers WHERE group_id = ${groupId}`);
    await database.execute(sql`DELETE FROM groups WHERE id IN (${groupId}, ${secondGroupId}, ${makeupGroupId})`);
    await database.execute(sql`DELETE FROM settings WHERE school_id IN (${schoolId}, ${otherSchoolId})`);
  });
  await pool.query("DELETE FROM product_licenses WHERE school_id = $1", [schoolId]);
  await pool.query("DELETE FROM school_memberships WHERE user_id = $1", [teacherId]);
  await pool.query("DELETE FROM users WHERE id = $1", [teacherId]);
  await pool.query("DELETE FROM users WHERE id = $1", [coTeacherId]);
  await pool.query("DELETE FROM schools WHERE id IN ($1, $2)", [schoolId, otherSchoolId]);
  const { sessionPool } = await import("../src/db.js");
  await Promise.all([pool.end(), sessionPool.end()]);
});

describe("School scheduling persistence", () => {
  it("saves the exact reviewed configuration, rejects a stale preview, and isolates school data", async () => {
    const initial = await scoped(() => scheduling.getSchoolSchedulingContext(schoolId));
    assert.equal(initial.revision, 0);
    const preview = await scoped(() => scheduling.previewSchoolScheduling({ schoolId, config }));
    assert.deepEqual(preview.blockers, []);
    const saved = await scoped(() => scheduling.saveSchoolScheduling({ schoolId, config, expectedRevision: 0, previewToken: preview.previewToken, actorId: teacherId }));
    assert.equal(saved.revision, 1);
    await assert.rejects(scoped(() => scheduling.saveSchoolScheduling({ schoolId, config, expectedRevision: 0, previewToken: preview.previewToken, actorId: teacherId })), (error: Error & { code?: string }) => error.code === "SCHEDULE_PREVIEW_STALE");
    const other = await withTenant({ schoolId: otherSchoolId }, () => scheduling.getSchoolSchedulingContext(otherSchoolId));
    assert.equal(other.revision, 0);
    assert.deepEqual(other.config.periods, []);
  });
  it("uses actual meeting days for primary and co-teacher overlap checks", async () => {
    const { sql } = await import("drizzle-orm");
    await scoped(() => database.execute(sql`INSERT INTO groups (id, school_id, teacher_id, name, group_type, status, schedule_enabled, block_start_time, block_end_time, schedule_rule) VALUES (${groupId}, ${schoolId}, ${teacherId}, 'Monday Wednesday Friday', 'admin_class', 'active', true, '09:00', '09:50', ${JSON.stringify({ ...defaultClassScheduleRule(), weekdays: [1, 3, 5] })}::jsonb)`));
    const group = { scheduleEnabled: true, blockStartTime: "09:00", blockEndTime: "09:50", scheduleRule: { ...defaultClassScheduleRule(), weekdays: [2, 4] } };
    await scoped(() => scheduling.assertSchoolSchedulingClassOverlap({ schoolId, group, teacherIds: [teacherId], dbInstance: database }));
    await assert.rejects(scoped(() => scheduling.assertSchoolSchedulingClassOverlap({ schoolId, group: { ...group, scheduleRule: defaultClassScheduleRule() }, teacherIds: [teacherId], dbInstance: database })), (error: Error & { code?: string }) => error.code === "CLASS_SCHEDULE_CONFLICT");
    await scoped(() => database.execute(sql`INSERT INTO group_teachers (group_id, teacher_id, role) VALUES (${groupId}, ${coTeacherId}, 'co-teacher')`));
    await assert.rejects(scoped(() => scheduling.assertSchoolSchedulingClassOverlap({ schoolId, group: { ...group, scheduleRule: defaultClassScheduleRule() }, teacherIds: [coTeacherId], dbInstance: database })), (error: Error & { code?: string }) => error.code === "CLASS_SCHEDULE_CONFLICT");
  });
  it("refuses to remove a period used by an active class", async () => {
    const { sql } = await import("drizzle-orm");
    await scoped(() => database.execute(sql`UPDATE groups SET schedule_rule = ${JSON.stringify({ ...defaultClassScheduleRule(), periodId: "p1" })}::jsonb WHERE id = ${groupId}`));
    const preview = await scoped(() => scheduling.previewSchoolScheduling({ schoolId, config: { ...config, defaultProfileId: null, profiles: [], periods: [] } }));
    assert.ok(preview.blockers.some((blocker) => blocker.code === "SCHEDULE_PERIOD_IN_USE"));
  });
  it("reviews and saves a holiday reflow using the same preview token under calendar locks", async () => {
    const { sql } = await import("drizzle-orm");
    const { replaceInstructionalCalendarMonth } = await import("../src/services/storage.js");
    await scoped(() => database.execute(sql`UPDATE groups SET schedule_rule = ${JSON.stringify({ ...defaultClassScheduleRule(), periodId: "p1", cycleDay: "A" })}::jsonb WHERE id = ${groupId}`));
    let closure = datePlusDays(config.cycleAnchorDate!, 1);
    while ([0, 6].includes(dateWeekday(closure))) closure = datePlusDays(closure, 1);
    const month = closure.slice(0, 7);
    const current = await scoped(() => scheduling.getSchoolSchedulingContext(schoolId));
    const preview = await scoped(() => scheduling.previewSchoolScheduling({ schoolId, config, calendar: { ...current.calendar, [month]: { nonInstructionalDates: [closure] } } }));
    assert.deepEqual(preview.blockers, []);
    assert.ok(preview.changedOccurrences > 0);
    const saved = await scoped(() => replaceInstructionalCalendarMonth({ schoolId, month, expectedRevision: 0, nonInstructionalDates: [closure], updatedBy: teacherId, previewToken: preview.previewToken }));
    assert.equal(saved.status, "saved");
  });
  it("preserves frozen occurrence times and rejects another class moved into that frozen window", async () => {
    const { sql } = await import("drizzle-orm");
    const { localDateTimeUtc } = await import("../src/util/schoolTime.js");
    const date = datePlusDays(config.cycleAnchorDate!, 7);
    const twoPeriods = { ...config, periods: [...config.periods, { id: "p2", name: "Period 2" }],
      profiles: [{ ...config.profiles[0]!, periods: { ...config.profiles[0]!.periods, p2: { startTime: "10:00", endTime: "10:50" } } }] };
    const rule = { ...defaultClassScheduleRule(), periodId: "p1", startsOn: date, endsOn: date };
    await scoped(() => database.execute(sql`UPDATE groups SET schedule_rule = ${JSON.stringify(rule)}::jsonb WHERE id = ${groupId}`));
    const initialPreview = await scoped(() => scheduling.previewSchoolScheduling({ schoolId, config: twoPeriods }));
    await scoped(() => scheduling.saveSchoolScheduling({ schoolId, config: twoPeriods, expectedRevision: initialPreview.revision, previewToken: initialPreview.previewToken, actorId: teacherId }));
    await scoped(() => database.execute(sql`INSERT INTO groups (id, school_id, teacher_id, name, group_type, status, schedule_enabled, block_start_time, block_end_time, schedule_rule) VALUES (${secondGroupId}, ${schoolId}, ${teacherId}, 'Later class', 'admin_class', 'active', true, '10:00', '10:50', ${JSON.stringify({ ...rule, periodId: "p2" })}::jsonb)`));
    await scoped(() => database.execute(sql`INSERT INTO teaching_sessions (group_id, school_id, teacher_id, scheduled_date, scheduled_timezone, scheduled_start_at, scheduled_end_at, scheduled_state, class_name_snapshot) VALUES (${groupId}, ${schoolId}, ${teacherId}, ${date}, 'America/New_York', ${localDateTimeUtc(date, "09:00", "America/New_York").toISOString()}::timestamptz, ${localDateTimeUtc(date, "09:50", "America/New_York").toISOString()}::timestamptz, 'active', 'Frozen class')`));
    const changed = { ...twoPeriods, profiles: [{ ...twoPeriods.profiles[0]!, periods: {
      p1: { startTime: "11:00", endTime: "11:50" }, p2: { startTime: "09:20", endTime: "10:00" },
    } }] };
    const preview = await scoped(() => scheduling.previewSchoolScheduling({ schoolId, config: changed }));
    assert.ok(preview.blockers.some((blocker) => blocker.code === "CLASS_SCHEDULE_CONFLICT" && blocker.date === date));
    assert.ok(!preview.changes.some((change) => change.classId === groupId && change.date === date), "frozen occurrence must not be recomputed");
    assert.ok(preview.changes.some((change) => change.classId === secondGroupId && change.date === date));
  });
  it("reviews a weekend makeup date and discovers Monday classes without opening GoPilot dismissal", async () => {
    const { sql } = await import("drizzle-orm");
    const { getInstructionalDateStatus, getGroupByIdAndSchool } = await import("../src/services/storage.js");
    const { getClasspilotGroupsReadyAtEffectiveWindow, processScheduledClassAutoStart } = await import("../src/services/classpilotScheduledStart.js");
    const { localDateTimeUtc } = await import("../src/util/schoolTime.js");
    let date = datePlusDays(config.cycleAnchorDate!, 14);
    while (dateWeekday(date) !== 6) date = datePlusDays(date, 1);
    const current = await scoped(() => scheduling.getSchoolSchedulingContext(schoolId));
    const rule = { ...defaultClassScheduleRule(), weekdays: [1], startsOn: date, endsOn: date, periodId: "p1" };
    await scoped(() => database.execute(sql`INSERT INTO groups (id, school_id, teacher_id, name, group_type, status, schedule_enabled, block_start_time, block_end_time, schedule_rule) VALUES (${makeupGroupId}, ${schoolId}, ${teacherId}, 'Weekend makeup class', 'admin_class', 'active', true, '09:00', '09:50', ${JSON.stringify(rule)}::jsonb)`));
    const changed = { ...current.config, dateOverrides: { ...current.config.dateOverrides, [date]: { instructional: true, meetingWeekday: 1 } } };
    const preview = await scoped(() => scheduling.previewSchoolScheduling({ schoolId, config: changed }));
    assert.deepEqual(preview.blockers, []);
    assert.ok(preview.changes.some((change) => change.date === date && change.classId === makeupGroupId && change.before === null && change.after));
    await scoped(() => scheduling.saveSchoolScheduling({ schoolId, config: changed, expectedRevision: preview.revision, previewToken: preview.previewToken, actorId: teacherId }));
    assert.equal((await scoped(() => scheduling.getClasspilotInstructionalDateStatus(schoolId, date))).instructional, true);
    assert.equal((await scoped(() => getInstructionalDateStatus(schoolId, date))).instructional, false, "ClassPilot makeup must not open GoPilot dismissal");
    const ready = await scoped(() => getClasspilotGroupsReadyAtEffectiveWindow({ schoolId, scheduledDate: date, currentTimeHHMM: "09:05" }));
    assert.ok(ready.some((group) => group.id === makeupGroupId));
    const group = await scoped(() => getGroupByIdAndSchool(makeupGroupId, schoolId));
    assert.ok(group);
    const started = await scoped(() => processScheduledClassAutoStart({ group, scheduledDate: date, scheduledTeacherConnectedOverride: true, now: localDateTimeUtc(date, "09:05", "America/New_York") }));
    assert.equal(started.status, "started");
    const occurrences = await pool.query("SELECT scheduled_date FROM teaching_sessions WHERE school_id=$1 AND group_id=$2 AND scheduled_date=$3", [schoolId, makeupGroupId, date]);
    assert.equal(occurrences.rowCount, 1);
  });
});
