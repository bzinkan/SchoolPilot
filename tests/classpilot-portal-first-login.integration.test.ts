import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { eq, sql } from "drizzle-orm";
import type { ClasspilotClassroomStateSnapshot } from "../src/services/classpilotClassroomState.js";
import type { InsertSettings } from "../src/schema/shared.js";

process.env.NODE_ENV = "test";
process.env.REDIS_URL = "";
process.env.CLASSPILOT_MANUAL_SHARED_SESSION_ISSUANCE_ENABLED = "true";
process.env.CLASSPILOT_PROTOCOL_V3_ENABLED = "true";
process.env.CLASSPILOT_CAP_SCOPED_AUTHORITY_CHECKS_V1 = "true";
process.env.CLASSPILOT_CAP_RESTRICTION_AUTH_PASS_THROUGH_V1 = "true";
process.env.CLASSPILOT_CAP_LATE_SIGNIN_RESTRICTION_SSO_V1 = "true";
process.env.CLASSPILOT_CAP_AFTER_HOURS_SAFETY_ONLY_V1 = "true";

const { default: db, pool, sessionPool } = await import("../dist/db.js");
const { schedulerPool } = await import("../dist/services/schedulerDb.js");
const { runWithTenantContext } = await import("../dist/middleware/tenantContext.js");
const storage = await import("../dist/services/storage.js");
const schema = await import("../dist/schema/index.js");
const { normalizeClasspilotRestrictions, withClasspilotLateSignInOrigin } = await import("../dist/services/classpilotClassroomState.js");
const { verifyStudentToken } = await import("../dist/services/deviceJwt.js");

const tag = `portal-login-${randomUUID()}`;
const capabilities = ["scopedAuthorityChecksV1", "restrictionAuthPassThroughV1", "restrictionPortalFirstV1", "lateSignInRestrictionSsoV1", "afterHoursSafetyOnlyV1"];
const policy = {
  schemaVersion: 1 as const, enabled: true, defaultProfileId: "clever", attemptTtlSeconds: 300 as const,
  profiles: [{ id: "clever", name: "Clever", startUrl: "https://clever.com/in/portal-fixture",
    hostRules: [{ hostname: "clever.com", includeSubdomains: true }, { hostname: "accounts.google.com", includeSubdomains: false }] }],
};
type Fixture = { schoolId: string; domain: string; teacherId: string; groupId: string; teachingSessionId: string };
type LoginBody = {
  success: boolean; schoolId: string; studentId: string; studentSessionId: string; studentToken: string;
  acceptedCapabilities: string[]; exactBinding: { schoolId: string; studentId: string; studentSessionId: string; deviceId: string; controlRevision: number };
  monitoringPolicy: { mode: string }; classroomState: ClasspilotClassroomStateSnapshot | null;
};
const fixtures: Fixture[] = [];
let server: Server;
let baseUrl = "";
const scoped = <T>(fixture: Fixture, fn: () => Promise<T>) => runWithTenantContext({ schoolId: fixture.schoolId }, fn);

function setRollout(lateSignIn = false) {
  process.env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON = JSON.stringify({
    scopedAuthorityChecksV1: { mode: "on", schoolIds: fixtures.map(row => row.schoolId) },
    restrictionAuthPassThroughV1: { mode: "on", schoolIds: [fixtures[0]!.schoolId] },
    lateSignInRestrictionSsoV1: { mode: lateSignIn ? "on" : "off", schoolIds: [fixtures[0]!.schoolId] },
    afterHoursSafetyOnlyV1: { mode: "on", schoolIds: fixtures.map(row => row.schoolId) },
  });
}

async function settings(fixture: Fixture, overrides: Partial<InsertSettings> = {}) {
  await scoped(fixture, () => storage.upsertSettings(fixture.schoolId, {
    enrollmentKey: tag, enrollmentKeyRequired: true, sharedChromebookSignInEnabled: true,
    sharedChromebookLoginMethod: "email_id", enableTrackingHours: false, afterHoursMode: "off",
    classpilotSsoPolicy: policy, classpilotSsoPolicyRevision: 4, ...overrides,
  }));
}

async function login(options: { restriction?: "waypoint" | "flightPath" | "attention"; deferred?: boolean;
  fixture?: Fixture; advertised?: string[]; extraBody?: Record<string, unknown> } = {}) {
  const fixture = options.fixture ?? fixtures[0]!;
  const suffix = randomUUID();
  const student = await scoped(fixture, () => storage.createStudent({ schoolId: fixture.schoolId,
    firstName: "Portal", lastName: "Student", email: `${suffix}@${fixture.domain}`, emailLc: `${suffix}@${fixture.domain}`,
    studentIdNumber: suffix, status: "active" }));
  const deviceId = `${tag}-${suffix}`;
  const restrictions = normalizeClasspilotRestrictions(options.restriction === "flightPath"
    ? { flightPath: { active: true, allowedDomains: ["ixl.com", "nwea.org"] } }
    : options.restriction === "attention" ? { attentionMode: { active: true, message: "Listen" } }
      : { screenLock: { active: true, url: "https://www.ixl.com/math" } });
  const desiredState = options.deferred ? withClasspilotLateSignInOrigin({ desiredState: { restrictions }, commandId: randomUUID() }) : { restrictions };
  await scoped(fixture, async () => {
    await db.insert(schema.classpilotSessionStudents).values({ schoolId: fixture.schoolId, teachingSessionId: fixture.teachingSessionId,
      groupId: fixture.groupId, studentId: student.id });
    await db.insert(schema.classpilotStudentControlStates).values({ schoolId: fixture.schoolId, studentId: student.id,
      teachingSessionId: fixture.teachingSessionId, revision: 9, desiredState,
      hardExpiresAt: new Date(Date.now() + 3_600_000), scheduledEndAt: new Date(Date.now() + 3_000_000) });
  });
  const response = await fetch(`${baseUrl}/api/classpilot/extension/student-login`, { method: "POST",
    headers: { "content-type": "application/json", "x-classpilot-enrollment-key": tag },
    body: JSON.stringify({ schoolId: fixture.schoolId, deviceId, studentEmail: student.email, studentIdNumber: suffix,
      clientProtocolVersion: 3, capabilities: options.advertised ?? capabilities, ...options.extraBody }),
  });
  const body = await response.json() as LoginBody;
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.success, true);
  const active = await scoped(fixture, () => storage.getActiveSessionById(body.studentSessionId));
  assert.equal(active?.studentId, student.id, "the portal response must preserve the committed login");
  assert.equal(active?.deviceId, deviceId);
  const token = verifyStudentToken(body.studentToken);
  assert.equal(token?.sessionId, body.studentSessionId);
  assert.equal(token?.schoolId, fixture.schoolId);
  assert.deepEqual(body.exactBinding, { bindingVersion: 2, schoolId: fixture.schoolId, studentId: student.id,
    studentSessionId: body.studentSessionId, deviceId, controlRevision: body.classroomState?.revision ?? 0 });
  return { body, fixture, student, deviceId };
}

before(async () => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.DATABASE_URL || "").hostname), "Use an isolated local database fixture");
  for (const name of ["enabled", "outside-rollout"]) {
    const domain = `${name}-${tag}.example.edu`;
    const school = await storage.createSchool({ name: `${name}-${tag}`, domain, slug: `${name}-${tag}`, status: "active", planStatus: "active" });
    const teacher = await storage.createUser({ email: `teacher@${domain}`, firstName: "Portal", lastName: "Teacher" });
    const fixture: Fixture = { schoolId: school.id, domain, teacherId: teacher.id, groupId: randomUUID(), teachingSessionId: randomUUID() };
    fixtures.push(fixture);
    await storage.createProductLicense({ schoolId: school.id, product: "CLASSPILOT", status: "active" });
    await storage.createMembership({ schoolId: school.id, userId: teacher.id, role: "teacher", status: "active" });
    await scoped(fixture, async () => {
      if (process.env.RLS_GUC_ENABLED === "true") {
        const scope = await db.execute(sql`SELECT current_setting('app.school_id', true) AS school_id`);
        assert.equal(scope.rows[0]?.school_id, fixture.schoolId, "fixture writes must use the same tenant connection as runtime delivery");
      }
      // The converged database requires the primary-teacher mirror in the
      // same transaction. Use the canonical writer rather than schema-only inserts.
      await storage.createGroup({ id: fixture.groupId, schoolId: school.id, teacherId: teacher.id,
        name: "Portal class", groupType: "admin_class", status: "active" });
      await db.insert(schema.teachingSessions).values({ id: fixture.teachingSessionId, schoolId: school.id,
        groupId: fixture.groupId, teacherId: teacher.id, sessionMode: "live", rosterSnapshotCompletedAt: new Date() });
      await db.insert(schema.classpilotSessionStaff).values({ schoolId: school.id, teachingSessionId: fixture.teachingSessionId,
        staffId: teacher.id, role: "primary" });
    });
    await settings(fixture);
  }
  setRollout();
  const { createApp } = await import("../dist/app.js");
  server = createServer(createApp());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  try {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    const retentionGuards = await db.execute(sql`
      SELECT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
        WHERE t.tgrelid='schools'::regclass AND t.tgenabled<>'D'
          AND p.proname='schoolpilot_guard_school_hard_delete') AS retain_schools,
        EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
        WHERE t.tgrelid='users'::regclass AND t.tgenabled<>'D'
          AND p.proname='schoolpilot_guard_user_hard_delete') AS retain_users`);
    for (const fixture of fixtures) await scoped(fixture, () => db.transaction(async (tx) => {
      for (const table of ["classpilot_student_control_states", "heartbeats", "classpilot_session_students", "classpilot_session_staff", "teaching_sessions"])
        await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE school_id=${fixture.schoolId}`);
      await tx.execute(sql`DELETE FROM student_sessions WHERE student_id IN (SELECT id FROM students WHERE school_id=${fixture.schoolId})`);
      await tx.execute(sql`DELETE FROM student_devices WHERE student_id IN (SELECT id FROM students WHERE school_id=${fixture.schoolId})`);
      await tx.execute(sql`DELETE FROM group_teachers WHERE group_id=${fixture.groupId}`);
      for (const table of ["devices", "groups", "students", "settings", "product_licenses", "school_memberships"])
        await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE school_id=${fixture.schoolId}`);
      // Converged schemas deliberately retain lifecycle roots. Their final
      // cleanup belongs to the disposable test database, never a disabled guard.
      if (retentionGuards.rows[0]?.retain_schools !== true)
        await tx.delete(schema.schools).where(eq(schema.schools.id, fixture.schoolId));
      if (retentionGuards.rows[0]?.retain_users !== true)
        await tx.delete(schema.users).where(eq(schema.users.id, fixture.teacherId));
    }));
  } finally { await Promise.allSettled([pool.end(), sessionPool.end(), schedulerPool.end()]); }
});

describe("ClassPilot portal-first authenticated login delivery", () => {
  it("delivers normal existing Waypoints and Flight Paths at login without enabling offline assignment", async () => {
    setRollout(false);
    for (const restriction of ["waypoint", "flightPath"] as const) {
      const { body } = await login({ restriction });
      assert.ok(body.acceptedCapabilities.includes("restrictionPortalFirstV1"));
      assert.ok(!body.acceptedCapabilities.includes("lateSignInRestrictionSsoV1"));
      assert.equal(body.monitoringPolicy.mode, "full");
      assert.deepEqual(body.classroomState?.deliveryContext, { portalFirstOnLogin: true });
      assert.equal(body.classroomState?.authPassThrough?.profiles[0]?.startUrl, policy.profiles[0]!.startUrl);
      assert.equal(body.classroomState?.authPassThroughPolicyRevision, 8);
      assert.equal(body.classroomState?.revision, 9);
    }
  });
  it("keeps legacy login envelopes absent and ignores an untrusted client login marker", async () => {
    const { body } = await login({ advertised: capabilities.filter(value => value !== "restrictionPortalFirstV1"),
      extraBody: { portalFirstOnLogin: true, authPassThrough: policy, deliveryContext: { portalFirstOnLogin: true } } });
    assert.equal(body.classroomState?.deliveryContext, undefined);
    assert.equal(body.classroomState?.authPassThrough, undefined);
    assert.equal(body.classroomState?.authPassThroughPolicyRevision, undefined);
    assert.equal(body.classroomState?.restrictions.screenLock.url, "https://www.ixl.com/math");
  });
  it("requires the older capability and gate for both deferred restriction types", async () => {
    for (const restriction of ["waypoint", "flightPath"] as const) {
      setRollout(false);
      assert.equal((await login({ restriction, deferred: true })).body.classroomState, null);
      setRollout(true);
      const { body } = await login({ restriction, deferred: true });
      assert.deepEqual(body.classroomState?.deliveryContext, { lateSignInRestrictionSso: true, portalFirstOnLogin: true });
      assert.ok(body.classroomState?.authPassThrough);
      assert.equal((await login({ restriction, deferred: true,
        advertised: capabilities.filter(value => value !== "lateSignInRestrictionSsoV1") })).body.classroomState, null);
    }
    setRollout(false);
  });
  it("does not carry a portal or auth authority when saved policy is off or the school is outside rollout", async () => {
    await settings(fixtures[0]!, { classpilotSsoPolicy: { ...policy, enabled: false }, classpilotSsoPolicyRevision: 5 });
    try {
      const { body } = await login();
      assert.equal(body.classroomState?.authPassThrough, undefined);
      assert.equal(body.classroomState?.deliveryContext, undefined);
      assert.equal(body.classroomState?.authPassThroughPolicyRevision, 10, "a saved policy edit advances authority and fences the prior revision");
    } finally { await settings(fixtures[0]!); }
    const { body } = await login({ fixture: fixtures[1]! });
    assert.ok(!body.acceptedCapabilities.includes("restrictionPortalFirstV1"));
    assert.equal(body.classroomState?.authPassThrough, undefined);
    assert.equal(body.classroomState?.deliveryContext, undefined);
  });
  it("never launches a portal for attention-only state", async () => {
    const { body } = await login({ restriction: "attention" });
    assert.equal(body.classroomState?.restrictions.attentionMode.active, true);
    assert.equal(body.classroomState?.authPassThrough, undefined);
    assert.equal(body.classroomState?.deliveryContext, undefined);
  });
  it("withholds all classroom and portal authority in Safety only or off monitoring", async () => {
    for (const afterHoursMode of ["limited", "off"] as const) {
      // An explicit closed instructional date is deterministic at any clock time.
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
      await settings(fixtures[0]!, { enableTrackingHours: true, trackingStartTime: "00:00", trackingEndTime: "23:59",
        afterHoursMode, instructionalCalendar: { [today.slice(0, 7)]: {
          revision: 1, nonInstructionalDates: [today], updatedAt: new Date().toISOString(), updatedBy: null,
        } } });
      try {
        const { body } = await login();
        assert.equal(body.monitoringPolicy.mode, afterHoursMode === "limited" ? "safety_only" : "off");
        assert.equal(body.classroomState, null);
        assert.equal(body.exactBinding.controlRevision, 0);
      } finally { await settings(fixtures[0]!); }
    }
  });
});
