import { after, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { and, eq, inArray } from "drizzle-orm";
import pg from "pg";
import db, { pool, sessionPool } from "../dist/db.js";
import * as schema from "../dist/schema/index.js";
import { signUserToken } from "../dist/services/jwt.js";
import { runWithTenantContext } from "../dist/middleware/tenantContext.js";
import { CLASSPILOT_TEACHER_PREFERENCES_SCHEMA_SQL } from "../src/db/classpilotTeacherPreferencesMigration.js";

const tag = `settings_${Date.now()}`;
let schoolA: schema.School;
let schoolB: schema.School;
let admin: schema.User;
let teacher: schema.User;
let otherTeacher: schema.User;
let outsider: schema.User;
let office: schema.User;
let platformAdmin: schema.User;
let server: Server;
let baseUrl: string;
const schoolIds: string[] = [];
const userIds: string[] = [];
// Schema and failure-injection DDL use the local fixture owner. HTTP requests
// and all behavioral reads/writes keep the application's configured role.
const fixturePool = new pg.Pool({ connectionString: process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL, max: 1 });
const personalPath = "/classpilot/teacher/preferences";
const schoolPath = "/classpilot/admin/settings";
const originalSettings = {
  schoolName: "Legacy settings name",
  schoolTimezone: "America/Los_Angeles",
  wsSharedKey: "synthetic-settings-shared-key",
  enrollmentKey: "synthetic-settings-enrollment-key",
  retentionHours: "720",
  maxTabsPerStudent: "5",
  allowedDomains: ["school.example"],
  blockedDomains: [],
  ipAllowlist: ["192.0.2.1"],
  gradeLevels: ["6", "7"],
  enableTrackingHours: false,
  trackingStartTime: "08:00",
  trackingEndTime: "15:00",
  trackingDays: ["Monday", "Tuesday"],
  afterHoursMode: "off" as const,
  sharedChromebookSignInEnabled: false,
  sharedChromebookLoginMethod: "email_id" as const,
  sharedChromebookPinLoginEnabled: false,
  pauseChatDuringTesting: false,
  centralEmailRecipientUserId: null,
};

function system<T>(action: () => Promise<T>) {
  return runWithTenantContext({ isSuper: true }, action);
}
function auth(user = admin, school = schoolA) {
  return { authorization: `Bearer ${signUserToken({ userId: user.id, email: user.email, isSuperAdmin: user.isSuperAdmin })}`,
    "x-school-id": school.id };
}
async function request(method: string, path: string, body?: unknown, headers = auth()) {
  const response = await fetch(`${baseUrl}${path}`, { method, headers: { ...headers,
    ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: JSON.parse(await response.text()) };
}
async function schoolDto() {
  const response = await request("GET", schoolPath);
  assert.equal(response.status, 200);
  return response.body;
}
async function state() {
  return system(async () => ({
    settings: await db.select().from(schema.settings).where(inArray(schema.settings.schoolId, schoolIds)).orderBy(schema.settings.schoolId),
    preferences: await db.select().from(schema.classpilotTeacherPreferences).where(inArray(schema.classpilotTeacherPreferences.schoolId, schoolIds)).orderBy(schema.classpilotTeacherPreferences.id),
    legacy: await db.select().from(schema.teacherSettings).where(inArray(schema.teacherSettings.teacherId, userIds)).orderBy(schema.teacherSettings.teacherId),
    audit: await db.select().from(schema.auditLogs).where(inArray(schema.auditLogs.schoolId, schoolIds)).orderBy(schema.auditLogs.id),
    commands: await db.select().from(schema.classpilotCommands).where(inArray(schema.classpilotCommands.schoolId, schoolIds)),
  }));
}

before(async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  assert.ok(["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL || "").hostname),
    "Schema fixtures require a local database");
  await fixturePool.query(CLASSPILOT_TEACHER_PREFERENCES_SCHEMA_SQL);
  await system(async () => {
    const schools = await db.insert(schema.schools).values([
      { name: "Canonical School A", slug: `${tag}_a`, schoolTimezone: "America/Chicago" },
      { name: "Canonical School B", slug: `${tag}_b`, schoolTimezone: "America/New_York" },
    ]).returning();
    [schoolA, schoolB] = [schools[0]!, schools[1]!];
    schoolIds.push(schoolA.id, schoolB.id);
    const staff = await db.insert(schema.users).values(["admin", "teacher", "other", "outsider", "office", "platform"].map(name => ({
      email: `${name}@${tag}.example`, firstName: name, lastName: "Fixture", isSuperAdmin: name === "platform",
    }))).returning();
    [admin, teacher, otherTeacher, outsider, office, platformAdmin] = [staff[0]!, staff[1]!, staff[2]!, staff[3]!, staff[4]!, staff[5]!];
    userIds.push(...staff.map(user => user.id));
    await db.insert(schema.schoolMemberships).values([
      { schoolId: schoolA.id, userId: admin.id, role: "admin", status: "active" },
      { schoolId: schoolA.id, userId: teacher.id, role: "teacher", status: "active" },
      { schoolId: schoolA.id, userId: otherTeacher.id, role: "teacher", status: "active" },
      { schoolId: schoolA.id, userId: office.id, role: "office_staff", status: "active" },
      { schoolId: schoolB.id, userId: teacher.id, role: "teacher", status: "active" },
      { schoolId: schoolB.id, userId: outsider.id, role: "admin", status: "active" },
    ]);
    await db.insert(schema.productLicenses).values(schoolIds.map(schoolId => ({ schoolId, product: "CLASSPILOT", status: "active" })));
    await db.insert(schema.settings).values(schoolIds.map(schoolId => ({ schoolId, ...originalSettings })));
    await db.insert(schema.teacherSettings).values({ teacherId: teacher.id, maxTabsPerStudent: "9" });
  });
  const { createApp } = await import("../dist/app.js");
  server = createServer(createApp());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}/api`;
});

beforeEach(async () => {
  await system(async () => {
    await db.delete(schema.classpilotTeacherPreferences).where(inArray(schema.classpilotTeacherPreferences.schoolId, schoolIds));
    await db.delete(schema.auditLogs).where(inArray(schema.auditLogs.schoolId, schoolIds));
    await db.delete(schema.classpilotSchoolWebsitePolicies).where(inArray(schema.classpilotSchoolWebsitePolicies.schoolId, schoolIds));
    await db.update(schema.settings).set(originalSettings).where(inArray(schema.settings.schoolId, schoolIds));
    await db.update(schema.schoolMemberships).set({ status: "active" }).where(inArray(schema.schoolMemberships.schoolId, schoolIds));
    await db.update(schema.productLicenses).set({ status: "active" }).where(inArray(schema.productLicenses.schoolId, schoolIds));
    await db.update(schema.schools).set({ isActive: true, status: "active" }).where(inArray(schema.schools.id, schoolIds));
  });
});

after(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await system(async () => {
    if (schoolIds.length) {
      await db.delete(schema.classpilotTeacherPreferences).where(inArray(schema.classpilotTeacherPreferences.schoolId, schoolIds));
      await db.delete(schema.classpilotSchoolWebsitePolicies).where(inArray(schema.classpilotSchoolWebsitePolicies.schoolId, schoolIds));
      await db.delete(schema.auditLogs).where(inArray(schema.auditLogs.schoolId, schoolIds));
      await db.delete(schema.settings).where(inArray(schema.settings.schoolId, schoolIds));
      await db.delete(schema.productLicenses).where(inArray(schema.productLicenses.schoolId, schoolIds));
      await db.delete(schema.schoolMemberships).where(inArray(schema.schoolMemberships.schoolId, schoolIds));
      await db.delete(schema.schools).where(inArray(schema.schools.id, schoolIds));
    }
    if (userIds.length) {
      await db.delete(schema.teacherSettings).where(inArray(schema.teacherSettings.teacherId, userIds));
      await db.delete(schema.users).where(inArray(schema.users.id, userIds));
    }
  });
  mock.timers.reset();
  await Promise.all([pool.end(), sessionPool.end(), fixturePool.end()]);
});

describe("ClassPilot scoped settings saves", () => {
  it("reads absent preferences without writing or reusing legacy account defaults", async () => {
    const before = await state();
    const response = await request("GET", personalPath, undefined, auth(teacher));
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { schoolId: schoolA.id, revision: 0, maxTabsPerStudent: null,
      schoolMaxTabsPerStudent: 5, effectiveMaxTabsPerStudent: 5 });
    assert.deepEqual(await state(), before);
  });

  it("keeps personal values within one school and author, permits explicit inheritance, and sends no commands", async () => {
    const before = await state();
    const first = await request("PATCH", personalPath, { expectedRevision: 0, maxTabsPerStudent: 8 }, auth(teacher));
    assert.equal(first.status, 200);
    assert.equal(first.body.revision, 1);
    assert.equal(first.body.effectiveMaxTabsPerStudent, 8);
    for (const headers of [auth(teacher, schoolB), auth(otherTeacher)]) {
      const separate = await request("GET", personalPath, undefined, headers);
      assert.equal(separate.body.revision, 0);
      assert.equal(separate.body.maxTabsPerStudent, null);
    }
    const inherited = await request("PATCH", personalPath, { expectedRevision: 1, maxTabsPerStudent: null }, auth(teacher));
    assert.equal(inherited.status, 200);
    assert.equal(inherited.body.revision, 2);
    assert.equal(inherited.body.maxTabsPerStudent, null);
    assert.equal(inherited.body.effectiveMaxTabsPerStudent, 5);
    const after = await state();
    assert.equal(after.preferences.length, 1);
    assert.equal(after.preferences[0]!.teacherId, teacher.id);
    assert.deepEqual(after.settings, before.settings);
    assert.deepEqual(after.legacy, before.legacy);
    assert.deepEqual(after.commands, before.commands);
  });

  it("serializes competing first saves and rejects the loser without changing the winner", async () => {
    const responses = await Promise.all([3, 7].map(maxTabsPerStudent => request("PATCH", personalPath,
      { expectedRevision: 0, maxTabsPerStudent }, auth(teacher))));
    const winner = responses.find(response => response.status === 200);
    const loser = responses.find(response => response.status === 409);
    assert.ok(winner && loser);
    assert.equal(loser.body.code, "CLASSPILOT_PREFERENCES_CONFLICT");
    assert.deepEqual(loser.body.current, winner.body);
    const current = await request("GET", personalPath, undefined, auth(teacher));
    assert.deepEqual(current.body, winner.body);
    assert.equal((await state()).preferences.length, 1);
  });

  it("rejects malformed personal payloads and caller-supplied identity fields without writes", async () => {
    const before = await state();
    for (const body of [null, [], {}, { expectedRevision: 0 }, ...[0, 101, 1.5, "4"].map(maxTabsPerStudent => ({ expectedRevision: 0, maxTabsPerStudent })),
      { expectedRevision: -1, maxTabsPerStudent: 4 }, { expectedRevision: 0, maxTabsPerStudent: 4, teacherId: otherTeacher.id },
      { expectedRevision: 0, maxTabsPerStudent: 4, schoolId: schoolB.id }, { expectedRevision: 0, maxTabsPerStudent: 4, allowedDomains: [] }]) {
      const response = await request("PATCH", personalPath, body, auth(teacher));
      assert.equal(response.status, 400, JSON.stringify(body));
    }
    assert.deepEqual(await state(), before);
  });

  it("requires active teaching membership and current school entitlement for personal reads and writes", async () => {
    for (const actor of [office, outsider, platformAdmin]) {
      for (const method of ["GET", "PATCH"]) {
        const response = await request(method, personalPath, method === "GET" ? undefined : { expectedRevision: 0, maxTabsPerStudent: 4 }, auth(actor));
        assert.equal(response.status, 403, `${actor.firstName} ${method}`);
      }
    }
    await system(() => db.update(schema.schoolMemberships).set({ status: "suspended" }).where(and(eq(schema.schoolMemberships.schoolId, schoolA.id), eq(schema.schoolMemberships.userId, teacher.id))));
    assert.equal((await request("PATCH", personalPath, { expectedRevision: 0, maxTabsPerStudent: 4 }, auth(teacher))).status, 403);
    await system(() => db.update(schema.productLicenses).set({ status: "inactive" }).where(eq(schema.productLicenses.schoolId, schoolA.id)));
    assert.equal((await request("GET", personalPath, undefined, auth(admin))).status, 403);
    await system(() => db.update(schema.schools).set({ isActive: false }).where(eq(schema.schools.id, schoolB.id)));
    assert.equal((await request("PATCH", personalPath, { expectedRevision: 0, maxTabsPerStudent: 4 }, auth(teacher, schoolB))).status, 403);
    assert.equal((await state()).preferences.length, 0);
  });

  it("returns canonical profile identity and visible school fields without secrets", async () => {
    const current = await schoolDto();
    assert.equal(current.schoolName, schoolA.name);
    assert.equal(current.schoolTimezone, schoolA.schoolTimezone);
    assert.deepEqual(current.sections.classroom.allowedDomains, ["school.example"]);
    assert.deepEqual(current.sections.rosterGrades.gradeLevels, ["6", "7"]);
    assert.equal(JSON.stringify(current).includes("synthetic-settings"), false);
    for (const forbidden of ["ipAllowlist", "wsSharedKey", "enrollmentKey", "teacherId"]) assert.equal(JSON.stringify(current).includes(forbidden), false);
    assert.equal((await request("GET", schoolPath, undefined, auth(teacher))).status, 403);
    const legacy = await request("GET", "/settings", undefined, auth(teacher));
    assert.deepEqual(legacy.body.allowedDomains, ["school.example"]);
    assert.deepEqual(legacy.body.gradeLevels, ["6", "7"]);
  });

  it("saves independent school sections against their own versions and rejects stale replacement", async () => {
    const before = await state();
    const loaded = await schoolDto();
    const retention = await request("PATCH", `${schoolPath}/retention`, { expectedVersion: loaded.sections.retention.version, retentionHours: "48" });
    assert.equal(retention.status, 200);
    const classroom = await request("PATCH", `${schoolPath}/classroom`, { expectedVersion: loaded.sections.classroom.version, maxTabsPerStudent: 6, allowedDomains: ["class.example"] });
    assert.equal(classroom.status, 200);
    const stable = await state();
    const stale = await request("PATCH", `${schoolPath}/retention`, { expectedVersion: loaded.sections.retention.version, retentionHours: "96" });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "CLASSPILOT_SETTINGS_CONFLICT");
    assert.equal(stale.body.current.retentionHours, "48");
    assert.deepEqual(await state(), stable);
    const a = stable.settings.find(row => row.schoolId === schoolA.id)!;
    assert.deepEqual(a.ipAllowlist, originalSettings.ipAllowlist);
    assert.equal(a.schoolName, originalSettings.schoolName);
    assert.equal(a.enrollmentKey, originalSettings.enrollmentKey);
    assert.equal(a.pauseChatDuringTesting, false);
    assert.deepEqual(stable.settings.find(row => row.schoolId === schoolB.id), before.settings.find(row => row.schoolId === schoolB.id));
    assert.deepEqual(stable.preferences, before.preferences);
    assert.deepEqual(stable.legacy, before.legacy);
    assert.equal(stable.audit.length, 2);
    assert.ok(stable.audit.every(row => row.userId === admin.id && row.schoolId === schoolA.id));
  });

  it("rejects hidden fields, cross-school versions, invalid retention and invalid monitoring atomically", async () => {
    const loaded = await schoolDto();
    const other = await request("GET", schoolPath, undefined, auth(outsider, schoolB));
    const before = await state();
    const invalidRequests = [
      ["classroom", { expectedVersion: loaded.sections.classroom.version, maxTabsPerStudent: 5, allowedDomains: [], ipAllowlist: [] }],
      ["classroom", { expectedVersion: loaded.sections.classroom.version, maxTabsPerStudent: 5, allowedDomains: [], pauseChatDuringTesting: true }],
      ["retention", { expectedVersion: loaded.sections.retention.version, retentionHours: "25" }],
      ["retention", { expectedVersion: loaded.sections.retention.version, retentionHours: "8784" }],
      ["retention", { expectedVersion: loaded.sections.retention.version, retentionHours: "24", schoolId: schoolB.id }],
      ["monitoring", { expectedVersion: loaded.sections.monitoring.version, enableTrackingHours: false, trackingStartTime: "08:00", trackingEndTime: "15:00", trackingDays: ["Monday"], afterHoursMode: "limited" }],
      ["monitoring", { expectedVersion: loaded.sections.monitoring.version, enableTrackingHours: true, trackingStartTime: "08:00", trackingEndTime: "08:00", trackingDays: ["Monday"], afterHoursMode: "off" }],
    ] as const;
    for (const [section, body] of invalidRequests) assert.equal((await request("PATCH", `${schoolPath}/${section}`, body)).status, 400, section);
    assert.equal((await request("PATCH", `${schoolPath}/retention`, { expectedVersion: other.body.sections.retention.version, retentionHours: "24" })).status, 409);
    assert.equal((await request("PATCH", `${schoolPath}/retention`, { expectedVersion: loaded.sections.retention.version, retentionHours: "24" }, auth(teacher))).status, 403);
    assert.deepEqual(await state(), before);
  });

  it("keeps website policy revisions separate and updates only active same-school email recipients", async () => {
    const loaded = await schoolDto();
    const blocked = await request("PATCH", `${schoolPath}/blockedWebsites`, { policyRevision: 0, blockedDomains: ["blocked.example"] });
    assert.equal(blocked.status, 200);
    assert.equal(blocked.body.policyRevision, 1);
    const conflict = await request("PATCH", `${schoolPath}/blockedWebsites`, { policyRevision: 0, blockedDomains: [] });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, "SCHOOL_WEBSITE_POLICY_CONFLICT");
    for (const recipient of [outsider.id, " ", "missing-user"]) {
      assert.equal((await request("PATCH", `${schoolPath}/email`, { expectedVersion: loaded.sections.email.version, centralEmailRecipientUserId: recipient })).status, 400);
    }
    const email = await request("PATCH", `${schoolPath}/email`, { expectedVersion: loaded.sections.email.version, centralEmailRecipientUserId: office.id });
    assert.equal(email.status, 200);
    assert.equal(email.body.centralEmailRecipientUserId, office.id);
    const clear = await request("PATCH", `${schoolPath}/email`, { expectedVersion: email.body.version, centralEmailRecipientUserId: null });
    assert.equal(clear.status, 200);
    const current = await schoolDto();
    assert.deepEqual(current.sections.blockedWebsites, { policyRevision: 1, blockedDomains: ["blocked.example"] });
    assert.equal(current.sections.classroom.version, loaded.sections.classroom.version);
  });

  it("saves visible monitoring, sign-in and grade fields while retaining unrelated settings and null inheritance", async () => {
    const loaded = await schoolDto();
    const monitoring = await request("PATCH", `${schoolPath}/monitoring`, {
      expectedVersion: loaded.sections.monitoring.version, enableTrackingHours: true,
      trackingStartTime: "07:30", trackingEndTime: "16:30", trackingDays: ["Monday", "Wednesday"], afterHoursMode: "limited",
    });
    assert.equal(monitoring.status, 200);
    assert.equal(monitoring.body.afterHoursMode, "limited");
    const signIn = await request("PATCH", `${schoolPath}/signIn`, {
      expectedVersion: loaded.sections.signIn.version, sharedChromebookSignInEnabled: true,
    });
    assert.equal(signIn.status, 200);
    const grades = await request("PATCH", `${schoolPath}/rosterGrades`, {
      expectedVersion: loaded.sections.rosterGrades.version, gradeLevels: [" 8 ", "9", "8"],
    });
    assert.equal(grades.status, 200);
    assert.deepEqual(grades.body.gradeLevels, ["8", "9"]);
    assert.equal((await request("PATCH", `${schoolPath}/classroom`, {
      expectedVersion: loaded.sections.classroom.version, maxTabsPerStudent: null, allowedDomains: [],
    })).status, 200);
    const inherited = await request("GET", personalPath, undefined, auth(teacher));
    assert.equal(inherited.body.schoolMaxTabsPerStudent, null);
    assert.equal(inherited.body.effectiveMaxTabsPerStudent, null);
    const current = (await state()).settings.find(row => row.schoolId === schoolA.id)!;
    assert.equal(current.sharedChromebookLoginMethod, "name_pin");
    assert.equal(current.sharedChromebookPinLoginEnabled, true);
    assert.deepEqual(current.ipAllowlist, originalSettings.ipAllowlist);
    assert.equal(current.schoolTimezone, originalSettings.schoolTimezone);
  });

  it("rolls back settings changes when the required audit write fails", async () => {
    const loaded = await schoolDto();
    const before = await state();
    await fixturePool.query(`CREATE FUNCTION settings_fixture_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action = 'classpilot.settings.update' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER settings_fixture_audit_failure BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION settings_fixture_audit_failure();`);
    try {
      const failed = await request("PATCH", `${schoolPath}/retention`, { expectedVersion: loaded.sections.retention.version, retentionHours: "24" });
      assert.equal(failed.status, 500);
      assert.deepEqual(await state(), before);
    } finally {
      await fixturePool.query("DROP TRIGGER settings_fixture_audit_failure ON audit_logs; DROP FUNCTION settings_fixture_audit_failure();");
    }
  });

  it("retires every mixed settings writer with refresh-required and zero writes", async () => {
    const before = await state();
    for (const path of ["/settings", "/teacher/settings", "/classpilot/teacher/settings"]) {
      for (const user of [admin, teacher]) {
        const response = await request("POST", path, { schoolName: "Wrong", retentionHours: "24", maxTabsPerStudent: "2",
          centralEmailRecipientUserId: office.id, blockedDomains: ["wrong.example"], gradeLevels: ["12"] }, auth(user));
        assert.equal(response.status, 409, path);
        assert.equal(response.body.code, "SETTINGS_REFRESH_REQUIRED");
      }
    }
    assert.deepEqual(await state(), before);
  });
});
