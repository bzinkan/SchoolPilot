import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import WebSocket from "ws";

const TAG = `cp_summary_lifecycle_${Date.now()}`;
const ORIGINAL_SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const ORIGINAL_REDIS_URL = process.env.REDIS_URL;
process.env.SENDGRID_API_KEY = "SG.classpilot-session-summary.lifecycle-test";
// This suite validates database lifecycle and durable-delivery semantics. Keep
// realtime/rate-limit Redis clients in local-only mode so importing the full
// app cannot leave network handles alive after the test server closes.
delete process.env.REDIS_URL;

let db: any;
let pool: any;
let storage: any;
let lifecycle: any;
let monitoringReports: any;
let scheduled: any;
let scheduler: any;
let schoolTime: any;
let schedulerPool: any;
let schedulerLockPool: any;
let runWithTenantContext: any;
let signUserToken: any;
let sgMail: any;
let sendMock: any;
let sendBehavior: (message: any) => Promise<any>;
const sentMessages: any[] = [];

let server: Server;
let baseUrl: string;
let school: any;
let teacher: any;
let secondTeacher: any;
let centralRecipient: any;
let studentOne: any;
let studentTwo: any;
let scheduledGroupIdsCreatedByCurrentTest: string[] = [];

function inSchool(schoolId: string, fn: () => Promise<any>): Promise<any> {
  return runWithTenantContext({ schoolId }, fn);
}

function asSystem(fn: () => Promise<any>): Promise<any> {
  return runWithTenantContext({ isSuper: true }, fn);
}

function authFor(user: any): Record<string, string> {
  const token = signUserToken({
    userId: user.id,
    email: user.email,
    isSuperAdmin: !!user.isSuperAdmin,
  });
  return {
    authorization: `Bearer ${token}`,
    "x-school-id": school.id,
  };
}

async function requestJson(
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string>
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function waitFor(
  predicate: () => Promise<boolean>,
  message: string,
  timeoutMs = 3_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

async function setCentralRecipient(userId: string | null): Promise<void> {
  await inSchool(school.id, () =>
    storage.updateEnrollmentSettings(school.id, { centralEmailRecipientUserId: userId } as any)
  );
}

async function saveInstructionalMonth(
  month: string,
  nonInstructionalDates: string[],
  now = new Date("2026-08-11T16:00:00.000Z")
): Promise<any> {
  return inSchool(school.id, async () => {
    const current = await storage.getInstructionalCalendarMonth(school.id, month);
    const result = await storage.replaceInstructionalCalendarMonth({
      schoolId: school.id,
      month,
      expectedRevision: current.revision,
      nonInstructionalDates,
      updatedBy: centralRecipient.id,
      now,
    });
    assert.equal(result.status, "saved");
    return result;
  });
}

async function createClass(options: {
  name: string;
  teacherId?: string;
  groupType?: "admin_class" | "teacher_small_group" | "teacher_created";
  scheduled?: boolean;
  start?: string;
  end?: string;
  roster?: any[];
}): Promise<any> {
  let group = await inSchool(school.id, () => storage.createGroup({
    schoolId: school.id,
    teacherId: options.teacherId || teacher.id,
    name: `${TAG}_${options.name}`,
    groupType: options.groupType || "admin_class",
    status: "active",
    scheduleEnabled: false,
    blockStartTime: null,
    blockEndTime: null,
  } as any));
  if (options.scheduled) {
    // This long-lived scheduler fixture intentionally accumulates many classes
    // with identical bell windows across independent test cases. Production
    // writers correctly reject those overlaps, so seed the legacy/direct-write
    // fixture explicitly and let the runtime tests exercise fail-closed logic.
    await inSchool(school.id, () => db.execute(sql`
      UPDATE groups
      SET schedule_enabled = true,
          block_start_time = ${options.start || "09:00"},
          block_end_time = ${options.end || "10:00"}
      WHERE id = ${group.id} AND school_id = ${school.id}
    `));
    group = await inSchool(school.id, () =>
      storage.getGroupByIdAndSchool(group.id, school.id)
    );
    scheduledGroupIdsCreatedByCurrentTest.push(group.id);
  }
  const roster = options.roster || [studentOne];
  if (roster.length > 0) {
    await inSchool(school.id, () =>
      storage.addGroupStudentsDetailed(group.id, roster.map((student) => student.id))
    );
  }
  return group;
}

async function deliveryRows(sessionId: string, targetSchoolId = school.id): Promise<any[]> {
  const result = await inSchool(targetSchoolId, () => db.execute(sql`
    SELECT id, school_id, teaching_session_id, recipient_kind, recipient_email,
           state, attempt_count, submission_started_at, next_attempt_at,
           provider_message_id, last_error, sent_at
    FROM classpilot_session_summary_deliveries
    WHERE teaching_session_id = ${sessionId}
    ORDER BY recipient_kind
  `));
  return result.rows;
}

async function materializeReportForSession(
  sessionId: string,
  targetSchoolId = school.id
): Promise<Date> {
  const pending = await inSchool(targetSchoolId, () =>
    storage.getClasspilotSessionReportBySession(targetSchoolId, sessionId)
  );
  assert.ok(pending, "finalization must create a pending immutable report");
  assert.ok(["pending", "materializing"].includes(pending.state), `unexpected pre-settlement report state: ${pending.state}`);
  const settleAt = new Date(pending.settleAt);
  await inSchool(targetSchoolId, () => monitoringReports.materializeDueClasspilotSessionReports({
    now: settleAt,
    limit: 100,
    schoolId: targetSchoolId,
    teachingSessionId: sessionId,
  }));
  const ready = await inSchool(targetSchoolId, () =>
    storage.getClasspilotSessionReportBySession(targetSchoolId, sessionId)
  );
  assert.equal(ready?.state, "ready", "settled report must materialize before delivery");
  return settleAt;
}

async function materializeAndDispatch(options: {
  sessionId: string;
  schoolId?: string;
  transport?: (message: any) => Promise<any>;
}): Promise<any> {
  const targetSchoolId = options.schoolId || school.id;
  const settledAt = await materializeReportForSession(options.sessionId, targetSchoolId);
  return inSchool(targetSchoolId, () => lifecycle.dispatchDueClasspilotSessionSummaries({
    schoolId: targetSchoolId,
    teachingSessionId: options.sessionId,
    now: settledAt,
    ...(options.transport ? { transport: options.transport } : {}),
  }));
}

async function occurrenceCount(groupId: string, scheduledDate: string): Promise<number> {
  const result = await inSchool(school.id, () => db.execute(sql`
    SELECT count(*)::int AS count
    FROM teaching_sessions
    WHERE school_id = ${school.id}
      AND group_id = ${groupId}
      AND scheduled_date = ${scheduledDate}
  `));
  return Number(result.rows[0]?.count || 0);
}

async function seedScheduleChange(options: {
  firstGroup: any;
  secondGroup: any;
  scheduledDate: string;
  status?: "approved" | "pending_counterpart" | "pending_admin";
}): Promise<string> {
  return inSchool(school.id, () => db.transaction(async (tx: any) => {
    const status = options.status || "approved";
    const approved = status === "approved";
    const orderedGroupIds = [options.firstGroup.id, options.secondGroup.id].sort();
    const pairResult = await tx.execute(sql`
      INSERT INTO classpilot_schedule_change_pairs (
        school_id, first_group_id, second_group_id, status, created_by
      ) VALUES (
        ${school.id}, ${orderedGroupIds[0]}, ${orderedGroupIds[1]}, 'active', ${centralRecipient.id}
      )
      RETURNING id
    `);
    const pairId = String(pairResult.rows[0].id);
    const changeResult = await tx.execute(sql`
      INSERT INTO classpilot_schedule_changes (
        school_id, pair_id, scheduled_date, timezone_snapshot, status, reason,
        requested_by_user_id, requester_group_id, counterpart_teacher_id,
        requested_by_role, requires_admin_approval, reservation_active,
        approved_by_user_id, approved_at
      ) VALUES (
        ${school.id}, ${pairId}, ${options.scheduledDate}, 'America/New_York',
        ${status}, 'Event-day class-time exchange', ${centralRecipient.id},
        ${options.firstGroup.id}, ${options.secondGroup.teacherId}, 'admin', true,
        true, ${approved ? centralRecipient.id : null}, ${approved ? new Date("2030-12-01T12:00:00.000Z") : null}
      )
      RETURNING id
    `);
    const changeId = String(changeResult.rows[0].id);
    await tx.execute(sql`
      INSERT INTO classpilot_schedule_change_legs (
        school_id, schedule_change_id, scheduled_date, leg_order, group_id,
        primary_teacher_id_snapshot, class_name_snapshot,
        original_start_time, original_end_time,
        effective_start_time, effective_end_time, reservation_active
      ) VALUES
      (
        ${school.id}, ${changeId}, ${options.scheduledDate}, 1, ${options.firstGroup.id},
        ${options.firstGroup.teacherId}, ${options.firstGroup.name},
        ${options.firstGroup.blockStartTime}, ${options.firstGroup.blockEndTime},
        ${options.secondGroup.blockStartTime}, ${options.secondGroup.blockEndTime}, true
      ),
      (
        ${school.id}, ${changeId}, ${options.scheduledDate}, 2, ${options.secondGroup.id},
        ${options.secondGroup.teacherId}, ${options.secondGroup.name},
        ${options.secondGroup.blockStartTime}, ${options.secondGroup.blockEndTime},
        ${options.firstGroup.blockStartTime}, ${options.firstGroup.blockEndTime}, true
      )
    `);
    return changeId;
  }));
}

async function finalizeManualForDelivery(
  name: string,
  finalizedAt: Date,
  centralUserId: string | null = null
): Promise<{ group: any; session: any }> {
  await setCentralRecipient(centralUserId);
  const group = await createClass({ name });
  const session = await inSchool(school.id, () =>
    storage.createTeachingSession({ groupId: group.id, teacherId: teacher.id } as any)
  );
  const result = await inSchool(school.id, () => lifecycle.finalizeClasspilotSession({
    schoolId: school.id,
    sessionId: session.id,
    reason: "manual_end",
    finalizedAt,
  }));
  assert.equal(result?.summaryDisposition, "queued");
  return { group, session: result.session };
}

async function cleanup(): Promise<void> {
  if (!school?.id) return;
  await asSystem(async () => {
    await db.transaction(async (tx: any) => {
      await tx.execute(sql`DELETE FROM classpilot_schedule_change_legs WHERE school_id = ${school.id}`);
      await tx.execute(sql`DELETE FROM classpilot_schedule_changes WHERE school_id = ${school.id}`);
      await tx.execute(sql`DELETE FROM classpilot_schedule_change_pairs WHERE school_id = ${school.id}`);
    });
    await db.execute(sql`DELETE FROM classpilot_session_summary_deliveries WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM classpilot_monitoring_events WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM classpilot_session_student_reports WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM classpilot_session_reports WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM classpilot_session_staff WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM classpilot_student_control_states WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM classpilot_session_usage WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM session_settings WHERE session_id IN (SELECT id FROM teaching_sessions WHERE school_id = ${school.id})`);
    await db.execute(sql`DELETE FROM classpilot_classroom_states WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM classpilot_active_hands WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM classpilot_supervision_students WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM classpilot_supervision_contexts WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM classpilot_scheduled_conflicts WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM classpilot_session_students WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM heartbeats WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM teaching_sessions WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM student_sessions WHERE student_id IN (SELECT id FROM students WHERE school_id = ${school.id})`);
    await db.execute(sql`DELETE FROM student_devices WHERE student_id IN (SELECT id FROM students WHERE school_id = ${school.id})`);
    await db.execute(sql`DELETE FROM devices WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM group_students WHERE group_id IN (SELECT id FROM groups WHERE school_id = ${school.id})`);
    await db.execute(sql`DELETE FROM group_teachers WHERE group_id IN (SELECT id FROM groups WHERE school_id = ${school.id})`);
    await db.execute(sql`DELETE FROM groups WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM students WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM audit_logs WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM settings WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM product_licenses WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM school_memberships WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM schools WHERE id = ${school.id}`);
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${`%@${TAG}.example.edu`}`);
  });
}

afterEach(async () => {
  if (!school?.id) return;
  const scheduledGroupIds = scheduledGroupIdsCreatedByCurrentTest;
  scheduledGroupIdsCreatedByCurrentTest = [];
  await inSchool(school.id, () => db.transaction(async (tx: any) => {
    await tx.execute(sql`DELETE FROM classpilot_schedule_change_legs WHERE school_id = ${school.id}`);
    await tx.execute(sql`DELETE FROM classpilot_schedule_changes WHERE school_id = ${school.id}`);
    await tx.execute(sql`DELETE FROM classpilot_schedule_change_pairs WHERE school_id = ${school.id}`);
    if (scheduledGroupIds.length > 0) {
      await tx.execute(sql`
        UPDATE groups
        SET schedule_enabled = false
        WHERE school_id = ${school.id}
          AND id IN (${sql.join(scheduledGroupIds.map((id) => sql`${id}`), sql`, `)})
      `);
    }
  }));
});

before(async () => {
  const dbModule = await import("../dist/db.js");
  db = dbModule.default;
  pool = dbModule.pool;
  storage = await import("../dist/services/storage.js");
  lifecycle = await import("../dist/services/classpilotSessionLifecycle.js");
  monitoringReports = await import("../dist/services/classpilotMonitoringReports.js");
  scheduled = await import("../dist/services/classpilotScheduledStart.js");
  scheduler = await import("../dist/services/scheduler.js");
  schoolTime = await import("../dist/util/schoolTime.js");
  const schedulerDbModule = await import("../dist/services/schedulerDb.js");
  schedulerPool = schedulerDbModule.schedulerPool;
  schedulerLockPool = schedulerDbModule.schedulerLockPool;
  ({ runWithTenantContext } = await import("../dist/middleware/tenantContext.js"));
  ({ signUserToken } = await import("../dist/services/jwt.js"));
  sgMail = (await import("@sendgrid/mail")).default;

  sendBehavior = async () => [{ headers: { "x-message-id": `${TAG}-sent` } }];
  sendMock = mock.method(sgMail, "send", async (message: any) => {
    sentMessages.push(message);
    return sendBehavior(message);
  });

  school = await storage.createSchool({
    name: `${TAG}_School`,
    domain: `${TAG}.example.edu`,
    slug: TAG,
    schoolTimezone: "America/New_York",
  } as any);
  teacher = await storage.createUser({
    email: `teacher@${TAG}.example.edu`,
    firstName: "Terry",
    lastName: "Teacher",
  } as any);
  secondTeacher = await storage.createUser({
    email: `second-teacher@${TAG}.example.edu`,
    firstName: "Sasha",
    lastName: "Second",
  } as any);
  centralRecipient = await storage.createUser({
    email: `central@${TAG}.example.edu`,
    firstName: "Casey",
    lastName: "Central",
  } as any);
  for (const [user, role] of [[teacher, "teacher"], [secondTeacher, "teacher"], [centralRecipient, "admin"]] as const) {
    await storage.createMembership({
      userId: user.id,
      schoolId: school.id,
      role,
      status: "active",
    } as any);
  }
  await storage.createProductLicense({ schoolId: school.id, product: "CLASSPILOT", status: "active" } as any);
  studentOne = await inSchool(school.id, () => storage.createStudent({
    schoolId: school.id,
    firstName: "Student",
    lastName: "One",
    email: `student-one@${TAG}.example.edu`,
    emailLc: `student-one@${TAG}.example.edu`,
    gradeLevel: "7",
    status: "active",
  } as any));
  studentTwo = await inSchool(school.id, () => storage.createStudent({
    schoolId: school.id,
    firstName: "Student",
    lastName: "Two",
    email: `student-two@${TAG}.example.edu`,
    emailLc: `student-two@${TAG}.example.edu`,
    gradeLevel: "7",
    status: "active",
  } as any));

  const { createApp } = await import("../dist/app.js");
  server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

after(async () => {
  try {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve())
      );
    }
    await cleanup();
  } finally {
    sendMock?.mock.restore();
    await schedulerLockPool?.end().catch(() => undefined);
    await schedulerPool?.end().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    if (ORIGINAL_SENDGRID_API_KEY === undefined) delete process.env.SENDGRID_API_KEY;
    else process.env.SENDGRID_API_KEY = ORIGINAL_SENDGRID_API_KEY;
    if (ORIGINAL_REDIS_URL === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = ORIGINAL_REDIS_URL;
  }
});

describe("ClassPilot scheduled Session Summary lifecycle", { concurrency: false }, () => {
  it("resolves spring-forward gaps and fall-back ambiguity with compatible school-local semantics", () => {
    assert.equal(
      schoolTime.localDateTimeUtc("2031-03-09", "01:30", "America/New_York").toISOString(),
      "2031-03-09T06:30:00.000Z"
    );
    assert.equal(
      schoolTime.localDateTimeUtc("2031-03-09", "02:30", "America/New_York").toISOString(),
      "2031-03-09T07:30:00.000Z",
      "nonexistent spring time should advance across the one-hour gap"
    );
    assert.equal(
      schoolTime.localDateTimeUtc("2031-03-09", "03:30", "America/New_York").toISOString(),
      "2031-03-09T07:30:00.000Z"
    );
    assert.equal(
      schoolTime.localDateTimeUtc("2031-11-02", "01:30", "America/New_York").toISOString(),
      "2031-11-02T05:30:00.000Z",
      "ambiguous fall time should choose the earlier instant"
    );
    assert.equal(
      schoolTime.localDateTimeUtc("2031-11-02", "02:30", "America/New_York").toISOString(),
      "2031-11-02T07:30:00.000Z"
    );
  });

  it("blocks automatic occurrences, coverage, and email on a closed weekday even with teacher presence and a home heartbeat", async () => {
    await setCentralRecipient(centralRecipient.id);
    const scheduledDate = "2031-07-01";
    await saveInstructionalMonth("2031-07", [scheduledDate]);
    const group = await createClass({ name: "calendar_closed_home_activity", scheduled: true });
    await inSchool(school.id, () => db.execute(sql`
      INSERT INTO heartbeats (
        device_id, student_id, student_email, school_id,
        active_tab_title, active_tab_url, timestamp
      ) VALUES (
        ${`${TAG}-closed-home-device`}, ${studentOne.id}, ${studentOne.email}, ${school.id},
        'Home Chromebook activity', 'https://home.example.edu', '2031-07-01 13:05:00'
      )
    `));

    const schedulerLogs: string[] = [];
    const consoleLogMock = mock.method(console, "log", (...args: unknown[]) => {
      schedulerLogs.push(args.map(String).join(" "));
    });
    try {
      await scheduler.reconcileClasspilotScheduledSessions(
        new Date("2031-07-01T13:05:00.000Z"),
        school.id
      );
    } finally {
      consoleLogMock.mock.restore();
    }
    const skipMetric = schedulerLogs
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .find((entry) => entry?.AutomaticScheduleSkipped === 1);
    assert.equal(skipMetric?.Reason, "non_instructional_day");
    assert.ok(schedulerLogs.some((line) => line.includes("non_instructional_day")));
    const direct = await inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
      group,
      scheduledDate,
      scheduledTeacherConnectedOverride: true,
      now: new Date("2031-07-01T13:10:00.000Z"),
    }));
    assert.deepEqual(direct, { status: "skipped", reason: "non_instructional_day" });

    const skipped = await inSchool(school.id, () => scheduled.skipScheduledClassBeforeStart({
      group,
      scheduledDate,
      now: new Date("2031-07-01T12:55:00.000Z"),
    }));
    assert.deepEqual(skipped, { skipped: false, reason: "non_instructional_day" });
    assert.equal(await occurrenceCount(group.id, scheduledDate), 0);

    const sideEffects = await inSchool(school.id, () => db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM classpilot_scheduled_conflicts
         WHERE school_id = ${school.id} AND group_id = ${group.id}) AS conflict_count,
        (SELECT count(*)::int FROM classpilot_supervision_contexts
         WHERE school_id = ${school.id} AND scheduled_conflict_id IN (
           SELECT id FROM classpilot_scheduled_conflicts WHERE group_id = ${group.id}
         )) AS coverage_count,
        (SELECT count(*)::int FROM classpilot_session_summary_deliveries delivery
         JOIN teaching_sessions session ON session.id = delivery.teaching_session_id
         WHERE session.school_id = ${school.id} AND session.group_id = ${group.id}) AS delivery_count
    `));
    assert.deepEqual(sideEffects.rows, [{ conflict_count: 0, coverage_count: 0, delivery_count: 0 }]);
  });

  it("keeps unmarked weekdays authoritative, including a zero-activity scheduled summary and a manual class on a closed date", async () => {
    await setCentralRecipient(null);
    const scheduledDate = "2031-07-02";
    const group = await createClass({ name: "calendar_open_zero_activity", scheduled: true });
    const started = await inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
      group,
      scheduledDate,
      scheduledTeacherConnectedOverride: false,
      now: new Date("2031-07-02T13:30:00.000Z"),
    }));
    assert.equal(started.status, "coverage_needed");
    const occurrence = await inSchool(school.id, () =>
      storage.getScheduledTeachingSessionOccurrence(school.id, group.id, scheduledDate)
    );
    assert.ok(occurrence);
    const messageStart = sentMessages.length;

    await scheduler.reconcileClasspilotScheduledSessions(
      new Date("2031-07-02T14:00:00.000Z"),
      school.id
    );
    const waiting = await deliveryRows(occurrence.id);
    assert.equal(waiting.length, 1);
    assert.equal(waiting[0].state, "waiting_report");
    assert.equal(sentMessages.length, messageStart, "settlement window must not send early");
    await scheduler.reconcileClasspilotScheduledSessions(
      new Date("2031-07-02T14:00:30.000Z"),
      school.id
    );
    await waitFor(async () => {
      const rows = await deliveryRows(occurrence.id);
      return rows.length === 1 && rows[0].state === "sent";
    }, "unmarked instructional weekday did not dispatch its settled summary");
    assert.match(sentMessages.slice(messageStart).at(-1).html, /Observed browser telemetry/);
    assert.match(sentMessages.slice(messageStart).at(-1).html, /Monitoring coverage/);

    const manualGroup = await createClass({ name: "manual_on_calendar_closed" });
    const manualSession = await inSchool(school.id, () => storage.createTeachingSession({
      groupId: manualGroup.id,
      teacherId: teacher.id,
      startTime: new Date("2031-07-01T13:10:00.000Z"),
    } as any));
    const finalized = await inSchool(school.id, () => lifecycle.finalizeClasspilotSession({
      schoolId: school.id,
      sessionId: manualSession.id,
      reason: "manual_end",
      finalizedAt: new Date("2031-07-01T13:20:00.000Z"),
    }));
    assert.equal(finalized.summaryDisposition, "queued");
    assert.equal((await deliveryRows(manualSession.id))[0].state, "waiting_report");
    const premature = await inSchool(school.id, () => lifecycle.dispatchDueClasspilotSessionSummaries({
      schoolId: school.id,
      teachingSessionId: manualSession.id,
      now: new Date("2031-07-01T13:20:00.000Z"),
    }));
    assert.equal(premature.claimed, 0);
    const manualDispatch = await materializeAndDispatch({ sessionId: manualSession.id });
    assert.equal(manualDispatch.sent, 1);
    assert.equal((await deliveryRows(manualSession.id))[0].state, "sent");
  });

  it("keeps an already-frozen occurrence after a same-day closure while suppressing later blocks", async () => {
    await setCentralRecipient(null);
    const scheduledDate = "2031-07-03";
    const activeGroup = await createClass({
      name: "calendar_active_before_closure",
      scheduled: true,
      start: "09:00",
      end: "10:00",
    });
    const laterGroup = await createClass({
      name: "calendar_later_after_closure",
      teacherId: secondTeacher.id,
      scheduled: true,
      start: "11:00",
      end: "12:00",
    });
    const activeStart = await inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
      group: activeGroup,
      scheduledDate,
      scheduledTeacherConnectedOverride: false,
      now: new Date("2031-07-03T13:05:00.000Z"),
    }));
    assert.equal(activeStart.status, "coverage_needed");
    const activeOccurrence = await inSchool(school.id, () =>
      storage.getScheduledTeachingSessionOccurrence(school.id, activeGroup.id, scheduledDate)
    );
    assert.ok(activeOccurrence);

    await saveInstructionalMonth(
      "2031-07",
      ["2031-07-01", scheduledDate],
      new Date("2031-07-03T13:10:00.000Z")
    );
    const existing = await inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
      group: activeGroup,
      scheduledDate,
      scheduledTeacherConnectedOverride: false,
      now: new Date("2031-07-03T13:15:00.000Z"),
    }));
    assert.equal(existing.status, "coverage_needed");
    assert.equal(await occurrenceCount(activeGroup.id, scheduledDate), 1);

    const later = await inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
      group: laterGroup,
      scheduledDate,
      scheduledTeacherConnectedOverride: true,
      now: new Date("2031-07-03T15:05:00.000Z"),
    }));
    assert.deepEqual(later, { status: "skipped", reason: "non_instructional_day" });
    assert.equal(await occurrenceCount(laterGroup.id, scheduledDate), 0);

    await scheduler.reconcileClasspilotScheduledSessions(
      new Date("2031-07-03T14:00:00.000Z"),
      school.id
    );
    const finalized = await inSchool(school.id, () => storage.getTeachingSessionById(activeOccurrence.id));
    assert.equal(finalized.scheduledState, "finalized");
    assert.equal(finalized.endTime.toISOString(), "2031-07-03T14:00:00.000Z");
    assert.equal((await deliveryRows(activeOccurrence.id)).length, 1);
  });

  it("serializes a calendar closure racing the bell with canonical occurrence creation", async () => {
    await setCentralRecipient(null);
    const scheduledDate = "2031-07-07";
    const group = await createClass({ name: "calendar_save_bell_race", scheduled: true });
    const current = await inSchool(school.id, () =>
      storage.getInstructionalCalendarMonth(school.id, "2031-07")
    );
    const [save, start] = await Promise.all([
      inSchool(school.id, () => storage.replaceInstructionalCalendarMonth({
        schoolId: school.id,
        month: "2031-07",
        expectedRevision: current.revision,
        nonInstructionalDates: [...current.nonInstructionalDates, scheduledDate],
        updatedBy: centralRecipient.id,
        now: new Date("2031-07-07T13:00:00.000Z"),
      })),
      inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
        group,
        scheduledDate,
        scheduledTeacherConnectedOverride: false,
        now: new Date("2031-07-07T13:00:00.000Z"),
      })),
    ]);
    assert.equal(save.status, "saved");
    const occurrence = await inSchool(school.id, () =>
      storage.getScheduledTeachingSessionOccurrence(school.id, group.id, scheduledDate)
    );
    if (occurrence) {
      assert.equal(start.status, "coverage_needed", "occurrence winner must continue after the closure commits");
      await inSchool(school.id, () => lifecycle.finalizeClasspilotSession({
        schoolId: school.id,
        sessionId: occurrence.id,
        reason: "teacher_end",
        finalizedAt: new Date("2031-07-07T13:05:00.000Z"),
      }));
    } else {
      assert.deepEqual(start, { status: "skipped", reason: "non_instructional_day" });
    }
    assert.ok((await inSchool(school.id, () =>
      storage.getInstructionalCalendarMonth(school.id, "2031-07")
    )).nonInstructionalDates.includes(scheduledDate));
  });

  it("uses the school-local calendar date across a UTC date boundary", async () => {
    const scheduledDate = "2031-07-08";
    await saveInstructionalMonth(
      "2031-07",
      ["2031-07-01", "2031-07-03", "2031-07-07", scheduledDate],
      new Date("2031-07-08T12:00:00.000Z")
    );
    const group = await createClass({
      name: "calendar_school_local_boundary",
      scheduled: true,
      start: "23:00",
      end: "23:59",
    });
    await scheduler.reconcileClasspilotScheduledSessions(
      new Date("2031-07-09T03:30:00.000Z"),
      school.id
    );
    assert.equal(await occurrenceCount(group.id, scheduledDate), 0);
    assert.equal(await occurrenceCount(group.id, "2031-07-09"), 0);
  });

  it("fails closed without creating an occurrence when calendar settings cannot be read", async () => {
    const missingSettingsSchool = await storage.createSchool({
      name: `${TAG}_Missing_Calendar_Settings`,
      domain: `missing-calendar.${TAG}.example.edu`,
      slug: `${TAG}-missing-calendar-settings`,
      schoolTimezone: "America/New_York",
    } as any);
    const missingSettingsTeacher = await storage.createUser({
      email: `teacher@missing-calendar.${TAG}.example.edu`,
      firstName: "Missing",
      lastName: "Settings",
    } as any);
    try {
      await storage.createMembership({
        userId: missingSettingsTeacher.id,
        schoolId: missingSettingsSchool.id,
        role: "teacher",
        status: "active",
      } as any);
      await storage.createProductLicense({
        schoolId: missingSettingsSchool.id,
        product: "CLASSPILOT",
        status: "active",
      } as any);
      const group = await inSchool(missingSettingsSchool.id, () => storage.createGroup({
        schoolId: missingSettingsSchool.id,
        teacherId: missingSettingsTeacher.id,
        name: `${TAG}_missing_calendar_settings_group`,
        groupType: "admin_class",
        status: "active",
        scheduleEnabled: true,
        blockStartTime: "09:00",
        blockEndTime: "10:00",
      } as any));
      await assert.rejects(
        inSchool(missingSettingsSchool.id, () => scheduled.processScheduledClassAutoStart({
          group,
          scheduledDate: "2031-07-09",
          scheduledTeacherConnectedOverride: true,
          now: new Date("2031-07-09T13:05:00.000Z"),
        })),
        (error: any) => error?.code === "INSTRUCTIONAL_CALENDAR_SETTINGS_UNAVAILABLE"
      );
      const rows = await asSystem(() => db.execute(sql`
        SELECT count(*)::int AS count
        FROM teaching_sessions
        WHERE school_id = ${missingSettingsSchool.id}
      `));
      assert.equal(Number(rows.rows[0]?.count || 0), 0);
    } finally {
      await asSystem(async () => {
        await db.execute(sql`DELETE FROM classpilot_session_students WHERE school_id = ${missingSettingsSchool.id}`);
        await db.execute(sql`DELETE FROM teaching_sessions WHERE school_id = ${missingSettingsSchool.id}`);
        await db.execute(sql`DELETE FROM group_students WHERE group_id IN (SELECT id FROM groups WHERE school_id = ${missingSettingsSchool.id})`);
        await db.execute(sql`DELETE FROM group_teachers WHERE group_id IN (SELECT id FROM groups WHERE school_id = ${missingSettingsSchool.id})`);
        await db.execute(sql`DELETE FROM groups WHERE school_id = ${missingSettingsSchool.id}`);
        await db.execute(sql`DELETE FROM settings WHERE school_id = ${missingSettingsSchool.id}`);
        await db.execute(sql`DELETE FROM product_licenses WHERE school_id = ${missingSettingsSchool.id}`);
        await db.execute(sql`DELETE FROM school_memberships WHERE school_id = ${missingSettingsSchool.id}`);
        await db.execute(sql`DELETE FROM schools WHERE id = ${missingSettingsSchool.id}`);
        await db.execute(sql`DELETE FROM users WHERE id = ${missingSettingsTeacher.id}`);
      });
    }
  });

  it("keeps logout authentication-only and queues one teacher plus one distinct central delivery on manual End Class", async () => {
    await setCentralRecipient(centralRecipient.id);
    const group = await createClass({ name: "manual_logout_end" });
    const session = await inSchool(school.id, () =>
      storage.createTeachingSession({ groupId: group.id, teacherId: teacher.id } as any)
    );
    await inSchool(school.id, async () => {
      await db.execute(sql`
        INSERT INTO classpilot_classroom_states (
          school_id, teaching_session_id, student_id, state_type, state_key, payload, applied_by
        ) VALUES (
          ${school.id}, ${session.id}, ${studentOne.id}, 'screen_lock', 'class', '{}'::jsonb, ${teacher.id}
        )
      `);
      await db.execute(sql`
        INSERT INTO devices (device_id, device_name, school_id, class_id)
        VALUES (
          ${`${TAG}-manual-hand-device`}, 'Manual hand fixture', ${school.id}, ${group.id}
        )
      `);
      await db.execute(sql`
        INSERT INTO classpilot_active_hands (
          school_id, teaching_session_id, student_id, device_id
        ) VALUES (
          ${school.id}, ${session.id}, ${studentOne.id}, ${`${TAG}-manual-hand-device`}
        )
      `);
    });

    const logout = await requestJson("POST", "/auth/logout", {}, authFor(teacher));
    assert.equal(logout.status, 200);
    assert.equal((await inSchool(school.id, () => storage.getActiveTeachingSessionForSchool(teacher.id, school.id)))?.id, session.id);
    assert.equal((await deliveryRows(session.id)).length, 0, "logout must not queue a summary");

    const ended = await requestJson("POST", "/sessions/end", {}, authFor(teacher));
    assert.equal(ended.status, 200);
    assert.equal(ended.body.summaryDisposition, "queued");
    const waiting = await deliveryRows(session.id);
    assert.equal(waiting.length, 2);
    assert.ok(waiting.every((delivery) => delivery.state === "waiting_report"));
    const dispatch = await materializeAndDispatch({ sessionId: session.id });
    assert.equal(dispatch.sent, 2);
    const rows = await deliveryRows(session.id);
    assert.ok(rows.every((delivery) => delivery.state === "sent"));
    assert.deepEqual(rows.map((row) => row.recipient_kind), ["central", "teacher"]);
    assert.equal(new Set(rows.map((row) => row.recipient_email.toLowerCase())).size, 2);
    assert.equal(await inSchool(school.id, () => storage.getActiveTeachingSessionForSchool(teacher.id, school.id)), undefined);
    const cleared = await inSchool(school.id, () => db.execute(sql`
      SELECT
        (SELECT cleared_at IS NOT NULL FROM classpilot_classroom_states
         WHERE teaching_session_id = ${session.id}) AS classroom_cleared,
        (SELECT cleared_at IS NOT NULL FROM classpilot_active_hands
         WHERE teaching_session_id = ${session.id}) AS hand_cleared
    `));
    assert.deepEqual(cleared.rows, [{ classroom_cleared: true, hand_cleared: true }]);
  });

  it("snapshots a teacher-created class roster and includes it in the manual summary", async () => {
    await setCentralRecipient(null);
    const group = await createClass({
      name: "manual_teacher_created_roster",
      groupType: "teacher_created",
      roster: [studentOne, studentTwo],
    });
    const session = await inSchool(school.id, () =>
      storage.createTeachingSession({ groupId: group.id, teacherId: teacher.id } as any)
    );
    const snapshot = await inSchool(school.id, () =>
      storage.getClasspilotSessionStudents(session.id)
    );
    assert.deepEqual(
      snapshot.map((row: any) => row.studentId).sort(),
      [studentOne.id, studentTwo.id].sort()
    );

    const ended = await inSchool(school.id, () => lifecycle.finalizeClasspilotSession({
      schoolId: school.id,
      sessionId: session.id,
      reason: "manual_end",
      finalizedAt: new Date("2031-01-06T14:00:00.000Z"),
    }));
    assert.equal(ended.summaryDisposition, "queued");
    const waiting = await deliveryRows(session.id);
    assert.equal(waiting.length, 1);
    assert.equal(waiting[0].state, "waiting_report");

    const messageStart = sentMessages.length;
    const dispatched = await materializeAndDispatch({ sessionId: session.id });
    assert.equal(dispatched.sent, 1);
    assert.equal(sentMessages.length, messageStart + 1);
    assert.match(sentMessages.at(-1).html, /Students<\/td><td[^>]*>2<\/td>/);
  });

  it("rejects unrelated same-school staff from reading a session or changing its settings", async () => {
    await setCentralRecipient(null);
    const group = await createClass({ name: "unrelated_staff_session_access" });
    const session = await inSchool(school.id, () => storage.createTeachingSession({
      groupId: group.id,
      teacherId: teacher.id,
    } as any));

    const read = await requestJson(
      "GET",
      `/classpilot/teaching-sessions/${session.id}`,
      undefined,
      authFor(secondTeacher)
    );
    assert.equal(read.status, 404);

    const update = await requestJson(
      "PUT",
      `/classpilot/teaching-sessions/${session.id}/settings`,
      { chatEnabled: false, raiseHandEnabled: false },
      authFor(secondTeacher)
    );
    assert.equal(update.status, 404);
    const settingsMutation = await inSchool(school.id, () => db.execute(sql`
      SELECT count(*)::int AS count
      FROM session_settings
      WHERE session_id = ${session.id}
    `));
    assert.equal(Number(settingsMutation.rows[0]?.count || 0), 0);

    await inSchool(school.id, () => lifecycle.finalizeClasspilotSession({
      schoolId: school.id,
      sessionId: session.id,
      reason: "manual_end",
    }));
  });

  it("finalizes an old manual class as replacement_start before scheduled pickup leaves exactly one live class", async () => {
    await setCentralRecipient(null);
    const manualGroup = await createClass({ name: "manual_replaced_by_schedule" });
    const manualSession = await inSchool(school.id, () => storage.createTeachingSession({
      groupId: manualGroup.id,
      teacherId: teacher.id,
    } as any));
    const scheduledGroup = await createClass({ name: "scheduled_replacement", scheduled: true });
    const started = await inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
      group: scheduledGroup,
      scheduledDate: "2031-01-06",
      scheduledTeacherConnectedOverride: true,
      now: new Date("2031-01-06T14:05:00.000Z"),
    }));

    assert.equal(started.status, "started");
    const replaced = await inSchool(school.id, () => storage.getTeachingSessionById(manualSession.id));
    assert.ok(replaced.endTime);
    assert.equal(replaced.scheduledFinalizationReason, "replacement_start");
    assert.equal((await deliveryRows(manualSession.id)).length, 1);
    const live = await inSchool(school.id, () => db.execute(sql`
      SELECT id
      FROM teaching_sessions
      WHERE school_id = ${school.id}
        AND teacher_id = ${teacher.id}
        AND session_mode = 'live'
        AND end_time IS NULL
      ORDER BY id
    `));
    assert.deepEqual(live.rows, [{ id: started.session.id }]);

    await inSchool(school.id, () => lifecycle.finalizeClasspilotSession({
      schoolId: school.id,
      sessionId: started.session.id,
      reason: "teacher_end",
      finalizedAt: new Date("2031-01-06T14:10:00.000Z"),
    }));
  });

  it("linearizes truly concurrent manual and scheduled starts to exactly one live class", async () => {
    await setCentralRecipient(null);
    const manualGroup = await createClass({ name: "manual_scheduled_start_race" });
    const scheduledGroup = await createClass({ name: "scheduled_manual_start_race", scheduled: true });

    const [manualStart, scheduledStart] = await Promise.all([
      requestJson(
        "POST",
        "/classpilot/teaching-sessions/start",
        { groupId: manualGroup.id },
        authFor(teacher)
      ),
      inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
        group: scheduledGroup,
        scheduledDate: "2031-01-21",
        scheduledTeacherConnectedOverride: true,
        now: new Date("2031-01-21T14:05:00.000Z"),
      })),
    ]);
    assert.equal(manualStart.status, 201);
    assert.equal(scheduledStart.status, "started");

    const raceSessions = await inSchool(school.id, () => db.execute(sql`
      SELECT id, group_id, end_time
      FROM teaching_sessions
      WHERE school_id = ${school.id}
        AND teacher_id = ${teacher.id}
        AND group_id IN (${manualGroup.id}, ${scheduledGroup.id})
      ORDER BY id
    `));
    const live = raceSessions.rows.filter((row: any) => row.end_time === null);
    assert.equal(live.length, 1);
    assert.ok(
      [manualStart.body.session.id, scheduledStart.session.id].includes(live[0].id),
      "the sole live row must be one of the two serialized start winners"
    );
    assert.equal(raceSessions.rows.filter((row: any) => row.end_time !== null).length, 1);

    await inSchool(school.id, () => lifecycle.finalizeClasspilotSession({
      schoolId: school.id,
      sessionId: live[0].id,
      reason: live[0].group_id === scheduledGroup.id ? "teacher_end" : "manual_end",
    }));
  });

  it("rolls back replacement, outbox, promotion, and conflict effects when a scheduled start fails inside its lock", async () => {
    await setCentralRecipient(null);
    const oldGroup = await createClass({ name: "rollback_old_manual" });
    const oldSession = await inSchool(school.id, () => storage.createTeachingSession({
      groupId: oldGroup.id,
      teacherId: teacher.id,
    } as any));
    const scheduledGroup = await createClass({ name: "rollback_scheduled_start", scheduled: true });
    const prepared = await inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
      group: scheduledGroup,
      scheduledDate: "2031-01-22",
      scheduledTeacherConnectedOverride: false,
      now: new Date("2031-01-22T14:05:00.000Z"),
    }));
    assert.equal(prepared.status, "coverage_needed");
    const occurrence = await inSchool(school.id, () =>
      storage.getScheduledTeachingSessionOccurrence(school.id, scheduledGroup.id, "2031-01-22")
    );
    const sentBefore = sentMessages.length;

    await assert.rejects(
      inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
        group: scheduledGroup,
        scheduledDate: "2031-01-22",
        scheduledTeacherConnectedOverride: true,
        now: new Date("2031-01-22T14:10:00.000Z"),
        afterReplacement: async () => {
          throw new Error("forced start-lock rollback");
        },
      })),
      /forced start-lock rollback/
    );

    const [oldAfter, occurrenceAfter, conflictAfter] = await Promise.all([
      inSchool(school.id, () => storage.getTeachingSessionById(oldSession.id)),
      inSchool(school.id, () => storage.getTeachingSessionById(occurrence.id)),
      inSchool(school.id, () =>
        storage.getScheduledClassConflictByIdAndSchool(prepared.conflictId, school.id)
      ),
    ]);
    assert.equal(oldAfter.endTime, null);
    assert.equal(oldAfter.scheduledFinalizationReason, null);
    assert.equal(occurrenceAfter.sessionMode, "scheduled_report");
    assert.equal(occurrenceAfter.endTime, null);
    assert.equal(conflictAfter.status, "coverage_needed");
    assert.equal((await deliveryRows(oldSession.id)).length, 0);
    assert.equal(sentMessages.length, sentBefore, "a rolled-back replacement must not kick delivery");

    await inSchool(school.id, () => lifecycle.finalizeClasspilotSession({
      schoolId: school.id,
      sessionId: oldSession.id,
      reason: "manual_end",
    }));
    await inSchool(school.id, () => lifecycle.finalizeClasspilotSession({
      schoolId: school.id,
      sessionId: occurrence.id,
      reason: "teacher_end",
      finalizedAt: new Date("2031-01-22T14:15:00.000Z"),
    }));
  });

  it("guards admin and teacher-created class history from deletion while allowing no-history deletes", async () => {
    await setCentralRecipient(null);
    const adminHistory = await createClass({ name: "admin_delete_history" });
    const adminHistorySession = await inSchool(school.id, () => storage.createTeachingSession({
      groupId: adminHistory.id,
      teacherId: teacher.id,
    } as any));
    await inSchool(school.id, () => lifecycle.finalizeClasspilotSession({
      schoolId: school.id,
      sessionId: adminHistorySession.id,
      reason: "manual_end",
    }));
    const adminHistoryDelete = await requestJson(
      "DELETE",
      `/classpilot/admin/classes/${adminHistory.id}`,
      undefined,
      authFor(centralRecipient)
    );
    assert.equal(adminHistoryDelete.status, 409);
    assert.equal(adminHistoryDelete.body.code, "CLASS_HAS_HISTORY");
    assert.match(adminHistoryDelete.body.error, /archiv/i);

    const teacherHistory = await createClass({
      name: "teacher_delete_history",
      groupType: "teacher_created",
    });
    const teacherHistorySession = await inSchool(school.id, () => storage.createTeachingSession({
      groupId: teacherHistory.id,
      teacherId: teacher.id,
    } as any));
    await inSchool(school.id, () => lifecycle.finalizeClasspilotSession({
      schoolId: school.id,
      sessionId: teacherHistorySession.id,
      reason: "manual_end",
    }));
    const teacherHistoryDelete = await requestJson(
      "DELETE",
      `/groups/${teacherHistory.id}`,
      undefined,
      authFor(teacher)
    );
    assert.equal(teacherHistoryDelete.status, 409);
    assert.equal(teacherHistoryDelete.body.code, "CLASS_HAS_HISTORY");
    assert.match(teacherHistoryDelete.body.error, /archiv/i);

    const adminNoHistory = await createClass({ name: "admin_delete_no_history" });
    const adminNoHistoryDelete = await requestJson(
      "DELETE",
      `/classpilot/admin/classes/${adminNoHistory.id}`,
      undefined,
      authFor(centralRecipient)
    );
    assert.equal(adminNoHistoryDelete.status, 200);
    assert.equal(adminNoHistoryDelete.body.ok, true);

    const teacherNoHistory = await createClass({
      name: "teacher_delete_no_history",
      groupType: "teacher_created",
    });
    const teacherNoHistoryDelete = await requestJson(
      "DELETE",
      `/groups/${teacherNoHistory.id}`,
      undefined,
      authFor(teacher)
    );
    assert.equal(teacherNoHistoryDelete.status, 200);
    assert.equal(teacherNoHistoryDelete.body.ok, true);
  });

  it("linearizes class creation against hard delete without orphaning teaching history", async () => {
    const group = await createClass({
      name: "create_session_hard_delete_race",
      groupType: "teacher_created",
    });
    const [createResult, deleteResult] = await Promise.allSettled([
      inSchool(school.id, () => storage.createTeachingSession({
        groupId: group.id,
        teacherId: teacher.id,
      } as any)),
      inSchool(school.id, () => storage.hardDeleteGroupWithCleanup(group.id)),
    ]);

    const persisted = await asSystem(() => db.execute(sql`
      SELECT
        EXISTS (SELECT 1 FROM groups WHERE id = ${group.id}) AS group_exists,
        (SELECT count(*)::int FROM teaching_sessions WHERE group_id = ${group.id}) AS session_count
    `));
    const state = persisted.rows[0];
    if (createResult.status === "fulfilled") {
      assert.equal(deleteResult.status, "rejected");
      assert.equal((deleteResult as PromiseRejectedResult).reason.status, 409);
      assert.equal((deleteResult as PromiseRejectedResult).reason.code, "CLASS_HAS_HISTORY");
      assert.equal(state.group_exists, true);
      assert.equal(Number(state.session_count), 1);
      await inSchool(school.id, () => lifecycle.finalizeClasspilotSession({
        schoolId: school.id,
        sessionId: createResult.value.id,
        reason: "manual_end",
      }));
    } else {
      assert.equal(deleteResult.status, "fulfilled");
      assert.equal(deleteResult.value, true);
      assert.match(String(createResult.reason?.message || createResult.reason), /group .* not found/i);
      assert.equal(state.group_exists, false);
      assert.equal(Number(state.session_count), 0);
    }
  });

  it("does not invent and email a missing occurrence after its configured end", async () => {
    await setCentralRecipient(centralRecipient.id);
    const group = await createClass({ name: "missed_window", scheduled: true, start: "08:00", end: "08:45" });
    const scheduledDate = "2031-01-06";
    const result = await inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
      group,
      scheduledDate,
      scheduledTeacherConnectedOverride: false,
      now: new Date("2031-01-06T14:00:00.000Z"),
    }));
    assert.equal(result.status, "skipped");
    assert.equal(await occurrenceCount(group.id, scheduledDate), 0);
    const deliveries = await inSchool(school.id, () => db.execute(sql`
      SELECT count(*)::int AS count
      FROM classpilot_session_summary_deliveries delivery
      JOIN teaching_sessions session ON session.id = delivery.teaching_session_id
      WHERE session.group_id = ${group.id}
    `));
    assert.equal(Number(deliveries.rows[0]?.count || 0), 0);
  });

  it("suppresses original windows, starts both swapped windows once, and restores the recurring schedule next day", async () => {
    await setCentralRecipient(null);
    await saveInstructionalMonth("2031-01", []);
    const firstGroup = await createClass({
      name: "swap_runtime_first",
      teacherId: teacher.id,
      scheduled: true,
      start: "09:00",
      end: "10:00",
      roster: [],
    });
    const secondGroup = await createClass({
      name: "swap_runtime_second",
      teacherId: secondTeacher.id,
      scheduled: true,
      start: "10:00",
      end: "11:00",
      roster: [],
    });
    const scheduledDate = "2031-01-09";
    await seedScheduleChange({ firstGroup, secondGroup, scheduledDate });

    const runtimeLogs: string[] = [];
    const runtimeLogMock = mock.method(console, "log", (...args: unknown[]) => {
      runtimeLogs.push(args.map(String).join(" "));
    });
    try {
    const sessionRoutes = await import("../dist/routes/classpilot/sessions.js");
    await assert.rejects(
      () => inSchool(school.id, () => sessionRoutes.assertManualStartWindow(
        firstGroup,
        new Date("2031-01-09T14:30:00.000Z")
      )),
      (error: any) => {
        assert.equal(error.code, "SCHEDULE_CHANGE_WINDOW_REQUIRED");
        assert.equal(error.status, 403);
        return true;
      }
    );
    await assert.doesNotReject(() => inSchool(school.id, () =>
      sessionRoutes.assertManualStartWindow(
        firstGroup,
        new Date("2031-01-09T15:30:00.000Z")
      )
    ));

    const originalWindowCandidates = await inSchool(school.id, () =>
      scheduled.getClasspilotGroupsReadyAtEffectiveWindow({
        schoolId: school.id,
        scheduledDate,
        currentTimeHHMM: "09:30",
      })
    );
    assert.equal(originalWindowCandidates.some((group: any) => group.id === firstGroup.id), false);
    assert.equal(originalWindowCandidates.some((group: any) => group.id === secondGroup.id), true);

    const suppressed = await inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
      group: firstGroup,
      scheduledDate,
      scheduledTeacherConnectedOverride: true,
      now: new Date("2031-01-09T14:30:00.000Z"),
    }));
    assert.deepEqual(suppressed, { status: "skipped", reason: "outside_schedule_window" });
    assert.equal(await occurrenceCount(firstGroup.id, scheduledDate), 0);

    const secondStarted = await inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
      group: secondGroup,
      scheduledDate,
      scheduledTeacherConnectedOverride: true,
      now: new Date("2031-01-09T14:30:00.000Z"),
    }));
    assert.equal(secondStarted.status, "started");
    assert.equal(secondStarted.session.scheduledStartAt.toISOString(), "2031-01-09T14:00:00.000Z");
    assert.equal(secondStarted.session.scheduledEndAt.toISOString(), "2031-01-09T15:00:00.000Z");

    const [firstAttempt, secondAttempt] = await Promise.all([
      inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
        group: firstGroup,
        scheduledDate,
        scheduledTeacherConnectedOverride: true,
        now: new Date("2031-01-09T15:30:00.000Z"),
      })),
      inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
        group: firstGroup,
        scheduledDate,
        scheduledTeacherConnectedOverride: true,
        now: new Date("2031-01-09T15:30:00.000Z"),
      })),
    ]);
    // Both callers serialize on the teacher start lock; whichever observes the
    // promoted occurrence reports already_live instead of re-starting it.
    assert.ok(["started", "already_live"].includes(firstAttempt.status), firstAttempt.status);
    assert.ok(["started", "already_live"].includes(secondAttempt.status), secondAttempt.status);
    assert.equal(firstAttempt.session.id, secondAttempt.session.id);
    assert.equal(await occurrenceCount(firstGroup.id, scheduledDate), 1);
    assert.equal(firstAttempt.session.scheduledStartAt.toISOString(), "2031-01-09T15:00:00.000Z");
    assert.equal(firstAttempt.session.scheduledEndAt.toISOString(), "2031-01-09T16:00:00.000Z");

    const nextDate = "2031-01-10";
    const nextDay = await inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
      group: firstGroup,
      scheduledDate: nextDate,
      scheduledTeacherConnectedOverride: true,
      now: new Date("2031-01-10T14:30:00.000Z"),
    }));
    assert.equal(nextDay.status, "started");
    assert.equal(nextDay.session.scheduledStartAt.toISOString(), "2031-01-10T14:00:00.000Z");
    assert.equal(nextDay.session.scheduledEndAt.toISOString(), "2031-01-10T15:00:00.000Z");
    } finally {
      runtimeLogMock.mock.restore();
    }
    const runtimeMetrics = runtimeLogs.flatMap((line) => {
      try {
        const parsed = JSON.parse(line);
        return parsed?._aws?.CloudWatchMetrics?.[0]?.Namespace === "SchoolPilot/ClassPilot"
          ? [parsed]
          : [];
      } catch {
        return [];
      }
    });
    assert.equal(
      runtimeMetrics.filter((metric) => metric.OriginalWindowStartDenied === 1).length,
      1
    );
    assert.equal(
      runtimeMetrics.filter((metric) => metric.SwappedOccurrenceStarted === 1).length,
      2
    );
    assert.ok(
      runtimeMetrics.some((metric) => metric.EffectiveWindowResolved === 1)
    );
    assert.equal(
      runtimeMetrics.some((metric) => JSON.stringify(metric).includes(firstGroup.id)),
      false
    );
  });

  it("Skip Today freezes the swapped window and never falls back to the recurring window", async () => {
    await setCentralRecipient(null);
    await saveInstructionalMonth("2031-01", []);
    const firstGroup = await createClass({
      name: "swap_skip_first",
      scheduled: true,
      start: "09:00",
      end: "10:00",
      roster: [],
    });
    const secondGroup = await createClass({
      name: "swap_skip_second",
      teacherId: secondTeacher.id,
      scheduled: true,
      start: "10:00",
      end: "11:00",
      roster: [],
    });
    const scheduledDate = "2031-01-13";
    await seedScheduleChange({ firstGroup, secondGroup, scheduledDate });

    const skipped = await inSchool(school.id, () => scheduled.skipScheduledClassBeforeStart({
      group: firstGroup,
      scheduledDate,
      now: new Date("2031-01-13T14:30:00.000Z"),
    }));
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.session?.scheduledState, "skipped");
    assert.equal(skipped.session?.scheduledStartAt.toISOString(), "2031-01-13T15:00:00.000Z");
    assert.equal(skipped.session?.scheduledEndAt.toISOString(), "2031-01-13T16:00:00.000Z");

    const originalWindow = await inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
      group: firstGroup,
      scheduledDate,
      scheduledTeacherConnectedOverride: true,
      now: new Date("2031-01-13T14:45:00.000Z"),
    }));
    assert.equal(originalWindow.status, "skipped");
    const effectiveWindow = await inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
      group: firstGroup,
      scheduledDate,
      scheduledTeacherConnectedOverride: true,
      now: new Date("2031-01-13T15:15:00.000Z"),
    }));
    assert.equal(effectiveWindow.status, "skipped");
    assert.equal(await occurrenceCount(firstGroup.id, scheduledDate), 1);
  });

  it("keeps coverage, reconnect promotion, auto-end, and summaries on the frozen swapped window", async () => {
    await setCentralRecipient(centralRecipient.id);
    await saveInstructionalMonth("2031-02", []);
    const firstGroup = await createClass({
      name: "swap_frozen_lifecycle_first",
      scheduled: true,
      start: "09:00",
      end: "10:00",
      roster: [],
    });
    const secondGroup = await createClass({
      name: "swap_frozen_lifecycle_second",
      teacherId: secondTeacher.id,
      scheduled: true,
      start: "10:00",
      end: "11:00",
      roster: [],
    });
    const scheduledDate = "2031-02-03";
    await seedScheduleChange({ firstGroup, secondGroup, scheduledDate });

    const unattended = await inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
      group: firstGroup,
      scheduledDate,
      scheduledTeacherConnectedOverride: false,
      now: new Date("2031-02-03T15:05:00.000Z"),
    }));
    assert.equal(unattended.status, "coverage_needed");
    const occurrence = await inSchool(school.id, () =>
      storage.getScheduledTeachingSessionOccurrence(school.id, firstGroup.id, scheduledDate)
    );
    const conflict = await inSchool(school.id, () =>
      storage.getScheduledClassConflictByIdAndSchool(unattended.conflictId, school.id)
    );
    assert.equal(occurrence.scheduledStartAt.toISOString(), "2031-02-03T15:00:00.000Z");
    assert.equal(occurrence.scheduledEndAt.toISOString(), "2031-02-03T16:00:00.000Z");
    assert.equal(conflict.blockStartTime, "10:00");
    assert.equal(conflict.blockEndTime, "11:00");
    assert.equal(conflict.conflictPayload.blockStartTime, "10:00");
    assert.equal(conflict.conflictPayload.blockEndTime, "11:00");

    const reconnected = await inSchool(school.id, () =>
      scheduled.startActiveScheduledClassesForTeacher({
        schoolId: school.id,
        teacherId: teacher.id,
        now: new Date("2031-02-03T15:10:00.000Z"),
      })
    );
    assert.equal(reconnected.length, 1);
    assert.equal(reconnected[0].id, occurrence.id);
    assert.equal(reconnected[0].scheduledStartAt.toISOString(), "2031-02-03T15:00:00.000Z");
    assert.equal(reconnected[0].scheduledEndAt.toISOString(), "2031-02-03T16:00:00.000Z");

    await scheduler.reconcileClasspilotScheduledSessions(
      new Date("2031-02-03T16:00:00.000Z"),
      school.id
    );
    const finalized = await inSchool(school.id, () =>
      storage.getTeachingSessionById(occurrence.id)
    );
    assert.equal(finalized.scheduledState, "finalized");
    assert.equal(finalized.endTime.toISOString(), "2031-02-03T16:00:00.000Z");
    assert.deepEqual(
      (await deliveryRows(occurrence.id)).map((row) => row.recipient_kind),
      ["central", "teacher"]
    );
  });

  it("refetches the class after cancellation and blocks a stale recurring-window candidate", async () => {
    await setCentralRecipient(null);
    await saveInstructionalMonth("2031-01", []);
    const firstGroup = await createClass({
      name: "swap_cancel_stale_first",
      scheduled: true,
      start: "09:00",
      end: "10:00",
      roster: [],
    });
    const secondGroup = await createClass({
      name: "swap_cancel_stale_second",
      teacherId: secondTeacher.id,
      scheduled: true,
      start: "10:00",
      end: "11:00",
      roster: [],
    });
    const scheduledDate = "2031-01-15";
    const changeId = await seedScheduleChange({ firstGroup, secondGroup, scheduledDate });

    const cancelled = await inSchool(school.id, () =>
      storage.applyClasspilotScheduleChangeAction({
        schoolId: school.id,
        changeId,
        action: "cancel",
        expectedRevision: 0,
        reason: "Event cancelled",
        actor: { userId: centralRecipient.id, role: "admin" },
        now: new Date("2031-01-15T12:30:00.000Z"),
      })
    );
    assert.equal(cancelled.status, "saved");
    assert.equal(cancelled.change.status, "cancelled");

    const edited = await inSchool(school.id, () => storage.updateGroup(
      firstGroup.id,
      { blockStartTime: "08:00", blockEndTime: "09:00" },
      centralRecipient.id
    ));
    assert.ok(edited);

    // The stale object still says 09:00-10:00. The date/group lock path must
    // refetch 08:00-09:00 and refuse to create at the obsolete window.
    const staleAttempt = await inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
      group: firstGroup,
      scheduledDate,
      scheduledTeacherConnectedOverride: true,
      now: new Date("2031-01-15T14:30:00.000Z"),
    }));
    assert.deepEqual(staleAttempt, { status: "skipped", reason: "outside_schedule_window" });
    assert.equal(await occurrenceCount(firstGroup.id, scheduledDate), 0);

    const currentAttempt = await inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
      group: edited,
      scheduledDate,
      scheduledTeacherConnectedOverride: true,
      now: new Date("2031-01-15T13:30:00.000Z"),
    }));
    assert.equal(currentAttempt.status, "started");
    assert.equal(currentAttempt.session.scheduledStartAt.toISOString(), "2031-01-15T13:00:00.000Z");
    assert.equal(currentAttempt.session.scheduledEndAt.toISOString(), "2031-01-15T14:00:00.000Z");
  });

  it("blocks a school timezone change while an approved future swap is active", async () => {
    await setCentralRecipient(null);
    await saveInstructionalMonth("2031-03", []);
    const firstGroup = await createClass({
      name: "swap_current_timezone_first",
      scheduled: true,
      start: "09:00",
      end: "10:00",
      roster: [],
    });
    const secondGroup = await createClass({
      name: "swap_current_timezone_second",
      teacherId: secondTeacher.id,
      scheduled: true,
      start: "10:00",
      end: "11:00",
      roster: [],
    });
    const scheduledDate = "2031-03-10";
    const changeId = await seedScheduleChange({ firstGroup, secondGroup, scheduledDate });
    const stored = await inSchool(school.id, () => db.execute(sql`
      SELECT timezone_snapshot FROM classpilot_schedule_changes WHERE id = ${changeId}
    `));
    assert.equal(stored.rows[0]?.timezone_snapshot, "America/New_York");

    await assert.rejects(
      () => asSystem(() => storage.updateSchool(school.id, {
        schoolTimezone: "America/Los_Angeles",
      })),
      (error: any) => {
        assert.equal(error.code, "APPROVED_SCHEDULE_CHANGE_EXISTS");
        assert.equal(error.status, 409);
        return true;
      }
    );

    const result = await inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
      group: firstGroup,
      scheduledDate,
      scheduledTeacherConnectedOverride: true,
      now: new Date("2031-03-10T14:30:00.000Z"),
    }));
    assert.equal(result.status, "started");
    assert.equal(result.session.scheduledTimezone, "America/New_York");
    assert.equal(result.session.scheduledStartAt.toISOString(), "2031-03-10T14:00:00.000Z");
    assert.equal(result.session.scheduledEndAt.toISOString(), "2031-03-10T15:00:00.000Z");
  });

  it("linearizes a timezone writer before freezing the swapped occurrence", async () => {
    await setCentralRecipient(null);
    await saveInstructionalMonth("2031-03", []);
    const firstGroup = await createClass({
      name: "swap_timezone_race_first",
      scheduled: true,
      start: "06:00",
      end: "10:00",
      roster: [],
    });
    const secondGroup = await createClass({
      name: "swap_timezone_race_second",
      teacherId: secondTeacher.id,
      scheduled: true,
      start: "10:00",
      end: "14:00",
      roster: [],
    });
    const scheduledDate = "2031-03-11";
    await seedScheduleChange({ firstGroup, secondGroup, scheduledDate });

    const writer = await pool.connect();
    let writerCommitted = false;
    let startPromise: Promise<any> | undefined;
    try {
      await writer.query("BEGIN");
      const pidResult = await writer.query("SELECT pg_backend_pid() AS pid");
      const writerPid = Number(pidResult.rows[0].pid);
      await writer.query(
        "UPDATE schools SET school_timezone = $2, updated_at = NOW() WHERE id = $1",
        [school.id, "America/Los_Angeles"]
      );

      startPromise = inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
        group: firstGroup,
        scheduledDate,
        scheduledTeacherConnectedOverride: true,
        // 13:30 New York and 10:30 Los Angeles are both in the effective
        // 10:00-14:00 window, so the pre-lock candidate cannot short-circuit.
        now: new Date("2031-03-11T17:30:00.000Z"),
      }));
      await waitFor(async () => {
        const blocked = await schedulerPool.query(
          "SELECT count(*)::int AS count FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))",
          [writerPid]
        );
        return Number(blocked.rows[0]?.count || 0) > 0;
      }, "occurrence preparation did not wait on the authoritative school timezone row");

      await writer.query("COMMIT");
      writerCommitted = true;
      const result = await startPromise;
      assert.equal(result.status, "started");
      assert.equal(result.session.scheduledTimezone, "America/Los_Angeles");
      assert.equal(result.session.scheduledStartAt.toISOString(), "2031-03-11T17:00:00.000Z");
      assert.equal(result.session.scheduledEndAt.toISOString(), "2031-03-11T21:00:00.000Z");
    } finally {
      if (!writerCommitted) await writer.query("ROLLBACK").catch(() => undefined);
      if (!writerCommitted) await startPromise?.catch(() => undefined);
      writer.release();
      await asSystem(() => db.execute(sql`
        UPDATE schools
        SET school_timezone = 'America/New_York', updated_at = NOW()
        WHERE id = ${school.id}
      `));
    }
  });

  it("does not tombstone the stale school date when timezone changes during Skip Today", async () => {
    await setCentralRecipient(null);
    await saveInstructionalMonth("2031-03", []);
    const group = await createClass({
      name: "skip_timezone_date_race",
      scheduled: true,
      start: "09:00",
      end: "10:00",
      roster: [],
    });
    const staleNewYorkDate = "2031-03-12";
    const now = new Date("2031-03-12T05:30:00.000Z");
    const writer = await pool.connect();
    let writerCommitted = false;
    let skipPromise: Promise<any> | undefined;
    try {
      await writer.query("BEGIN");
      const pidResult = await writer.query("SELECT pg_backend_pid() AS pid");
      const writerPid = Number(pidResult.rows[0].pid);
      await writer.query(
        "UPDATE schools SET school_timezone = $2, updated_at = NOW() WHERE id = $1",
        [school.id, "America/Los_Angeles"]
      );

      skipPromise = inSchool(school.id, () => scheduled.skipScheduledClassBeforeStart({
        group,
        scheduledDate: staleNewYorkDate,
        now,
      }));
      await waitFor(async () => {
        const blocked = await schedulerPool.query(
          "SELECT count(*)::int AS count FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))",
          [writerPid]
        );
        return Number(blocked.rows[0]?.count || 0) > 0;
      }, "Skip Today did not wait on the authoritative school timezone row");

      await writer.query("COMMIT");
      writerCommitted = true;
      assert.deepEqual(await skipPromise, {
        skipped: false,
        reason: "school_date_changed",
      });
      assert.equal(await occurrenceCount(group.id, staleNewYorkDate), 0);
      assert.equal(await occurrenceCount(group.id, "2031-03-11"), 0);
    } finally {
      if (!writerCommitted) await writer.query("ROLLBACK").catch(() => undefined);
      if (!writerCommitted) await skipPromise?.catch(() => undefined);
      writer.release();
      await asSystem(() => db.execute(sql`
        UPDATE schools
        SET school_timezone = 'America/New_York', updated_at = NOW()
        WHERE id = ${school.id}
      `));
    }
  });

  it("fails closed when an approved swap becomes unsafe before occurrence creation", async () => {
    await setCentralRecipient(null);
    await saveInstructionalMonth("2031-04", []);
    const firstGroup = await createClass({
      name: "swap_runtime_guard_first",
      scheduled: true,
      start: "09:00",
      end: "10:00",
      roster: [],
    });
    const secondGroup = await createClass({
      name: "swap_runtime_guard_second",
      teacherId: secondTeacher.id,
      scheduled: true,
      start: "10:00",
      end: "11:00",
      roster: [],
    });
    const scheduledDate = "2031-04-01";
    await seedScheduleChange({ firstGroup, secondGroup, scheduledDate });

    // Simulate a legacy/direct writer that bypassed the normal assignment
    // guards after approval. The locked runtime validator must not execute the
    // swap or silently fall back to the recurring window.
    await asSystem(() => db.execute(sql`
      UPDATE school_memberships
      SET status = 'inactive'
      WHERE school_id = ${school.id} AND user_id = ${secondTeacher.id}
    `));
    const logs: string[] = [];
    const logMock = mock.method(console, "log", (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      await assert.rejects(
        inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
          group: firstGroup,
          scheduledDate,
          scheduledTeacherConnectedOverride: true,
          now: new Date("2031-04-01T14:15:00.000Z"),
        })),
        (error: any) => error?.code === "SCHEDULE_CHANGE_EXECUTION_INVALID"
      );
    } finally {
      logMock.mock.restore();
      await asSystem(() => db.execute(sql`
        UPDATE school_memberships
        SET status = 'active'
        WHERE school_id = ${school.id} AND user_id = ${secondTeacher.id}
      `));
    }

    assert.equal(await occurrenceCount(firstGroup.id, scheduledDate), 0);
    const executionMetrics = logs.flatMap((line) => {
      try {
        const parsed = JSON.parse(line);
        return parsed.ScheduleChangeExecutionInvalid === 1 ? [parsed] : [];
      } catch {
        return [];
      }
    });
    assert.equal(executionMetrics.length, 1);
    assert.equal(JSON.stringify(executionMetrics[0]).includes(firstGroup.id), false);
    assert.equal(JSON.stringify(executionMetrics[0]).includes(secondTeacher.id), false);
  });

  it("releases pending reservations but refuses approved execution after license expiry", async () => {
    await setCentralRecipient(null);
    await saveInstructionalMonth("2031-04", []);
    const approvedFirst = await createClass({
      name: "swap_expired_license_approved_first",
      scheduled: true,
      start: "09:00",
      end: "10:00",
      roster: [],
    });
    const approvedSecond = await createClass({
      name: "swap_expired_license_approved_second",
      teacherId: secondTeacher.id,
      scheduled: true,
      start: "10:00",
      end: "11:00",
      roster: [],
    });
    const pendingFirst = await createClass({
      name: "swap_expired_license_pending_first",
      scheduled: true,
      start: "15:00",
      end: "16:00",
      roster: [],
    });
    const pendingSecond = await createClass({
      name: "swap_expired_license_pending_second",
      teacherId: secondTeacher.id,
      scheduled: true,
      start: "16:00",
      end: "17:00",
      roster: [],
    });
    const approvedDate = "2031-04-02";
    const pendingDate = "2031-04-03";
    await seedScheduleChange({
      firstGroup: approvedFirst,
      secondGroup: approvedSecond,
      scheduledDate: approvedDate,
    });
    const pendingChangeId = await seedScheduleChange({
      firstGroup: pendingFirst,
      secondGroup: pendingSecond,
      scheduledDate: pendingDate,
      status: "pending_admin",
    });

    await asSystem(() => db.execute(sql`
      UPDATE product_licenses
      SET expires_at = ${new Date("2020-01-01T00:00:00.000Z")}
      WHERE school_id = ${school.id} AND product = 'CLASSPILOT'
    `));
    try {
      await assert.rejects(
        inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
          group: approvedFirst,
          scheduledDate: approvedDate,
          scheduledTeacherConnectedOverride: true,
          now: new Date("2031-04-02T14:15:00.000Z"),
        })),
        (error: any) =>
          error?.code === "CLASSPILOT_NOT_ENTITLED" && error?.reason === "license_inactive"
      );
      assert.equal(await occurrenceCount(approvedFirst.id, approvedDate), 0);

      // Expiry is lifecycle cleanup, not product access: even after licensing
      // lapses, a recovery tick must release old pending reservations.
      await scheduler.reconcileClasspilotScheduledSessions(
        new Date("2031-04-04T04:01:00.000Z"),
        school.id
      );
      const pendingState = await inSchool(school.id, () => db.execute(sql`
        SELECT status, reservation_active
        FROM classpilot_schedule_changes
        WHERE id = ${pendingChangeId}
      `));
      assert.equal(pendingState.rows[0]?.status, "expired");
      assert.equal(pendingState.rows[0]?.reservation_active, false);
    } finally {
      await asSystem(() => db.execute(sql`
        UPDATE product_licenses
        SET expires_at = NULL
        WHERE school_id = ${school.id} AND product = 'CLASSPILOT'
      `));
    }
  });

  it("expires incomplete swap approvals at the earliest bell once and emits an ID-free metric", async () => {
    await setCentralRecipient(null);
    await saveInstructionalMonth("2031-01", []);
    const firstGroup = await createClass({
      name: "swap_expiry_first",
      scheduled: true,
      start: "09:00",
      end: "10:00",
      roster: [],
    });
    const secondGroup = await createClass({
      name: "swap_expiry_second",
      teacherId: secondTeacher.id,
      scheduled: true,
      start: "10:00",
      end: "11:00",
      roster: [],
    });
    const scheduledDate = "2031-01-14";
    const changeId = await seedScheduleChange({
      firstGroup,
      secondGroup,
      scheduledDate,
      status: "pending_counterpart",
    });

    const logs: string[] = [];
    const messageStart = sentMessages.length;
    const logMock = mock.method(console, "log", (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      await scheduler.reconcileClasspilotScheduledSessions(
        new Date("2031-01-14T14:00:00.000Z"),
        school.id
      );
      await scheduler.reconcileClasspilotScheduledSessions(
        new Date("2031-01-14T14:01:00.000Z"),
        school.id
      );
    } finally {
      logMock.mock.restore();
    }

    const state = await inSchool(school.id, () => db.execute(sql`
      SELECT change.status, change.reservation_active,
             bool_and(NOT leg.reservation_active) AS legs_released
      FROM classpilot_schedule_changes AS change
      JOIN classpilot_schedule_change_legs AS leg
        ON leg.schedule_change_id = change.id
      WHERE change.id = ${changeId}
      GROUP BY change.status, change.reservation_active
    `));
    assert.equal(state.rows[0]?.status, "expired");
    assert.equal(state.rows[0]?.reservation_active, false);
    assert.equal(state.rows[0]?.legs_released, true);

    const expiryMetrics = logs.flatMap((line) => {
      try {
        const parsed = JSON.parse(line);
        return parsed.ScheduleChangeExpired === 1 ? [parsed] : [];
      } catch {
        return [];
      }
    });
    assert.equal(expiryMetrics.length, 1, "idempotent reconcile should emit one expiry metric");
    assert.equal(expiryMetrics[0].Outcome, "approval_incomplete_at_bell");
    assert.equal(JSON.stringify(expiryMetrics[0]).includes(changeId), false);
    await waitFor(
      async () => sentMessages.slice(messageStart).filter((message) =>
        message.subject === `ClassPilot schedule change: ${scheduledDate}`
      ).length === 3,
      "expired schedule-change staff notifications were not delivered"
    );
    const expirationMessages = sentMessages.slice(messageStart).filter((message) =>
      message.subject === `ClassPilot schedule change: ${scheduledDate}`
    );
    assert.equal(new Set(expirationMessages.map((message) => message.to)).size, 3);
    assert.ok(expirationMessages.every((message) => /now expired/i.test(message.text)));
    assert.ok(expirationMessages.every((message) => !/Event-day class-time exchange/.test(message.text)));
  });

  it("expires a prior-date pending swap after a missed scheduler bell", async () => {
    await setCentralRecipient(null);
    await saveInstructionalMonth("2031-01", []);
    const firstGroup = await createClass({
      name: "swap_expiry_recovery_first",
      scheduled: true,
      start: "09:00",
      end: "10:00",
      roster: [],
    });
    const secondGroup = await createClass({
      name: "swap_expiry_recovery_second",
      teacherId: secondTeacher.id,
      scheduled: true,
      start: "10:00",
      end: "11:00",
      roster: [],
    });
    const scheduledDate = "2031-01-16";
    const changeId = await seedScheduleChange({
      firstGroup,
      secondGroup,
      scheduledDate,
      status: "pending_admin",
    });

    // Simulate the worker being unavailable for the entire event date. The
    // next day's bounded recovery sweep must release the old reservation.
    await scheduler.reconcileClasspilotScheduledSessions(
      new Date("2031-01-17T05:01:00.000Z"),
      school.id
    );
    const state = await inSchool(school.id, () => db.execute(sql`
      SELECT change.status, change.reservation_active,
             bool_and(NOT leg.reservation_active) AS legs_released
      FROM classpilot_schedule_changes AS change
      JOIN classpilot_schedule_change_legs AS leg
        ON leg.schedule_change_id = change.id
      WHERE change.id = ${changeId}
      GROUP BY change.status, change.reservation_active
    `));
    assert.equal(state.rows[0]?.status, "expired");
    assert.equal(state.rows[0]?.reservation_active, false);
    assert.equal(state.rows[0]?.legs_released, true);
  });

  it("creates one frozen occurrence during a delayed in-window tick and preserves schedule, teacher, and roster edits", async () => {
    const group = await createClass({ name: "frozen_occurrence", scheduled: true, roster: [studentOne] });
    const scheduledDate = "2031-01-07";
    const first = await inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
      group,
      scheduledDate,
      scheduledTeacherConnectedOverride: false,
      now: new Date("2031-01-07T14:30:00.000Z"),
    }));
    assert.equal(first.status, "coverage_needed");
    const occurrence = await inSchool(school.id, () =>
      storage.getScheduledTeachingSessionOccurrence(school.id, group.id, scheduledDate)
    );
    assert.ok(occurrence);

    const editedGroup = await inSchool(school.id, async () => {
      await storage.addGroupStudentsDetailed(group.id, [studentTwo.id]);
      return storage.updateGroup(group.id, {
        name: `${TAG}_frozen_occurrence_edited`,
        teacherId: secondTeacher.id,
        blockStartTime: "11:00",
        blockEndTime: "12:00",
      } as any);
    });
    const repeated = await inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
      group: editedGroup,
      scheduledDate,
      scheduledTeacherConnectedOverride: false,
      now: new Date("2031-01-07T14:35:00.000Z"),
    }));
    assert.equal(repeated.status, "coverage_needed");
    assert.equal(await occurrenceCount(group.id, scheduledDate), 1);

    const frozen = await inSchool(school.id, () =>
      storage.getScheduledTeachingSessionOccurrence(school.id, group.id, scheduledDate)
    );
    assert.equal(frozen.id, occurrence.id);
    assert.equal(frozen.teacherId, teacher.id);
    assert.equal(frozen.scheduledStartAt.toISOString(), "2031-01-07T14:00:00.000Z");
    assert.equal(frozen.scheduledEndAt.toISOString(), "2031-01-07T15:00:00.000Z");
    const frozenRoster = await inSchool(school.id, () => storage.getClasspilotSessionStudents(frozen.id));
    assert.deepEqual(frozenRoster.map((row: any) => row.studentId), [studentOne.id]);
    const conflict = await inSchool(school.id, () =>
      storage.getScheduledClassConflictByIdAndSchool(first.conflictId, school.id)
    );
    assert.equal(conflict.teacherId, teacher.id);
    assert.equal(conflict.blockStartTime, "09:00");
    assert.equal(conflict.blockEndTime, "10:00");

    const frozenDeviceId = `${TAG}-frozen-roster-device`;
    const addedDeviceId = `${TAG}-added-roster-device`;
    await inSchool(school.id, async () => {
      await storage.createDevice({
        deviceId: frozenDeviceId,
        schoolId: school.id,
        classId: "default",
        deviceName: "Frozen roster student",
      } as any);
      await storage.linkStudentDevice({ studentId: studentOne.id, deviceId: frozenDeviceId });
      await storage.setActiveStudentForDevice(frozenDeviceId, studentOne.id);
      await storage.createDevice({
        deviceId: addedDeviceId,
        schoolId: school.id,
        classId: "default",
        deviceName: "Post-freeze roster student",
      } as any);
      await storage.linkStudentDevice({ studentId: studentTwo.id, deviceId: addedDeviceId });
      await storage.setActiveStudentForDevice(addedDeviceId, studentTwo.id);
    });
    const refreshedCoverage = await inSchool(school.id, () =>
      scheduled.buildScheduledCoveragePayload({
        group: editedGroup,
        scheduledDate,
        scheduledConflictId: first.conflictId,
        connectedTeacherIdsOverride: new Set<string>(),
      })
    );
    assert.equal(refreshedCoverage.scheduledTeacher.id, teacher.id);
    assert.equal(refreshedCoverage.selectedClass.name, group.name);
    assert.equal(refreshedCoverage.blockStartTime, "09:00");
    assert.equal(refreshedCoverage.blockEndTime, "10:00");
    assert.equal(refreshedCoverage.totalRosterCount, 1);
    assert.deepEqual(
      refreshedCoverage.claimableStudents.map((student: any) => student.studentId),
      [studentOne.id]
    );
    const addedStudentClaim = await requestJson(
      "POST",
      "/classpilot/coverage/claim",
      { scheduledConflictId: first.conflictId, studentIds: [studentTwo.id] },
      authFor(centralRecipient)
    );
    assert.equal(addedStudentClaim.status, 409);
    const frozenStudentClaim = await requestJson(
      "POST",
      "/classpilot/coverage/claim",
      { scheduledConflictId: first.conflictId, studentIds: [studentOne.id] },
      authFor(centralRecipient)
    );
    assert.equal(frozenStudentClaim.status, 201);

    await inSchool(school.id, () => storage.promoteScheduledReportSessionToLive({
      schoolId: school.id,
      sessionId: frozen.id,
    }));
    const resync = await requestJson(
      "POST",
      `/classpilot/teaching-sessions/${frozen.id}/resync`,
      {},
      authFor(teacher)
    );
    assert.equal(resync.status, 409);
    assert.equal(resync.body.code, "SCHEDULED_ROSTER_SNAPSHOT_FROZEN");
    await inSchool(school.id, () => lifecycle.finalizeClasspilotSession({
      schoolId: school.id,
      sessionId: frozen.id,
      reason: "teacher_end",
      finalizedAt: new Date("2031-01-07T14:40:00.000Z"),
    }));

    const nextDay = await inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
      group: editedGroup,
      scheduledDate: "2031-01-08",
      scheduledTeacherConnectedOverride: false,
      now: new Date("2031-01-08T16:05:00.000Z"),
    }));
    assert.equal(nextDay.status, "coverage_needed");
    const futureOccurrence = await inSchool(school.id, () =>
      storage.getScheduledTeachingSessionOccurrence(school.id, group.id, "2031-01-08")
    );
    assert.equal(futureOccurrence.teacherId, secondTeacher.id);
    assert.equal(futureOccurrence.classNameSnapshot, editedGroup.name);
    assert.equal(futureOccurrence.scheduledStartAt.toISOString(), "2031-01-08T16:00:00.000Z");
    assert.equal(futureOccurrence.scheduledEndAt.toISOString(), "2031-01-08T17:00:00.000Z");
    assert.deepEqual(
      (await inSchool(school.id, () => storage.getClasspilotSessionStudents(futureOccurrence.id)))
        .map((row: any) => row.studentId)
        .sort(),
      [studentOne.id, studentTwo.id].sort()
    );
    await inSchool(school.id, () => lifecycle.finalizeClasspilotSession({
      schoolId: school.id,
      sessionId: futureOccurrence.id,
      reason: "teacher_end",
      finalizedAt: new Date("2031-01-08T16:10:00.000Z"),
    }));
  });

  it("freezes an in-progress occurrence before schedule and roster edit paths mutate the class", async () => {
    const group = await createClass({
      name: "pre_edit_freeze",
      scheduled: true,
      roster: [studentOne],
    });
    const occurrence = await inSchool(school.id, () => scheduled.freezeScheduledOccurrenceIfDue({
      group,
      now: new Date("2031-01-17T14:30:00.000Z"),
    }));
    assert.ok(occurrence);
    await inSchool(school.id, async () => {
      await storage.addGroupStudentsDetailed(group.id, [studentTwo.id]);
      await storage.updateGroup(group.id, {
        teacherId: secondTeacher.id,
        blockStartTime: "11:00",
        blockEndTime: "12:00",
      } as any);
    });

    const frozen = await inSchool(school.id, () => storage.getTeachingSessionById(occurrence.id));
    const roster = await inSchool(school.id, () => storage.getClasspilotSessionStudents(occurrence.id));
    assert.equal(frozen.scheduledDate, "2031-01-17");
    assert.equal(frozen.teacherId, teacher.id);
    assert.equal(frozen.scheduledStartAt.toISOString(), "2031-01-17T14:00:00.000Z");
    assert.equal(frozen.scheduledEndAt.toISOString(), "2031-01-17T15:00:00.000Z");
    assert.deepEqual(roster.map((row: any) => row.studentId), [studentOne.id]);
    await inSchool(school.id, () => lifecycle.finalizeClasspilotSession({
      schoolId: school.id,
      sessionId: occurrence.id,
      reason: "teacher_end",
      finalizedAt: new Date("2031-01-17T14:35:00.000Z"),
    }));
  });

  it("uses shared staff presence across processes and treats an expired shared record as offline", async () => {
    const presenceTtlMs = 90_000;
    const forcedTouchAt = new Map<string, number>();
    const connectionExpiryByScope = new Map<string, Map<string, number>>();
    const scopeKey = (schoolId: string, userId: string) => `${schoolId}\0${userId}`;
    const apiProcessPresenceStore = {
      async touch(
        schoolId: string,
        userId: string,
        connectionId: string,
        observedAt = new Date()
      ): Promise<boolean> {
        const scope = scopeKey(schoolId, userId);
        const connections = connectionExpiryByScope.get(scope) || new Map<string, number>();
        const touchedAt = forcedTouchAt.get(scope) ?? observedAt.getTime();
        connections.set(connectionId, touchedAt + presenceTtlMs);
        connectionExpiryByScope.set(scope, connections);
        return true;
      },
      async remove(schoolId: string, userId: string, connectionId: string): Promise<boolean> {
        const scope = scopeKey(schoolId, userId);
        const connections = connectionExpiryByScope.get(scope);
        connections?.delete(connectionId);
        if (connections?.size === 0) connectionExpiryByScope.delete(scope);
        return true;
      },
      async isFresh(schoolId: string, userId: string, now = new Date()): Promise<boolean> {
        const scope = scopeKey(schoolId, userId);
        const connections = connectionExpiryByScope.get(scope);
        if (!connections) return false;
        for (const [connectionId, expiresAt] of connections) {
          if (expiresAt <= now.getTime()) connections.delete(connectionId);
        }
        if (connections.size === 0) {
          connectionExpiryByScope.delete(scope);
          return false;
        }
        return true;
      },
    };
    // This deliberately distinct object represents the scheduler process. It
    // can observe only the API process's shared-store writes, never its local
    // in-memory WebSocket registry.
    const schedulerProcessPresenceReader = {
      isFresh: apiProcessPresenceStore.isFresh.bind(apiProcessPresenceStore),
    };
    const websocketModule = await import("../dist/realtime/websocket.js");
    const websocketRegistry = await import("../dist/realtime/ws-broadcast.js");
    const websocketServer = createServer();
    const websocketConnections = websocketModule.setupWebSocket(websocketServer, {
      presenceStore: apiProcessPresenceStore,
    });
    const clients: WebSocket[] = [];
    const occurrencesToFinalize: Array<{ group: any; scheduledDate: string; finalizedAt: Date }> = [];

    const closeClient = async (client: WebSocket): Promise<void> => {
      if (client.readyState === WebSocket.CLOSED) return;
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve();
        };
        const timeout = setTimeout(() => {
          client.terminate();
          finish();
        }, 500);
        timeout.unref();
        client.once("close", finish);
        client.close();
      });
    };

    try {
      await new Promise<void>((resolve) => websocketServer.listen(0, "127.0.0.1", resolve));
      const websocketUrl = `ws://127.0.0.1:${(websocketServer.address() as AddressInfo).port}/ws`;
      const authenticate = async (user: any): Promise<WebSocket> => {
        const client = new WebSocket(websocketUrl);
        clients.push(client);
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error(`Timed out authenticating ${user.email}`)),
            2_000
          );
          timeout.unref();
          client.once("error", reject);
          client.on("message", (raw) => {
            const message = JSON.parse(raw.toString());
            if (message.type === "auth-error") {
              clearTimeout(timeout);
              reject(new Error(message.message));
            }
            if (message.type === "auth-success") {
              clearTimeout(timeout);
              resolve();
            }
          });
          client.once("open", () => {
            client.send(JSON.stringify({
              type: "auth",
              role: "teacher",
              schoolId: school.id,
              userToken: signUserToken({
                userId: user.id,
                email: user.email,
                isSuperAdmin: false,
              }),
            }));
          });
        });
        return client;
      };

      const freshNow = new Date("2031-01-27T14:05:00.000Z");
      const freshGroup = await createClass({
        name: "distributed_presence_fresh",
        teacherId: teacher.id,
        scheduled: true,
        roster: [studentOne],
      });
      occurrencesToFinalize.push({
        group: freshGroup,
        scheduledDate: "2031-01-27",
        finalizedAt: new Date("2031-01-27T14:06:00.000Z"),
      });
      forcedTouchAt.set(scopeKey(school.id, teacher.id), freshNow.getTime() - 30_000);
      const freshClient = await authenticate(teacher);
      await waitFor(
        async () => (connectionExpiryByScope.get(scopeKey(school.id, teacher.id))?.size || 0) > 0,
        "WebSocket auth did not publish fresh presence to the shared store"
      );
      assert.equal(
        websocketRegistry.isStaffUserConnectedLocal(school.id, teacher.id),
        true,
        "the API process should also have its own local socket presence"
      );
      assert.equal(
        await schedulerProcessPresenceReader.isFresh(school.id, teacher.id, freshNow),
        true,
        "the separate scheduler view should see the API process's shared presence write"
      );

      const freshStart = await inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
        group: freshGroup,
        scheduledDate: "2031-01-27",
        presenceStore: schedulerProcessPresenceReader,
        now: freshNow,
      }));
      assert.equal(freshStart.status, "started");
      assert.equal(freshStart.session.sessionMode, "live");
      assert.equal(await occurrenceCount(freshGroup.id, "2031-01-27"), 1);
      const freshConflictCount = await inSchool(school.id, () => db.execute(sql`
        SELECT count(*)::int AS count
        FROM classpilot_scheduled_conflicts
        WHERE school_id = ${school.id}
          AND group_id = ${freshGroup.id}
          AND scheduled_date = ${"2031-01-27"}
      `));
      assert.equal(Number(freshConflictCount.rows[0]?.count || 0), 0);
      await closeClient(freshClient);

      const staleNow = new Date("2031-01-28T14:05:00.000Z");
      const staleGroup = await createClass({
        name: "distributed_presence_expired",
        teacherId: secondTeacher.id,
        scheduled: true,
        roster: [studentTwo],
      });
      occurrencesToFinalize.push({
        group: staleGroup,
        scheduledDate: "2031-01-28",
        finalizedAt: new Date("2031-01-28T14:06:00.000Z"),
      });
      forcedTouchAt.set(
        scopeKey(school.id, secondTeacher.id),
        staleNow.getTime() - presenceTtlMs - 1
      );
      await authenticate(secondTeacher);
      await waitFor(
        async () => (connectionExpiryByScope.get(scopeKey(school.id, secondTeacher.id))?.size || 0) > 0,
        "WebSocket auth did not publish the scripted stale presence record"
      );
      assert.equal(
        websocketRegistry.isStaffUserConnectedLocal(school.id, secondTeacher.id),
        true,
        "the stale case must keep a misleading local socket open"
      );
      assert.equal(
        await schedulerProcessPresenceReader.isFresh(school.id, secondTeacher.id, staleNow),
        false,
        "the shared record should be authoritatively expired"
      );

      const staleStart = await inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
        group: staleGroup,
        scheduledDate: "2031-01-28",
        presenceStore: schedulerProcessPresenceReader,
        now: staleNow,
      }));
      assert.equal(staleStart.status, "coverage_needed");
      const staleOccurrence = await inSchool(school.id, () =>
        storage.getScheduledTeachingSessionOccurrence(school.id, staleGroup.id, "2031-01-28")
      );
      assert.equal(staleOccurrence.sessionMode, "scheduled_report");
      const staleConflict = await inSchool(school.id, () =>
        storage.getScheduledClassConflictByIdAndSchool(staleStart.conflictId, school.id)
      );
      assert.equal(staleConflict.status, "coverage_needed");
    } finally {
      for (const { group, scheduledDate, finalizedAt } of occurrencesToFinalize) {
        const occurrence = await inSchool(school.id, () =>
          storage.getScheduledTeachingSessionOccurrence(school.id, group.id, scheduledDate)
        ).catch(() => undefined);
        if (occurrence && !occurrence.endTime) {
          await inSchool(school.id, () => lifecycle.finalizeClasspilotSession({
            schoolId: school.id,
            sessionId: occurrence.id,
            reason: "teacher_end",
            finalizedAt,
          })).catch(() => undefined);
        }
      }
      await Promise.all(clients.map(closeClient));
      await new Promise<void>((resolve) => websocketConnections.close(() => resolve()));
      if (websocketServer.listening) {
        await new Promise<void>((resolve, reject) =>
          websocketServer.close((error) => error ? reject(error) : resolve())
        );
      }
    }
  });

  it("fails closed promptly when shared presence is unavailable without blocking WebSocket authentication", async () => {
    const presenceModule = await import("../dist/realtime/classpilotStaffPresence.js");
    const websocketModule = await import("../dist/realtime/websocket.js");
    let releaseTouch: (() => void) | undefined;
    let touchCompleted = false;
    let releaseRead: (() => void) | undefined;
    let readCompleted = false;
    const unavailablePresenceStore = {
      async touch(): Promise<boolean> {
        await new Promise<void>((resolve) => {
          releaseTouch = resolve;
        });
        touchCompleted = true;
        return true;
      },
      async remove(): Promise<boolean> {
        return true;
      },
      async isFresh(): Promise<boolean | undefined> {
        await new Promise<void>((resolve) => {
          releaseRead = resolve;
        });
        readCompleted = true;
        return undefined;
      },
    };
    const websocketServer = createServer();
    const websocketConnections = websocketModule.setupWebSocket(websocketServer, {
      presenceStore: unavailablePresenceStore,
    });
    let client: WebSocket | undefined;
    let group: any;
    const scheduledDate = "2031-01-29";

    try {
      await new Promise<void>((resolve) => websocketServer.listen(0, "127.0.0.1", resolve));
      const websocketUrl = `ws://127.0.0.1:${(websocketServer.address() as AddressInfo).port}/ws`;
      client = new WebSocket(websocketUrl);
      const authenticatedAt = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("WebSocket authentication waited for unavailable presence")),
          2_000
        );
        timeout.unref();
        client!.once("error", reject);
        client!.on("message", (raw) => {
          const message = JSON.parse(raw.toString());
          if (message.type === "auth-error") {
            clearTimeout(timeout);
            reject(new Error(message.message));
          }
          if (message.type === "auth-success") {
            clearTimeout(timeout);
            resolve(Date.now());
          }
        });
        client!.once("open", () => {
          client!.send(JSON.stringify({
            type: "auth",
            role: "teacher",
            schoolId: school.id,
            userToken: signUserToken({
              userId: teacher.id,
              email: teacher.email,
              isSuperAdmin: false,
            }),
          }));
        });
      });
      assert.ok(Number.isFinite(authenticatedAt));
      await waitFor(async () => releaseTouch !== undefined, "presence touch was not attempted");
      assert.equal(
        touchCompleted,
        false,
        "auth-success must be observable while the shared presence write is still unresolved"
      );
      releaseTouch?.();
      await waitFor(async () => touchCompleted, "released presence touch did not settle");

      group = await createClass({
        name: "distributed_presence_unavailable",
        teacherId: teacher.id,
        scheduled: true,
        roster: [studentOne],
      });
      const now = new Date("2031-01-29T14:05:00.000Z");
      const startedAt = Date.now();
      const result = await inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
        group,
        scheduledDate,
        presenceStore: unavailablePresenceStore,
        now,
      }));
      const durationMs = Date.now() - startedAt;
      assert.equal(result.status, "coverage_needed");
      assert.ok(
        durationMs < presenceModule.CLASSPILOT_STAFF_PRESENCE_OPERATION_TIMEOUT_MS * 4,
        `scheduler presence timeout exceeded its fail-closed bound (${durationMs} ms)`
      );
      assert.equal(readCompleted, false, "scheduler must not await an unavailable store indefinitely");
      const occurrence = await inSchool(school.id, () =>
        storage.getScheduledTeachingSessionOccurrence(school.id, group.id, scheduledDate)
      );
      assert.equal(occurrence.sessionMode, "scheduled_report");
      releaseRead?.();
    } finally {
      releaseTouch?.();
      releaseRead?.();
      if (group) {
        const occurrence = await inSchool(school.id, () =>
          storage.getScheduledTeachingSessionOccurrence(school.id, group.id, scheduledDate)
        ).catch(() => undefined);
        if (occurrence && !occurrence.endTime) {
          await inSchool(school.id, () => lifecycle.finalizeClasspilotSession({
            schoolId: school.id,
            sessionId: occurrence.id,
            reason: "teacher_end",
            finalizedAt: new Date("2031-01-29T14:06:00.000Z"),
          })).catch(() => undefined);
        }
      }
      if (client && client.readyState !== WebSocket.CLOSED) {
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            client!.terminate();
            resolve();
          }, 500);
          timeout.unref();
          client!.once("close", () => {
            clearTimeout(timeout);
            resolve();
          });
          client!.close();
        });
      }
      await new Promise<void>((resolve) => websocketConnections.close(() => resolve()));
      if (websocketServer.listening) {
        await new Promise<void>((resolve, reject) =>
          websocketServer.close((error) => error ? reject(error) : resolve())
        );
      }
    }
  });

  it("finalizes connected, unattended, late, logged-out, and reconnected scheduled occurrences exactly at the frozen end", async () => {
    await setCentralRecipient(centralRecipient.id);

    const unattendedGroup = await createClass({ name: "scheduled_unattended", teacherId: secondTeacher.id, scheduled: true });
    const unattendedStart = await inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
      group: unattendedGroup,
      scheduledDate: "2031-01-08",
      scheduledTeacherConnectedOverride: false,
      now: new Date("2031-01-08T14:05:00.000Z"),
    }));
    assert.equal(unattendedStart.status, "coverage_needed");
    const unattended = await inSchool(school.id, () =>
      storage.getScheduledTeachingSessionOccurrence(school.id, unattendedGroup.id, "2031-01-08")
    );
    assert.equal(unattended.sessionMode, "scheduled_report");
    assert.equal((await deliveryRows(unattended.id)).length, 0, "unattended summary must not queue before the bell");
    const unattendedEnd = await inSchool(school.id, () => lifecycle.finalizeClasspilotSession({
      schoolId: school.id,
      sessionId: unattended.id,
      reason: "scheduled_end",
      finalizedAt: new Date("2031-01-08T15:05:00.000Z"),
    }));
    assert.equal(unattendedEnd.session.endTime.toISOString(), "2031-01-08T15:00:00.000Z");
    assert.ok((await deliveryRows(unattended.id)).every((delivery) => delivery.state === "waiting_report"));
    const messageStart = sentMessages.length;
    await materializeAndDispatch({ sessionId: unattended.id });
    const unattendedMessages = sentMessages.slice(messageStart);
    assert.equal(unattendedMessages.length, 2);
    assert.ok(unattendedMessages.every((message) => /No live ClassPilot session was opened/.test(message.html)));
    assert.ok(unattendedMessages.every((message) => /Observed browser telemetry/.test(message.html)));
    assert.ok(unattendedMessages.every((message) => /Monitoring coverage/.test(message.html)));

    const connectedGroup = await createClass({ name: "scheduled_connected", teacherId: secondTeacher.id, scheduled: true });
    const connectedStart = await inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
      group: connectedGroup,
      scheduledDate: "2031-01-09",
      scheduledTeacherConnectedOverride: true,
      now: new Date("2031-01-09T14:10:00.000Z"),
    }));
    assert.equal(connectedStart.status, "started");
    assert.equal(connectedStart.session.sessionMode, "live");
    assert.equal((await deliveryRows(connectedStart.session.id)).length, 0, "connected summary must not queue before the bell");
    const connectedEnd = await inSchool(school.id, () => lifecycle.finalizeClasspilotSession({
      schoolId: school.id,
      sessionId: connectedStart.session.id,
      reason: "scheduled_end",
      finalizedAt: new Date("2031-01-09T15:04:00.000Z"),
    }));
    assert.equal(connectedEnd.session.endTime.toISOString(), "2031-01-09T15:00:00.000Z");
    const connectedWaiting = await deliveryRows(connectedStart.session.id);
    assert.equal(connectedWaiting.length, 2);
    assert.ok(connectedWaiting.every((delivery) => delivery.state === "waiting_report"));

    const lateGroup = await createClass({ name: "scheduled_late_reconnect", teacherId: secondTeacher.id, scheduled: true });
    const lateStart = await inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
      group: lateGroup,
      scheduledDate: "2031-01-10",
      scheduledTeacherConnectedOverride: false,
      now: new Date("2031-01-10T14:05:00.000Z"),
    }));
    assert.equal(lateStart.status, "coverage_needed");
    const lateOccurrence = await inSchool(school.id, () =>
      storage.getScheduledTeachingSessionOccurrence(school.id, lateGroup.id, "2031-01-10")
    );
    const pickedUp = await inSchool(school.id, () => scheduled.startActiveScheduledClassesForTeacher({
      schoolId: school.id,
      teacherId: secondTeacher.id,
      now: new Date("2031-01-10T14:30:00.000Z"),
    }));
    assert.equal(pickedUp.length, 1);
    assert.equal(pickedUp[0].id, lateOccurrence.id);
    assert.equal(pickedUp[0].sessionMode, "live");

    const logout = await requestJson("POST", "/auth/logout", {}, authFor(secondTeacher));
    assert.equal(logout.status, 200);
    assert.equal((await inSchool(school.id, () =>
      storage.getActiveTeachingSessionForSchool(secondTeacher.id, school.id)
    ))?.id, lateOccurrence.id);
    assert.equal((await deliveryRows(lateOccurrence.id)).length, 0);

    const reconnectPickup = await inSchool(school.id, () => scheduled.startActiveScheduledClassesForTeacher({
      schoolId: school.id,
      teacherId: secondTeacher.id,
      now: new Date("2031-01-10T14:45:00.000Z"),
    }));
    assert.deepEqual(reconnectPickup, []);
    assert.equal((await inSchool(school.id, () =>
      storage.getActiveTeachingSessionForSchool(secondTeacher.id, school.id)
    ))?.id, lateOccurrence.id);
    const lateEnd = await inSchool(school.id, () => lifecycle.finalizeClasspilotSession({
      schoolId: school.id,
      sessionId: lateOccurrence.id,
      reason: "scheduled_end",
      finalizedAt: new Date("2031-01-10T15:02:00.000Z"),
    }));
    assert.equal(lateEnd.session.endTime.toISOString(), "2031-01-10T15:00:00.000Z");
    const lateWaiting = await deliveryRows(lateOccurrence.id);
    assert.equal(lateWaiting.length, 2);
    assert.ok(lateWaiting.every((delivery) => delivery.state === "waiting_report"));
  });

  it("shows active scheduled-report occurrences in the admin session list and rejects teacher access", async () => {
    await setCentralRecipient(null);
    const group = await createClass({ name: "admin_active_scheduled_report", scheduled: true });
    const now = new Date();
    const scheduledDate = schoolTime.localDateInTimeZone(now, "America/New_York");
    const scheduledStartAt = new Date(now.getTime() - 5 * 60_000);
    const scheduledEndAt = new Date(now.getTime() + 55 * 60_000);
    const occurrence = await inSchool(school.id, () => storage.createOrReuseScheduledReportSession({
      schoolId: school.id,
      groupId: group.id,
      teacherId: teacher.id,
      scheduledDate,
      scheduledTimezone: "America/New_York",
      scheduledStartAt,
      scheduledEndAt,
      scheduledTeacherEmail: teacher.email,
      scheduledTeacherName: "Terry Teacher",
    }));

    const adminView = await requestJson(
      "GET",
      "/classpilot/sessions/all",
      undefined,
      authFor(centralRecipient)
    );
    assert.equal(adminView.status, 200);
    const listed = adminView.body.sessions.find((session: any) => session.id === occurrence.id);
    assert.ok(listed);
    assert.equal(listed.sessionMode, "scheduled_report");
    assert.deepEqual(listed.lifecycle, { kind: "scheduled", state: "active" });
    assert.equal(listed.summaryTrigger, "scheduled_end");
    assert.equal(listed.summaryExpectedAt, scheduledEndAt.toISOString());

    const teacherView = await requestJson(
      "GET",
      "/classpilot/sessions/all",
      undefined,
      authFor(teacher)
    );
    assert.equal(teacherView.status, 403);

    const adminEnd = await requestJson(
      "POST",
      `/classpilot/teaching-sessions/${occurrence.id}/end`,
      {},
      authFor(centralRecipient)
    );
    assert.equal(adminEnd.status, 200);
    assert.equal(adminEnd.body.summaryDisposition, "queued");
    assert.equal(adminEnd.body.finalizationReason, "admin_end");
    assert.deepEqual(adminEnd.body.session.lifecycle, { kind: "scheduled", state: "finalized" });
  });

  it("ends a scheduled class early once, covers scheduled start through now, and never restarts or queues a second summary", async () => {
    await setCentralRecipient(centralRecipient.id);
    const group = await createClass({ name: "scheduled_early_end", scheduled: true });
    const started = await inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
      group,
      scheduledDate: "2031-01-13",
      scheduledTeacherConnectedOverride: true,
      now: new Date("2031-01-13T14:05:00.000Z"),
    }));
    assert.equal(started.status, "started");
    const earlyAt = new Date("2031-01-13T14:20:00.000Z");
    const early = await inSchool(school.id, () => lifecycle.finalizeClasspilotSession({
      schoolId: school.id,
      sessionId: started.session.id,
      reason: "teacher_end",
      finalizedAt: earlyAt,
    }));
    assert.equal(early.finalized, true);
    assert.equal(early.session.startTime.toISOString(), "2031-01-13T14:00:00.000Z");
    assert.equal(early.session.endTime.toISOString(), earlyAt.toISOString());
    assert.equal(early.session.scheduledFinalizationReason, "teacher_end");
    assert.equal((await deliveryRows(started.session.id)).length, 2);

    const restart = await inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
      group,
      scheduledDate: "2031-01-13",
      scheduledTeacherConnectedOverride: true,
      now: new Date("2031-01-13T14:30:00.000Z"),
    }));
    assert.equal(restart.status, "skipped");
    const atBell = await inSchool(school.id, () => lifecycle.finalizeClasspilotSession({
      schoolId: school.id,
      sessionId: started.session.id,
      reason: "scheduled_end",
      finalizedAt: new Date("2031-01-13T15:00:00.000Z"),
    }));
    assert.equal(atBell.finalized, false);
    assert.equal(atBell.summaryDisposition, "already_queued");
    assert.equal((await deliveryRows(started.session.id)).length, 2);
    assert.equal(await occurrenceCount(group.id, "2031-01-13"), 1);
  });

  it("reports already_live for a live occurrence without re-starting it or finalizing a manual class", async () => {
    await setCentralRecipient(null);
    const group = await createClass({ name: "scheduled_already_live", scheduled: true });
    const started = await inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
      group,
      scheduledDate: "2031-01-17",
      scheduledTeacherConnectedOverride: true,
      now: new Date("2031-01-17T14:05:00.000Z"),
    }));
    assert.equal(started.status, "started");
    const liveBefore = await inSchool(school.id, () => storage.getTeachingSessionById(started.session.id));
    assert.equal(liveBefore.sessionMode, "live");
    assert.equal(liveBefore.endTime, null);

    // A class the teacher starts manually mid-block must survive the next tick;
    // before the short-circuit every tick finalized it as replacement_start.
    const manualGroup = await createClass({ name: "manual_during_live_occurrence" });
    const manualSession = await inSchool(school.id, () => storage.createTeachingSession({
      groupId: manualGroup.id,
      teacherId: teacher.id,
    } as any));

    const tick = await inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
      group,
      scheduledDate: "2031-01-17",
      scheduledTeacherConnectedOverride: true,
      now: new Date("2031-01-17T14:06:00.000Z"),
    }));
    assert.equal(tick.status, "already_live");
    assert.equal(tick.session.id, started.session.id);
    assert.equal(await occurrenceCount(group.id, "2031-01-17"), 1);

    const liveAfter = await inSchool(school.id, () => storage.getTeachingSessionById(started.session.id));
    assert.deepEqual(liveAfter, liveBefore, "the live occurrence row must be untouched by the steady-state tick");
    const manualAfter = await inSchool(school.id, () => storage.getTeachingSessionById(manualSession.id));
    assert.equal(manualAfter.endTime, null, "a manual class started mid-block must not be finalized by the tick");
    assert.equal(manualAfter.scheduledFinalizationReason, null);

    await inSchool(school.id, () => lifecycle.finalizeClasspilotSession({
      schoolId: school.id,
      sessionId: manualSession.id,
      reason: "manual_end",
      finalizedAt: new Date("2031-01-17T14:08:00.000Z"),
    }));
    await inSchool(school.id, () => lifecycle.finalizeClasspilotSession({
      schoolId: school.id,
      sessionId: started.session.id,
      reason: "teacher_end",
      finalizedAt: new Date("2031-01-17T14:10:00.000Z"),
    }));
  });

  it("re-opens a live scheduled occurrence from the start route without restarting it", async () => {
    await setCentralRecipient(null);
    const group = await createClass({ name: "scheduled_reopen_live", scheduled: true });
    const now = new Date();
    const scheduledDate = schoolTime.localDateInTimeZone(now, "America/New_York");
    const occurrence = await inSchool(school.id, () => storage.createOrReuseScheduledReportSession({
      schoolId: school.id,
      groupId: group.id,
      teacherId: teacher.id,
      scheduledDate,
      scheduledTimezone: "America/New_York",
      scheduledStartAt: new Date(now.getTime() - 30 * 60_000),
      scheduledEndAt: new Date(now.getTime() + 30 * 60_000),
      scheduledTeacherEmail: teacher.email,
      scheduledTeacherName: "Terry Teacher",
    }));
    const started = await inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
      group,
      scheduledDate,
      scheduledTeacherConnectedOverride: true,
      now,
    }));
    assert.equal(started.status, "started");
    assert.equal(started.session.id, occurrence.id);

    const reopened = await requestJson(
      "POST",
      "/classpilot/teaching-sessions/start",
      { groupId: group.id },
      authFor(teacher)
    );
    assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
    assert.equal(reopened.body.session.id, occurrence.id);
    assert.equal(reopened.body.session.sessionMode, "live");
    assert.deepEqual(reopened.body.session.lifecycle, { kind: "scheduled", state: "active" });
    assert.equal(await occurrenceCount(group.id, scheduledDate), 1);

    await inSchool(school.id, () => lifecycle.finalizeClasspilotSession({
      schoolId: school.id,
      sessionId: occurrence.id,
      reason: "teacher_end",
    }));
  });

  it("marks only material scheduled-conflict reconciliations for dashboard refresh", async () => {
    await setCentralRecipient(null);
    const group = await createClass({ name: "conflict_refresh_dedup", scheduled: true });
    const occurrence = await inSchool(school.id, () =>
      storage.createOrReuseScheduledReportSession({
        schoolId: school.id,
        groupId: group.id,
        teacherId: teacher.id,
        scheduledDate: "2031-01-29",
        scheduledTimezone: "America/New_York",
        scheduledStartAt: new Date("2031-01-29T14:00:00.000Z"),
        scheduledEndAt: new Date("2031-01-29T15:00:00.000Z"),
        scheduledTeacherEmail: teacher.email,
        scheduledTeacherName: "Terry Teacher",
      })
    );
    const baseConflict = {
      teachingSessionId: occurrence.id,
      schoolId: school.id,
      groupId: group.id,
      teacherId: teacher.id,
      scheduledDate: "2031-01-29",
      blockStartTime: "09:00",
      blockEndTime: "10:00",
      status: "coverage_needed",
      conflictPayload: {
        claimableCount: 1,
        claimableStudents: [{
          studentId: "student-with-nullable-fields",
          studentEmail: undefined,
          gradeLevel: undefined,
        }],
      },
      scheduledTeacherConnected: false,
    } as any;

    const created = await inSchool(school.id, () =>
      storage.upsertScheduledClassConflictForOccurrence(baseConflict)
    );
    assert.equal(created.materiallyChanged, true);

    const unchanged = await inSchool(school.id, () =>
      storage.upsertScheduledClassConflictForOccurrence(baseConflict)
    );
    assert.equal(unchanged.conflict.id, created.conflict.id);
    assert.equal(unchanged.materiallyChanged, false);

    const payloadChanged = await inSchool(school.id, () =>
      storage.upsertScheduledClassConflictForOccurrence({
        ...baseConflict,
        conflictPayload: { claimableCount: 0 },
      })
    );
    assert.equal(payloadChanged.materiallyChanged, true);

    const statusChanged = await inSchool(school.id, () =>
      storage.upsertScheduledClassConflictForOccurrence({
        ...baseConflict,
        status: "claimed",
        conflictPayload: { claimableCount: 0 },
      })
    );
    assert.equal(statusChanged.materiallyChanged, true);

    await inSchool(school.id, () => lifecycle.finalizeClasspilotSession({
      schoolId: school.id,
      sessionId: occurrence.id,
      reason: "teacher_end",
      finalizedAt: new Date("2031-01-29T14:10:00.000Z"),
    }));
  });

  it("keeps conflict attachment, live promotion, and teacher start linearized against finalization", async () => {
    await setCentralRecipient(null);
    const attachGroup = await createClass({ name: "conflict_attach_barrier", scheduled: true });
    const attachOccurrence = await inSchool(school.id, () =>
      storage.createOrReuseScheduledReportSession({
        schoolId: school.id,
        groupId: attachGroup.id,
        teacherId: teacher.id,
        scheduledDate: "2031-01-14",
        scheduledTimezone: "America/New_York",
        scheduledStartAt: new Date("2031-01-14T14:00:00.000Z"),
        scheduledEndAt: new Date("2031-01-14T15:00:00.000Z"),
        scheduledTeacherEmail: teacher.email,
        scheduledTeacherName: "Terry Teacher",
      })
    );
    await Promise.all([
      inSchool(school.id, () => storage.upsertScheduledClassConflictForOccurrence({
        teachingSessionId: attachOccurrence.id,
        schoolId: school.id,
        groupId: attachGroup.id,
        teacherId: teacher.id,
        scheduledDate: "2031-01-14",
        blockStartTime: "09:00",
        blockEndTime: "10:00",
        status: "coverage_needed",
        conflictPayload: {},
        scheduledTeacherConnected: false,
      } as any)),
      inSchool(school.id, () => lifecycle.finalizeClasspilotSession({
        schoolId: school.id,
        sessionId: attachOccurrence.id,
        reason: "teacher_end",
        finalizedAt: new Date("2031-01-14T14:10:00.000Z"),
      })),
    ]);
    const attachedFinal = await inSchool(school.id, () =>
      storage.getTeachingSessionById(attachOccurrence.id)
    );
    const attachedConflict = await inSchool(school.id, () =>
      storage.getScheduledClassConflictForSlot({
        schoolId: school.id,
        groupId: attachGroup.id,
        scheduledDate: "2031-01-14",
        blockStartTime: "09:00",
      })
    );
    assert.equal(attachedFinal.scheduledState, "finalized");
    assert.equal(attachedConflict.status, "ended");
    assert.equal(
      await inSchool(school.id, () => storage.promoteScheduledReportSessionToLive({
        schoolId: school.id,
        sessionId: attachOccurrence.id,
      })),
      undefined
    );

    const promotionGroup = await createClass({ name: "promotion_finalize_barrier", scheduled: true });
    const promotionOccurrence = await inSchool(school.id, () =>
      storage.createOrReuseScheduledReportSession({
        schoolId: school.id,
        groupId: promotionGroup.id,
        teacherId: teacher.id,
        scheduledDate: "2031-01-15",
        scheduledTimezone: "America/New_York",
        scheduledStartAt: new Date("2031-01-15T14:00:00.000Z"),
        scheduledEndAt: new Date("2031-01-15T15:00:00.000Z"),
        scheduledTeacherEmail: teacher.email,
        scheduledTeacherName: "Terry Teacher",
      })
    );
    await Promise.all([
      inSchool(school.id, () => storage.promoteScheduledReportSessionToLive({
        schoolId: school.id,
        sessionId: promotionOccurrence.id,
      })),
      inSchool(school.id, () => lifecycle.finalizeClasspilotSession({
        schoolId: school.id,
        sessionId: promotionOccurrence.id,
        reason: "teacher_end",
        finalizedAt: new Date("2031-01-15T14:10:00.000Z"),
      })),
    ]);
    const promotionFinal = await inSchool(school.id, () =>
      storage.getTeachingSessionById(promotionOccurrence.id)
    );
    assert.equal(promotionFinal.scheduledState, "finalized");
    assert.ok(promotionFinal.endTime);
    assert.equal(
      await inSchool(school.id, () => storage.promoteScheduledReportSessionToLive({
        schoolId: school.id,
        sessionId: promotionOccurrence.id,
      })),
      undefined
    );

    const startGroup = await createClass({ name: "teacher_start_finalize_barrier", scheduled: true });
    const prepared = await inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
      group: startGroup,
      scheduledDate: "2031-01-16",
      scheduledTeacherConnectedOverride: false,
      now: new Date("2031-01-16T14:05:00.000Z"),
    }));
    assert.equal(prepared.status, "coverage_needed");
    const startOccurrence = await inSchool(school.id, () =>
      storage.getScheduledTeachingSessionOccurrence(school.id, startGroup.id, "2031-01-16")
    );
    const conflict = await inSchool(school.id, () =>
      storage.getScheduledClassConflictByIdAndSchool(prepared.conflictId, school.id)
    );
    const [startRace, endRace] = await Promise.allSettled([
      inSchool(school.id, () => scheduled.startScheduledClassFromConflict({
        conflict,
        actorId: teacher.id,
        now: new Date("2031-01-16T14:10:00.000Z"),
      })),
      inSchool(school.id, () => lifecycle.finalizeClasspilotSession({
        schoolId: school.id,
        sessionId: startOccurrence.id,
        reason: "teacher_end",
        finalizedAt: new Date("2031-01-16T14:10:00.000Z"),
      })),
    ]);
    assert.equal(endRace.status, "fulfilled");
    if (startRace.status === "rejected") {
      assert.equal(startRace.reason.code, "SCHEDULED_OCCURRENCE_FINALIZED");
    }
    const startFinal = await inSchool(school.id, () =>
      storage.getTeachingSessionById(startOccurrence.id)
    );
    const conflictFinal = await inSchool(school.id, () =>
      storage.getScheduledClassConflictByIdAndSchool(conflict.id, school.id)
    );
    assert.equal(startFinal.scheduledState, "finalized");
    assert.ok(!["coverage_needed", "claimed", "pending"].includes(conflictFinal.status));
  });

  it("keeps a scheduled coverage claim atomic with End Class and never resurrects supervision or its conflict", async () => {
    await setCentralRecipient(null);
    const group = await createClass({ name: "coverage_claim_end_barrier", scheduled: true, roster: [studentOne] });
    const prepared = await inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
      group,
      scheduledDate: "2031-01-20",
      scheduledTeacherConnectedOverride: false,
      now: new Date("2031-01-20T14:05:00.000Z"),
    }));
    assert.equal(prepared.status, "coverage_needed");
    const occurrence = await inSchool(school.id, () =>
      storage.getScheduledTeachingSessionOccurrence(school.id, group.id, "2031-01-20")
    );

    const [claimRace, endRace] = await Promise.allSettled([
      inSchool(school.id, () => storage.claimScheduledCoverageStudents({
        schoolId: school.id,
        scheduledConflictId: prepared.conflictId,
        className: group.name,
        assignedStaffId: centralRecipient.id,
        actorId: centralRecipient.id,
        studentIds: [studentOne.id],
        endsAt: new Date("2031-01-20T15:00:00.000Z"),
      })),
      inSchool(school.id, () => lifecycle.finalizeClasspilotSession({
        schoolId: school.id,
        sessionId: occurrence.id,
        reason: "teacher_end",
        finalizedAt: new Date("2031-01-20T14:10:00.000Z"),
      })),
    ]);
    assert.equal(endRace.status, "fulfilled");
    if (claimRace.status === "rejected") {
      assert.equal(claimRace.reason.code, "SCHEDULED_CONFLICT_EXPIRED");
    }
    assert.equal(endRace.value.session.scheduledState, "finalized");

    const terminal = await inSchool(school.id, () => db.execute(sql`
      SELECT
        session.scheduled_state,
        conflict.status AS conflict_status,
        (count(DISTINCT context.id) FILTER (WHERE context.status = 'active'))::int AS active_contexts,
        (count(DISTINCT assignment.id) FILTER (WHERE assignment.released_at IS NULL))::int AS active_students
      FROM teaching_sessions session
      JOIN classpilot_scheduled_conflicts conflict
        ON conflict.id = ${prepared.conflictId}
       AND conflict.school_id = session.school_id
      LEFT JOIN classpilot_supervision_contexts context
        ON context.scheduled_conflict_id = conflict.id
       AND context.school_id = conflict.school_id
      LEFT JOIN classpilot_supervision_students assignment
        ON assignment.context_id = context.id
       AND assignment.school_id = context.school_id
      WHERE session.id = ${occurrence.id}
        AND session.school_id = ${school.id}
      GROUP BY session.scheduled_state, conflict.status
    `));
    assert.deepEqual(terminal.rows, [{
      scheduled_state: "finalized",
      conflict_status: "ended",
      active_contexts: 0,
      active_students: 0,
    }]);

    assert.equal(
      await inSchool(school.id, () => storage.updateScheduledClassConflictStatus(
        prepared.conflictId,
        school.id,
        "claimed",
        { staleRouteRefresh: true }
      )),
      undefined,
      "a stale post-claim refresh must not resurrect a terminal conflict"
    );

    const retry = await requestJson(
      "POST",
      "/classpilot/coverage/claim",
      { scheduledConflictId: prepared.conflictId, studentIds: [studentOne.id] },
      authFor(centralRecipient)
    );
    assert.ok([404, 409].includes(retry.status));
    const conflictAfterRetry = await inSchool(school.id, () =>
      storage.getScheduledClassConflictByIdAndSchool(prepared.conflictId, school.id)
    );
    assert.equal(conflictAfterRetry.status, "ended");
  });

  it("lets only one of two simultaneous staff claims own the same scheduled student", async () => {
    await setCentralRecipient(null);
    const group = await createClass({
      name: "two_staff_one_student_claim",
      scheduled: true,
      roster: [studentTwo],
    });
    const prepared = await inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
      group,
      scheduledDate: "2031-01-23",
      scheduledTeacherConnectedOverride: false,
      now: new Date("2031-01-23T14:05:00.000Z"),
    }));
    assert.equal(prepared.status, "coverage_needed");
    const occurrence = await inSchool(school.id, () =>
      storage.getScheduledTeachingSessionOccurrence(school.id, group.id, "2031-01-23")
    );

    const claimers = [centralRecipient, secondTeacher];
    const attempts = await Promise.allSettled(claimers.map((staff) =>
      inSchool(school.id, () => storage.claimScheduledCoverageStudents({
        schoolId: school.id,
        scheduledConflictId: prepared.conflictId,
        className: group.name,
        assignedStaffId: staff.id,
        actorId: staff.id,
        studentIds: [studentTwo.id],
        endsAt: new Date("2031-01-23T15:00:00.000Z"),
      }))
    ));
    const winners = attempts
      .map((result, index) => ({ result, staff: claimers[index] }))
      .filter((entry) => entry.result.status === "fulfilled");
    const losers = attempts.filter((result) => result.status === "rejected");
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.equal((losers[0] as PromiseRejectedResult).reason.status, 409);
    assert.equal(
      (losers[0] as PromiseRejectedResult).reason.code,
      "SCHEDULED_COVERAGE_STUDENT_UNAVAILABLE"
    );

    const assignment = await inSchool(school.id, () => db.execute(sql`
      SELECT assignment.student_id, context.assigned_staff_id
      FROM classpilot_supervision_students assignment
      JOIN classpilot_supervision_contexts context
        ON context.id = assignment.context_id
       AND context.school_id = assignment.school_id
      WHERE assignment.school_id = ${school.id}
        AND assignment.student_id = ${studentTwo.id}
        AND assignment.released_at IS NULL
        AND context.scheduled_conflict_id = ${prepared.conflictId}
        AND context.status = 'active'
    `));
    assert.deepEqual(assignment.rows, [{
      student_id: studentTwo.id,
      assigned_staff_id: winners[0].staff.id,
    }]);

    await inSchool(school.id, () => lifecycle.finalizeClasspilotSession({
      schoolId: school.id,
      sessionId: occurrence.id,
      reason: "teacher_end",
      finalizedAt: new Date("2031-01-23T14:10:00.000Z"),
    }));
  });

  it("deduplicates an equal central address and keeps recipient failures independent", async () => {
    const deduped = await finalizeManualForDelivery(
      "central_same_as_teacher",
      new Date("2031-02-03T14:00:00.000Z"),
      teacher.id
    );
    const oneRecipient = await deliveryRows(deduped.session.id);
    assert.equal(oneRecipient.length, 1);
    assert.equal(oneRecipient[0].recipient_kind, "teacher");

    const independent = await finalizeManualForDelivery(
      "independent_recipient_failure",
      new Date("2031-02-04T14:00:00.000Z"),
      centralRecipient.id
    );
    assert.ok((await deliveryRows(independent.session.id)).every((row) => row.state === "waiting_report"));
    const result = await materializeAndDispatch({
      sessionId: independent.session.id,
      transport: async (message: any) =>
        String(message.to).toLowerCase() === teacher.email.toLowerCase()
          ? { status: "transient_failure", error: "provider unavailable", providerStatus: 503 }
          : { status: "sent", providerMessageId: `${TAG}-central-sent` },
    });
    assert.equal(result.sent, 1);
    assert.equal(result.retry, 1);
    const rows = await deliveryRows(independent.session.id);
    assert.equal(rows.find((row) => row.recipient_kind === "central")?.state, "sent");
    assert.equal(rows.find((row) => row.recipient_kind === "teacher")?.state, "retry");
  });

  it("keeps the frozen class name identical for teacher, central, and a teacher retry after rename", async () => {
    await setCentralRecipient(centralRecipient.id);
    const group = await createClass({ name: "frozen_name_delivery", scheduled: true });
    const originalName = group.name;
    const started = await inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
      group,
      scheduledDate: "2031-02-10",
      scheduledTeacherConnectedOverride: false,
      now: new Date("2031-02-10T14:05:00.000Z"),
    }));
    assert.equal(started.status, "coverage_needed");
    const occurrence = await inSchool(school.id, () =>
      storage.getScheduledTeachingSessionOccurrence(school.id, group.id, "2031-02-10")
    );
    await inSchool(school.id, () => storage.updateGroup(group.id, {
      name: `${TAG}_renamed_after_bell`,
    } as any));
    await inSchool(school.id, () => lifecycle.finalizeClasspilotSession({
      schoolId: school.id,
      sessionId: occurrence.id,
      reason: "teacher_end",
      finalizedAt: new Date("2031-02-10T14:10:00.000Z"),
    }));

    const observed: Array<{ to: string; className: string }> = [];
    const settledAt = await materializeReportForSession(occurrence.id);
    const first = await inSchool(school.id, () => lifecycle.dispatchDueClasspilotSessionSummaries({
      schoolId: school.id,
      teachingSessionId: occurrence.id,
      now: settledAt,
      transport: async (message: any) => {
        observed.push({ to: String(message.to).toLowerCase(), className: message.className });
        return String(message.to).toLowerCase() === teacher.email.toLowerCase()
          ? { status: "transient_failure", error: "retry teacher", providerStatus: 503 }
          : { status: "sent", providerMessageId: `${TAG}-frozen-central` };
      },
    }));
    assert.equal(first.sent, 1);
    assert.equal(first.retry, 1);
    const retry = await inSchool(school.id, () => lifecycle.dispatchDueClasspilotSessionSummaries({
      schoolId: school.id,
      teachingSessionId: occurrence.id,
      now: new Date(settledAt.getTime() + 60_000),
      transport: async (message: any) => {
        observed.push({ to: String(message.to).toLowerCase(), className: message.className });
        return { status: "sent", providerMessageId: `${TAG}-frozen-teacher-retry` };
      },
    }));
    assert.equal(retry.sent, 1);
    assert.equal(observed.length, 3);
    assert.ok(observed.every((message) => message.className === originalName));
    assert.deepEqual(
      observed.map((message) => message.to).sort(),
      [centralRecipient.email.toLowerCase(), teacher.email.toLowerCase(), teacher.email.toLowerCase()].sort()
    );
  });

  it("freezes tracking policy at finalization so settlement retries ignore later settings edits", async () => {
    const original = await inSchool(school.id, () => storage.getSettingsForSchool(school.id));
    try {
      await inSchool(school.id, () => storage.updateEnrollmentSettings(school.id, {
        enableTrackingHours: true,
        trackingStartTime: "08:15",
        trackingEndTime: "14:45",
        trackingDays: ["Monday", "Wednesday"],
        afterHoursMode: "off",
      } as any));
      const finalized = await finalizeManualForDelivery(
        "frozen_tracking_policy",
        new Date("2031-02-11T14:00:00.000Z"),
        null
      );
      const report = await inSchool(school.id, () =>
        storage.getClasspilotSessionReportBySession(school.id, finalized.session.id)
      );
      assert.deepEqual(report.trackingPolicy, {
        enableTrackingHours: true,
        trackingStartTime: "08:15",
        trackingEndTime: "14:45",
        trackingDays: ["Monday", "Wednesday"],
        schoolTimezone: "America/New_York",
        afterHoursMode: "off",
      });

      await inSchool(school.id, () => storage.updateEnrollmentSettings(school.id, {
        enableTrackingHours: false,
        trackingStartTime: "01:00",
        trackingEndTime: "02:00",
        trackingDays: ["Friday"],
        afterHoursMode: "full",
      } as any));
      const input = await inSchool(school.id, () => storage.getClasspilotSessionReportInput(report));
      assert.deepEqual(input.trackingPolicy, report.trackingPolicy);
    } finally {
      await inSchool(school.id, () => storage.updateEnrollmentSettings(school.id, {
        enableTrackingHours: original?.enableTrackingHours ?? false,
        trackingStartTime: original?.trackingStartTime || "08:00",
        trackingEndTime: original?.trackingEndTime || "15:00",
        trackingDays: original?.trackingDays || ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
        afterHoursMode: original?.afterHoursMode || "off",
      } as any));
    }
  });

  it("fences a stale report worker after another worker reclaims its lease", async () => {
    const finalized = await finalizeManualForDelivery(
      "materialization_lease_fence",
      new Date("2031-02-11T16:00:00.000Z"),
      null
    );
    const pending = await inSchool(school.id, () =>
      storage.getClasspilotSessionReportBySession(school.id, finalized.session.id)
    );
    const firstLeaseAt = new Date(pending.settleAt);
    const firstOwner = `${TAG}-report-worker-one`;
    const firstClaim = await inSchool(school.id, () => storage.claimDueClasspilotSessionReports({
      leaseOwner: firstOwner,
      now: firstLeaseAt,
      leaseMs: 1_000,
      schoolId: school.id,
      teachingSessionId: finalized.session.id,
    }));
    assert.equal(firstClaim.reports.length, 1);

    const secondLeaseAt = new Date(firstLeaseAt.getTime() + 2_000);
    const secondOwner = `${TAG}-report-worker-two`;
    const secondClaim = await inSchool(school.id, () => storage.claimDueClasspilotSessionReports({
      leaseOwner: secondOwner,
      now: secondLeaseAt,
      leaseMs: 60_000,
      schoolId: school.id,
      teachingSessionId: finalized.session.id,
    }));
    assert.equal(secondClaim.reports.length, 1);

    const staleCommit = await inSchool(school.id, () => storage.completeClasspilotSessionReport({
      report: firstClaim.reports[0],
      leaseOwner: firstOwner,
      students: [],
      completedAt: new Date(secondLeaseAt.getTime() + 1),
    }));
    assert.equal(staleCommit, undefined);
    const current = await inSchool(school.id, () =>
      storage.getClasspilotSessionReportBySession(school.id, finalized.session.id)
    );
    assert.equal(current.state, "materializing");
    assert.equal(current.leaseOwner, secondOwner);
    const detail = await inSchool(school.id, () => db.execute(sql`
      SELECT count(*)::int AS count
      FROM classpilot_session_student_reports
      WHERE school_id = ${school.id} AND report_id = ${pending.id}
    `));
    assert.equal(Number(detail.rows[0]?.count || 0), 0);
  });

  it("serializes monitoring-event scope binding with a supervision handoff", async () => {
    const contextId = `${TAG}-atomic-scope-context`;
    const sourceEventId = `${TAG}-atomic-scope-event`;
    const studentSessionId = `${TAG}-atomic-scope-student-session`;
    const eventAt = new Date(Date.now() + 1_000);
    const handoffAt = new Date(eventAt.getTime() - 500);
    let releaseTransition!: () => void;
    let transitionLocked!: () => void;
    const transitionReady = new Promise<void>((resolve) => { transitionLocked = resolve; });
    const mayCommit = new Promise<void>((resolve) => { releaseTransition = resolve; });
    const transition = inSchool(school.id, () => db.transaction(async (tx: any) => {
      const lockKey = `classpilot:student-control:${school.id}:${studentOne.id}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0::bigint))`);
      await tx.execute(sql`
        UPDATE classpilot_supervision_students
        SET released_at = ${handoffAt}, release_reason = 'reassigned'
        WHERE school_id = ${school.id}
          AND student_id = ${studentOne.id}
          AND assigned_at <= ${handoffAt}
          AND (released_at IS NULL OR released_at > ${handoffAt})
      `);
      await tx.execute(sql`
        INSERT INTO classpilot_supervision_contexts (
          id, school_id, context_type, name, status, assigned_staff_id,
          created_by, starts_at, ends_at
        ) VALUES (
          ${contextId}, ${school.id}, 'manual', 'Atomic scope test', 'active',
          ${teacher.id}, ${teacher.id}, ${new Date(eventAt.getTime() - 1_000)},
          ${new Date(eventAt.getTime() + 60_000)}
        )
      `);
      await tx.execute(sql`
        INSERT INTO classpilot_supervision_students (
          school_id, context_id, student_id, source, assigned_by, assigned_at
        ) VALUES (
          ${school.id}, ${contextId}, ${studentOne.id}, 'manual', ${teacher.id},
          ${handoffAt}
        )
      `);
      transitionLocked();
      await mayCommit;
    }));
    await transitionReady;

    let insertSettled = false;
    const insertion = inSchool(school.id, () => storage.insertClasspilotMonitoringEventForResolvedScope({
      schoolId: school.id,
      studentId: studentOne.id,
      deviceId: null,
      studentSessionId,
      claimedTeachingSessionId: null,
      claimedSupervisionContextId: contextId,
      sourceEventId,
      schemaVersion: 1,
      origin: "extension",
      eventType: "navigation_changed",
      occurredAt: eventAt,
      receivedAt: eventAt,
      normalizedDomain: "example.edu",
      sanitizedPath: "/lesson",
      title: "Lesson",
      metadata: {},
      retentionExpiresAt: new Date(eventAt.getTime() + 24 * 60 * 60_000),
    })).finally(() => { insertSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(insertSettled, false, "event insertion must wait for the authority handoff lock");
    releaseTransition();
    await transition;
    assert.equal(await insertion, "stored");

    const retained = await inSchool(school.id, () => db.execute(sql`
      SELECT teaching_session_id, supervision_context_id
      FROM classpilot_monitoring_events
      WHERE school_id = ${school.id}
        AND student_session_id = ${studentSessionId}
        AND source_event_id = ${sourceEventId}
    `));
    assert.equal(retained.rows[0]?.teaching_session_id, null);
    assert.equal(retained.rows[0]?.supervision_context_id, contextId);
    await inSchool(school.id, async () => {
      await db.execute(sql`
        DELETE FROM classpilot_monitoring_events
        WHERE school_id = ${school.id}
          AND student_session_id = ${studentSessionId}
          AND source_event_id = ${sourceEventId}
      `);
      await db.execute(sql`
        DELETE FROM classpilot_supervision_students
        WHERE school_id = ${school.id} AND context_id = ${contextId}
      `);
      await db.execute(sql`
        DELETE FROM classpilot_supervision_contexts
        WHERE school_id = ${school.id} AND id = ${contextId}
      `);
    });
  });

  it("removes expired roster/staff linkage while preserving authorized 410 responses", async () => {
    const finalized = await finalizeManualForDelivery(
      "expired_non_pii_marker",
      new Date("2031-02-11T17:00:00.000Z"),
      null
    );
    const report = await inSchool(school.id, () =>
      storage.getClasspilotSessionReportBySession(school.id, finalized.session.id)
    );
    assert.ok(report.authorizationMarker);
    assert.equal(JSON.stringify(report.authorizationMarker).includes(teacher.id), false);

    const expiredAt = new Date(Date.now() - 1_000);
    await inSchool(school.id, async () => {
      await db.execute(sql`
        DELETE FROM classpilot_session_students
        WHERE school_id = ${school.id} AND teaching_session_id = ${finalized.session.id}
      `);
      await db.execute(sql`
        DELETE FROM classpilot_session_staff
        WHERE school_id = ${school.id} AND teaching_session_id = ${finalized.session.id}
      `);
      await db.execute(sql`
        UPDATE classpilot_session_reports
        SET state = 'expired', expires_at = ${expiredAt}, detail_expired_at = ${expiredAt}
        WHERE school_id = ${school.id} AND teaching_session_id = ${finalized.session.id}
      `);
    });

    const authorizedRead = await requestJson(
      "GET",
      `/classpilot/teaching-sessions/${finalized.session.id}/report`,
      undefined,
      authFor(teacher)
    );
    assert.equal(authorizedRead.status, 410);
    assert.equal(authorizedRead.body.code, "SUMMARY_EXPIRED");
    const unrelatedRead = await requestJson(
      "GET",
      `/classpilot/teaching-sessions/${finalized.session.id}/report`,
      undefined,
      authFor(secondTeacher)
    );
    assert.equal(unrelatedRead.status, 404);

    const linkage = await inSchool(school.id, () => db.execute(sql`
      SELECT
        (SELECT count(*) FROM classpilot_session_students
          WHERE school_id = ${school.id} AND teaching_session_id = ${finalized.session.id})::int AS roster_count,
        (SELECT count(*) FROM classpilot_session_staff
          WHERE school_id = ${school.id} AND teaching_session_id = ${finalized.session.id})::int AS staff_count
    `));
    assert.equal(Number(linkage.rows[0]?.roster_count || 0), 0);
    assert.equal(Number(linkage.rows[0]?.staff_count || 0), 0);
  });

  it("returns 410 and terminalizes queued email when immutable report detail expires", async () => {
    const finalized = await finalizeManualForDelivery(
      "expired_report_not_emailed",
      new Date("2031-02-12T14:00:00.000Z"),
      null
    );
    await materializeReportForSession(finalized.session.id);
    const expiredAt = new Date(Date.now() - 1_000);
    await inSchool(school.id, () => db.execute(sql`
      UPDATE classpilot_session_reports
      SET expires_at = ${expiredAt}
      WHERE school_id = ${school.id} AND teaching_session_id = ${finalized.session.id}
    `));

    const read = await requestJson(
      "GET",
      `/classpilot/teaching-sessions/${finalized.session.id}/report`,
      undefined,
      authFor(teacher)
    );
    assert.equal(read.status, 410);
    assert.equal(read.body.code, "SUMMARY_EXPIRED");

    let transportCalls = 0;
    const dispatched = await inSchool(school.id, () => lifecycle.dispatchDueClasspilotSessionSummaries({
      schoolId: school.id,
      teachingSessionId: finalized.session.id,
      now: new Date(),
      transport: async () => {
        transportCalls += 1;
        return { status: "sent" };
      },
    }));
    assert.equal(dispatched.claimed, 0);
    assert.equal(transportCalls, 0);
    const [delivery] = await deliveryRows(finalized.session.id);
    assert.equal(delivery.state, "failed");
    assert.match(delivery.last_error, /expired before email/i);
  });

  it("rechecks report expiry with a fresh clock immediately before materialization commits", async () => {
    const finalized = await finalizeManualForDelivery(
      "materialization_expiry_boundary",
      new Date("2031-02-12T15:00:00.000Z"),
      null
    );
    const pending = await inSchool(school.id, () =>
      storage.getClasspilotSessionReportBySession(school.id, finalized.session.id)
    );
    const claimAt = new Date(pending.settleAt);
    const expiresAt = new Date(claimAt.getTime() + 1_000);
    await inSchool(school.id, () => db.execute(sql`
      UPDATE classpilot_session_reports
      SET expires_at = ${expiresAt}
      WHERE school_id = ${school.id} AND teaching_session_id = ${finalized.session.id}
    `));

    const outcome = await inSchool(school.id, () => monitoringReports.materializeDueClasspilotSessionReports({
      now: claimAt,
      clock: () => new Date(expiresAt.getTime() + 1),
      schoolId: school.id,
      teachingSessionId: finalized.session.id,
    }));
    assert.equal(outcome.claimed, 1);
    assert.equal(outcome.ready, 0);
    const expired = await inSchool(school.id, () =>
      storage.getClasspilotSessionReportBySession(school.id, finalized.session.id)
    );
    assert.equal(expired.state, "expired");
  });

  it("rechecks report expiry immediately before provider submission", async () => {
    const finalized = await finalizeManualForDelivery(
      "delivery_expiry_boundary",
      new Date("2031-02-12T16:00:00.000Z"),
      null
    );
    const claimAt = await materializeReportForSession(finalized.session.id);
    const expiresAt = new Date(claimAt.getTime() + 1_000);
    await inSchool(school.id, () => db.execute(sql`
      UPDATE classpilot_session_reports
      SET expires_at = ${expiresAt}
      WHERE school_id = ${school.id} AND teaching_session_id = ${finalized.session.id}
    `));
    const times = [
      new Date(expiresAt.getTime() - 1),
      new Date(expiresAt.getTime() + 1),
      new Date(expiresAt.getTime() + 2),
    ];
    let transportCalls = 0;
    const outcome = await inSchool(school.id, () => lifecycle.dispatchDueClasspilotSessionSummaries({
      now: claimAt,
      clock: () => times.shift() || new Date(expiresAt.getTime() + 3),
      schoolId: school.id,
      teachingSessionId: finalized.session.id,
      transport: async () => {
        transportCalls += 1;
        return { status: "sent" };
      },
    }));
    assert.equal(outcome.claimed, 1);
    assert.equal(transportCalls, 0);
    const [delivery] = await deliveryRows(finalized.session.id);
    assert.equal(delivery.state, "failed");
    assert.match(delivery.last_error, /expired before email/i);
  });

  it("fails permanent delivery errors and isolates a poison recipient from a healthy recipient", async () => {
    const permanent = await finalizeManualForDelivery(
      "permanent_delivery_failure",
      new Date("2031-02-05T14:00:00.000Z"),
      null
    );
    const permanentResult = await materializeAndDispatch({
      sessionId: permanent.session.id,
      transport: async () => ({
          status: "permanent_failure",
          error: "recipient rejected",
          providerStatus: 400,
      }),
    });
    assert.equal(permanentResult.failed, 1);
    assert.equal((await deliveryRows(permanent.session.id))[0].state, "failed");

    const poison = await finalizeManualForDelivery(
      "poison_recipient_isolation",
      new Date("2031-02-06T14:00:00.000Z"),
      centralRecipient.id
    );
    const poisonResult = await materializeAndDispatch({
      sessionId: poison.session.id,
      transport: async (message: any) => {
          if (String(message.to).toLowerCase() === teacher.email.toLowerCase()) {
            throw new Error("poison transport callback");
          }
          return { status: "sent", providerMessageId: `${TAG}-healthy-recipient` };
      },
    });
    assert.equal(poisonResult.sent, 1);
    assert.equal(poisonResult.unknown, 1);
    const poisonRows = await deliveryRows(poison.session.id);
    assert.equal(poisonRows.find((row) => row.recipient_kind === "central")?.state, "sent");
    assert.equal(poisonRows.find((row) => row.recipient_kind === "teacher")?.state, "unknown");
  });

  it("applies 1/5/15/60/180 minute retries and quarantines ambiguous provider and process outcomes", async () => {
    const transient = await finalizeManualForDelivery(
      "retry_schedule",
      new Date("2031-03-03T14:00:00.000Z"),
      null
    );
    const transientTransport = async () => ({
      status: "transient_failure" as const,
      error: "temporary provider failure",
      providerStatus: 503,
    });
    const firstAttemptAt = await materializeReportForSession(transient.session.id);
    const attemptOffsetsMinutes = [0, 1, 6, 21, 81];
    const nextOffsetsMinutes = [1, 6, 21, 81, 261];
    const attemptTimes = attemptOffsetsMinutes.map(
      (minutes) => new Date(firstAttemptAt.getTime() + minutes * 60_000)
    );
    const expectedNext = nextOffsetsMinutes.map(
      (minutes) => new Date(firstAttemptAt.getTime() + minutes * 60_000).toISOString()
    );
    for (let index = 0; index < attemptTimes.length; index++) {
      const outcome = await inSchool(school.id, () => lifecycle.dispatchDueClasspilotSessionSummaries({
        schoolId: school.id,
        teachingSessionId: transient.session.id,
        now: attemptTimes[index],
        transport: transientTransport,
      }));
      assert.equal(outcome.retry, 1);
      const [row] = await deliveryRows(transient.session.id);
      assert.equal(row.attempt_count, index + 1);
      assert.equal(new Date(row.next_attempt_at).toISOString(), expectedNext[index]);
    }
    const exhausted = await inSchool(school.id, () => lifecycle.dispatchDueClasspilotSessionSummaries({
      schoolId: school.id,
      teachingSessionId: transient.session.id,
      now: new Date(firstAttemptAt.getTime() + 261 * 60_000),
      transport: transientTransport,
    }));
    assert.equal(exhausted.failed, 1);
    assert.equal((await deliveryRows(transient.session.id))[0].state, "failed");

    const ambiguous = await finalizeManualForDelivery(
      "provider_timeout_unknown",
      new Date("2031-03-04T14:00:00.000Z"),
      null
    );
    const ambiguousSettledAt = await materializeReportForSession(ambiguous.session.id);
    const unknown = await inSchool(school.id, () => lifecycle.dispatchDueClasspilotSessionSummaries({
      schoolId: school.id,
      teachingSessionId: ambiguous.session.id,
      now: ambiguousSettledAt,
      transport: async () => ({
        status: "unknown",
        error: "provider acceptance timed out",
        providerCode: "ETIMEDOUT",
      }),
    }));
    assert.equal(unknown.unknown, 1);
    assert.equal((await deliveryRows(ambiguous.session.id))[0].state, "unknown");
    const notRetried = await inSchool(school.id, () => lifecycle.dispatchDueClasspilotSessionSummaries({
      schoolId: school.id,
      teachingSessionId: ambiguous.session.id,
      now: new Date(ambiguousSettledAt.getTime() + 24 * 60 * 60_000),
      transport: async () => ({ status: "sent" }),
    }));
    assert.equal(notRetried.claimed, 0);

    const processDeath = await finalizeManualForDelivery(
      "process_death_unknown",
      new Date("2031-03-05T15:00:00.000Z"),
      null
    );
    const processDeathSettledAt = await materializeReportForSession(processDeath.session.id);
    const [claimed] = await inSchool(school.id, () => storage.claimDueSessionSummaryDeliveries({
      leaseOwner: `${TAG}-dead-worker`,
      now: processDeathSettledAt,
      leaseMs: 1_000,
      schoolId: school.id,
      teachingSessionId: processDeath.session.id,
    }));
    assert.ok(claimed);
    await inSchool(school.id, () => storage.markSessionSummarySubmissionStarted(
      claimed.id,
      `${TAG}-dead-worker`,
      processDeathSettledAt
    ));
    const recovered = await inSchool(school.id, () => storage.recoverExpiredSessionSummaryLeases(
      new Date(processDeathSettledAt.getTime() + 2_000)
    ));
    assert.equal(recovered.quarantined, 1);
    assert.equal((await deliveryRows(processDeath.session.id))[0].state, "unknown");
  });

  it("uses half-open heartbeat windows so a boundary heartbeat belongs only to the next class", async () => {
    const start = new Date("2031-04-01T14:00:00.000Z");
    const boundary = new Date("2031-04-01T15:00:00.000Z");
    const end = new Date("2031-04-01T16:00:00.000Z");
    await inSchool(school.id, async () => {
      for (const [suffix, timestamp] of [["start", start], ["boundary", boundary], ["end-minus", new Date(end.getTime() - 1)]] as const) {
        const dbTimestamp = timestamp.toISOString().slice(0, 23).replace("T", " ");
        await db.execute(sql`
          INSERT INTO heartbeats (
            device_id, student_id, student_email, school_id,
            active_tab_title, active_tab_url, timestamp
          ) VALUES (
            ${`${TAG}-${suffix}`}, ${studentOne.id}, ${studentOne.email}, ${school.id},
            ${suffix}, 'https://example.edu', ${dbTimestamp}
          )
        `);
      }
    });
    const first = await inSchool(school.id, () =>
      storage.getHeartbeatsForStudentsInRange(school.id, [studentOne.id], start, boundary)
    );
    const second = await inSchool(school.id, () =>
      storage.getHeartbeatsForStudentsInRange(school.id, [studentOne.id], boundary, end)
    );
    assert.deepEqual(first.map((heartbeat: any) => heartbeat.activeTabTitle), ["start"]);
    assert.deepEqual(second.map((heartbeat: any) => heartbeat.activeTabTitle), ["boundary", "end-minus"]);
  });

  it("keeps summary roster and heartbeat reads explicitly tenant-scoped even under system access", async () => {
    const foreignSchool = await storage.createSchool({
      name: `${TAG}_Foreign_Summary_School`,
      domain: `${TAG}-foreign.example.edu`,
      slug: `${TAG}-foreign`,
      schoolTimezone: "America/New_York",
    } as any);
    try {
      const foreignStudent = await inSchool(foreignSchool.id, () => storage.createStudent({
        schoolId: foreignSchool.id,
        firstName: "Foreign",
        lastName: "Student",
        email: `foreign-student@${TAG}-foreign.example.edu`,
        emailLc: `foreign-student@${TAG}-foreign.example.edu`,
        status: "active",
      } as any));
      const group = await createClass({ name: "tenant_scoped_summary", roster: [studentOne] });
      const session = await inSchool(school.id, () =>
        storage.createTeachingSession({ groupId: group.id, teacherId: teacher.id } as any)
      );
      const start = new Date("2031-04-02T14:00:00.000Z");
      const end = new Date("2031-04-02T15:00:00.000Z");
      await asSystem(async () => {
        await db.execute(sql`
          INSERT INTO heartbeats (
            device_id, student_id, student_email, school_id,
            active_tab_title, active_tab_url, timestamp
          ) VALUES
            (${`${TAG}-tenant-main`}, ${studentOne.id}, ${studentOne.email}, ${school.id},
             'main', 'https://main.example.edu', '2031-04-02 14:10:00'),
            (${`${TAG}-tenant-foreign`}, ${foreignStudent.id}, ${foreignStudent.email}, ${foreignSchool.id},
             'foreign', 'https://foreign.example.edu', '2031-04-02 14:10:00')
        `);
      });

      const wrongSchoolRoster = await asSystem(() =>
        storage.getClasspilotSessionStudentRoster(foreignSchool.id, session.id)
      );
      const mainHeartbeatRead = await asSystem(() =>
        storage.getHeartbeatsForStudentsInRange(
          school.id,
          [studentOne.id, foreignStudent.id],
          start,
          end
        )
      );
      const foreignHeartbeatRead = await asSystem(() =>
        storage.getHeartbeatsForStudentsInRange(
          foreignSchool.id,
          [studentOne.id, foreignStudent.id],
          start,
          end
        )
      );

      assert.deepEqual(wrongSchoolRoster, []);
      assert.deepEqual(mainHeartbeatRead.map((row: any) => row.activeTabTitle), ["main"]);
      assert.deepEqual(foreignHeartbeatRead.map((row: any) => row.activeTabTitle), ["foreign"]);
    } finally {
      await asSystem(async () => {
        await db.execute(sql`DELETE FROM heartbeats WHERE school_id = ${foreignSchool.id}`);
        await db.execute(sql`DELETE FROM students WHERE school_id = ${foreignSchool.id}`);
        await db.execute(sql`DELETE FROM settings WHERE school_id = ${foreignSchool.id}`);
        await db.execute(sql`DELETE FROM schools WHERE id = ${foreignSchool.id}`);
      });
    }
  });

  it("adopts only open legacy scheduled reports and never mails already-ended historical rows", async () => {
    await setCentralRecipient(null);
    const openGroup = await createClass({ name: "legacy_open", scheduled: true });
    const openConflict = await inSchool(school.id, () => storage.upsertScheduledClassConflict({
      schoolId: school.id,
      groupId: openGroup.id,
      teacherId: teacher.id,
      scheduledDate: "2031-05-05",
      blockStartTime: "09:00",
      blockEndTime: "10:00",
      status: "coverage_needed",
      conflictPayload: {},
      scheduledTeacherConnected: false,
    } as any));
    const openLegacy = await inSchool(school.id, () => storage.createTeachingSession({
      groupId: openGroup.id,
      teacherId: teacher.id,
      sessionMode: "scheduled_report",
      scheduledConflictId: openConflict.id,
      startTime: new Date("2031-05-05T14:05:00.000Z"),
    } as any));

    const endedGroup = await createClass({ name: "legacy_ended", scheduled: true });
    const endedConflict = await inSchool(school.id, () => storage.upsertScheduledClassConflict({
      schoolId: school.id,
      groupId: endedGroup.id,
      teacherId: teacher.id,
      scheduledDate: "2031-05-06",
      blockStartTime: "09:00",
      blockEndTime: "10:00",
      status: "expired",
      conflictPayload: {},
      scheduledTeacherConnected: false,
    } as any));
    const endedLegacy = await inSchool(school.id, () => storage.createTeachingSession({
      groupId: endedGroup.id,
      teacherId: teacher.id,
      sessionMode: "scheduled_report",
      scheduledConflictId: endedConflict.id,
      startTime: new Date("2031-05-06T14:00:00.000Z"),
    } as any));
    await inSchool(school.id, () => storage.endTeachingSession(endedLegacy.id));

    const adopted = await asSystem(() => storage.reconcileLegacyOpenScheduledSessions());
    assert.ok(adopted.some((session: any) => session.id === openLegacy.id));
    assert.ok(!adopted.some((session: any) => session.id === endedLegacy.id));
    const openCanonical = await inSchool(school.id, () => storage.getTeachingSessionById(openLegacy.id));
    assert.equal(openCanonical.scheduledDate, "2031-05-05");
    assert.equal(openCanonical.scheduledState, "active");
    assert.equal(openCanonical.scheduledStartAt.toISOString(), "2031-05-05T13:00:00.000Z");
    assert.equal(openCanonical.scheduledEndAt.toISOString(), "2031-05-05T14:00:00.000Z");
    const historical = await inSchool(school.id, () => storage.getTeachingSessionById(endedLegacy.id));
    assert.equal(historical.scheduledDate, null);
    assert.equal((await deliveryRows(endedLegacy.id)).length, 0);

    await inSchool(school.id, () => lifecycle.finalizeClasspilotSession({
      schoolId: school.id,
      sessionId: openLegacy.id,
      reason: "scheduled_end",
      finalizedAt: new Date("2031-05-05T14:01:00.000Z"),
    }));
    assert.equal((await deliveryRows(openLegacy.id)).length, 1);
    assert.equal((await deliveryRows(endedLegacy.id)).length, 0);
  });

  it("terminally cleans a duplicate legacy row when its canonical scheduled occurrence already exists", async () => {
    await setCentralRecipient(null);
    const group = await createClass({
      name: "legacy_duplicate_canonical_present",
      scheduled: true,
      roster: [studentOne],
    });
    const scheduledDate = "2031-05-12";
    const canonical = await inSchool(school.id, () => storage.createOrReuseScheduledReportSession({
      schoolId: school.id,
      groupId: group.id,
      teacherId: teacher.id,
      scheduledDate,
      scheduledTimezone: "America/New_York",
      scheduledStartAt: new Date("2031-05-12T13:00:00.000Z"),
      scheduledEndAt: new Date("2031-05-12T14:00:00.000Z"),
      scheduledTeacherEmail: teacher.email,
      scheduledTeacherName: "Terry Teacher",
    }));
    const conflict = await inSchool(school.id, () => storage.upsertScheduledClassConflict({
      schoolId: school.id,
      groupId: group.id,
      teacherId: teacher.id,
      scheduledDate,
      blockStartTime: "09:00",
      blockEndTime: "10:00",
      status: "coverage_needed",
      conflictPayload: {},
      scheduledTeacherConnected: false,
    } as any));
    const duplicate = await inSchool(school.id, () => storage.createTeachingSession({
      groupId: group.id,
      teacherId: teacher.id,
      sessionMode: "scheduled_report",
      scheduledConflictId: conflict.id,
      startTime: new Date("2031-05-12T13:05:00.000Z"),
    } as any));
    const seeded = await inSchool(school.id, async () => {
      await db.execute(sql`
        INSERT INTO classpilot_classroom_states (
          school_id, teaching_session_id, student_id, state_type, state_key, payload, applied_by
        ) VALUES (
          ${school.id}, ${duplicate.id}, ${studentOne.id}, 'screen_lock', 'legacy-duplicate',
          '{}'::jsonb, ${teacher.id}
        )
      `);
      await db.execute(sql`
        INSERT INTO devices (device_id, device_name, school_id, class_id)
        VALUES (
          ${`${TAG}-legacy-duplicate-hand`}, 'Legacy duplicate hand fixture', ${school.id}, ${group.id}
        )
      `);
      await db.execute(sql`
        INSERT INTO classpilot_active_hands (
          school_id, teaching_session_id, student_id, device_id
        ) VALUES (
          ${school.id}, ${duplicate.id}, ${studentOne.id}, ${`${TAG}-legacy-duplicate-hand`}
        )
      `);
      const context = await db.execute(sql`
        INSERT INTO classpilot_supervision_contexts (
          school_id, context_type, name, status, assigned_staff_id,
          scheduled_conflict_id, created_by, ends_at
        ) VALUES (
          ${school.id}, 'scheduled_coverage', 'Legacy duplicate coverage', 'active',
          ${centralRecipient.id}, ${conflict.id}, ${centralRecipient.id},
          '2031-05-12 14:00:00+00'
        )
        RETURNING id
      `);
      await db.execute(sql`
        INSERT INTO classpilot_supervision_students (
          school_id, context_id, student_id, source, assigned_by
        ) VALUES (
          ${school.id}, ${context.rows[0].id}, ${studentOne.id},
          'scheduled_coverage_claim', ${centralRecipient.id}
        )
      `);
      return context.rows[0].id as string;
    });

    const reconciliationNow = new Date("2031-05-12T13:10:00.000Z");
    const adopted = await asSystem(() => storage.reconcileLegacyOpenScheduledSessions(
      reconciliationNow
    ));
    assert.ok(!adopted.some((session: any) => session.id === duplicate.id));

    const terminal = await inSchool(school.id, () => db.execute(sql`
      SELECT
        duplicate.end_time::text AS duplicate_end_time_text,
        duplicate.scheduled_finalization_reason,
        canonical.end_time AS canonical_end_time,
        canonical.scheduled_state AS canonical_state,
        classroom.cleared_at AS classroom_cleared_at,
        hand.cleared_at AS hand_cleared_at,
        conflict.status AS conflict_status,
        conflict.resolution AS conflict_resolution,
        context.status AS context_status,
        assignment.released_at,
        assignment.release_reason
      FROM teaching_sessions duplicate
      JOIN teaching_sessions canonical ON canonical.id = ${canonical.id}
      JOIN classpilot_classroom_states classroom
        ON classroom.teaching_session_id = duplicate.id
       AND classroom.school_id = duplicate.school_id
      JOIN classpilot_active_hands hand
        ON hand.teaching_session_id = duplicate.id
       AND hand.school_id = duplicate.school_id
      JOIN classpilot_scheduled_conflicts conflict ON conflict.id = ${conflict.id}
      JOIN classpilot_supervision_contexts context ON context.id = ${seeded}
      JOIN classpilot_supervision_students assignment ON assignment.context_id = context.id
      WHERE duplicate.id = ${duplicate.id}
        AND duplicate.school_id = ${school.id}
    `));
    assert.equal(terminal.rows.length, 1);
    const state = terminal.rows[0];
    assert.equal(
      new Date(`${String(state.duplicate_end_time_text).replace(" ", "T")}Z`).toISOString(),
      reconciliationNow.toISOString()
    );
    assert.equal(state.scheduled_finalization_reason, "scheduled_end");
    assert.equal(state.canonical_end_time, null);
    assert.equal(state.canonical_state, "active");
    assert.ok(state.classroom_cleared_at);
    assert.ok(state.hand_cleared_at);
    assert.equal(state.conflict_status, "ended");
    assert.equal(state.conflict_resolution, "scheduled_end");
    assert.equal(state.context_status, "ended");
    assert.ok(state.released_at);
    assert.equal(state.release_reason, "scheduled_end");
    assert.equal((await deliveryRows(duplicate.id)).length, 0);

    await inSchool(school.id, () => lifecycle.finalizeClasspilotSession({
      schoolId: school.id,
      sessionId: canonical.id,
      reason: "teacher_end",
      finalizedAt: new Date("2031-05-12T13:20:00.000Z"),
    }));
  });

  it("derives a prior-date no-conflict legacy occurrence from startTime and finalizes it without consulting today's schedule", async () => {
    await setCentralRecipient(null);
    const group = await createClass({ name: "legacy_prior_date_no_conflict", scheduled: true });
    const legacy = await inSchool(school.id, () => storage.createTeachingSession({
      groupId: group.id,
      teacherId: teacher.id,
      sessionMode: "live",
      startTime: new Date("2031-05-07T13:15:00.000Z"),
    } as any));

    await scheduler.reconcileClasspilotScheduledSessions(new Date("2031-05-08T16:00:00.000Z"));

    const recovered = await inSchool(school.id, () => storage.getTeachingSessionById(legacy.id));
    assert.equal(recovered.scheduledDate, "2031-05-07");
    assert.equal(recovered.scheduledStartAt.toISOString(), "2031-05-07T13:00:00.000Z");
    assert.equal(recovered.scheduledEndAt.toISOString(), "2031-05-07T14:00:00.000Z");
    assert.equal(recovered.startTime.toISOString(), "2031-05-07T13:00:00.000Z");
    assert.equal(recovered.endTime.toISOString(), "2031-05-07T14:00:00.000Z");
    assert.equal(recovered.scheduledState, "finalized");
    assert.equal(recovered.scheduledFinalizationReason, "scheduled_end");
    const legacyDeliveries = await deliveryRows(legacy.id);
    assert.equal(legacyDeliveries.length, 1);
    assert.equal(legacyDeliveries[0].state, "sent");
  });

  it("keeps pre-start Skip Today atomic with occurrence creation and never emits a skipped summary", async () => {
    await setCentralRecipient(null);
    const group = await createClass({ name: "skip_race", scheduled: true, start: "10:00", end: "11:00" });
    const scheduledDate = "2031-06-02";
    const [skipResult, startResult] = await Promise.all([
      inSchool(school.id, () => scheduled.skipScheduledClassBeforeStart({
        group,
        scheduledDate,
        now: new Date("2031-06-02T13:59:59.999Z"),
      })),
      inSchool(school.id, () => scheduled.processScheduledClassAutoStart({
        group,
        scheduledDate,
        scheduledTeacherConnectedOverride: false,
        now: new Date("2031-06-02T14:00:00.000Z"),
      })),
    ]);
    assert.equal(await occurrenceCount(group.id, scheduledDate), 1);
    const occurrence = await inSchool(school.id, () =>
      storage.getScheduledTeachingSessionOccurrence(school.id, group.id, scheduledDate)
    );
    assert.ok(occurrence);
    if (occurrence.scheduledState === "skipped") {
      assert.equal(skipResult.skipped, true);
      assert.equal(startResult.status, "skipped");
      assert.equal((await deliveryRows(occurrence.id)).length, 0);
      assert.equal(occurrence.endTime.toISOString(), occurrence.scheduledStartAt.toISOString());
    } else {
      assert.equal(skipResult.skipped, false);
      assert.ok(["coverage_needed", "claimed", "started"].includes(startResult.status));
      await inSchool(school.id, () => lifecycle.finalizeClasspilotSession({
        schoolId: school.id,
        sessionId: occurrence.id,
        reason: "teacher_end",
        finalizedAt: new Date("2031-06-02T14:05:00.000Z"),
      }));
      assert.equal((await deliveryRows(occurrence.id)).length, 1);
    }
  });

  it("holds 120 bell-time recipients through settlement, then drains them exactly once", async () => {
    const volumeSchool = await storage.createSchool({
      name: `${TAG}_Bell_Volume_School`,
      domain: `${TAG}-volume.example.edu`,
      slug: `${TAG}-volume`,
      schoolTimezone: "America/New_York",
    } as any);
    const volumeCentral = await storage.createUser({
      email: `central@${TAG}-volume.example.edu`,
      firstName: "Bell",
      lastName: "Central",
    } as any);
    const volumeTeacher = await storage.createUser({
      email: `teacher@${TAG}-volume.example.edu`,
      firstName: "Bell",
      lastName: "Teacher",
    });
    await storage.createProductLicense({
      schoolId: volumeSchool.id,
      product: "CLASSPILOT",
      status: "active",
    } as any);
    const bellTime = new Date("2031-06-03T15:00:00.000Z");
    try {
      await storage.createMembership({
        userId: volumeCentral.id,
        schoolId: volumeSchool.id,
        role: "admin",
        status: "active",
      } as any);
      await storage.createMembership({
        userId: volumeTeacher.id,
        schoolId: volumeSchool.id,
        role: "teacher",
        status: "active",
      });
      await inSchool(volumeSchool.id, () => storage.updateEnrollmentSettings(
        volumeSchool.id,
        { centralEmailRecipientUserId: volumeCentral.id } as any
      ));
      const sessions = await inSchool(volumeSchool.id, async () => {
        const created: any[] = [];
        for (let index = 0; index < 60; index++) {
          const group = await storage.createGroup({
            schoolId: volumeSchool.id,
            teacherId: volumeTeacher.id,
            name: `${TAG}_bell_${index}`,
            groupType: "admin_class",
            status: "active",
          } as any);
          created.push(await storage.createTeachingSession({
            groupId: group.id,
            teacherId: volumeTeacher.id,
            startTime: new Date(bellTime.getTime() - 45 * 60_000),
          } as any));
        }
        return created;
      });
      for (let offset = 0; offset < sessions.length; offset += 20) {
        await Promise.all(sessions.slice(offset, offset + 20).map((session: any) =>
          inSchool(volumeSchool.id, () => lifecycle.finalizeClasspilotSession({
            schoolId: volumeSchool.id,
            sessionId: session.id,
            reason: "manual_end",
            finalizedAt: bellTime,
          }))
        ));
      }

      const queued = await inSchool(volumeSchool.id, () => db.execute(sql`
        SELECT id, state
        FROM classpilot_session_summary_deliveries
        WHERE school_id = ${volumeSchool.id}
        ORDER BY id
      `));
      assert.equal(queued.rows.length, 120);
      assert.ok(queued.rows.every((row: any) => row.state === "waiting_report"));
      const expectedDeliveryIds = new Set(queued.rows.map((row: any) => row.id));
      const messageStart = sentMessages.length;

      await scheduler.reconcileClasspilotScheduledSessions(bellTime, volumeSchool.id);
      const beforeSettlement = await inSchool(volumeSchool.id, () => db.execute(sql`
        SELECT state
        FROM classpilot_session_summary_deliveries
        WHERE school_id = ${volumeSchool.id}
      `));
      assert.ok(beforeSettlement.rows.every((row: any) => row.state === "waiting_report"));
      assert.equal(sentMessages.length, messageStart, "no bell-time delivery may bypass report settlement");

      await scheduler.reconcileClasspilotScheduledSessions(
        new Date(bellTime.getTime() + 30_000),
        volumeSchool.id
      );

      const rows = await inSchool(volumeSchool.id, () => db.execute(sql`
        SELECT id, state
        FROM classpilot_session_summary_deliveries
        WHERE school_id = ${volumeSchool.id}
        ORDER BY id
      `));
      assert.equal(rows.rows.length, 120);
      assert.ok(rows.rows.every((row: any) => row.state === "sent"));
      const submittedIds = sentMessages
        .slice(messageStart)
        .map((message) => message.customArgs?.classpilot_summary_delivery_id)
        .filter((id): id is string => expectedDeliveryIds.has(id));
      assert.equal(submittedIds.length, 120);
      assert.equal(new Set(submittedIds).size, 120);
    } finally {
      await asSystem(async () => {
        await db.execute(sql`DELETE FROM classpilot_session_summary_deliveries WHERE school_id = ${volumeSchool.id}`);
        await db.execute(sql`DELETE FROM classpilot_monitoring_events WHERE school_id = ${volumeSchool.id}`);
        await db.execute(sql`DELETE FROM classpilot_session_student_reports WHERE school_id = ${volumeSchool.id}`);
        await db.execute(sql`DELETE FROM classpilot_session_reports WHERE school_id = ${volumeSchool.id}`);
        await db.execute(sql`DELETE FROM classpilot_session_staff WHERE school_id = ${volumeSchool.id}`);
        await db.execute(sql`DELETE FROM classpilot_student_control_states WHERE school_id = ${volumeSchool.id}`);
        await db.execute(sql`DELETE FROM classpilot_session_students WHERE school_id = ${volumeSchool.id}`);
        await db.execute(sql`DELETE FROM teaching_sessions WHERE school_id = ${volumeSchool.id}`);
        await db.execute(sql`DELETE FROM group_students WHERE group_id IN (SELECT id FROM groups WHERE school_id = ${volumeSchool.id})`);
        await db.execute(sql`DELETE FROM group_teachers WHERE group_id IN (SELECT id FROM groups WHERE school_id = ${volumeSchool.id})`);
        await db.execute(sql`DELETE FROM groups WHERE school_id = ${volumeSchool.id}`);
        await db.execute(sql`DELETE FROM settings WHERE school_id = ${volumeSchool.id}`);
        await db.execute(sql`DELETE FROM product_licenses WHERE school_id = ${volumeSchool.id}`);
        await db.execute(sql`DELETE FROM school_memberships WHERE school_id = ${volumeSchool.id}`);
        await db.execute(sql`DELETE FROM schools WHERE id = ${volumeSchool.id}`);
        await db.execute(sql`DELETE FROM users WHERE id = ${volumeCentral.id}`);
        await db.execute(sql`DELETE FROM users WHERE id = ${volumeTeacher.id}`);
      });
    }
  });

  it("allows concurrent End Class and reconcilers to produce one finalization and one delivery per recipient", async () => {
    await setCentralRecipient(centralRecipient.id);
    const group = await createClass({ name: "concurrent_finalize", scheduled: true });
    const occurrence = await inSchool(school.id, () => storage.createOrReuseScheduledReportSession({
      schoolId: school.id,
      groupId: group.id,
      teacherId: teacher.id,
      scheduledDate: "2031-01-12",
      scheduledTimezone: "America/New_York",
      scheduledStartAt: new Date("2031-01-12T14:00:00.000Z"),
      scheduledEndAt: new Date("2031-01-12T15:00:00.000Z"),
      scheduledTeacherEmail: teacher.email,
      scheduledTeacherName: "Terry Teacher",
    }));
    await Promise.all([
      inSchool(school.id, () => lifecycle.finalizeClasspilotSession({
        schoolId: school.id,
        sessionId: occurrence.id,
        reason: "teacher_end",
        finalizedAt: new Date("2031-01-12T15:00:00.000Z"),
      })),
      scheduler.reconcileClasspilotScheduledSessions(new Date("2031-01-12T15:00:00.000Z")),
      scheduler.reconcileClasspilotScheduledSessions(new Date("2031-01-12T15:00:00.000Z")),
    ]);
    const finalized = await inSchool(school.id, () => storage.getTeachingSessionById(occurrence.id));
    assert.equal(finalized.endTime.toISOString(), "2031-01-12T15:00:00.000Z");
    assert.equal(finalized.scheduledState, "finalized");
    assert.equal(await occurrenceCount(group.id, "2031-01-12"), 1);
    const deliveries = await deliveryRows(occurrence.id);
    assert.deepEqual(deliveries.map((row) => row.recipient_kind), ["central", "teacher"]);
    assert.equal(new Set(deliveries.map((row) => row.recipient_email.toLowerCase())).size, 2);
  });
});
