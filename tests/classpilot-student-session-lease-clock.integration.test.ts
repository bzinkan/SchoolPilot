import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { Client } from "pg";

process.env.NODE_ENV = "test";
process.env.SCHEDULER_ENABLED = "true";
process.env.REDIS_URL = "";
process.env.CLASSPILOT_MANUAL_SHARED_SESSION_ISSUANCE_ENABLED = "true";

const { default: db, pool, sessionPool } = await import("../dist/db.js");
const { runWithTenantContext } = await import("../dist/middleware/tenantContext.js");
const storage = await import("../dist/services/storage.js");
const { schedulerPool } = await import("../dist/services/schedulerDb.js");
const schema = await import("../dist/schema/index.js");
const {
  devices,
  productLicenses,
  schools,
  studentSessions,
  students,
} = schema;

const tag = `student-session-lease-clock-${Date.now()}-${randomUUID().slice(0, 8)}`;
const deviceId = `${tag}-device`;
let schoolId = "";
let studentId = "";
let studentSessionId = "";

const inSchool = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ schoolId }, fn);

before(async () => {
  const school = await storage.createSchool({
    name: tag,
    domain: `${tag}.example.edu`,
    slug: tag,
    status: "active",
    planStatus: "active",
  } as Parameters<typeof storage.createSchool>[0]);
  schoolId = school.id;
  await storage.createProductLicense({
    schoolId,
    product: "CLASSPILOT",
    status: "active",
  } as Parameters<typeof storage.createProductLicense>[0]);
  await inSchool(async () => {
    const student = await storage.createStudent({
      schoolId,
      firstName: "Lease",
      lastName: "Clock",
      email: `${tag}@${tag}.example.edu`,
      emailLc: `${tag}@${tag}.example.edu`,
      status: "active",
    } as Parameters<typeof storage.createStudent>[0]);
    studentId = student.id;
    await storage.createDevice({
      deviceId,
      deviceName: "Lease clock race device",
      schoolId,
      classId: schoolId,
    } as Parameters<typeof storage.createDevice>[0]);
    const started = await storage.startStudentSessionWithReplacements(
      schoolId,
      studentId,
      deviceId,
      {
        authKind: "manual_shared",
        sessionRecoveryTokenHash: "a".repeat(64),
      }
    );
    studentSessionId = started.session.id;
  });
});

after(async () => {
  try {
    if (schoolId) {
      await runWithTenantContext({ isSuper: true }, async () => {
        await db.delete(studentSessions).where(eq(studentSessions.studentId, studentId));
        await db.delete(devices).where(eq(devices.schoolId, schoolId));
        await db.delete(students).where(eq(students.schoolId, schoolId));
        await db.delete(productLicenses).where(eq(productLicenses.schoolId, schoolId));
        await db.delete(schools).where(eq(schools.id, schoolId));
      });
    }
  } finally {
    await Promise.allSettled([pool.end(), sessionPool.end(), schedulerPool.end()]);
  }
});

test("a manual lease that expires while exact authority waits on the shared lock is rejected", async () => {
  await inSchool(() => db
    .update(studentSessions)
    .set({ manualLeaseExpiresAt: sql`clock_timestamp() + interval '2 seconds'` })
    .where(eq(studentSessions.id, studentSessionId)));

  const blocker = new Client({ connectionString: process.env.DATABASE_URL });
  await blocker.connect();
  const lockKey = `classpilot:student-control:${schoolId}:${studentId}`;
  let lockHeld = false;
  let prepareCalled = false;
  let deliveryCalled = false;
  let authorityPromise:
    | Promise<{ authorized: true; value: string } | { authorized: false }>
    | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0::bigint))",
      [lockKey]
    );
    lockHeld = true;

    authorityPromise = inSchool(() =>
      storage.withClasspilotStudentControlDeliveryAuthority(
        { schoolId, studentId, studentSessionId, deviceId },
        () => {
          prepareCalled = true;
          return "prepared";
        },
        (_claimed, prepared) => {
          deliveryCalled = true;
          return prepared;
        }
      )
    );

    let waitingCount = 0;
    const waitDeadline = Date.now() + 5_000;
    while (waitingCount === 0 && Date.now() < waitDeadline) {
      const snapshot = await blocker.query(`
        WITH requested_lock AS (
          SELECT hashtextextended($1, 0::bigint) AS value
        )
        SELECT count(*) FILTER (WHERE lock_row.granted = false)::integer AS "waitingCount"
        FROM pg_locks AS lock_row
        CROSS JOIN requested_lock
        WHERE lock_row.locktype = 'advisory'
          AND lock_row.objsubid = 1
          AND lock_row.classid::bigint =
            ((requested_lock.value >> 32) & 4294967295::bigint)
          AND lock_row.objid::bigint =
            (requested_lock.value & 4294967295::bigint)
      `, [lockKey]);
      waitingCount = Number(snapshot.rows[0]?.waitingCount ?? 0);
      if (waitingCount === 0) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert.equal(waitingCount, 1, "the authority transaction must begin and wait before expiry");

    let expired = false;
    const expiryDeadline = Date.now() + 5_000;
    while (!expired && Date.now() < expiryDeadline) {
      const [lease] = await inSchool(() => db
        .select({
          expired: sql<boolean>`${studentSessions.manualLeaseExpiresAt} <= clock_timestamp()`,
        })
        .from(studentSessions)
        .where(eq(studentSessions.id, studentSessionId))
        .limit(1));
      expired = lease?.expired === true;
      if (!expired) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(expired, true, "the database wall clock must cross the lease boundary while blocked");

    await blocker.query("COMMIT");
    lockHeld = false;
    assert.deepEqual(await authorityPromise, { authorized: false });
    assert.equal(prepareCalled, false);
    assert.equal(deliveryCalled, false);
  } finally {
    if (lockHeld) await blocker.query("ROLLBACK");
    await Promise.allSettled(authorityPromise ? [authorityPromise] : []);
    await blocker.end();
  }
});
