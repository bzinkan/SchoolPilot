import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

// These values must be set before importing any application module. The test
// models the production API process (not the scheduler worker) and deliberately
// exercises the launch cap of 18 request/RLS connections.
process.env.NODE_ENV = "test";
process.env.SCHEDULER_ENABLED = "false";
process.env.DB_POOL_MAX = "18";
process.env.SESSION_DB_POOL_MAX = "2";
process.env.RLS_GUC_ENABLED = "true";
process.env.JWT_SECRET = randomBytes(32).toString("hex");
process.env.SESSION_SECRET = randomBytes(32).toString("hex");
// Keep the key present so app.ts's dotenv import cannot repopulate a developer
// Redis URL after this test has intentionally selected the in-memory fallback.
process.env.REDIS_URL = "";

// Several application modules own process-lifetime housekeeping intervals.
// This integration test starts the real app but must let Node's isolated test
// worker exit afterward, so make only this worker's intervals non-blocking.
const originalSetInterval = globalThis.setInterval;
globalThis.setInterval = ((...args: any[]) => {
  const timer = (originalSetInterval as any)(...args);
  timer.unref?.();
  return timer;
}) as typeof setInterval;

// Import sequentially because app.ts and the database/error-monitor modules
// intentionally reference each other. Concurrent dynamic roots can leave the
// ESM loader waiting on that cycle even though normal application startup is
// well-defined.
const { default: db, pool, sessionPool } = await import("../dist/db.js");
const tenantContext = await import("../dist/middleware/tenantContext.js");
const storage = await import("../dist/services/storage.js");
const jwt = await import("../dist/services/jwt.js");
const appModule = await import("../dist/app.js");
const drizzle = await import("drizzle-orm");
const schema = await import("../dist/schema/index.js");
const schedulerPools = await import("../dist/services/schedulerDb.js");

const { runWithTenantContext } = tenantContext;
const {
  createMembership,
  createProductLicense,
  createSchool,
  createUser,
} = storage;
const { signUserToken } = jwt;
const { createApp } = appModule;
const { eq, sql } = drizzle;
const {
  classpilotSupervisionContexts,
  classpilotSupervisionStudents,
  devices,
  groupStudents,
  groups,
  heartbeats,
  studentDevices,
  studentSessions,
  students,
  teachingSessions,
} = schema;
const { schedulerPool, schedulerLockPool } = schedulerPools;

const unique = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const tag = `tile-read-${unique}`;
const schoolADomain = `${tag}-a.example.edu`;
const schoolBDomain = `${tag}-b.example.edu`;
const primaryDeviceIds = Array.from(
  { length: 40 },
  (_, index) => `${tag}-a-device-${String(index + 1).padStart(2, "0")}`
);
const foreignDeviceId = `${tag}-b-device`;

let schoolA: any;
let schoolB: any;
let teacher: any;
let admin: any;
let schoolAdmin: any;
let officeStaff: any;
let parent: any;
let server: Server;
let baseUrl = "";
let authorizedStudentIds: string[] = [];
let otherStudentId = "";

function inSchool<T>(schoolId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ schoolId }, fn);
}

function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuper: true }, fn);
}

function authHeaders(user: any, schoolId = schoolA.id): Record<string, string> {
  const token = signUserToken({
    userId: user.id,
    email: user.email,
    isSuperAdmin: false,
  });
  return {
    authorization: `Bearer ${token}`,
    "x-school-id": schoolId,
  };
}

async function requestJson(
  path: string,
  user: any,
  schoolId = schoolA.id,
  signal?: AbortSignal
): Promise<{
  status: number;
  body: any;
  rateLimit: string | null;
}> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: authHeaders(user, schoolId),
    signal,
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    rateLimit: response.headers.get("ratelimit-limit"),
  };
}

async function waitForMainPoolDrain(timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (
    Date.now() < deadline &&
    (pool.waitingCount !== 0 || pool.idleCount !== pool.totalCount)
  ) {
    await delay(10);
  }
}

before(async () => {
  assert.equal((pool as any).options.max, 18);

  schoolA = await createSchool({
    name: `${tag} A`,
    domain: schoolADomain,
    slug: `${tag}-a`,
    status: "active",
    planStatus: "active",
  } as any);
  schoolB = await createSchool({
    name: `${tag} B`,
    domain: schoolBDomain,
    slug: `${tag}-b`,
    status: "active",
    planStatus: "active",
  } as any);

  [teacher, admin, schoolAdmin, officeStaff, parent] = await Promise.all([
    createUser({
      email: `${tag}-teacher@${schoolADomain}`,
      firstName: "Synthetic",
      lastName: "Teacher",
    } as any),
    createUser({
      email: `${tag}-admin@${schoolADomain}`,
      firstName: "Synthetic",
      lastName: "Admin",
    } as any),
    createUser({
      email: `${tag}-school-admin@${schoolADomain}`,
      firstName: "Synthetic",
      lastName: "School Admin",
    } as any),
    createUser({
      email: `${tag}-office@${schoolADomain}`,
      firstName: "Synthetic",
      lastName: "Office",
    } as any),
    createUser({
      email: `${tag}-parent@example.invalid`,
      firstName: "Synthetic",
      lastName: "Parent",
    } as any),
  ]);

  await inSchool(schoolA.id, async () => {
    for (const [user, role] of [
      [teacher, "teacher"],
      [admin, "admin"],
      [schoolAdmin, "school_admin"],
      [officeStaff, "office_staff"],
      [parent, "parent"],
    ] as const) {
      await createMembership({
        userId: user.id,
        schoolId: schoolA.id,
        role,
        status: "active",
      } as any);
    }
  });
  await createProductLicense({
    schoolId: schoolA.id,
    product: "CLASSPILOT",
    status: "active",
  } as any);

  await inSchool(schoolA.id, async () => {
    const studentEmails = primaryDeviceIds.map(
      (_deviceId, index) => `${tag}-student-${index + 1}@${schoolADomain}`
    );
    const otherStudentEmail = `${tag}-other-student@${schoolADomain}`;
    const studentRows = await db
      .insert(students)
      .values([
        ...studentEmails.map((email, index) => ({
          schoolId: schoolA.id,
          firstName: "Synthetic",
          lastName: `Student ${index + 1}`,
          email,
          emailLc: email,
          status: "active",
        })),
        {
          schoolId: schoolA.id,
          firstName: "Other",
          lastName: "Student",
          email: otherStudentEmail,
          emailLc: otherStudentEmail,
          status: "active",
        },
      ])
      .returning({ id: students.id, email: students.email });
    const studentIdByEmail = new Map(
      studentRows.map((row) => [row.email, row.id])
    );
    authorizedStudentIds = studentEmails.map((email) => {
      const id = studentIdByEmail.get(email);
      assert.ok(id);
      return id;
    });
    otherStudentId = studentIdByEmail.get(otherStudentEmail) ?? "";
    assert.ok(otherStudentId);

    await db.insert(devices).values(
      primaryDeviceIds.map((deviceId, index) => ({
        deviceId,
        deviceName: `Synthetic device ${index + 1}`,
        schoolId: schoolA.id,
        classId: "synthetic-class",
      }))
    );
    await db.insert(studentDevices).values([
      ...primaryDeviceIds.map((deviceId, index) => ({
        studentId: authorizedStudentIds[index]!,
        deviceId,
      })),
      // The first Chromebook is historically shared. The teacher must not see
      // the other student's heartbeat merely because the device id matches.
      { studentId: otherStudentId, deviceId: primaryDeviceIds[0]! },
    ]);
    await db.insert(studentSessions).values(
      primaryDeviceIds.map((deviceId, index) => ({
        studentId: authorizedStudentIds[index]!,
        deviceId,
        isActive: true,
      }))
    );
    await db.insert(heartbeats).values([
      ...primaryDeviceIds.map((deviceId, index) => ({
        deviceId,
        studentId: authorizedStudentIds[index]!,
        schoolId: schoolA.id,
        activeTabTitle: `Synthetic tab ${index + 1}`,
        activeTabUrl: `https://example.invalid/device/${index + 1}`,
        timestamp: new Date(),
      })),
      {
        deviceId: primaryDeviceIds[0]!,
        studentId: otherStudentId,
        schoolId: schoolA.id,
        activeTabTitle: "Other student's old tab",
        activeTabUrl: "https://other-student.example.invalid/",
        timestamp: new Date(Date.now() - 60_000),
      },
    ]);

    const [group] = await db
      .insert(groups)
      .values({
        schoolId: schoolA.id,
        teacherId: teacher.id,
        name: `${tag} active class`,
        groupType: "admin_class",
        status: "active",
      })
      .returning({ id: groups.id });
    assert.ok(group?.id);
    await db.insert(groupStudents).values(
      authorizedStudentIds.map((studentId) => ({
        groupId: group.id,
        studentId,
      }))
    );
    await db.insert(teachingSessions).values({
      schoolId: schoolA.id,
      groupId: group.id,
      teacherId: teacher.id,
      sessionMode: "live",
      endTime: null,
    });
  });
  await inSchool(schoolB.id, async () => {
    await db.insert(devices).values({
      deviceId: foreignDeviceId,
      deviceName: "Foreign synthetic device",
      schoolId: schoolB.id,
      classId: "synthetic-class",
    });
    await db.insert(heartbeats).values({
      deviceId: foreignDeviceId,
      schoolId: schoolB.id,
      activeTabTitle: "Foreign synthetic tab",
      activeTabUrl: "https://foreign.example.invalid/",
    });
  });

  const screenshots = new Map<string, unknown>();
  for (const deviceId of [...primaryDeviceIds, foreignDeviceId]) {
    screenshots.set(deviceId, {
      screenshot: `data:image/jpeg;base64,${Buffer.from(deviceId).toString("base64")}`,
      timestamp: Date.now(),
      tabTitle: "Synthetic tile",
    });
  }
  (globalThis as any).__screenshots = screenshots;

  server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  try {
    await asSystem(async () => {
      const schoolNamePattern = `${tag}%`;
      const userEmailPattern = `${tag}-%`;
      const devicePattern = `${tag}-%`;
      await db.execute(sql`
        DELETE FROM classpilot_supervision_students
        WHERE school_id IN (SELECT id FROM schools WHERE name LIKE ${schoolNamePattern})
      `);
      await db.execute(sql`
        DELETE FROM classpilot_supervision_contexts
        WHERE school_id IN (SELECT id FROM schools WHERE name LIKE ${schoolNamePattern})
      `);
      await db.execute(sql`
        DELETE FROM teaching_sessions
        WHERE school_id IN (SELECT id FROM schools WHERE name LIKE ${schoolNamePattern})
      `);
      await db.execute(sql`
        DELETE FROM group_students
        WHERE group_id IN (
          SELECT id FROM groups
          WHERE school_id IN (SELECT id FROM schools WHERE name LIKE ${schoolNamePattern})
        )
      `);
      await db.execute(sql`
        DELETE FROM groups
        WHERE school_id IN (SELECT id FROM schools WHERE name LIKE ${schoolNamePattern})
      `);
      await db.execute(sql`DELETE FROM heartbeats WHERE device_id LIKE ${devicePattern}`);
      await db.execute(sql`DELETE FROM student_sessions WHERE device_id LIKE ${devicePattern}`);
      await db.execute(sql`DELETE FROM student_devices WHERE device_id LIKE ${devicePattern}`);
      await db.execute(sql`DELETE FROM devices WHERE device_id LIKE ${devicePattern}`);
      await db.execute(sql`
        DELETE FROM students
        WHERE school_id IN (SELECT id FROM schools WHERE name LIKE ${schoolNamePattern})
      `);
      await db.execute(sql`
        DELETE FROM product_licenses
        WHERE school_id IN (SELECT id FROM schools WHERE name LIKE ${schoolNamePattern})
      `);
      await db.execute(sql`
        DELETE FROM school_memberships
        WHERE school_id IN (SELECT id FROM schools WHERE name LIKE ${schoolNamePattern})
      `);
      await db.execute(sql`DELETE FROM schools WHERE name LIKE ${schoolNamePattern}`);
      await db.execute(sql`DELETE FROM users WHERE email LIKE ${userEmailPattern}`);
    });
  } finally {
    delete (globalThis as any).__screenshots;
    await Promise.allSettled([
      pool.end(),
      sessionPool.end(),
      schedulerPool.end(),
      schedulerLockPool.end(),
    ]);
  }
});

describe("ClassPilot tile-read tenant scope", () => {
  it("allows classroom staff, denies parents, and hides unassigned office-staff tiles", async () => {
    const path = `/api/classpilot/device/screenshot/${primaryDeviceIds[0]}`;

    for (const allowed of [teacher, admin, schoolAdmin]) {
      const response = await requestJson(path, allowed);
      assert.equal(response.status, 200);
      assert.equal(response.rateLimit, "5000");
      assert.match(response.body.screenshot, /^data:image\/jpeg;base64,/);
    }

    const parentResponse = await requestJson(path, parent);
    assert.equal(parentResponse.status, 403);
    assert.match(parentResponse.body.error, /Insufficient permissions/i);

    const parentLegacyDeviceList = await requestJson(
      "/api/classpilot/devices",
      parent
    );
    assert.equal(parentLegacyDeviceList.status, 403);
    assert.match(parentLegacyDeviceList.body.error, /Insufficient permissions/i);

    // Office staff are a valid ClassPilot staff role, but they may read a tile
    // only when an active coverage context assigns that student to them.
    const officeResponse = await requestJson(path, officeStaff);
    assert.equal(officeResponse.status, 404);
    assert.match(officeResponse.body.error, /Device not found/i);
  });

  it("returns only same-school tile data and hides foreign devices", async () => {
    const ownHistory = await requestJson(
      `/api/classpilot/heartbeats/${primaryDeviceIds[0]}?limit=100`,
      teacher
    );
    assert.equal(ownHistory.status, 200);
    assert.equal(ownHistory.body.heartbeats.length, 1);
    assert.equal(ownHistory.body.heartbeats[0].schoolId, schoolA.id);
    assert.equal(ownHistory.body.heartbeats[0].deviceId, primaryDeviceIds[0]);
    assert.equal(ownHistory.body.heartbeats[0].studentId, authorizedStudentIds[0]);
    assert.ok(
      ownHistory.body.heartbeats.every(
        (heartbeat: { studentId: string }) => heartbeat.studentId !== otherStudentId
      )
    );

    const adminHistory = await requestJson(
      `/api/classpilot/heartbeats/${primaryDeviceIds[0]}?limit=100`,
      admin
    );
    assert.equal(adminHistory.status, 200);
    assert.equal(adminHistory.body.heartbeats.length, 2);
    assert.ok(
      adminHistory.body.heartbeats.some(
        (heartbeat: { studentId: string }) => heartbeat.studentId === otherStudentId
      )
    );

    const foreignScreenshot = await requestJson(
      `/api/classpilot/device/screenshot/${foreignDeviceId}`,
      teacher
    );
    assert.equal(foreignScreenshot.status, 404);
    assert.match(foreignScreenshot.body.error, /Device not found/i);

    const foreignHistory = await requestJson(
      `/api/classpilot/heartbeats/${foreignDeviceId}?limit=1`,
      teacher
    );
    assert.equal(foreignHistory.status, 404);
    assert.match(foreignHistory.body.error, /Device not found/i);

    const unauthorizedSchool = await requestJson(
      `/api/classpilot/heartbeats/${foreignDeviceId}?limit=1`,
      teacher,
      schoolB.id
    );
    assert.equal(unauthorizedSchool.status, 403);
    assert.match(unauthorizedSchool.body.error, /No access to this school/i);
  });

  it("honors active supervision ownership over the original class teacher", async () => {
    const coveredDeviceId = primaryDeviceIds[1]!;
    const coveredStudentId = authorizedStudentIds[1]!;
    const context = await inSchool(schoolA.id, async () => {
      const [created] = await db
        .insert(classpilotSupervisionContexts)
        .values({
          schoolId: schoolA.id,
          contextType: "office",
          name: `${tag} office coverage`,
          status: "active",
          assignedStaffId: officeStaff.id,
          createdBy: admin.id,
          endsAt: new Date(Date.now() + 60 * 60 * 1000),
        })
        .returning({ id: classpilotSupervisionContexts.id });
      assert.ok(created?.id);
      await db.insert(classpilotSupervisionStudents).values({
        schoolId: schoolA.id,
        contextId: created.id,
        studentId: coveredStudentId,
        source: "admin_reroute",
        assignedBy: admin.id,
      });
      return created;
    });

    try {
      const officeLive = await requestJson(
        `/api/classpilot/device/screenshot/${coveredDeviceId}`,
        officeStaff
      );
      assert.equal(officeLive.status, 200);

      const officeHistory = await requestJson(
        `/api/classpilot/heartbeats/${coveredDeviceId}?limit=100`,
        officeStaff
      );
      assert.equal(officeHistory.status, 200);
      assert.equal(officeHistory.body.heartbeats.length, 1);
      assert.equal(officeHistory.body.heartbeats[0].studentId, coveredStudentId);

      const originalTeacherLive = await requestJson(
        `/api/classpilot/device/screenshot/${coveredDeviceId}`,
        teacher
      );
      assert.equal(originalTeacherLive.status, 404);
      assert.match(originalTeacherLive.body.error, /Device not found/i);

      const originalTeacherHistory = await requestJson(
        `/api/classpilot/heartbeats/${coveredDeviceId}?limit=100`,
        teacher
      );
      assert.equal(originalTeacherHistory.status, 404);
      assert.match(originalTeacherHistory.body.error, /Device not found/i);
    } finally {
      await inSchool(schoolA.id, async () => {
        await db
          .delete(classpilotSupervisionStudents)
          .where(eq(classpilotSupervisionStudents.contextId, context.id));
        await db
          .delete(classpilotSupervisionContexts)
          .where(eq(classpilotSupervisionContexts.id, context.id));
      });
    }
  });

  it("serves a 40-request aligned burst through the 18-connection API pool", async () => {
    assert.equal((pool as any).options.max, 18);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    let responses: Awaited<ReturnType<typeof requestJson>>[];
    try {
      responses = await Promise.all(
        primaryDeviceIds.map((deviceId, index) =>
          requestJson(
            index % 2 === 0
              ? `/api/classpilot/device/screenshot/${deviceId}`
              : `/api/classpilot/heartbeats/${deviceId}?limit=1`,
            teacher,
            schoolA.id,
            controller.signal
          )
        )
      );
    } finally {
      clearTimeout(timeout);
    }

    assert.equal(responses.length, 40);
    assert.ok(responses.every((response) => response.status === 200));
    assert.ok(responses.every((response) => response.rateLimit === "5000"));
    assert.ok(pool.totalCount > 0);
    assert.ok(pool.totalCount <= 18);

    await waitForMainPoolDrain();
    assert.equal(pool.waitingCount, 0);
    assert.equal(pool.idleCount, pool.totalCount);
  });
});
