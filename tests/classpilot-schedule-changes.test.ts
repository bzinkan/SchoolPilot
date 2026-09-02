import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { sql } from "drizzle-orm";

const TAG = `cp_schedule_changes_${Date.now()}`;
const ORIGINAL_REDIS_URL = process.env.REDIS_URL;
const ORIGINAL_SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
process.env.REDIS_URL = "";
delete process.env.SENDGRID_API_KEY;
process.env.NODE_ENV = "test";

let db: any;
let pool: any;
let sessionPool: any;
let schedulerPool: any;
let schedulerLockPool: any;
let storage: any;
let runWithTenantContext: any;
let signUserToken: any;
let server: Server;
let baseUrl: string;

let schoolA: any;
let schoolB: any;
let admin: any;
let teacherA: any;
let teacherB: any;
let teacherC: any;
let office: any;
let firstGroup: any;
let secondGroup: any;
let pairId: string;
let approvedChangeId: string;

function inSchool<T>(schoolId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ schoolId }, fn);
}

function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuper: true }, fn);
}

function headersFor(user: any, schoolId = schoolA.id): Record<string, string> {
  return {
    authorization: `Bearer ${signUserToken({
      userId: user.id,
      email: user.email,
      isSuperAdmin: false,
    })}`,
    "x-school-id": schoolId,
  };
}

async function requestJson(
  method: string,
  path: string,
  user: any,
  body?: unknown,
  schoolId = schoolA.id
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...headersFor(user, schoolId),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function createScheduledClass(options: {
  name: string;
  teacherId: string;
  start: string;
  end: string;
  schoolId?: string;
}): Promise<any> {
  const schoolId = options.schoolId ?? schoolA.id;
  return inSchool(schoolId, () => storage.createGroup({
    schoolId,
    teacherId: options.teacherId,
    name: `${TAG}_${options.name}`,
    groupType: "admin_class",
    status: "active",
    scheduleEnabled: true,
    blockStartTime: options.start,
    blockEndTime: options.end,
  }));
}

async function cleanupSchool(schoolId: string): Promise<void> {
  await asSystem(() => db.transaction(async (tx: any) => {
    await tx.execute(sql`DELETE FROM classpilot_schedule_change_legs WHERE school_id = ${schoolId}`);
    await tx.execute(sql`DELETE FROM classpilot_schedule_changes WHERE school_id = ${schoolId}`);
    await tx.execute(sql`DELETE FROM classpilot_schedule_change_pairs WHERE school_id = ${schoolId}`);
    await tx.execute(sql`DELETE FROM audit_logs WHERE school_id = ${schoolId}`);
    await tx.execute(sql`DELETE FROM classpilot_session_summary_deliveries WHERE school_id = ${schoolId}`);
    await tx.execute(sql`DELETE FROM classpilot_session_students WHERE school_id = ${schoolId}`);
    await tx.execute(sql`DELETE FROM classpilot_session_staff WHERE school_id = ${schoolId}`);
    await tx.execute(sql`DELETE FROM teaching_sessions WHERE school_id = ${schoolId}`);
    await tx.execute(sql`DELETE FROM group_students WHERE group_id IN (SELECT id FROM groups WHERE school_id = ${schoolId})`);
    await tx.execute(sql`DELETE FROM group_teachers WHERE group_id IN (SELECT id FROM groups WHERE school_id = ${schoolId})`);
    await tx.execute(sql`DELETE FROM groups WHERE school_id = ${schoolId}`);
    await tx.execute(sql`DELETE FROM students WHERE school_id = ${schoolId}`);
    await tx.execute(sql`DELETE FROM product_licenses WHERE school_id = ${schoolId}`);
    await tx.execute(sql`DELETE FROM school_memberships WHERE school_id = ${schoolId}`);
    await tx.execute(sql`DELETE FROM settings WHERE school_id = ${schoolId}`);
    await tx.execute(sql`DELETE FROM schools WHERE id = ${schoolId}`);
  }));
}

before(async () => {
  const dbModule = await import("../dist/db.js");
  db = dbModule.default;
  pool = dbModule.pool;
  sessionPool = dbModule.sessionPool;
  storage = await import("../dist/services/storage.js");
  ({ runWithTenantContext } = await import("../dist/middleware/tenantContext.js"));
  ({ signUserToken } = await import("../dist/services/jwt.js"));
  const schedulerDbModule = await import("../dist/services/schedulerDb.js");
  schedulerPool = schedulerDbModule.schedulerPool;
  schedulerLockPool = schedulerDbModule.schedulerLockPool;

  schoolA = await storage.createSchool({
    name: `${TAG} School A`,
    domain: `${TAG}.example.edu`,
    slug: `${TAG}-a`,
    schoolTimezone: "America/New_York",
  });
  schoolB = await storage.createSchool({
    name: `${TAG} School B`,
    domain: `${TAG}.example.edu`,
    slug: `${TAG}-b`,
    schoolTimezone: "America/New_York",
  });
  [admin, teacherA, teacherB, teacherC, office] = await Promise.all([
    storage.createUser({ email: `admin@${TAG}.example.edu`, firstName: "Alex", lastName: "Admin" }),
    storage.createUser({ email: `teacher-a@${TAG}.example.edu`, firstName: "Avery", lastName: "Math" }),
    storage.createUser({ email: `teacher-b@${TAG}.example.edu`, firstName: "Blake", lastName: "ELA" }),
    storage.createUser({ email: `teacher-c@${TAG}.example.edu`, firstName: "Casey", lastName: "Other" }),
    storage.createUser({ email: `office@${TAG}.example.edu`, firstName: "Oakley", lastName: "Office" }),
  ]);
  for (const [user, role] of [
    [admin, "admin"],
    [teacherA, "teacher"],
    [teacherB, "teacher"],
    [teacherC, "teacher"],
    [office, "office_staff"],
  ] as const) {
    await storage.createMembership({ userId: user.id, schoolId: schoolA.id, role, status: "active" });
  }
  // The same administrator is authorized in school B so a school-B request
  // for a school-A identifier proves tenant non-enumeration, not auth failure.
  await storage.createMembership({
    userId: admin.id,
    schoolId: schoolB.id,
    role: "admin",
    status: "active",
  });
  await storage.createProductLicense({ schoolId: schoolA.id, product: "CLASSPILOT", status: "active" });
  await storage.createProductLicense({ schoolId: schoolB.id, product: "CLASSPILOT", status: "active" });
  await storage.upsertSettings(schoolA.id, { schoolName: schoolA.name, wsSharedKey: "" });
  await storage.upsertSettings(schoolB.id, { schoolName: schoolB.name, wsSharedKey: "" });

  firstGroup = await createScheduledClass({
    name: "Seventh Math",
    teacherId: teacherA.id,
    start: "09:00",
    end: "10:00",
  });
  secondGroup = await createScheduledClass({
    name: "Eighth ELA",
    teacherId: teacherB.id,
    start: "10:00",
    end: "11:00",
  });

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
    if (schoolA?.id) await cleanupSchool(schoolA.id);
    if (schoolB?.id) await cleanupSchool(schoolB.id);
    await asSystem(() => db.execute(sql`DELETE FROM users WHERE email LIKE ${`%@${TAG}.example.edu`}`));
  } finally {
    await schedulerLockPool?.end().catch(() => undefined);
    await schedulerPool?.end().catch(() => undefined);
    await sessionPool?.end().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    if (ORIGINAL_REDIS_URL === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = ORIGINAL_REDIS_URL;
    if (ORIGINAL_SENDGRID_API_KEY === undefined) delete process.env.SENDGRID_API_KEY;
    else process.env.SENDGRID_API_KEY = ORIGINAL_SENDGRID_API_KEY;
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  }
});

describe("ClassPilot schedule-change API and storage workflow", { concurrency: false }, () => {
  it("defaults requests off, restricts policy writes, and resolves revision conflicts", async () => {
    const initial = await requestJson(
      "GET",
      "/classpilot/schedule-changes/settings",
      teacherA
    );
    assert.equal(initial.status, 200);
    assert.deepEqual(
      {
        teacherRequestsEnabled: initial.body.teacherRequestsEnabled,
        adminApprovalRequired: initial.body.adminApprovalRequired,
        sameDayCutoff: initial.body.sameDayCutoff,
        sameDayCutoffEnforced: initial.body.sameDayCutoffEnforced,
        reasonRequired: initial.body.reasonRequired,
        revision: initial.body.revision,
      },
      {
        teacherRequestsEnabled: false,
        adminApprovalRequired: true,
        sameDayCutoff: "07:00",
        sameDayCutoffEnforced: true,
        reasonRequired: true,
        revision: 0,
      }
    );

    const otherSchoolInitial = await requestJson(
      "GET",
      "/classpilot/schedule-changes/settings",
      admin,
      undefined,
      schoolB.id
    );
    assert.equal(otherSchoolInitial.status, 200);
    assert.equal(otherSchoolInitial.body.sameDayCutoffEnforced, true);
    assert.equal(otherSchoolInitial.body.reasonRequired, true);

    const teacherWrite = await requestJson(
      "PATCH",
      "/classpilot/schedule-changes/settings",
      teacherA,
      { expectedRevision: 0, teacherRequestsEnabled: true }
    );
    assert.equal(teacherWrite.status, 403);

    const saved = await requestJson(
      "PATCH",
      "/classpilot/schedule-changes/settings",
      admin,
      { expectedRevision: 0, teacherRequestsEnabled: true }
    );
    assert.equal(saved.status, 200);
    assert.equal(saved.body.teacherRequestsEnabled, true);
    assert.equal(saved.body.revision, 1);

    const toggled = await requestJson(
      "PATCH",
      "/classpilot/schedule-changes/settings",
      admin,
      {
        expectedRevision: 1,
        sameDayCutoffEnforced: false,
        reasonRequired: false,
      }
    );
    assert.equal(toggled.status, 200);
    assert.equal(toggled.body.sameDayCutoffEnforced, false);
    assert.equal(toggled.body.reasonRequired, false);
    assert.equal(toggled.body.sameDayCutoff, "07:00");
    assert.equal(toggled.body.revision, 2);

    const audit = await inSchool(schoolA.id, () => db.execute(sql`
      SELECT changes, metadata
      FROM audit_logs
      WHERE school_id = ${schoolA.id}
        AND action = 'classpilot.schedule_change.settings_updated'
      ORDER BY created_at DESC
      LIMIT 1
    `));
    assert.deepEqual(audit.rows[0]?.changes, {
      fields: ["sameDayCutoffEnforced", "reasonRequired"],
    });
    assert.deepEqual(audit.rows[0]?.metadata, { revision: 2 });

    const restored = await requestJson(
      "PATCH",
      "/classpilot/schedule-changes/settings",
      admin,
      {
        expectedRevision: 2,
        sameDayCutoffEnforced: true,
        reasonRequired: true,
      }
    );
    assert.equal(restored.status, 200);
    assert.equal(restored.body.sameDayCutoffEnforced, true);
    assert.equal(restored.body.reasonRequired, true);
    assert.equal(restored.body.revision, 3);

    const invalidCutoffPolicy = await requestJson(
      "PATCH",
      "/classpilot/schedule-changes/settings",
      admin,
      { expectedRevision: 3, sameDayCutoffEnforced: "false" }
    );
    assert.equal(invalidCutoffPolicy.status, 400);
    assert.equal(invalidCutoffPolicy.body.code, "INVALID_SCHEDULE_CHANGE_CUTOFF_POLICY");

    const invalidReasonPolicy = await requestJson(
      "PATCH",
      "/classpilot/schedule-changes/settings",
      admin,
      { expectedRevision: 3, reasonRequired: null }
    );
    assert.equal(invalidReasonPolicy.status, 400);
    assert.equal(invalidReasonPolicy.body.code, "INVALID_SCHEDULE_CHANGE_REASON_POLICY");

    const otherSchoolToggle = await requestJson(
      "PATCH",
      "/classpilot/schedule-changes/settings",
      admin,
      { expectedRevision: 0, reasonRequired: false },
      schoolB.id
    );
    assert.equal(otherSchoolToggle.status, 200);
    assert.equal(otherSchoolToggle.body.reasonRequired, false);
    const schoolAUnchanged = await requestJson(
      "GET",
      "/classpilot/schedule-changes/settings",
      admin
    );
    assert.equal(schoolAUnchanged.body.reasonRequired, true);
    const otherSchoolRestore = await requestJson(
      "PATCH",
      "/classpilot/schedule-changes/settings",
      admin,
      { expectedRevision: 1, reasonRequired: true },
      schoolB.id
    );
    assert.equal(otherSchoolRestore.status, 200);

    const stale = await requestJson(
      "PATCH",
      "/classpilot/schedule-changes/settings",
      admin,
      { expectedRevision: 0, sameDayCutoff: "06:30" }
    );
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "SCHEDULE_CHANGE_REVISION_CONFLICT");
    assert.equal(stale.body.current.revision, 3);
  });

  it("normalizes reversed pairs and completes teacher request, counterpart acceptance, and admin approval", async () => {
    const createdPair = await requestJson(
      "POST",
      "/classpilot/schedule-changes/pairs",
      admin,
      { firstGroupId: secondGroup.id, secondGroupId: firstGroup.id }
    );
    assert.equal(createdPair.status, 201);
    pairId = createdPair.body.id;
    assert.ok(pairId);

    const reversedRetry = await requestJson(
      "POST",
      "/classpilot/schedule-changes/pairs",
      admin,
      { firstGroupId: firstGroup.id, secondGroupId: secondGroup.id }
    );
    assert.equal(reversedRetry.status, 201);
    assert.equal(reversedRetry.body.id, pairId);

    const requested = await requestJson(
      "POST",
      "/classpilot/schedule-changes",
      teacherA,
      {
        pairId,
        scheduledDate: "2099-05-04",
        reason: "One-day event schedule",
      }
    );
    assert.equal(requested.status, 201);
    assert.equal(requested.body.status, "pending_counterpart");
    assert.equal(requested.body.revision, 0);
    approvedChangeId = requested.body.id;

    const unrelated = await requestJson(
      "POST",
      `/classpilot/schedule-changes/${approvedChangeId}/actions`,
      teacherC,
      { action: "accept", expectedRevision: 0 }
    );
    assert.equal(unrelated.status, 404);
    assert.equal(unrelated.body.code, "SCHEDULE_CHANGE_NOT_FOUND");

    const crossSchool = await requestJson(
      "POST",
      `/classpilot/schedule-changes/${approvedChangeId}/actions`,
      admin,
      { action: "approve", expectedRevision: 0 },
      schoolB.id
    );
    assert.equal(crossSchool.status, 404);
    assert.equal(crossSchool.body.code, "SCHEDULE_CHANGE_NOT_FOUND");

    const accepted = await requestJson(
      "POST",
      `/classpilot/schedule-changes/${approvedChangeId}/actions`,
      teacherB,
      { action: "accept", expectedRevision: 0 }
    );
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.status, "pending_admin");
    assert.equal(accepted.body.revision, 1);

    const staleApproval = await requestJson(
      "POST",
      `/classpilot/schedule-changes/${approvedChangeId}/actions`,
      admin,
      { action: "approve", expectedRevision: 0 }
    );
    assert.equal(staleApproval.status, 409);
    assert.equal(staleApproval.body.code, "SCHEDULE_CHANGE_REVISION_CONFLICT");

    const approved = await requestJson(
      "POST",
      `/classpilot/schedule-changes/${approvedChangeId}/actions`,
      admin,
      { action: "approve", expectedRevision: 1 }
    );
    assert.equal(approved.status, 200);
    assert.equal(approved.body.status, "approved");
    assert.equal(approved.body.revision, 2);
    assert.equal(approved.body.legs.length, 2);
    assert.deepEqual(
      approved.body.legs.map((leg: any) => [leg.normalWindow.startTime, leg.effectiveWindow.startTime]).sort(),
      [["09:00", "10:00"], ["10:00", "09:00"]].sort()
    );
  });

  it("supports admin-direct creation and blocks configuration edits while approved changes are future", async () => {
    const direct = await requestJson(
      "POST",
      "/classpilot/schedule-changes",
      admin,
      {
        pairId,
        scheduledDate: "2099-05-05",
        reason: "Administrator-created event change",
        directApprove: true,
      }
    );
    assert.equal(direct.status, 201);
    assert.equal(direct.body.status, "approved");

    await assert.rejects(
      () => inSchool(schoolA.id, () => storage.updateGroup(
        firstGroup.id,
        { blockStartTime: "08:30", blockEndTime: "09:30" },
        admin.id
      )),
      (error: any) => {
        assert.equal(error.code, "APPROVED_SCHEDULE_CHANGE_EXISTS");
        assert.equal(error.status, 409);
        return true;
      }
    );
    const unchanged = await inSchool(schoolA.id, () => storage.getGroupByIdAndSchool(
      firstGroup.id,
      schoolA.id
    ));
    assert.equal(unchanged.blockStartTime, "09:00");
    assert.equal(unchanged.blockEndTime, "10:00");

    await assert.rejects(
      () => asSystem(() => storage.softDeleteSchool(schoolA.id, admin.id)),
      (error: any) => {
        assert.equal(error.code, "APPROVED_SCHEDULE_CHANGE_EXISTS");
        assert.equal(error.status, 409);
        return true;
      }
    );
    const retainedSchool = await asSystem(() => storage.getSchoolById(schoolA.id));
    assert.equal(retainedSchool.deletedAt, null);
  });

  it("enforces the teacher cutoff only when enabled and always preserves the earliest-bell boundary", async () => {
    const initialPolicy = await requestJson(
      "GET",
      "/classpilot/schedule-changes/settings",
      admin
    );
    const cutoffOn = await requestJson(
      "PATCH",
      "/classpilot/schedule-changes/settings",
      admin,
      {
        expectedRevision: initialPolicy.body.revision,
        sameDayCutoff: "07:00",
        sameDayCutoffEnforced: true,
        reasonRequired: true,
      }
    );
    assert.equal(cutoffOn.status, 200);

    await assert.rejects(
      () => inSchool(schoolA.id, () => storage.createClasspilotScheduleChange({
        schoolId: schoolA.id,
        pairId,
        scheduledDate: "2099-05-25",
        reason: "Request after the policy cutoff",
        actor: { userId: teacherA.id, userEmail: teacherA.email, role: "teacher" },
        now: new Date("2099-05-25T12:00:00.000Z"),
      })),
      (error: any) => {
        assert.equal(error.code, "SCHEDULE_CHANGE_CUTOFF_PASSED");
        return true;
      }
    );

    const cutoffOff = await requestJson(
      "PATCH",
      "/classpilot/schedule-changes/settings",
      admin,
      {
        expectedRevision: cutoffOn.body.revision,
        sameDayCutoffEnforced: false,
      }
    );
    assert.equal(cutoffOff.status, 200);
    assert.equal(cutoffOff.body.sameDayCutoff, "07:00");
    const afterCutoff = await inSchool(schoolA.id, () =>
      storage.createClasspilotScheduleChange({
        schoolId: schoolA.id,
        pairId,
        scheduledDate: "2099-05-25",
        reason: "Same-day event before the first bell",
        actor: { userId: teacherA.id, userEmail: teacherA.email, role: "teacher" },
        now: new Date("2099-05-25T12:00:00.000Z"),
      })
    );
    assert.equal(afterCutoff.status, "pending_counterpart");

    await assert.rejects(
      () => inSchool(schoolA.id, () => storage.createClasspilotScheduleChange({
        schoolId: schoolA.id,
        pairId,
        scheduledDate: "2099-05-26",
        reason: "Attempt at the first bell",
        actor: { userId: teacherA.id, userEmail: teacherA.email, role: "teacher" },
        now: new Date("2099-05-26T13:00:00.000Z"),
      })),
      (error: any) => {
        assert.equal(error.code, "SCHEDULE_CHANGE_ALREADY_STARTED");
        return true;
      }
    );

    await assert.rejects(
      () => inSchool(schoolA.id, () => storage.createClasspilotScheduleChange({
        schoolId: schoolA.id,
        pairId,
        scheduledDate: "2099-05-28",
        reason: "Attempt after the first bell",
        actor: { userId: teacherA.id, userEmail: teacherA.email, role: "teacher" },
        now: new Date("2099-05-28T13:30:00.000Z"),
      })),
      (error: any) => {
        assert.equal(error.code, "SCHEDULE_CHANGE_ALREADY_STARTED");
        return true;
      }
    );

    const cutoffRestored = await requestJson(
      "PATCH",
      "/classpilot/schedule-changes/settings",
      admin,
      {
        expectedRevision: cutoffOff.body.revision,
        sameDayCutoffEnforced: true,
      }
    );
    assert.equal(cutoffRestored.status, 200);
    const futureRequest = await inSchool(schoolA.id, () =>
      storage.createClasspilotScheduleChange({
        schoolId: schoolA.id,
        pairId,
        scheduledDate: "2099-05-27",
        reason: "Future-date request remains eligible",
        actor: { userId: teacherA.id, userEmail: teacherA.email, role: "teacher" },
        now: new Date("2099-05-26T12:00:00.000Z"),
      })
    );
    assert.equal(futureRequest.status, "pending_counterpart");
  });

  it("makes teacher reasons optional by policy while keeping administrator reasons mandatory", async () => {
    const initialPolicy = await requestJson(
      "GET",
      "/classpilot/schedule-changes/settings",
      admin
    );
    const optionalPolicy = await requestJson(
      "PATCH",
      "/classpilot/schedule-changes/settings",
      admin,
      {
        expectedRevision: initialPolicy.body.revision,
        reasonRequired: false,
      }
    );
    assert.equal(optionalPolicy.status, 200);
    assert.equal(optionalPolicy.body.reasonRequired, false);

    const omitted = await requestJson(
      "POST",
      "/classpilot/schedule-changes",
      teacherA,
      { pairId, scheduledDate: "2099-05-11" }
    );
    assert.equal(omitted.status, 201);
    assert.equal(omitted.body.reason, "No reason provided.");

    const blank = await requestJson(
      "POST",
      "/classpilot/schedule-changes",
      teacherA,
      { pairId, scheduledDate: "2099-05-12", reason: "" }
    );
    assert.equal(blank.status, 201);
    assert.equal(blank.body.reason, "No reason provided.");

    const whitespace = await requestJson(
      "POST",
      "/classpilot/schedule-changes",
      teacherA,
      { pairId, scheduledDate: "2099-05-13", reason: "   " }
    );
    assert.equal(whitespace.status, 201);
    assert.equal(whitespace.body.reason, "No reason provided.");

    const note = await requestJson(
      "POST",
      "/classpilot/schedule-changes",
      teacherA,
      { pairId, scheduledDate: "2099-05-14", reason: "  Assembly timing  " }
    );
    assert.equal(note.status, 201);
    assert.equal(note.body.reason, "Assembly timing");

    const storedReasons = await inSchool(schoolA.id, () => db.execute(sql`
      SELECT id, reason
      FROM classpilot_schedule_changes
      WHERE id IN (${omitted.body.id}, ${blank.body.id}, ${whitespace.body.id}, ${note.body.id})
    `));
    const reasonById = new Map(storedReasons.rows.map((row: any) => [row.id, row.reason]));
    assert.equal(reasonById.get(omitted.body.id), "No reason provided.");
    assert.equal(reasonById.get(blank.body.id), "No reason provided.");
    assert.equal(reasonById.get(whitespace.body.id), "No reason provided.");
    assert.equal(reasonById.get(note.body.id), "Assembly timing");

    const overlength = await requestJson(
      "POST",
      "/classpilot/schedule-changes",
      teacherA,
      { pairId, scheduledDate: "2099-05-15", reason: "x".repeat(501) }
    );
    assert.equal(overlength.status, 400);
    assert.equal(overlength.body.code, "INVALID_SCHEDULE_CHANGE_REASON");

    const nonString = await requestJson(
      "POST",
      "/classpilot/schedule-changes",
      teacherA,
      { pairId, scheduledDate: "2099-05-18", reason: { note: "event" } }
    );
    assert.equal(nonString.status, 400);
    assert.equal(nonString.body.code, "INVALID_SCHEDULE_CHANGE_REASON");

    const adminWithoutReason = await requestJson(
      "POST",
      "/classpilot/schedule-changes",
      admin,
      { pairId, scheduledDate: "2099-05-19", directApprove: true }
    );
    assert.equal(adminWithoutReason.status, 400);
    assert.equal(adminWithoutReason.body.code, "INVALID_SCHEDULE_CHANGE_REASON");

    const requiredPolicy = await requestJson(
      "PATCH",
      "/classpilot/schedule-changes/settings",
      admin,
      {
        expectedRevision: optionalPolicy.body.revision,
        reasonRequired: true,
      }
    );
    assert.equal(requiredPolicy.status, 200);

    for (const [scheduledDate, reason] of [
      ["2099-05-20", undefined],
      ["2099-05-21", ""],
      ["2099-05-22", "   "],
    ] as const) {
      const required = await requestJson(
        "POST",
        "/classpilot/schedule-changes",
        teacherA,
        {
          pairId,
          scheduledDate,
          ...(reason === undefined ? {} : { reason }),
        }
      );
      assert.equal(required.status, 400);
      assert.equal(required.body.code, "INVALID_SCHEDULE_CHANGE_REASON");
    }
  });

  it("serializes a reason-policy save against teacher request creation", async () => {
    const initialPolicy = await requestJson(
      "GET",
      "/classpilot/schedule-changes/settings",
      admin
    );
    const optionalPolicy = await requestJson(
      "PATCH",
      "/classpilot/schedule-changes/settings",
      admin,
      {
        expectedRevision: initialPolicy.body.revision,
        reasonRequired: false,
      }
    );
    assert.equal(optionalPolicy.status, 200);

    const [createResult, saveResult] = await Promise.allSettled([
      inSchool(schoolA.id, () => storage.createClasspilotScheduleChange({
        schoolId: schoolA.id,
        pairId,
        scheduledDate: "2099-05-29",
        reason: "",
        actor: { userId: teacherA.id, userEmail: teacherA.email, role: "teacher" },
      })),
      inSchool(schoolA.id, () => storage.updateClasspilotScheduleChangeSettings({
        schoolId: schoolA.id,
        expectedRevision: optionalPolicy.body.revision,
        patch: { reasonRequired: true },
        actor: { userId: admin.id, userEmail: admin.email, role: "admin" },
      })),
    ]);

    assert.equal(saveResult.status, "fulfilled");
    if (saveResult.status === "fulfilled") {
      assert.equal(saveResult.value.status, "saved");
      assert.equal(saveResult.value.current.reasonRequired, true);
    }
    if (createResult.status === "fulfilled") {
      assert.equal(createResult.value.reason, "No reason provided.");
    } else {
      assert.equal(createResult.reason?.code, "INVALID_SCHEDULE_CHANGE_REASON");
    }

    const finalPolicy = await requestJson(
      "GET",
      "/classpilot/schedule-changes/settings",
      admin
    );
    assert.equal(finalPolicy.body.reasonRequired, true);
    const blankRows = await inSchool(schoolA.id, () => db.execute(sql`
      SELECT count(*)::int AS count
      FROM classpilot_schedule_changes
      WHERE school_id = ${schoolA.id} AND length(reason) = 0
    `));
    assert.equal(Number(blankRows.rows[0]?.count || 0), 0);
  });

  it("keeps delayed Stripe payment entitlements monotonic under the approved-swap lock domain", async () => {
    const billingRoute = readFileSync("src/routes/admin/billing.ts", "utf8");
    assert.match(billingRoute, /applySchoolBillingPayment\s*\(/);
    assert.doesNotMatch(billingRoute, /\.update\(schools\)|\.update\(productLicenses\)/);

    const paidThrough = new Date("2100-01-01T00:00:00.000Z");
    const first = await asSystem(() => storage.applySchoolBillingPayment({
      schoolId: schoolA.id,
      paidThrough,
      amountPaid: 300,
      planTier: "basic",
      now: new Date("2098-01-01T00:00:00.000Z"),
      products: ["CLASSPILOT"],
      stripeSubscriptionId: `${TAG}_newer_subscription`,
    }));
    assert.equal(first.school.activeUntil, null);
    const unbounded = await asSystem(() => db.execute(sql`
      SELECT school.active_until, license.expires_at
      FROM schools school
      JOIN product_licenses license ON license.school_id = school.id
      WHERE school.id = ${schoolA.id} AND license.product = 'CLASSPILOT'
    `));
    assert.equal(unbounded.rows[0].active_until, null);
    assert.equal(unbounded.rows[0].expires_at, null);

    // Seed an already-newer finite term, matching an earlier successfully
    // processed event, then replay an older payment below.
    await asSystem(() => db.transaction(async (tx: any) => {
      await tx.execute(sql`
        UPDATE schools SET active_until = ${paidThrough} WHERE id = ${schoolA.id}
      `);
      await tx.execute(sql`
        UPDATE product_licenses SET expires_at = ${paidThrough}
        WHERE school_id = ${schoolA.id} AND product = 'CLASSPILOT'
      `);
    }));
    const newer = await asSystem(() => db.execute(sql`
      SELECT school.active_until, license.expires_at
      FROM schools school
      JOIN product_licenses license ON license.school_id = school.id
      WHERE school.id = ${schoolA.id} AND license.product = 'CLASSPILOT'
    `));

    // A delayed older event must neither shorten the school nor ClassPilot
    // license horizon, and must not invalidate the approved May 2099 swaps.
    const delayed = await asSystem(() => storage.applySchoolBillingPayment({
      schoolId: schoolA.id,
      paidThrough: new Date("2099-01-01T00:00:00.000Z"),
      amountPaid: 300,
      planTier: "basic",
      now: new Date("2098-01-02T00:00:00.000Z"),
      products: ["CLASSPILOT"],
      stripeSubscriptionId: `${TAG}_older_subscription`,
    }));
    assert.ok(delayed?.school);
    const entitlement = await asSystem(() => db.execute(sql`
      SELECT school.active_until, license.expires_at
      FROM schools school
      JOIN product_licenses license ON license.school_id = school.id
      WHERE school.id = ${schoolA.id} AND license.product = 'CLASSPILOT'
    `));
    assert.equal(
      new Date(entitlement.rows[0].active_until).toISOString(),
      new Date(newer.rows[0].active_until).toISOString()
    );
    assert.equal(
      new Date(entitlement.rows[0].expires_at).toISOString(),
      new Date(newer.rows[0].expires_at).toISOString()
    );
  });

  it("supersedes pending requests atomically when a class schedule changes", async () => {
    const pendingFirst = await createScheduledClass({
      name: "Pending First",
      teacherId: teacherA.id,
      start: "12:00",
      end: "13:00",
    });
    const pendingSecond = await createScheduledClass({
      name: "Pending Second",
      teacherId: teacherB.id,
      start: "13:00",
      end: "14:00",
    });
    const pair = await requestJson(
      "POST",
      "/classpilot/schedule-changes/pairs",
      admin,
      { firstGroupId: pendingFirst.id, secondGroupId: pendingSecond.id }
    );
    assert.equal(pair.status, 201);
    const pending = await requestJson(
      "POST",
      "/classpilot/schedule-changes",
      teacherA,
      {
        pairId: pair.body.id,
        scheduledDate: "2099-05-06",
        reason: "Pending request to supersede",
      }
    );
    assert.equal(pending.status, 201);
    assert.equal(pending.body.status, "pending_counterpart");

    const updated = await inSchool(schoolA.id, () => storage.updateGroup(
      pendingFirst.id,
      { blockStartTime: "11:00", blockEndTime: "12:00" },
      admin.id
    ));
    assert.equal(updated.blockStartTime, "11:00");
    const status = await inSchool(schoolA.id, () => db.execute(sql`
      SELECT status, reservation_active
      FROM classpilot_schedule_changes
      WHERE id = ${pending.body.id}
    `));
    assert.deepEqual(status.rows[0], { status: "superseded", reservation_active: false });
  });

  it("keeps recurring Class Management writes outside swaps and preserves no-op skips", async () => {
    const created = await requestJson(
      "POST",
      "/classpilot/admin/classes",
      admin,
      {
        name: `${TAG}_Recurring Boundary`,
        primaryTeacherId: teacherC.id,
        scheduleEnabled: false,
      }
    );
    assert.equal(created.status, 201);
    const groupId = created.body.class.id;
    await inSchool(schoolA.id, () => storage.updateGroup(groupId, {
      scheduleSkippedDate: "2099-05-08",
    }));

    const noOp = await requestJson(
      "PATCH",
      `/classpilot/admin/classes/${groupId}`,
      admin,
      {
        name: `${TAG}_Recurring Boundary Renamed`,
        scheduleEnabled: false,
        blockStartTime: null,
        blockEndTime: null,
      }
    );
    assert.equal(noOp.status, 200);
    const afterNoOp = await inSchool(schoolA.id, () => storage.getGroupByIdAndSchool(groupId, schoolA.id));
    assert.equal(afterNoOp.scheduleSkippedDate, "2099-05-08");

    const enabled = await requestJson(
      "PATCH",
      `/classpilot/admin/classes/${groupId}`,
      admin,
      {
        scheduleEnabled: true,
        blockStartTime: "20:00",
        blockEndTime: "20:30",
      }
    );
    assert.equal(enabled.status, 200);
    const afterScheduleChange = await inSchool(schoolA.id, () => storage.getGroupByIdAndSchool(groupId, schoolA.id));
    assert.equal(afterScheduleChange.scheduleSkippedDate, null);

    const swapLegs = await inSchool(schoolA.id, () => db.execute(sql`
      SELECT count(*)::int AS count
      FROM classpilot_schedule_change_legs
      WHERE school_id = ${schoolA.id} AND group_id = ${groupId}
    `));
    assert.equal(Number(swapLegs.rows[0]?.count || 0), 0);
    const scheduleAudits = await inSchool(schoolA.id, () => db.execute(sql`
      SELECT action
      FROM audit_logs
      WHERE school_id = ${schoolA.id} AND entity_id = ${groupId}
      ORDER BY created_at
    `));
    const actions = scheduleAudits.rows.map((row: any) => row.action);
    assert.equal(actions.includes("class.recurring_schedule_updated"), true);
    assert.equal(actions.includes("class.schedule_change"), false);
  });

  it("fails closed when reactivation would introduce a conflict into an approved swap", async () => {
    const reactivationFirst = await createScheduledClass({
      name: "Reactivation First",
      teacherId: teacherA.id,
      start: "16:00",
      end: "17:00",
    });
    const reactivationSecond = await createScheduledClass({
      name: "Reactivation Second",
      teacherId: teacherB.id,
      start: "17:00",
      end: "18:00",
    });
    const student = await inSchool(schoolA.id, () => storage.createStudent({
      schoolId: schoolA.id,
      firstName: "Retained",
      lastName: "Student",
      email: `retained-student@${TAG}.example.edu`,
      emailLc: `retained-student@${TAG}.example.edu`,
      status: "active",
    }));
    const conflictGroup = await createScheduledClass({
      name: "Conflict Group",
      teacherId: teacherC.id,
      start: "17:15",
      end: "17:45",
    });
    await inSchool(schoolA.id, () => storage.addGroupStudentsDetailed(reactivationFirst.id, [student.id]));
    await inSchool(schoolA.id, () => storage.addGroupStudentsDetailed(conflictGroup.id, [student.id]));
    const removed = await inSchool(schoolA.id, () => storage.deactivateStudentsForRoster(
      schoolA.id,
      [student.id],
      { userId: admin.id, userRole: "admin", source: "schedule_change_test" }
    ));
    assert.deepEqual(removed.deactivatedStudentIds, [student.id]);

    const reactivationPair = await requestJson(
      "POST",
      "/classpilot/schedule-changes/pairs",
      admin,
      { firstGroupId: reactivationFirst.id, secondGroupId: reactivationSecond.id }
    );
    assert.equal(reactivationPair.status, 201);
    const reactivationChange = await requestJson(
      "POST",
      "/classpilot/schedule-changes",
      admin,
      {
        pairId: reactivationPair.body.id,
        scheduledDate: "2099-05-07",
        reason: "Approved while retained student is inactive",
        directApprove: true,
      }
    );
    assert.equal(reactivationChange.status, 201);
    assert.equal(reactivationChange.body.status, "approved");

    await assert.rejects(
      () => inSchool(schoolA.id, () => storage.reactivateInactiveStudentForRosterImport(
        schoolA.id,
        student.email.toLowerCase(),
        { firstName: "Retained" },
        { userId: admin.id, userRole: "admin", source: "schedule_change_test" }
      )),
      (error: any) => {
        assert.equal(error.code, "APPROVED_SCHEDULE_CHANGE_ASSIGNMENT_CONFLICT");
        assert.equal(error.status, 409);
        return true;
      }
    );
    const row = await inSchool(schoolA.id, () => db.execute(sql`
      SELECT status FROM students WHERE id = ${student.id}
    `));
    assert.equal(row.rows[0]?.status, "inactive");
  });

  it("rolls back a scheduled group create when a cross-school roster assignment fails", async () => {
    const foreignStudent = await inSchool(schoolB.id, () => storage.createStudent({
      schoolId: schoolB.id,
      firstName: "Foreign",
      lastName: "Student",
      email: `foreign-student@${TAG}.example.edu`,
      emailLc: `foreign-student@${TAG}.example.edu`,
      status: "active",
    }));
    const attemptedName = `${TAG}_Atomic Rollback`;
    await assert.rejects(
      () => inSchool(schoolA.id, () => storage.upsertClasspilotGroupWithAssignments({
        schoolId: schoolA.id,
        data: {
          name: attemptedName,
          groupType: "teacher_created",
          status: "active",
          scheduleEnabled: true,
          blockStartTime: "15:00",
          blockEndTime: "16:00",
        },
        primaryTeacherId: teacherC.id,
        coTeacherIds: [],
        studentIds: [foreignStudent.id],
        scheduleChangeActorId: admin.id,
      })),
      /school|student|tenant/i
    );
    const residue = await inSchool(schoolA.id, () => db.execute(sql`
      SELECT count(*)::int AS count
      FROM groups
      WHERE school_id = ${schoolA.id} AND name = ${attemptedName}
    `));
    assert.equal(Number(residue.rows[0]?.count || 0), 0);
  });

  it("lets a co-teacher start a scheduled class inside its window and rejects an unrelated teacher", async () => {
    const [primary, coTeacher, outsider] = await Promise.all([
      storage.createUser({ email: `coteach-primary@${TAG}.example.edu`, firstName: "Pat", lastName: "Primary" }),
      storage.createUser({ email: `coteach-co@${TAG}.example.edu`, firstName: "Cody", lastName: "CoTeach" }),
      storage.createUser({ email: `coteach-outsider@${TAG}.example.edu`, firstName: "Olive", lastName: "Outsider" }),
    ]);
    for (const user of [primary, coTeacher, outsider]) {
      await storage.createMembership({ userId: user.id, schoolId: schoolA.id, role: "teacher", status: "active" });
    }
    const group = await createScheduledClass({
      name: "CoTeacher Window",
      teacherId: primary.id,
      start: "00:00",
      end: "23:59",
    });
    await inSchool(schoolA.id, () => storage.addGroupTeacher(group.id, coTeacher.id, "co-teacher"));
    const now = new Date();
    const scheduledDate = now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    // Seed today's occurrence around the real clock so weekend runs do not
    // re-test the separate instructional-calendar creation gate.
    await inSchool(schoolA.id, () => storage.createOrReuseScheduledReportSession({
      schoolId: schoolA.id,
      groupId: group.id,
      teacherId: primary.id,
      scheduledDate,
      scheduledTimezone: "America/New_York",
      scheduledStartAt: new Date(now.getTime() - 60_000),
      scheduledEndAt: new Date(now.getTime() + 60 * 60_000),
      scheduledTeacherEmail: primary.email,
      scheduledTeacherName: "Pat Primary",
    }));

    const denied = await requestJson("POST", "/classpilot/teaching-sessions/start", outsider, { groupId: group.id });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, "This class is not assigned to you");

    const started = await requestJson("POST", "/classpilot/teaching-sessions/start", coTeacher, { groupId: group.id });
    assert.ok(
      started.status >= 200 && started.status < 300,
      `co-teacher start returned ${started.status}: ${JSON.stringify(started.body)}`
    );
    assert.equal(started.body.session.groupId, group.id);
    assert.equal(started.body.session.teacherId, primary.id);
    await inSchool(schoolA.id, () => storage.endTeachingSession(started.body.session.id));
  });
});
