import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

// These values must be set before importing any application module. The test
// models the production API process (not the scheduler worker) and deliberately
// exercises the reviewed API split of 16 request/RLS connections plus two
// independent web-session connections.
process.env.NODE_ENV = "test";
process.env.SCHEDULER_ENABLED = "false";
process.env.DB_POOL_MAX = "16";
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
const { classpilotScreenshotFallback } = await import(
  "../dist/services/classpilotScreenshotFallback.js"
);
const { screenshotBindingVersion, supervisionBoundScreenshotBindingVersion } = await import("../dist/realtime/ws-redis.js");
const { setClasspilotRealtimeStatusCommandForTests } = await import("../dist/services/classpilotRealtimeStatus.js");
const { setHeartbeatTileCacheCommandForTests } = await import("../dist/services/heartbeatTileCache.js");

const { runWithTenantContext } = tenantContext;
const {
  createMembership,
  createProductLicense,
  createSchool,
  createUser,
} = storage;
const { signUserToken } = jwt;
const { createApp } = appModule;
const { and, eq, sql } = drizzle;
const {
  classpilotStudentControlStates,
  classpilotSupervisionContexts,
  classpilotSupervisionStudents,
  devices,
  groupStudents,
  groupTeachers,
  groups,
  heartbeats,
  productLicenses,
  schoolMemberships,
  schools,
  studentDevices,
  studentSessions,
  studentTimelineEvents,
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
let coTeacher: any;
let superAdmin: any;
let admin: any;
let schoolAdmin: any;
let officeStaff: any;
let parent: any;
let server: Server;
let baseUrl = "";
let authorizedStudentIds: string[] = [];
let otherStudentId = "";
let activeGroupId = "";
let activeTeachingSessionId = "";
const activeStudentSessionIdByDevice = new Map<string, string>();

function exactScreenshotBinding(deviceId: string) {
  const studentIndex = primaryDeviceIds.indexOf(deviceId);
  const studentId = authorizedStudentIds[studentIndex];
  const studentSessionId = activeStudentSessionIdByDevice.get(deviceId);
  assert.ok(studentId && studentSessionId, `missing exact screenshot binding for ${deviceId}`);
  return { schoolId: schoolA.id, deviceId, studentId, studentSessionId };
}

function storeExactScreenshot(deviceId: string, overrides: Record<string, unknown> = {}) {
  const binding = exactScreenshotBinding(deviceId);
  const timestamp = typeof overrides.timestamp === "number" ? overrides.timestamp : Date.now();
  return classpilotScreenshotFallback.set(binding, {
    screenshot: `data:image/jpeg;base64,${Buffer.from(deviceId).toString("base64")}`,
    timestamp,
    capturedAt: new Date(timestamp).toISOString(),
    tabTitle: "Synthetic tile",
    ...binding,
    bindingVersion: screenshotBindingVersion(binding),
    ...overrides,
  });
}

function seedExactScreenshots(excludedDeviceId?: string) {
  classpilotScreenshotFallback.clear();
  for (const deviceId of primaryDeviceIds) {
    if (deviceId !== excludedDeviceId) assert.equal(storeExactScreenshot(deviceId), true);
  }
}

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
    isSuperAdmin: Boolean(user.isSuperAdmin),
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
  signal?: AbortSignal,
  extraHeaders: Record<string, string> = {}
): Promise<{
  status: number;
  body: any;
  rateLimit: string | null;
}> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { ...authHeaders(user, schoolId), ...extraHeaders },
    signal,
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    rateLimit: response.headers.get("ratelimit-limit"),
  };
}

async function postJson(
  path: string,
  body: unknown,
  user: any,
  schoolId = schoolA.id,
  signal?: AbortSignal,
  extraHeaders: Record<string, string> = {}
): Promise<{
  status: number;
  body: any;
  cacheControl: string | null;
  rateLimit: string | null;
}> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      ...authHeaders(user, schoolId),
      "content-type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    cacheControl: response.headers.get("cache-control"),
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
  assert.equal((pool as any).options.max, 16);
  assert.equal((sessionPool as any).options.max, 2);

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

  for (const school of [schoolA, schoolB]) await inSchool(school.id, () =>
    storage.upsertSettings(school.id, { schoolName: school.name, wsSharedKey: tag, enableTrackingHours: false }));

  [teacher, coTeacher, superAdmin, admin, schoolAdmin, officeStaff, parent] = await Promise.all([
    createUser({
      email: `${tag}-teacher@${schoolADomain}`,
      firstName: "Synthetic",
      lastName: "Teacher",
    } as any),
    createUser({
      email: `${tag}-co-teacher@${schoolADomain}`,
      firstName: "Synthetic",
      lastName: "Co Teacher",
    } as any),
    createUser({
      email: `${tag}-super-admin@${schoolADomain}`,
      firstName: "Synthetic",
      lastName: "Super Admin",
      isSuperAdmin: true,
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
      [coTeacher, "teacher"],
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
    const activeStudentSessions = await db.insert(studentSessions).values(
      primaryDeviceIds.map((deviceId, index) => ({
        studentId: authorizedStudentIds[index]!,
        deviceId,
        authKind: "managed_profile" as const,
        isActive: true,
      }))
    ).returning({
      id: studentSessions.id,
      deviceId: studentSessions.deviceId,
    });
    for (const session of activeStudentSessions) {
      activeStudentSessionIdByDevice.set(session.deviceId, session.id);
    }
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
    activeGroupId = group.id;
    await db.insert(groupStudents).values(
      authorizedStudentIds.map((studentId) => ({
        groupId: group.id,
        studentId,
      }))
    );
    await db.insert(groupTeachers).values({
      groupId: group.id,
      teacherId: coTeacher.id,
      role: "co-teacher",
    });
    const [teachingSession] = await db.insert(teachingSessions).values({
      schoolId: schoolA.id,
      groupId: group.id,
      teacherId: teacher.id,
      sessionMode: "live",
      endTime: null,
    }).returning({ id: teachingSessions.id });
    assert.ok(teachingSession?.id);
    activeTeachingSessionId = teachingSession.id;
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

  seedExactScreenshots();

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
        DELETE FROM group_teachers
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
    classpilotScreenshotFallback.clear();
    await Promise.allSettled([
      pool.end(),
      sessionPool.end(),
      schedulerPool.end(),
      schedulerLockPool.end(),
    ]);
  }
});

describe("ClassPilot tile-read tenant scope", () => {
  it("serves authorized student batches without revealing devices or denied ids", async () => {
    const requested = [authorizedStudentIds[0]!, otherStudentId];
    const screenshots = await postJson(
      "/api/classpilot/tiles/screenshots",
      { studentIds: requested },
      teacher
    );
    assert.equal(screenshots.status, 200);
    assert.equal(screenshots.cacheControl, "no-store");
    assert.deepEqual(
      screenshots.body.tiles.map((tile: { studentId: string }) => tile.studentId),
      [authorizedStudentIds[0]]
    );
    // Without fresh exact capability telemetry, the new reader is V2-only and
    // must not downgrade to the seeded legacy screenshot.
    assert.equal(screenshots.body.tiles[0].screenshot, null);
    assert.doesNotMatch(JSON.stringify(screenshots.body), /deviceId|device_id|denied/i);

    const history = await postJson(
      "/api/classpilot/tiles/history",
      { studentIds: requested, limit: 10 },
      teacher
    );
    assert.equal(history.status, 200);
    assert.equal(history.cacheControl, "no-store");
    assert.deepEqual(
      history.body.tiles.map((tile: { studentId: string }) => tile.studentId),
      [authorizedStudentIds[0]]
    );
    assert.ok(history.body.tiles[0].heartbeats.length >= 1);
    assert.ok(history.body.tiles[0].heartbeats.every(
      (heartbeat: { studentId: string }) => heartbeat.studentId === authorizedStudentIds[0]
    ));
    assert.doesNotMatch(JSON.stringify(history.body), /deviceId|device_id|denied/i);

    const inaccessible = await postJson(
      "/api/classpilot/tiles/history",
      { studentIds: [otherStudentId] },
      teacher
    );
    assert.equal(inaccessible.status, 404);
    assert.deepEqual(inaccessible.body, { error: "No accessible tiles", code: "CLASSPILOT_NO_ACCESSIBLE_TILES" });
  });

  it("fails closed without the selected tenant RLS context", async () => {
    const options = {
      schoolId: schoolA.id,
      staffId: teacher.id,
      role: "teacher" as const,
      isSuperAdmin: false,
    };
    const withoutTenant = await storage.getBatchTileAccessForStaff(
      options,
      [authorizedStudentIds[0]],
      "live"
    );
    assert.equal(withoutTenant.size, 0);
    const wrongTenant = await inSchool(schoolB.id, () =>
      storage.getBatchTileAccessForStaff(
        options,
        [authorizedStudentIds[0]],
        "live"
      )
    );
    assert.equal(wrongTenant.size, 0);
    const selectedTenant = await inSchool(schoolA.id, () =>
      storage.getBatchTileAccessForStaff(
        options,
        [authorizedStudentIds[0]],
        "live"
      )
    );
    assert.equal(selectedTenant.size, 1);
  });

  it("returns accessible empty tiles and validates bounded batch input", async () => {
    const deviceId = primaryDeviceIds[2]!;
    const studentId = authorizedStudentIds[2]!;
    seedExactScreenshots(deviceId);
    try {
      const response = await postJson(
        "/api/classpilot/tiles/screenshots",
        { studentIds: [studentId] },
        teacher
      );
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, {
        tiles: [{ studentId, screenshot: null }],
      });
    } finally {
      seedExactScreenshots();
    }

    for (const body of [
      { studentIds: [] },
      { studentIds: "not-an-array" },
      { studentIds: Array.from({ length: 51 }, (_, index) => `student-${index}`) },
      { studentIds: [studentId], limit: 11 },
    ]) {
      const path = "limit" in body
        ? "/api/classpilot/tiles/history"
        : "/api/classpilot/tiles/screenshots";
      const response = await postJson(path, body, teacher);
      assert.equal(response.status, 400);
      assert.equal(response.cacheControl, "no-store");
    }
  });

  it("never serves a stale screenshot after a shared-device student switch", async () => {
    const deviceId = primaryDeviceIds[0]!;
    const studentId = authorizedStudentIds[0]!;
    try {
      storeExactScreenshot(deviceId, {
        screenshot: "data:image/jpeg;base64,c3RhbGUtc3R1ZGVudA==",
        timestamp: Date.now(),
        studentId: otherStudentId,
        studentSessionId: randomUUID(),
      });

      const switchedBatch = await postJson(
        "/api/classpilot/tiles/screenshots",
        { studentIds: [studentId] },
        teacher
      );
      assert.equal(switchedBatch.status, 200);
      assert.deepEqual(switchedBatch.body, {
        tiles: [{ studentId, screenshot: null }],
      });
      const switchedLegacy = await requestJson(
        `/api/classpilot/device/screenshot/${deviceId}`,
        teacher
      );
      assert.equal(switchedLegacy.status, 403);
      assert.match(switchedLegacy.body.error, /Insufficient permissions/i);

      storeExactScreenshot(deviceId, {
        screenshot: "data:image/jpeg;base64,c3RhbGUtdHRs",
        timestamp: Date.now() - 121_000,
      });
      const expiredBatch = await postJson(
        "/api/classpilot/tiles/screenshots",
        { studentIds: [studentId] },
        teacher
      );
      assert.equal(expiredBatch.status, 200);
      assert.deepEqual(expiredBatch.body, {
        tiles: [{ studentId, screenshot: null }],
      });
      assert.equal((await requestJson(
        `/api/classpilot/device/screenshot/${deviceId}`,
        teacher
      )).status, 403);
    } finally {
      seedExactScreenshots();
    }
  });

  it("keeps shared-device batch history isolated for school-wide staff", async () => {
    const history = await postJson(
      "/api/classpilot/tiles/history",
      { studentIds: [authorizedStudentIds[0], otherStudentId], limit: 10 },
      admin
    );
    assert.equal(history.status, 200);
    assert.deepEqual(
      history.body.tiles.map((tile: { studentId: string }) => tile.studentId),
      [authorizedStudentIds[0], otherStudentId]
    );
    for (const tile of history.body.tiles as Array<{
      studentId: string;
      heartbeats: Array<{ studentId: string }>;
    }>) {
      assert.ok(tile.heartbeats.length >= 1);
      assert.ok(tile.heartbeats.every((heartbeat) => heartbeat.studentId === tile.studentId));
    }
    assert.doesNotMatch(JSON.stringify(history.body), /deviceId|device_id/);
  });

  it("grants active co-teachers and denies ended or non-live class sessions", async () => {
    const studentId = authorizedStudentIds[3]!;
    const request = () => postJson(
      "/api/classpilot/tiles/screenshots",
      { studentIds: [studentId] },
      coTeacher
    );
    assert.equal((await request()).status, 200);

    await inSchool(schoolA.id, async () => {
      await db
        .update(teachingSessions)
        .set({ endTime: new Date() })
        .where(eq(teachingSessions.id, activeTeachingSessionId));
    });
    try {
      assert.equal((await request()).status, 404);
    } finally {
      await inSchool(schoolA.id, async () => {
        await db
          .update(teachingSessions)
          .set({ endTime: null })
          .where(eq(teachingSessions.id, activeTeachingSessionId));
      });
    }

    await inSchool(schoolA.id, async () => {
      await db
        .update(teachingSessions)
        .set({ sessionMode: "scheduled_report" })
        .where(eq(teachingSessions.id, activeTeachingSessionId));
    });
    try {
      assert.equal((await request()).status, 404);
    } finally {
      await inSchool(schoolA.id, async () => {
        await db
          .update(teachingSessions)
          .set({ sessionMode: "live" })
          .where(eq(teachingSessions.id, activeTeachingSessionId));
      });
    }
    assert.equal((await request()).status, 200);
  });

  it("applies roster and active-session grants and revocations on the next batch request", async () => {
    const studentId = authorizedStudentIds[4]!;
    const deviceId = primaryDeviceIds[4]!;
    const screenshotRequest = () => postJson(
      "/api/classpilot/tiles/screenshots",
      { studentIds: [studentId] },
      teacher
    );
    assert.equal((await screenshotRequest()).status, 200);

    await inSchool(schoolA.id, async () => {
      await db
        .delete(groupStudents)
        .where(and(
          eq(groupStudents.groupId, activeGroupId),
          eq(groupStudents.studentId, studentId)
        ));
    });
    try {
      assert.equal((await screenshotRequest()).status, 404);
    } finally {
      await inSchool(schoolA.id, async () => {
        await db.insert(groupStudents).values({
          groupId: activeGroupId,
          studentId,
        });
      });
    }
    assert.equal((await screenshotRequest()).status, 200);

    await inSchool(schoolA.id, async () => {
      await db
        .update(studentSessions)
        .set({ isActive: false, endedAt: new Date() })
        .where(and(
          eq(studentSessions.studentId, studentId),
          eq(studentSessions.deviceId, deviceId)
        ));
    });
    try {
      assert.equal((await screenshotRequest()).status, 404);
      // Historical access follows student_devices and remains available after
      // the live device session ends.
      assert.equal((await postJson(
        "/api/classpilot/tiles/history",
        { studentIds: [studentId] },
        teacher
      )).status, 200);
    } finally {
      await inSchool(schoolA.id, async () => {
        await db
          .update(studentSessions)
          .set({ isActive: true, endedAt: null })
          .where(and(
            eq(studentSessions.studentId, studentId),
            eq(studentSessions.deviceId, deviceId)
          ));
      });
    }
    assert.equal((await screenshotRequest()).status, 200);
  });

  it("defaults teacher tile history to ten rows while preserving bounded explicit limits", async () => {
    const deviceId = primaryDeviceIds.at(-1)!;
    const studentId = authorizedStudentIds.at(-1)!;
    const firstTimestamp = Date.now() - 20_000;
    await inSchool(schoolA.id, async () => {
      await db
        .delete(heartbeats)
        .where(and(eq(heartbeats.schoolId, schoolA.id), eq(heartbeats.deviceId, deviceId)));
      await db.insert(heartbeats).values(
        Array.from({ length: 14 }, (_unused, index) => ({
          deviceId,
          studentId,
          schoolId: schoolA.id,
          activeTabTitle: `Bounded history ${index + 1}`,
          activeTabUrl: `https://example.invalid/bounded/${index + 1}`,
          timestamp: new Date(firstTimestamp + index * 1_000),
        }))
      );
    });

    const recent = await postJson(
      "/api/classpilot/tiles/history",
      { studentIds: [studentId] },
      teacher
    );
    assert.equal(recent.status, 200);
    assert.equal(recent.body.tiles[0].heartbeats.length, 10);
    assert.equal(recent.body.tiles[0].heartbeats[0].activeTabTitle, "Bounded history 14");
    assert.equal(recent.body.tiles[0].heartbeats.at(-1).activeTabTitle, "Bounded history 5");
    assert.doesNotMatch(JSON.stringify(recent.body), /deviceId|device_id/);

    const explicit = await postJson(
      "/api/classpilot/tiles/history",
      { studentIds: [studentId], limit: 7 },
      teacher
    );
    assert.equal(explicit.status, 200);
    assert.equal(explicit.body.tiles[0].heartbeats.length, 7);
    assert.equal(explicit.body.tiles[0].heartbeats.at(-1).activeTabTitle, "Bounded history 8");
  });

  it("keeps raw device reads admin-only while scoping teacher tiles by student", async () => {
    const path = `/api/classpilot/device/screenshot/${primaryDeviceIds[0]}`;

    for (const allowed of [admin, schoolAdmin, superAdmin]) {
      const response = await requestJson(path, allowed);
      assert.equal(response.status, 404);
      assert.equal(response.rateLimit, "5000");
      assert.equal(response.body.error, "No screenshot available");
    }
    for (const denied of [teacher, coTeacher, officeStaff, parent]) {
      const response = await requestJson(path, denied);
      assert.equal(response.status, 403);
      assert.match(response.body.error, /Insufficient permissions/i);
    }
    for (const allowed of [teacher, coTeacher, admin, schoolAdmin, superAdmin]) {
      const response = await postJson(
        "/api/classpilot/tiles/screenshots",
        { studentIds: [authorizedStudentIds[0]] },
        allowed
      );
      assert.equal(response.status, 200);
    }

    const parentBatchResponse = await postJson(
      "/api/classpilot/tiles/screenshots",
      { studentIds: [authorizedStudentIds[0]] },
      parent
    );
    assert.equal(parentBatchResponse.status, 403);
    assert.match(parentBatchResponse.body.error, /Insufficient permissions/i);

    const parentLegacyDeviceList = await requestJson(
      "/api/classpilot/devices",
      parent
    );
    assert.equal(parentLegacyDeviceList.status, 403);
    assert.match(parentLegacyDeviceList.body.error, /Insufficient permissions/i);

    // Office staff are a valid ClassPilot staff role, but they may read a tile
    // only when an active coverage context assigns that student to them.
    const officeBatchResponse = await postJson(
      "/api/classpilot/tiles/screenshots",
      { studentIds: [authorizedStudentIds[0]] },
      officeStaff
    );
    assert.equal(officeBatchResponse.status, 404);
    assert.deepEqual(officeBatchResponse.body, { error: "No accessible tiles", code: "CLASSPILOT_NO_ACCESSIBLE_TILES" });
  });

  it("fails closed for device-only screenshot detail after a session goes offline", async () => {
    const deviceId = primaryDeviceIds[5]!;
    const studentId = authorizedStudentIds[5]!;
    storeExactScreenshot(deviceId, {
      screenshot: "data:image/jpeg;base64,b2ZmbGluZS1hZG1pbi1kZXRhaWw=",
      timestamp: Date.now(),
      tabTitle: "Offline administrator detail",
    });
    await inSchool(schoolA.id, async () => {
      await db
        .update(studentSessions)
        .set({ isActive: false, endedAt: new Date() })
        .where(eq(studentSessions.deviceId, deviceId));
    });

    try {
      for (const schoolWideUser of [admin, schoolAdmin, superAdmin]) {
        const legacy = await requestJson(
          `/api/classpilot/device/screenshot/${deviceId}`,
          schoolWideUser
        );
        assert.equal(legacy.status, 404);
        assert.deepEqual(legacy.body, { error: "No screenshot available" });

        const batch = await postJson(
          "/api/classpilot/tiles/screenshots",
          { studentIds: [studentId] },
          schoolWideUser
        );
        assert.equal(batch.status, 404);
        assert.deepEqual(batch.body, { error: "No accessible tiles", code: "CLASSPILOT_NO_ACCESSIBLE_TILES" });
      }
    } finally {
      await inSchool(schoolA.id, async () => {
        await db
          .update(studentSessions)
          .set({ isActive: true, endedAt: null })
          .where(eq(studentSessions.deviceId, deviceId));
      });
      storeExactScreenshot(deviceId);
    }
  });

  it("keeps restricted legacy screenshot reads bound to an active student session", async () => {
    const deviceId = primaryDeviceIds[6]!;
    const studentId = authorizedStudentIds[6]!;
    storeExactScreenshot(deviceId, {
      screenshot: "data:image/jpeg;base64,b2ZmbGluZS1yZXN0cmljdGVk",
      timestamp: Date.now(),
    });
    await inSchool(schoolA.id, async () => {
      await db
        .update(studentSessions)
        .set({ isActive: false, endedAt: new Date() })
        .where(eq(studentSessions.deviceId, deviceId));
    });

    let contextId: string | undefined;
    try {
      // Raw device history and screenshot routes remain administrator-only.
      assert.equal((await requestJson(
        `/api/classpilot/heartbeats/${deviceId}`,
        teacher
      )).status, 403);
      assert.equal((await requestJson(
        `/api/classpilot/device/screenshot/${deviceId}`,
        teacher
      )).status, 403);

      contextId = await inSchool(schoolA.id, async () => {
        const [context] = await db
          .insert(classpilotSupervisionContexts)
          .values({
            schoolId: schoolA.id,
            contextType: "office",
            name: `${tag} offline isolation`,
            status: "active",
            assignedStaffId: officeStaff.id,
            createdBy: admin.id,
            endsAt: new Date(Date.now() + 60 * 60 * 1000),
          })
          .returning({ id: classpilotSupervisionContexts.id });
        assert.ok(context?.id);
        await db.insert(classpilotSupervisionStudents).values({
          schoolId: schoolA.id,
          contextId: context.id,
          studentId,
          source: "admin_reroute",
          assignedBy: admin.id,
        });
        return context.id;
      });

      // Active supervision grants the office user student-scoped history, but
      // never grants raw device routes or turns an offline cache into a live tile.
      assert.equal((await requestJson(
        `/api/classpilot/heartbeats/${deviceId}`,
        officeStaff
      )).status, 403);
      assert.equal((await requestJson(
        `/api/classpilot/device/screenshot/${deviceId}`,
        officeStaff
      )).status, 403);
      assert.equal((await postJson(
        "/api/classpilot/tiles/history",
        { studentIds: [studentId] },
        officeStaff
      )).status, 200);
      assert.equal((await postJson(
        "/api/classpilot/tiles/screenshots",
        { studentIds: [studentId] },
        officeStaff
      )).status, 404);
    } finally {
      await inSchool(schoolA.id, async () => {
        if (contextId) {
          await db
            .delete(classpilotSupervisionStudents)
            .where(eq(classpilotSupervisionStudents.contextId, contextId));
          await db
            .delete(classpilotSupervisionContexts)
            .where(eq(classpilotSupervisionContexts.id, contextId));
        }
        await db
          .update(studentSessions)
          .set({ isActive: true, endedAt: null })
          .where(eq(studentSessions.deviceId, deviceId));
      });
      storeExactScreenshot(deviceId);
    }
  });

  it("returns only same-school tile data and hides foreign devices", async () => {
    const teacherRawHistory = await requestJson(
      `/api/classpilot/heartbeats/${primaryDeviceIds[0]}?limit=100`,
      teacher
    );
    assert.equal(teacherRawHistory.status, 403);
    assert.match(teacherRawHistory.body.error, /Insufficient permissions/i);

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
      admin
    );
    assert.equal(foreignScreenshot.status, 404);
    assert.match(foreignScreenshot.body.error, /Device not found/i);

    const foreignHistory = await requestJson(
      `/api/classpilot/heartbeats/${foreignDeviceId}?limit=1`,
      admin
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

  it("keeps scheduled classroom aggregate and screenshots on their exact supervision authority", async () => {
    const oldMode = process.env.CLASSPILOT_SCHEDULED_CLASSROOM_MODE;
    const oldPreview = process.env.CLASSPILOT_SUPERVISION_PREVIEW_MODE;
    process.env.CLASSPILOT_SCHEDULED_CLASSROOM_MODE = "on";
    const studentId = authorizedStudentIds[0]!;
    const offlineStudentId = authorizedStudentIds[1]!;
    const deviceId = primaryDeviceIds[0]!;
    let contextId = "";
    try {
      contextId = await inSchool(schoolA.id, async () => {
        const [context] = await db.insert(classpilotSupervisionContexts).values({
          schoolId: schoolA.id, contextType: "testing", name: `${tag} scheduled classroom`,
          status: "active", assignedStaffId: coTeacher.id, createdBy: admin.id,
          startsAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 3_600_000),
          scheduleProfileApplicationId: `${tag}-application`, scheduleProfileDate: "2026-09-15",
          scheduleProfileBlockId: `${tag}-block`,
        }).returning({ id: classpilotSupervisionContexts.id });
        assert.ok(context);
        await db.insert(classpilotSupervisionStudents).values([studentId, offlineStudentId].map((id) => ({
          schoolId: schoolA.id, contextId: context.id, studentId: id, source: "admin_reroute", assignedBy: admin.id,
          assignedAt: new Date(Date.now() - 30_000),
        })));
        await db.insert(studentTimelineEvents).values([
          { title: `${tag} before assignment`, occurredAt: new Date(Date.now() - 45_000) },
          { title: `${tag} during assignment`, occurredAt: new Date(Date.now() - 10_000) },
          { title: `${tag} future event`, occurredAt: new Date(Date.now() + 120_000) },
        ].map(event => ({ ...event, schoolId: schoolA.id, studentId, eventType: 'classroom_context', sourceType: 'classpilot', sourceId: context.id })));
        await db.update(studentSessions).set({ isActive: false, endedAt: new Date() })
          .where(eq(studentSessions.studentId, offlineStudentId));
        await db.insert(classpilotStudentControlStates).values({ schoolId: schoolA.id, studentId,
          teachingSessionId: activeTeachingSessionId, revision: 4,
          desiredState: { screenLocked: true }, hardExpiresAt: new Date(Date.now() + 3_600_000),
        });
        return context.id;
      });
      const aggregate = () => requestJson(`/api/students-aggregated?supervisionContextId=${contextId}`, coTeacher);
      const timeline = (id = studentId, query = `supervisionContextId=${contextId}`, actor = coTeacher, revision = '0') =>
        requestJson(`/api/classpilot/students/${id}/timeline?${query}`, actor, schoolA.id, undefined,
          { 'X-ClassPilot-Context-Authority-Revision': revision });
      const first = await aggregate();
      const discovery = await requestJson('/api/classpilot/observable-activities', admin);
      assert.equal(discovery.status, 200);
      const observed = discovery.body.activities.find((row: { id: string }) => row.id === contextId);
      assert.equal(observed.purpose, 'testing');
      assert.equal(observed.authority.supervisionContextId, contextId);
      assert.equal(observed.authority.contextAuthorityRevision, '0');
      assert.equal(observed.owner.id, coTeacher.id);
      assert.equal(observed.studentCount, 2);
      assert.equal(observed.capabilities.commands, false);
      assert.equal(observed.capabilities.fab, false);
      assert.doesNotMatch(JSON.stringify(discovery.body), /deviceId|studentSessionId|chat|content/);
      assert.equal((await requestJson('/api/classpilot/observable-activities', teacher)).status, 403);
      assert.equal((await requestJson(`/api/students-aggregated?supervisionContextId=${contextId}`, admin,
        schoolA.id, undefined, { 'X-ClassPilot-Context-Authority-Revision': '1' })).status, 409);
      assert.equal((await requestJson(`/api/students-aggregated?supervisionContextId=${contextId}`, admin,
        schoolA.id, undefined, { 'X-ClassPilot-Context-Authority-Revision': '0' })).status, 200);
      assert.equal(first.status, 200);
      assert.deepEqual(first.body.map((row: any) => row.studentId).sort(), [studentId, offlineStudentId].sort());
      assert.equal(first.body.find((row: any) => row.studentId === offlineStudentId).isLoggedIn, false);
      assert.ok(first.body.every((row: any) => row.supervisionContext.id === contextId));
      assert.ok(first.body.every((row: any) => row.operatorCapabilities.scheduledClassroomV1));
      assert.equal(first.body.find((row: any) => row.studentId === studentId).classroomState, undefined,
        "the previous class desired state cannot become this supervision's state");
      assert.doesNotMatch(JSON.stringify(first.body), /deviceId|device_id/);
      assert.equal((await requestJson(`/api/students-aggregated?supervisionContextId=${randomUUID()}`, admin)).status, 404);
      assert.equal((await requestJson(`/api/students-aggregated?supervisionContextId=${contextId}`, teacher)).status, 404);
      assert.equal((await requestJson(`/api/students-aggregated?supervisionContextId=${contextId}&teachingSessionId=${activeTeachingSessionId}`, admin)).status, 400);
      assert.equal((await requestJson('/api/students-aggregated?supervisionContextId=', admin)).status, 400);
      await inSchool(schoolA.id, () => db.update(classpilotStudentControlStates)
        .set({ teachingSessionId: null, supervisionContextId: contextId })
        .where(and(eq(classpilotStudentControlStates.schoolId, schoolA.id), eq(classpilotStudentControlStates.studentId, studentId))));
      const history = await timeline();
      assert.equal(history.status, 200);
      assert.equal((await timeline(studentId, `supervisionContextId=${contextId}`, coTeacher, '1')).status, 403, 'Stale tenure cannot read current history');
      assert.deepEqual(history.body.events.filter((event: { title: string }) => event.title.startsWith(tag)).map((event: { title: string }) => event.title), [`${tag} during assignment`]);
      assert.equal((await timeline(otherStudentId)).status, 403, 'Unassigned students have no context history');
      assert.equal((await timeline(studentId, `supervisionContextId=${randomUUID()}`)).status, 403);
      assert.equal((await timeline(studentId, `supervisionContextId=${contextId}`, teacher)).status, 403);
      assert.equal((await timeline(studentId, `supervisionContextId=${contextId}&teachingSessionId=${activeTeachingSessionId}`)).status, 400);
      const own = await aggregate();
      assert.equal(own.body.find((row: any) => row.studentId === studentId).classroomState.supervisionContextId, contextId);
      const binding = { ...exactScreenshotBinding(deviceId), supervisionContextId: contextId, controlRevision: 4 };
      const screenshot = "data:image/jpeg;base64,c2NoZWR1bGVkLWNvbnRleHQ=";
      const timestamp = Date.now();
      assert.equal(classpilotScreenshotFallback.setSupervisionBound(binding, {
        ...binding, screenshot, timestamp, capturedAt: new Date(timestamp).toISOString(),
        bindingVersion: supervisionBoundScreenshotBindingVersion(binding),
      }), true);
      const tiles = () => postJson('/api/classpilot/tiles/screenshots', { studentIds: [studentId], supervisionContextId: contextId }, coTeacher);
      const exact = await tiles();
      assert.equal(exact.status, 200);
      assert.equal(exact.body.tiles[0].screenshot?.screenshot, screenshot);
      const observedTile = await postJson('/api/classpilot/tiles/screenshots', { studentIds: [studentId], supervisionContextId: contextId },
        admin, schoolA.id, undefined, { 'X-ClassPilot-Context-Authority-Revision': '0' });
      assert.equal(observedTile.status, 200);
      assert.equal(observedTile.body.tiles[0].screenshot?.screenshot, screenshot);
      let revisionMutationError: unknown;
      let revisionMutationObserved = false;
      try {
        setClasspilotRealtimeStatusCommandForTests(async args => {
          if (args[0] !== 'MGET') return undefined;
          revisionMutationObserved = true;
          try {
            const changed = await inSchool(schoolA.id, () => db.update(classpilotSupervisionContexts)
              .set({ assignedStaffId: teacher.id }).where(eq(classpilotSupervisionContexts.id, contextId))
              .returning({ revision: classpilotSupervisionContexts.classroomAuthorityRevision }));
            assert.deepEqual(changed, [{ revision: 1 }]);
          } catch (error) { revisionMutationError = error; throw error; }
          return args.slice(1).map(() => null);
        });
        const revokedDuringRead = await postJson('/api/classpilot/tiles/screenshots',
          { studentIds: [studentId], supervisionContextId: contextId }, admin, schoolA.id, undefined,
          { 'X-ClassPilot-Context-Authority-Revision': '0' });
        assert.equal(revisionMutationObserved, true, 'The read must reach the delayed realtime transport');
        if (revisionMutationError) throw revisionMutationError;
        assert.equal(revokedDuringRead.status, 409, 'An in-flight cache read cannot return pixels after context revision changes');
        assert.equal(JSON.stringify(revokedDuringRead.body).includes(screenshot), false);
      } finally {
        setClasspilotRealtimeStatusCommandForTests(undefined);
        await inSchool(schoolA.id, () => db.update(classpilotSupervisionContexts)
          .set({ assignedStaffId: coTeacher.id }).where(eq(classpilotSupervisionContexts.id, contextId)));
      }
      try {
        setHeartbeatTileCacheCommandForTests(async args => {
          if (args[0] !== 'EVAL') return undefined;
          await inSchool(schoolA.id, () => db.update(classpilotSupervisionContexts)
            .set({ assignedStaffId: teacher.id }).where(eq(classpilotSupervisionContexts.id, contextId)));
          return undefined;
        });
        const revokedHistory = await postJson('/api/classpilot/tiles/history',
          { studentIds: [studentId], supervisionContextId: contextId }, admin, schoolA.id, undefined,
          { 'X-ClassPilot-Context-Authority-Revision': '2' });
        assert.equal(revokedHistory.status, 409, 'An in-flight history read cannot outlive its context revision');
      } finally {
        setHeartbeatTileCacheCommandForTests(undefined);
        await inSchool(schoolA.id, () => db.update(classpilotSupervisionContexts)
          .set({ assignedStaffId: coTeacher.id }).where(eq(classpilotSupervisionContexts.id, contextId)));
      }
      assert.equal((await postJson('/api/classpilot/tiles/screenshots', { studentIds: [studentId], supervisionContextId: contextId },
        admin, schoolA.id, undefined, { 'X-ClassPilot-Context-Authority-Revision': '1' })).status, 409);
      assert.equal((await requestJson(`/api/students-aggregated?supervisionContextId=${contextId}`, teacher)).status, 404,
        'Observe does not transfer the existing owner');
      try {
        setClasspilotRealtimeStatusCommandForTests(async args => {
          if (args[0] !== 'MGET') return undefined;
          await inSchool(schoolA.id, () => db.update(classpilotStudentControlStates).set({ revision: 5 })
            .where(and(eq(classpilotStudentControlStates.schoolId, schoolA.id), eq(classpilotStudentControlStates.studentId, studentId))));
          return args.slice(1).map(() => null);
        });
        assert.equal((await tiles()).body.tiles[0].screenshot, null,
          'A student control change during cache reads cannot return the earlier capture');
      } finally {
        setClasspilotRealtimeStatusCommandForTests(undefined);
      }
      assert.equal((await tiles()).body.tiles[0].screenshot, null, "never downgrade to the prior revision or legacy screenshot");
      assert.equal((await postJson('/api/classpilot/tiles/screenshots', { studentIds: [studentId], supervisionContextId: randomUUID() }, coTeacher)).status, 404);
      try {
        setClasspilotRealtimeStatusCommandForTests(async args => {
          if (args[0] !== 'MGET') return undefined;
          await inSchool(schoolA.id, () => db.update(classpilotSupervisionStudents).set({ releasedAt: new Date() })
            .where(and(eq(classpilotSupervisionStudents.contextId, contextId), eq(classpilotSupervisionStudents.studentId, studentId))));
          return args.slice(1).map(() => null);
        });
        const releasedDuringHydration = await aggregate();
        assert.equal(releasedDuringHydration.status, 200);
        assert.deepEqual(releasedDuringHydration.body.map((row: { studentId: string }) => row.studentId), [offlineStudentId],
          'A release during realtime hydration removes only that student and preserves offline roster members');
      } finally {
        setClasspilotRealtimeStatusCommandForTests(undefined);
      }
      assert.equal((await tiles()).status, 404);
      assert.equal((await timeline()).status, 403, 'Release revokes history in the same context');
      assert.deepEqual((await aggregate()).body.map((row: any) => row.studentId), [offlineStudentId]);
      process.env.CLASSPILOT_SCHEDULED_CLASSROOM_MODE = "off";
      assert.equal((await aggregate()).status, 404);
      assert.equal((await tiles()).status, 404);
      process.env.CLASSPILOT_SCHEDULED_CLASSROOM_MODE = "on";
      await inSchool(schoolA.id, () => db.update(classpilotSupervisionContexts).set({
        scheduleProfileApplicationId: null, scheduleProfileDate: null, scheduleProfileBlockId: null,
      }).where(eq(classpilotSupervisionContexts.id, contextId)));
      // An ad hoc claim is the same classroom a scheduled block gets. A teacher who
      // claims students has taken responsibility for them, so the holder keeps the
      // roster once the scheduled origin is gone.
      const adHoc = await aggregate();
      assert.equal(adHoc.status, 200, "an ad hoc claim keeps the classroom a scheduled block had");
      assert.deepEqual(adHoc.body.map((row: any) => row.studentId), [offlineStudentId]);
      // Origin widens no boundary. A released student stays out, a teacher who does
      // not hold the claim still cannot read it, and a bogus id is still absent.
      assert.equal((await tiles()).status, 404, "release revokes tiles for an ad hoc claim too");
      assert.equal((await requestJson(`/api/students-aggregated?supervisionContextId=${contextId}`, teacher)).status, 404,
        "an ad hoc claim is no more readable by a teacher who does not hold it");
      assert.equal((await requestJson(`/api/students-aggregated?supervisionContextId=${randomUUID()}`, coTeacher)).status, 404);
      // The two switches cover different origins: the scheduled mode governs a
      // scheduled block, the preview mode governs an ad hoc claim. Turning off the
      // scheduled one alone must NOT be mistaken for having stopped both.
      process.env.CLASSPILOT_SCHEDULED_CLASSROOM_MODE = "off";
      assert.equal((await aggregate()).status, 200, "the scheduled switch does not govern an ad hoc claim");
      process.env.CLASSPILOT_SUPERVISION_PREVIEW_MODE = "off";
      assert.equal((await aggregate()).status, 404, "the preview switch does govern an ad hoc claim");
      assert.equal((await tiles()).status, 404);
      process.env.CLASSPILOT_SCHEDULED_CLASSROOM_MODE = "on";
      delete process.env.CLASSPILOT_SUPERVISION_PREVIEW_MODE;
    } finally {
      if (oldMode === undefined) delete process.env.CLASSPILOT_SCHEDULED_CLASSROOM_MODE;
      else process.env.CLASSPILOT_SCHEDULED_CLASSROOM_MODE = oldMode;
      if (oldPreview === undefined) delete process.env.CLASSPILOT_SUPERVISION_PREVIEW_MODE;
      else process.env.CLASSPILOT_SUPERVISION_PREVIEW_MODE = oldPreview;
      await inSchool(schoolA.id, async () => {
        await db.delete(studentTimelineEvents).where(and(eq(studentTimelineEvents.schoolId, schoolA.id), eq(studentTimelineEvents.sourceId, contextId)));
        await db.delete(classpilotStudentControlStates).where(and(eq(classpilotStudentControlStates.schoolId, schoolA.id), eq(classpilotStudentControlStates.studentId, studentId)));
        if (contextId) {
          await db.delete(classpilotSupervisionStudents).where(eq(classpilotSupervisionStudents.contextId, contextId));
          await db.delete(classpilotSupervisionContexts).where(eq(classpilotSupervisionContexts.id, contextId));
        }
        await db.update(studentSessions).set({ isActive: true, endedAt: null }).where(eq(studentSessions.studentId, offlineStudentId));
      });
      seedExactScreenshots();
    }
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
      const officeRawLive = await requestJson(
        `/api/classpilot/device/screenshot/${coveredDeviceId}`,
        officeStaff
      );
      assert.equal(officeRawLive.status, 403);

      const officeRawHistory = await requestJson(
        `/api/classpilot/heartbeats/${coveredDeviceId}?limit=100`,
        officeStaff
      );
      assert.equal(officeRawHistory.status, 403);
      assert.equal((await postJson(
        "/api/classpilot/tiles/screenshots",
        { studentIds: [coveredStudentId] },
        officeStaff
      )).status, 200);

      const originalTeacherLive = await requestJson(
        `/api/classpilot/device/screenshot/${coveredDeviceId}`,
        teacher
      );
      assert.equal(originalTeacherLive.status, 403);
      assert.match(originalTeacherLive.body.error, /Insufficient permissions/i);

      const originalTeacherHistory = await requestJson(
        `/api/classpilot/heartbeats/${coveredDeviceId}?limit=100`,
        teacher
      );
      assert.equal(originalTeacherHistory.status, 403);
      assert.match(originalTeacherHistory.body.error, /Insufficient permissions/i);
      assert.equal((await postJson(
        "/api/classpilot/tiles/screenshots",
        { studentIds: [coveredStudentId] },
        teacher
      )).status, 404);
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
    assert.equal((await postJson(
      "/api/classpilot/tiles/screenshots",
      { studentIds: [coveredStudentId] },
      officeStaff
    )).status, 404);
    assert.equal((await postJson(
      "/api/classpilot/tiles/screenshots",
      { studentIds: [coveredStudentId] },
      teacher
    )).status, 200);
  });

  it("applies membership, role, school, and license changes on the next request", async () => {
    const path = `/api/classpilot/device/screenshot/${primaryDeviceIds[0]}`;
    const batchRequest = () => postJson(
      "/api/classpilot/tiles/screenshots",
      { studentIds: [authorizedStudentIds[0]] },
      teacher
    );
    assert.equal((await requestJson(path, teacher)).status, 403);
    assert.equal((await batchRequest()).status, 200);

    const updateMembership = (values: Record<string, unknown>) =>
      asSystem(async () => {
        await db
          .update(schoolMemberships)
          .set(values)
          .where(
            and(
              eq(schoolMemberships.userId, teacher.id),
              eq(schoolMemberships.schoolId, schoolA.id)
            )
          );
      });

    await updateMembership({ status: "suspended" });
    try {
      assert.equal((await requestJson(path, teacher)).status, 403);
      assert.equal((await batchRequest()).status, 403);
    } finally {
      await updateMembership({ status: "active" });
    }
    assert.equal((await requestJson(path, teacher)).status, 403);
    assert.equal((await batchRequest()).status, 200);

    await updateMembership({ role: "parent" });
    try {
      assert.equal((await requestJson(path, teacher)).status, 403);
      assert.equal((await batchRequest()).status, 403);
    } finally {
      await updateMembership({ role: "teacher" });
    }
    assert.equal((await requestJson(path, teacher)).status, 403);
    assert.equal((await batchRequest()).status, 200);

    await asSystem(async () => {
      await db
        .update(schools)
        .set({ status: "suspended" })
        .where(eq(schools.id, schoolA.id));
    });
    try {
      assert.equal((await requestJson(path, teacher)).status, 403);
      assert.equal((await batchRequest()).status, 403);
    } finally {
      await asSystem(async () => {
        await db
          .update(schools)
          .set({ status: "active" })
          .where(eq(schools.id, schoolA.id));
      });
    }
    assert.equal((await requestJson(path, teacher)).status, 403);
    assert.equal((await batchRequest()).status, 200);

    await asSystem(async () => {
      await db
        .update(productLicenses)
        .set({ status: "suspended" })
        .where(
          and(
            eq(productLicenses.schoolId, schoolA.id),
            eq(productLicenses.product, "CLASSPILOT")
          )
        );
    });
    try {
      assert.equal((await requestJson(path, teacher)).status, 403);
      assert.equal((await batchRequest()).status, 403);
    } finally {
      await asSystem(async () => {
        await db
          .update(productLicenses)
          .set({ status: "active" })
          .where(
            and(
              eq(productLicenses.schoolId, schoolA.id),
              eq(productLicenses.product, "CLASSPILOT")
            )
          );
      });
    }
    assert.equal((await requestJson(path, teacher)).status, 403);
    assert.equal((await batchRequest()).status, 200);
  });

  it("serves a 40-request aligned burst through the 16-connection API pool", async () => {
    assert.equal((pool as any).options.max, 16);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    let responses: Awaited<ReturnType<typeof requestJson>>[];
    try {
      responses = await Promise.all(
        authorizedStudentIds.map((studentId, index) =>
          postJson(
            index % 2 === 0
              ? "/api/classpilot/tiles/screenshots"
              : "/api/classpilot/tiles/history",
            index % 2 === 0
              ? { studentIds: [studentId] }
              : { studentIds: [studentId], limit: 1 },
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
