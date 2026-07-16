import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

process.env.NODE_ENV = "test";
process.env.SCHEDULER_ENABLED = "false";
process.env.RLS_GUC_ENABLED = "true";
process.env.REDIS_URL = "";

const originalSetInterval = globalThis.setInterval;
globalThis.setInterval = ((...args: any[]) => {
  const timer = (originalSetInterval as any)(...args);
  timer.unref?.();
  return timer;
}) as typeof setInterval;

const { default: db, pool, sessionPool } = await import("../dist/db.js");
const { runWithTenantContext } = await import(
  "../dist/middleware/tenantContext.js"
);
const storage = await import("../dist/services/storage.js");
const schema = await import("../dist/schema/index.js");
const { and, asc, eq } = await import("drizzle-orm");

const {
  createHeartbeatAndRefreshPresence,
  createSchool,
  createStudent,
} = storage;
const {
  devices,
  heartbeats,
  schools,
  studentSessions,
  students,
} = schema;

const tag = `heartbeat-presence-${Date.now()}-${randomUUID().slice(0, 8)}`;
let schoolId = "";
let studentId = "";
const deviceId = `${tag}-device`;
let sessionId = "";

const inSchool = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ schoolId }, fn);

before(async () => {
  const school = await createSchool({
    name: tag,
    domain: `${tag}.example.edu`,
    slug: tag,
    status: "active",
    planStatus: "active",
  } as any);
  schoolId = school.id;

  await inSchool(async () => {
    const student = await createStudent({
      schoolId,
      firstName: "Synthetic",
      lastName: "Heartbeat",
      email: `${tag}@${tag}.example.edu`,
      emailLc: `${tag}@${tag}.example.edu`,
      status: "active",
    } as any);
    studentId = student.id;

    await db.insert(devices).values({
      deviceId,
      deviceName: "Synthetic heartbeat device",
      schoolId,
      classId: schoolId,
      lastSeenAt: new Date(Date.now() - 120_000),
    });
    const [session] = await db
      .insert(studentSessions)
      .values({
        studentId,
        deviceId,
        isActive: true,
        lastSeenAt: new Date(Date.now() - 120_000),
      })
      .returning({ id: studentSessions.id });
    assert.ok(session?.id);
    sessionId = session.id;
  });
});

after(async () => {
  try {
    await runWithTenantContext({ isSuper: true }, async () => {
      await db.delete(heartbeats).where(eq(heartbeats.deviceId, deviceId));
      await db
        .delete(studentSessions)
        .where(eq(studentSessions.deviceId, deviceId));
      await db.delete(devices).where(eq(devices.deviceId, deviceId));
      if (studentId) {
        await db.delete(students).where(eq(students.id, studentId));
      }
      if (schoolId) {
        await db.delete(schools).where(eq(schools.id, schoolId));
      }
    });
  } finally {
    await Promise.allSettled([pool.end(), sessionPool.end()]);
  }
});

describe("ClassPilot heartbeat presence hot path", () => {
  it("uses one SQL roundtrip for heartbeat insert and throttled presence writes", () => {
    const storageSource = readFileSync(
      new URL("../src/services/storage.ts", import.meta.url),
      "utf8"
    );
    const start = storageSource.indexOf(
      "export async function createHeartbeatAndRefreshPresence"
    );
    const end = storageSource.indexOf(
      "export async function updateHeartbeatClassification",
      start
    );
    assert.ok(start >= 0 && end > start);
    const functionSource = storageSource.slice(start, end);

    assert.equal(
      functionSource.match(/\bdb\.execute\s*\(/g)?.length,
      1,
      "the hot path must issue one database statement"
    );
    assert.match(functionSource, /WITH\s+represented_session\s+AS\s+MATERIALIZED/i);
    assert.match(functionSource, /eligible_session\s+AS\s+MATERIALIZED/i);
    assert.match(functionSource, /inserted_heartbeat\s+AS/i);
    assert.match(functionSource, /refreshed_device\s+AS/i);
    assert.match(functionSource, /refreshed_session\s+AS/i);
    assert.equal(
      functionSource.match(
        /\(last_seen_at\s+IS\s+NULL\s+OR\s+last_seen_at\s+<\s+now\(\)\s*-\s*interval\s+'60 seconds'\)/gi
      )?.length,
      2,
      "device and student-session presence writes must both be throttled"
    );
    assert.match(functionSource, /WHERE\s+id\s*=\s*\$\{studentSessionId\}/i);
    assert.match(functionSource, /AND\s+student_id\s*=\s*\$\{data\.studentId\}/i);
    assert.match(functionSource, /AND\s+device_id\s*=\s*\$\{data\.deviceId\}/i);
    assert.match(functionSource, /AND\s+is_active\s*=\s*true/i);
    assert.match(
      functionSource,
      /FOR\s+UPDATE\s+OF\s+represented/i,
      "session eligibility must linearize with a concurrent revoke"
    );
    assert.match(functionSource, /FROM\s+eligible_session/i);
    assert.match(
      functionSource,
      /EXISTS\s*\(SELECT\s+1\s+FROM\s+eligible_session\)/i
    );

    const routeSource = readFileSync(
      new URL("../src/routes/classpilot/devices.ts", import.meta.url),
      "utf8"
    );
    const routeStart = routeSource.indexOf('router.post("/device/heartbeat"');
    const routeEnd = routeSource.indexOf(
      'router.get("/device/screenshot/:deviceId"',
      routeStart
    );
    assert.ok(routeStart >= 0 && routeEnd > routeStart);
    const heartbeatRoute = routeSource.slice(routeStart, routeEnd);
    assert.equal(
      heartbeatRoute.match(/createHeartbeatAndRefreshPresence\s*\(/g)?.length,
      1
    );
    assert.doesNotMatch(heartbeatRoute, /\b(?:updateDevice|touchStudentSession)\s*\(/);
    const presenceCallStart = heartbeatRoute.indexOf(
      "createHeartbeatAndRefreshPresence({"
    );
    const presenceCallEnd = heartbeatRoute.indexOf(
      "res.locals.studentSessionId",
      presenceCallStart
    );
    assert.ok(presenceCallStart >= 0 && presenceCallEnd > presenceCallStart);
    const presenceCall = heartbeatRoute.slice(presenceCallStart, presenceCallEnd);
    assert.match(presenceCall, /\bextensionVersion,\s*\n\s*chromeVersion,\s*\n\s*screenshotHealth,/);
    assert.doesNotMatch(
      presenceCall,
      /(?:extensionVersion|chromeVersion|screenshotHealth):[^,]+\|\|\s*null/,
      "omitted optional diagnostics must not be converted into destructive null updates"
    );
  });

  it("inserts every heartbeat but refreshes presence metadata at most once per minute", async () => {
    const first = await inSchool(() =>
      createHeartbeatAndRefreshPresence(
        {
          deviceId,
          studentId,
          studentEmail: `${tag}@${tag}.example.edu`,
          schoolId,
          activeTabTitle: "First tab",
          activeTabUrl: "https://first.example.invalid/",
          extensionVersion: "2.5.7-first",
          chromeVersion: "145-first",
          screenshotHealth: { state: "first" },
        },
        sessionId
      )
    );
    assert.ok(first);
    assert.ok(first.id);

    const afterFirst = await inSchool(async () => {
      const [device] = await db
        .select()
        .from(devices)
        .where(eq(devices.deviceId, deviceId));
      const [session] = await db
        .select()
        .from(studentSessions)
        .where(eq(studentSessions.id, sessionId));
      return { device, session };
    });
    assert.ok(afterFirst.device?.lastSeenAt);
    assert.ok(afterFirst.session?.lastSeenAt);
    assert.equal(afterFirst.device.extensionVersion, "2.5.7-first");
    assert.equal(afterFirst.device.chromeVersion, "145-first");
    assert.deepEqual(afterFirst.device.lastScreenshotHealth, { state: "first" });

    const second = await inSchool(() =>
      createHeartbeatAndRefreshPresence(
        {
          deviceId,
          studentId,
          studentEmail: `${tag}@${tag}.example.edu`,
          schoolId,
          activeTabTitle: "Second tab",
          activeTabUrl: "https://second.example.invalid/",
          extensionVersion: "2.5.7-second",
          chromeVersion: "145-second",
          screenshotHealth: { state: "second" },
        },
        sessionId
      )
    );
    assert.ok(second);
    assert.ok(second.id);
    assert.notEqual(second.id, first.id);

    const final = await inSchool(async () => {
      const [device] = await db
        .select()
        .from(devices)
        .where(eq(devices.deviceId, deviceId));
      const [session] = await db
        .select()
        .from(studentSessions)
        .where(eq(studentSessions.id, sessionId));
      const rows = await db
        .select()
        .from(heartbeats)
        .where(
          and(
            eq(heartbeats.schoolId, schoolId),
            eq(heartbeats.deviceId, deviceId)
          )
        )
        .orderBy(asc(heartbeats.timestamp));
      return { device, session, rows };
    });

    assert.equal(final.rows.length, 2);
    assert.deepEqual(
      final.rows.map((row) => row.activeTabTitle),
      ["First tab", "Second tab"]
    );
    assert.equal(final.rows[1]?.extensionVersion, "2.5.7-second");
    assert.deepEqual(final.rows[1]?.screenshotHealth, { state: "second" });

    assert.equal(
      final.device?.lastSeenAt?.getTime(),
      afterFirst.device.lastSeenAt.getTime()
    );
    assert.equal(
      final.session?.lastSeenAt.getTime(),
      afterFirst.session.lastSeenAt.getTime()
    );
    assert.equal(final.device?.extensionVersion, "2.5.7-first");
    assert.equal(final.device?.chromeVersion, "145-first");
    assert.deepEqual(final.device?.lastScreenshotHealth, { state: "first" });
  });

  it("refreshes liveness without erasing optional device metadata omitted by a client", async () => {
    const oldPresence = new Date(Date.now() - 120_000);
    await inSchool(async () => {
      await db
        .update(devices)
        .set({ lastSeenAt: oldPresence })
        .where(eq(devices.deviceId, deviceId));
      await db
        .update(studentSessions)
        .set({ lastSeenAt: oldPresence })
        .where(eq(studentSessions.id, sessionId));
    });

    const heartbeat = await inSchool(() =>
      createHeartbeatAndRefreshPresence(
        {
          deviceId,
          studentId,
          studentEmail: `${tag}@${tag}.example.edu`,
          schoolId,
          activeTabTitle: "Client without diagnostics",
          activeTabUrl: "https://omitted.example.invalid/",
        },
        sessionId
      )
    );

    assert.ok(heartbeat);
    const result = await inSchool(async () => {
      const [device] = await db
        .select()
        .from(devices)
        .where(eq(devices.deviceId, deviceId));
      const [session] = await db
        .select()
        .from(studentSessions)
        .where(eq(studentSessions.id, sessionId));
      const [storedHeartbeat] = await db
        .select()
        .from(heartbeats)
        .where(eq(heartbeats.id, heartbeat.id));
      return { device, session, storedHeartbeat };
    });

    assert.ok(result.device?.lastSeenAt);
    assert.ok(result.session?.lastSeenAt);
    assert.ok(result.device.lastSeenAt.getTime() > oldPresence.getTime());
    assert.ok(result.session.lastSeenAt.getTime() > oldPresence.getTime());
    assert.equal(result.device.extensionVersion, "2.5.7-first");
    assert.equal(result.device.chromeVersion, "145-first");
    assert.deepEqual(result.device.lastScreenshotHealth, { state: "first" });
    assert.equal(result.storedHeartbeat?.extensionVersion, null);
    assert.equal(result.storedHeartbeat?.chromeVersion, null);
    assert.equal(result.storedHeartbeat?.screenshotHealth, null);
  });

  it("lets a concurrent session revoke win before recording the heartbeat", async () => {
    await inSchool(() =>
      db
        .update(studentSessions)
        .set({ isActive: true, endedAt: null })
        .where(eq(studentSessions.id, sessionId))
    );
    const beforeCount = await inSchool(async () => {
      const rows = await db
        .select({ id: heartbeats.id })
        .from(heartbeats)
        .where(eq(heartbeats.deviceId, deviceId));
      return rows.length;
    });

    const revoker = await pool.connect();
    let transactionOpen = false;
    let heartbeatSettled = false;
    let pendingHeartbeat:
      | Promise<{ outcome: string; id?: string } | undefined>
      | undefined;
    try {
      await revoker.query(
        "SELECT set_config('app.is_super', 'off', false), set_config('app.school_id', $1, false)",
        [schoolId]
      );
      await revoker.query("BEGIN");
      transactionOpen = true;
      const revoked = await revoker.query(
        "UPDATE student_sessions SET is_active = false, ended_at = now() WHERE id = $1",
        [sessionId]
      );
      assert.equal(revoked.rowCount, 1);

      pendingHeartbeat = inSchool(() =>
        createHeartbeatAndRefreshPresence(
          {
            deviceId,
            studentId,
            studentEmail: `${tag}@${tag}.example.edu`,
            schoolId,
            activeTabTitle: "Concurrent revoke must win",
            activeTabUrl: "https://concurrent-revoke.example.invalid/",
          },
          sessionId
        )
      ).finally(() => {
        heartbeatSettled = true;
      });

      // The heartbeat must wait behind the revoker's row lock instead of
      // consuming a stale READ COMMITTED snapshot of is_active=true.
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(heartbeatSettled, false);

      await revoker.query("COMMIT");
      transactionOpen = false;
      assert.deepEqual(await pendingHeartbeat, { outcome: "inactive_session" });
    } finally {
      if (transactionOpen) await revoker.query("ROLLBACK").catch(() => {});
      await revoker
        .query("SELECT set_config('app.school_id', '', false), set_config('app.is_super', 'off', false)")
        .catch(() => {});
      revoker.release();
      await pendingHeartbeat?.catch(() => undefined);
    }

    const afterCount = await inSchool(async () => {
      const rows = await db
        .select({ id: heartbeats.id })
        .from(heartbeats)
        .where(eq(heartbeats.deviceId, deviceId));
      return rows.length;
    });
    assert.equal(afterCount, beforeCount);
  });

  it("does not record or refresh presence after the exact session is revoked", async () => {
    const before = await inSchool(async () => {
      const rows = await db
        .select({ id: heartbeats.id })
        .from(heartbeats)
        .where(eq(heartbeats.deviceId, deviceId));
      const [device] = await db
        .select()
        .from(devices)
        .where(eq(devices.deviceId, deviceId));
      await db
        .update(studentSessions)
        .set({ isActive: false, endedAt: new Date() })
        .where(eq(studentSessions.id, sessionId));
      return { count: rows.length, lastSeenAt: device?.lastSeenAt };
    });

    const rejected = await inSchool(() =>
      createHeartbeatAndRefreshPresence(
        {
          deviceId,
          studentId,
          studentEmail: `${tag}@${tag}.example.edu`,
          schoolId,
          activeTabTitle: "Must not persist",
          activeTabUrl: "https://revoked.example.invalid/",
        },
        sessionId
      )
    );
    assert.deepEqual(rejected, { outcome: "inactive_session" });

    const afterRevocation = await inSchool(async () => {
      const rows = await db
        .select({ id: heartbeats.id })
        .from(heartbeats)
        .where(eq(heartbeats.deviceId, deviceId));
      const [device] = await db
        .select()
        .from(devices)
        .where(eq(devices.deviceId, deviceId));
      return { count: rows.length, lastSeenAt: device?.lastSeenAt };
    });
    assert.equal(afterRevocation.count, before.count);
    assert.equal(
      afterRevocation.lastSeenAt?.getTime(),
      before.lastSeenAt?.getTime()
    );
  });
});
