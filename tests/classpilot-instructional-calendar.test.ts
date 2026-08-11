import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";

const TAG = `cp_instructional_calendar_${Date.now()}`;
const ORIGINAL_REDIS_URL = process.env.REDIS_URL;
// Keep dotenv/config from restoring a local .env Redis URL when createApp is
// imported; this focused HTTP suite does not exercise distributed realtime.
process.env.REDIS_URL = "";

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
let adminA: any;
let adminB: any;
let teacherA: any;
let superAdmin: any;

function inSchool<T>(schoolId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ schoolId }, fn);
}

function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuper: true }, fn);
}

function authFor(user: any, schoolId: string): Record<string, string> {
  return {
    authorization: `Bearer ${signUserToken({
      userId: user.id,
      email: user.email,
      isSuperAdmin: !!user.isSuperAdmin,
    })}`,
    "x-school-id": schoolId,
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

async function cleanup(): Promise<void> {
  if (!schoolA?.id || !schoolB?.id) return;
  await asSystem(async () => {
    const schoolIds = [schoolA.id, schoolB.id];
    await db.execute(sql`DELETE FROM error_logs WHERE school_id IN (${sql.join(schoolIds.map((id) => sql`${id}`), sql`, `)})`);
    await db.execute(sql`DELETE FROM audit_logs WHERE school_id IN (${sql.join(schoolIds.map((id) => sql`${id}`), sql`, `)})`);
    await db.execute(sql`DELETE FROM teaching_sessions WHERE school_id IN (${sql.join(schoolIds.map((id) => sql`${id}`), sql`, `)})`);
    await db.execute(sql`DELETE FROM group_students WHERE group_id IN (SELECT id FROM groups WHERE school_id IN (${sql.join(schoolIds.map((id) => sql`${id}`), sql`, `)}))`);
    await db.execute(sql`DELETE FROM group_teachers WHERE group_id IN (SELECT id FROM groups WHERE school_id IN (${sql.join(schoolIds.map((id) => sql`${id}`), sql`, `)}))`);
    await db.execute(sql`DELETE FROM groups WHERE school_id IN (${sql.join(schoolIds.map((id) => sql`${id}`), sql`, `)})`);
    await db.execute(sql`DELETE FROM settings WHERE school_id IN (${sql.join(schoolIds.map((id) => sql`${id}`), sql`, `)})`);
    await db.execute(sql`DELETE FROM product_licenses WHERE school_id IN (${sql.join(schoolIds.map((id) => sql`${id}`), sql`, `)})`);
    await db.execute(sql`DELETE FROM school_memberships WHERE school_id IN (${sql.join(schoolIds.map((id) => sql`${id}`), sql`, `)})`);
    await db.execute(sql`DELETE FROM schools WHERE id IN (${sql.join(schoolIds.map((id) => sql`${id}`), sql`, `)})`);
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${`%@${TAG}.example.edu`}`);
  });
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

  // Focused suites can run against a long-lived local test DB without invoking
  // the full startup runner. Mirror the idempotent production migration here.
  await pool.query(`
    ALTER TABLE settings
    ADD COLUMN IF NOT EXISTS instructional_calendar JSONB NOT NULL DEFAULT '{}'::jsonb
  `);
  await pool.query(`UPDATE settings SET instructional_calendar = '{}'::jsonb WHERE instructional_calendar IS NULL`);
  await pool.query(`
    ALTER TABLE settings
      ALTER COLUMN instructional_calendar SET DEFAULT '{}'::jsonb,
      ALTER COLUMN instructional_calendar SET NOT NULL
  `);

  schoolA = await storage.createSchool({
    name: `${TAG}_A`,
    domain: `${TAG}.example.edu`,
    slug: `${TAG}-a`,
    schoolTimezone: "America/Chicago",
  } as any);
  schoolB = await storage.createSchool({
    name: `${TAG}_B`,
    domain: `${TAG}.example.edu`,
    slug: `${TAG}-b`,
    schoolTimezone: "America/Los_Angeles",
  } as any);
  adminA = await storage.createUser({
    email: `admin-a@${TAG}.example.edu`,
    firstName: "Admin",
    lastName: "Alpha",
  } as any);
  adminB = await storage.createUser({
    email: `admin-b@${TAG}.example.edu`,
    firstName: "Admin",
    lastName: "Beta",
  } as any);
  teacherA = await storage.createUser({
    email: `teacher-a@${TAG}.example.edu`,
    firstName: "Teacher",
    lastName: "Alpha",
  } as any);
  superAdmin = await storage.createUser({
    email: `super@${TAG}.example.edu`,
    firstName: "Super",
    lastName: "Admin",
    isSuperAdmin: true,
  } as any);
  await storage.createMembership({
    userId: adminA.id,
    schoolId: schoolA.id,
    role: "school_admin",
    status: "active",
  } as any);
  await storage.createMembership({
    userId: teacherA.id,
    schoolId: schoolA.id,
    role: "teacher",
    status: "active",
  } as any);
  await storage.createMembership({
    userId: adminB.id,
    schoolId: schoolB.id,
    role: "admin",
    status: "active",
  } as any);
  for (const school of [schoolA, schoolB]) {
    await storage.createProductLicense({
      schoolId: school.id,
      product: "CLASSPILOT",
      status: "active",
    } as any);
    await inSchool(school.id, () => storage.upsertSettings(school.id, {
      schoolName: school.name,
      wsSharedKey: `${TAG}-private-key`,
    }));
  }

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
    await schedulerLockPool?.end().catch(() => undefined);
    await schedulerPool?.end().catch(() => undefined);
    await sessionPool?.end().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    if (ORIGINAL_REDIS_URL === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = ORIGINAL_REDIS_URL;
  }
});

describe("ClassPilot instructional calendar backend", { concurrency: false }, () => {
  it("keeps the Drizzle field and required startup migration aligned", () => {
    const schemaSource = readFileSync(new URL("../src/schema/shared.ts", import.meta.url), "utf8");
    const migrationSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    assert.match(schemaSource, /instructionalCalendar:\s*jsonb\("instructional_calendar"\)/);
    assert.match(
      migrationSource,
      /ALTER TABLE settings\s+ADD COLUMN IF NOT EXISTS instructional_calendar JSONB NOT NULL DEFAULT '\{\}'::jsonb/
    );
    assert.match(
      migrationSource,
      /UPDATE settings\s+SET instructional_calendar = '\{\}'::jsonb\s+WHERE instructional_calendar IS NULL/
    );
    assert.match(
      migrationSource,
      /ALTER COLUMN instructional_calendar SET DEFAULT '\{\}'::jsonb,\s+ALTER COLUMN instructional_calendar SET NOT NULL/
    );
    assert.match(
      migrationSource,
      /ClassPilot instructional calendar settings integrity check failed/
    );
  });

  it("round-trips a canonical month without exposing settings secrets", async () => {
    const month = "2099-05";
    const weekdays = storage.instructionalCalendarWeekdaysInMonth(month);
    const initial = await requestJson(
      "GET",
      `/classpilot/admin/instructional-calendar?month=${month}`,
      undefined,
      authFor(adminA, schoolA.id)
    );
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.body.nonInstructionalDates, []);
    assert.equal(initial.body.revision, 0);
    assert.equal(initial.body.schoolTimezone, "America/Chicago");
    assert.equal(typeof initial.body.schoolLocalToday, "string");
    assert.equal("wsSharedKey" in initial.body, false);
    assert.equal("updatedBy" in initial.body, false);

    const saved = await requestJson(
      "PUT",
      `/classpilot/admin/instructional-calendar/${month}`,
      {
        expectedRevision: 0,
        nonInstructionalDates: [weekdays[2], weekdays[0]],
      },
      authFor(adminA, schoolA.id)
    );
    assert.equal(saved.status, 200);
    assert.equal(saved.body.revision, 1);
    assert.deepEqual(saved.body.nonInstructionalDates, [weekdays[0], weekdays[2]]);
    assert.ok(saved.body.updatedAt);

    const refreshed = await requestJson(
      "GET",
      `/classpilot/admin/instructional-calendar?month=${month}`,
      undefined,
      authFor(adminA, schoolA.id)
    );
    assert.equal(refreshed.status, 200);
    assert.deepEqual(refreshed.body, saved.body);

    const stored = await inSchool(schoolA.id, () =>
      storage.getInstructionalCalendarMonth(schoolA.id, month)
    );
    assert.equal(stored.updatedBy, adminA.id);
    const audit = await asSystem(() => db.execute(sql`
      SELECT changes, metadata
      FROM audit_logs
      WHERE school_id = ${schoolA.id}
        AND action = 'classpilot.instructional_calendar.update'
        AND entity_id = ${month}
      ORDER BY created_at DESC
      LIMIT 1
    `));
    assert.deepEqual(audit.rows[0].changes.addedDates, [weekdays[0], weekdays[2]]);
    assert.equal(audit.rows[0].metadata.revision, 1);
  });

  it("returns authoritative state on revision conflict and preserves other months", async () => {
    const firstMonth = "2099-05";
    const secondMonth = "2099-06";
    const firstState = await inSchool(schoolA.id, () =>
      storage.getInstructionalCalendarMonth(schoolA.id, firstMonth)
    );
    const firstDates = [...firstState.nonInstructionalDates];
    const secondDate = storage.instructionalCalendarWeekdaysInMonth(secondMonth)[0];
    const savedSecond = await requestJson(
      "PUT",
      `/classpilot/admin/instructional-calendar/${secondMonth}`,
      { expectedRevision: 0, nonInstructionalDates: [secondDate] },
      authFor(adminA, schoolA.id)
    );
    assert.equal(savedSecond.status, 200);

    const stale = await requestJson(
      "PUT",
      `/classpilot/admin/instructional-calendar/${firstMonth}`,
      {
        expectedRevision: 0,
        nonInstructionalDates: [storage.instructionalCalendarWeekdaysInMonth(firstMonth)[4]],
      },
      authFor(adminA, schoolA.id)
    );
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "INSTRUCTIONAL_CALENDAR_REVISION_CONFLICT");
    assert.equal(stale.body.current.revision, firstState.revision);
    assert.deepEqual(stale.body.current.nonInstructionalDates, firstDates);
    assert.equal("updatedBy" in stale.body.current, false);

    const stillFirst = await inSchool(schoolA.id, () =>
      storage.getInstructionalCalendarMonth(schoolA.id, firstMonth)
    );
    const stillSecond = await inSchool(schoolA.id, () =>
      storage.getInstructionalCalendarMonth(schoolA.id, secondMonth)
    );
    assert.deepEqual(stillFirst.nonInstructionalDates, firstDates);
    assert.deepEqual(stillSecond.nonInstructionalDates, [secondDate]);
  });

  it("enforces exact dates, weekdays, uniqueness, month membership, and roles", async () => {
    const month = "2099-07";
    const weekdays = storage.instructionalCalendarWeekdaysInMonth(month);
    const weekend = Array.from({ length: 31 }, (_, index) =>
      `${month}-${String(index + 1).padStart(2, "0")}`
    ).find((date) => storage.isValidInstructionalCalendarDate(date)
      && storage.isInstructionalCalendarWeekend(date));
    assert.ok(weekend);

    const invalidCases = [
      { pathMonth: "2099-13", dates: [] },
      { pathMonth: month, dates: ["2099-07-32"] },
      { pathMonth: month, dates: ["2099-08-02"] },
      { pathMonth: month, dates: [weekend] },
      { pathMonth: month, dates: [weekdays[0], weekdays[0]] },
      { pathMonth: month, dates: Array.from({ length: 32 }, () => weekdays[0]) },
    ];
    for (const testCase of invalidCases) {
      const response = await requestJson(
        "PUT",
        `/classpilot/admin/instructional-calendar/${testCase.pathMonth}`,
        { expectedRevision: 0, nonInstructionalDates: testCase.dates },
        authFor(adminA, schoolA.id)
      );
      assert.equal(response.status, 400, JSON.stringify(response.body));
    }
    const badGet = await requestJson(
      "GET",
      "/classpilot/admin/instructional-calendar?month=2099-7",
      undefined,
      authFor(adminA, schoolA.id)
    );
    assert.equal(badGet.status, 400);

    const teacher = await requestJson(
      "GET",
      `/classpilot/admin/instructional-calendar?month=${month}`,
      undefined,
      authFor(teacherA, schoolA.id)
    );
    assert.equal(teacher.status, 403);
    const crossSchool = await requestJson(
      "GET",
      `/classpilot/admin/instructional-calendar?month=${month}`,
      undefined,
      authFor(adminA, schoolB.id)
    );
    assert.equal(crossSchool.status, 403);
    const superAdminRead = await requestJson(
      "GET",
      `/classpilot/admin/instructional-calendar?month=${month}`,
      undefined,
      authFor(superAdmin, schoolA.id)
    );
    assert.equal(superAdminRead.status, 200);
  });

  it("allows unchanged past closures but rejects past additions and removals", async () => {
    const month = "2031-01";
    const initial = await inSchool(schoolB.id, () =>
      storage.replaceInstructionalCalendarMonth({
        schoolId: schoolB.id,
        month,
        expectedRevision: 0,
        nonInstructionalDates: ["2031-01-06"],
        updatedBy: adminB.id,
        now: new Date("2031-01-01T12:00:00.000Z"),
      })
    );
    assert.equal(initial.status, "saved");
    const unchanged = await inSchool(schoolB.id, () =>
      storage.replaceInstructionalCalendarMonth({
        schoolId: schoolB.id,
        month,
        expectedRevision: 1,
        nonInstructionalDates: ["2031-01-06"],
        updatedBy: adminB.id,
        now: new Date("2031-01-10T20:00:00.000Z"),
      })
    );
    assert.equal(unchanged.status, "saved");

    await assert.rejects(
      () => inSchool(schoolB.id, () => storage.replaceInstructionalCalendarMonth({
        schoolId: schoolB.id,
        month,
        expectedRevision: 2,
        nonInstructionalDates: [],
        updatedBy: adminB.id,
        now: new Date("2031-01-10T20:00:00.000Z"),
      })),
      (error: any) => error?.code === "INSTRUCTIONAL_CALENDAR_PAST_DATE_IMMUTABLE"
    );
    await assert.rejects(
      () => inSchool(schoolB.id, () => storage.replaceInstructionalCalendarMonth({
        schoolId: schoolB.id,
        month,
        expectedRevision: 2,
        nonInstructionalDates: ["2031-01-06", "2031-01-07"],
        updatedBy: adminB.id,
        now: new Date("2031-01-10T20:00:00.000Z"),
      })),
      (error: any) => error?.code === "INSTRUCTIONAL_CALENDAR_PAST_DATE_IMMUTABLE"
    );
  });

  it("treats Skip Today on a closed date as a no-op without a tombstone", async () => {
    const calendar = await requestJson(
      "GET",
      "/classpilot/admin/instructional-calendar?month=2099-05",
      undefined,
      authFor(adminA, schoolA.id)
    );
    assert.equal(calendar.status, 200);
    const schoolLocalToday = calendar.body.schoolLocalToday;
    const currentMonth = schoolLocalToday.slice(0, 7);
    const current = await requestJson(
      "GET",
      `/classpilot/admin/instructional-calendar?month=${currentMonth}`,
      undefined,
      authFor(adminA, schoolA.id)
    );
    assert.equal(current.status, 200);
    if (!storage.isInstructionalCalendarWeekend(schoolLocalToday)) {
      const closed = await requestJson(
        "PUT",
        `/classpilot/admin/instructional-calendar/${currentMonth}`,
        {
          expectedRevision: current.body.revision,
          nonInstructionalDates: [...new Set([
            ...current.body.nonInstructionalDates,
            schoolLocalToday,
          ])],
        },
        authFor(adminA, schoolA.id)
      );
      assert.equal(closed.status, 200);
    }

    const group = await inSchool(schoolA.id, () => storage.createGroup({
      schoolId: schoolA.id,
      teacherId: teacherA.id,
      name: `${TAG}_closed_skip`,
      groupType: "admin_class",
      status: "active",
      scheduleEnabled: true,
      blockStartTime: "09:00",
      blockEndTime: "10:00",
    } as any));
    const skipped = await requestJson(
      "POST",
      `/classpilot/scheduled-classes/${group.id}/skip-today`,
      {},
      authFor(adminA, schoolA.id)
    );
    assert.equal(skipped.status, 200);
    assert.deepEqual(
      {
        skipped: skipped.body.skipped,
        reason: skipped.body.reason,
        code: skipped.body.code,
      },
      {
        skipped: false,
        reason: "non_instructional_day",
        code: "NON_INSTRUCTIONAL_DAY",
      }
    );
    const occurrences = await inSchool(schoolA.id, () => db.execute(sql`
      SELECT count(*)::integer AS count
      FROM teaching_sessions
      WHERE school_id = ${schoolA.id}
        AND group_id = ${group.id}
        AND scheduled_date = ${schoolLocalToday}
    `));
    assert.equal(Number(occurrences.rows[0]?.count || 0), 0);
  });

  it("distinguishes instructional, closed, weekend, and missing-settings states", async () => {
    const state = await inSchool(schoolA.id, () =>
      storage.getInstructionalCalendarMonth(schoolA.id, "2099-05")
    );
    const closedDate = state.nonInstructionalDates[0];
    assert.ok(closedDate);
    const closed = await inSchool(schoolA.id, () =>
      storage.getInstructionalDateStatus(schoolA.id, closedDate)
    );
    assert.deepEqual(closed, { instructional: false, reason: "non_instructional_day" });
    const openDate = storage.instructionalCalendarWeekdaysInMonth("2099-05")
      .find((date: string) => !state.nonInstructionalDates.includes(date));
    const open = await inSchool(schoolA.id, () =>
      storage.getInstructionalDateStatus(schoolA.id, openDate)
    );
    assert.deepEqual(open, { instructional: true, reason: "instructional_day" });
    const weekendDate = Array.from({ length: 31 }, (_, index) =>
      `2099-05-${String(index + 1).padStart(2, "0")}`
    ).find((date) => storage.isValidInstructionalCalendarDate(date)
      && storage.isInstructionalCalendarWeekend(date));
    assert.ok(weekendDate);
    const weekend = await inSchool(schoolA.id, () =>
      storage.getInstructionalDateStatus(schoolA.id, weekendDate)
    );
    assert.deepEqual(weekend, { instructional: false, reason: "weekend" });

    await asSystem(() => db.execute(sql`
      DELETE FROM settings WHERE school_id = ${schoolB.id}
    `).then(() => undefined));
    await assert.rejects(
      () => inSchool(schoolB.id, () =>
        storage.getInstructionalDateStatus(schoolB.id, "2099-05-04")
      ),
      (error: any) => error?.code === "INSTRUCTIONAL_CALENDAR_SETTINGS_UNAVAILABLE"
    );
    const missingSettingsGet = await requestJson(
      "GET",
      "/classpilot/admin/instructional-calendar?month=2099-05",
      undefined,
      authFor(adminB, schoolB.id)
    );
    assert.equal(missingSettingsGet.status, 500);
    assert.equal(
      missingSettingsGet.body.code,
      "INSTRUCTIONAL_CALENDAR_SETTINGS_UNAVAILABLE"
    );
    assert.equal("nonInstructionalDates" in missingSettingsGet.body, false);
  });
});
