import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.NODE_ENV = "test";
process.env.REDIS_URL = "";
const originalSetInterval = globalThis.setInterval;
globalThis.setInterval = ((...args: Parameters<typeof originalSetInterval>) => {
  const timer = originalSetInterval(...args); timer.unref?.(); return timer;
}) as typeof setInterval;
const { default: db, pool, sessionPool } = await import("../dist/db.js");
const { runWithTenantContext } = await import("../dist/middleware/tenantContext.js");
const storage = await import("../dist/services/storage.js");
const policy = await import("../dist/services/classpilotSchoolWebsitePolicy.js");
const { CLASSPILOT_SCHOOL_WEBSITE_POLICY_SQL } = await import("../dist/db/classpilotSchoolWebsitePolicyMigration.js");
const { devices, studentSessions, students, schools, users } = await import("../dist/schema/index.js");
const { eq, sql } = await import("drizzle-orm");
const { schedulerPool, schedulerLockPool } = await import("../dist/services/schedulerDb.js");
const tag = `website-policy-${randomUUID()}`;
let schoolId = "";
let actorId = "";
let binding: { schoolId: string; studentId: string; studentSessionId: string; deviceId: string };
const inSchool = <T>(fn: () => Promise<T>) => runWithTenantContext({ schoolId }, fn);
before(async () => {
  await pool.query(CLASSPILOT_SCHOOL_WEBSITE_POLICY_SQL);
  schoolId = (await storage.createSchool({ name: tag, domain: `${tag}.example.edu`, slug: tag, status: "active", planStatus: "active" })).id;
  actorId = (await storage.createUser({ email: `admin@${tag}.example.edu`, firstName: "Test", lastName: "Administrator" })).id;
  await storage.createMembership({ schoolId, userId: actorId, role: "school_admin", status: "active" });
  await storage.createProductLicense({ schoolId, product: "CLASSPILOT", status: "active" });
  await inSchool(async () => {
    await storage.upsertSettings(schoolId, { schoolName: tag, wsSharedKey: tag, blockedDomains: [] });
    const [student] = await db.insert(students).values({ schoolId, firstName: "Synthetic", lastName: "Website", status: "active" }).returning();
    assert.ok(student);
    const deviceId = `${tag}-device`;
    await db.insert(devices).values({ schoolId, classId: schoolId, deviceId, deviceName: tag });
    const [session] = await db.insert(studentSessions).values({ studentId: student.id, deviceId, authKind: "managed_profile", isActive: true }).returning();
    assert.ok(session);
    binding = { schoolId, studentId: student.id, studentSessionId: session.id, deviceId };
  });
});
after(async () => {
  try { await runWithTenantContext({ isSuper: true }, async () => {
    if (schoolId) await db.delete(schools).where(eq(schools.id, schoolId));
    if (actorId) await db.delete(users).where(eq(users.id, actorId));
  }); } finally { await Promise.all([pool.end(), sessionPool.end(), schedulerPool.end(), schedulerLockPool.end()]); }
});

test("website policy revision and alert callback commit together; repeated blocks remain idempotent", async () => inSchool(async () => {
  let callbacks = 0;
  const afterSave = async (tx: typeof db, saved: { policyRevision: number }) => {
    callbacks++;
    const result = await tx.execute(sql`SELECT revision FROM classpilot_school_website_policies WHERE school_id=${schoolId}`);
    assert.equal(result.rows[0]?.revision, saved.policyRevision);
  };
  const first = await policy.addSchoolBlockedWebsite({ schoolId, actorId, domain: "games.example", expectedRevision: 0, afterSave });
  assert.equal(first.policyRevision, 1);
  assert.equal(first.enforcement.pending, 1);
  const repeated = await policy.addSchoolBlockedWebsite({ schoolId, actorId, domain: "games.example", expectedRevision: 1, afterSave });
  assert.equal(repeated.policyRevision, 1);
  assert.equal(callbacks, 2);
  const covered = await policy.addSchoolBlockedWebsite({ schoolId, actorId, domain: "www.games.example", expectedRevision: 1 });
  assert.equal(covered.policyRevision, 1);
  assert.equal(covered.enforcement.pending, 1);
  assert.equal((await policy.getSchoolWebsitePolicyStatus(schoolId, "play.games.example")).blocked, true);
  assert.equal((await policy.getSchoolWebsitePolicyStatus(schoolId, "games.example.other.test")).blocked, false);
  await assert.rejects(policy.addSchoolBlockedWebsite({ schoolId, actorId, domain: "other.example", expectedRevision: 0 }), { code: "SCHOOL_WEBSITE_POLICY_CONFLICT" });
  await assert.rejects(policy.addSchoolBlockedWebsite({ schoolId, actorId, domain: "other.example", expectedRevision: 1,
    afterSave: async () => { throw new Error("review revision conflict"); },
  }), /review revision conflict/);
  assert.deepEqual(await policy.getSchoolWebsitePolicy(schoolId), { policyRevision: 1, blockedDomains: ["games.example"] });
}));

test("ACKs require current exact binding and revision; applied cannot be downgraded", async () => inSchool(async () => {
  const ack = { policyRevision: 1, status: "applied" as const, closedTabCount: 2 };
  assert.equal((await policy.recordSchoolWebsitePolicyAck({ ...binding, deviceId: "wrong-device" }, ack)).accepted, false);
  assert.equal((await policy.recordSchoolWebsitePolicyAck(binding, { ...ack, policyRevision: 0 })).accepted, false);
  assert.equal((await policy.recordSchoolWebsitePolicyAck(binding, ack)).accepted, true);
  await policy.recordSchoolWebsitePolicyAck(binding, { ...ack, status: "failed", errorCode: "POLICY_APPLY_FAILED" });
  assert.deepEqual((await policy.getSchoolWebsitePolicyStatus(schoolId, "games.example")).enforcement, { applied: 1 });
  await db.update(studentSessions).set({ isActive: false, endedAt: new Date() }).where(eq(studentSessions.id, binding.studentSessionId));
  assert.equal((await policy.recordSchoolWebsitePolicyAck(binding, ack)).accepted, false);
  assert.deepEqual((await policy.getSchoolWebsitePolicyStatus(schoolId, "games.example")).enforcement, {});
  const [replacement] = await db.insert(studentSessions).values({ studentId: binding.studentId, deviceId: binding.deviceId, authKind: "managed_profile", isActive: true }).returning();
  assert.ok(replacement);
  assert.deepEqual((await policy.getSchoolWebsitePolicyStatus(schoolId, "games.example")).enforcement, { pending: 1 });
  assert.equal((await policy.recordSchoolWebsitePolicyAck({ ...binding, studentSessionId: replacement.id }, ack)).accepted, true);
  assert.deepEqual((await policy.getSchoolWebsitePolicyStatus(schoolId, "games.example")).enforcement, { applied: 1 });
}));
