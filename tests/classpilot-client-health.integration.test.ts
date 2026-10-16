import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

process.env.NODE_ENV = "test";
process.env.REDIS_URL = "";
const databaseHost = new URL(process.env.DATABASE_URL || "postgresql://localhost/unused").hostname;
assert.ok(["localhost", "127.0.0.1", "::1", "[::1]"].includes(databaseHost), "HTTP fixtures must use local PostgreSQL");

const storage = await import("../src/services/storage.js");
const { createApp } = await import("../src/app.js");
const { signUserToken } = await import("../src/services/jwt.js");
const { runWithTenantContext } = await import("../src/middleware/tenantContext.js");
let server: Server;
let baseUrl: string;
let schoolId: string;
let otherSchoolId: string;
let teacherToken: string;
let adminToken: string;
let officeToken: string;
let parentToken: string;
let operatorToken: string;
const tag = randomUUID();
const body = {
  version: 1, intervalSeconds: 60, freshnessBuckets: [100, 10, 0, 0, 0, 1],
  counters: { readTimeouts: 0, reconnects: 1, recoveries: 1, eventGapRecoveries: 0 },
};

before(async () => {
  const school = await storage.createSchool({ name: `Client health ${tag}`, domain: `${tag}.example.test`, status: "active", isActive: true, planStatus: "active" });
  const other = await storage.createSchool({ name: `Other health ${tag}`, domain: `other-${tag}.example.test`, status: "active", isActive: true, planStatus: "active" });
  schoolId = school.id; otherSchoolId = other.id;
  await storage.createProductLicense({ schoolId, product: "CLASSPILOT", status: "active" });
  const tokens: string[] = [];
  for (const role of ["teacher", "admin", "office_staff", "parent"] as const) {
    const user = await storage.createUser({ email: `${role}@${tag}.example.test`, firstName: "Synthetic", lastName: "Health" });
    await storage.createMembership({ schoolId, userId: user.id, role, status: "active" });
    tokens.push(signUserToken({ userId: user.id, email: user.email, authVersion: user.authVersion }));
  }
  [teacherToken, adminToken, officeToken, parentToken] = tokens as [string, string, string, string];
  const operator = await storage.createUser({ email: `operator@${tag}.example.test`, firstName: "Synthetic", lastName: "Operator", isSuperAdmin: true });
  operatorToken = signUserToken({ userId: operator.id, email: operator.email, authVersion: operator.authVersion });
  server = createServer(createApp());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>(resolve => server?.close(() => resolve()));
  for (const id of [schoolId, otherSchoolId].filter(Boolean)) {
    await runWithTenantContext({ schoolId: id }, () => storage.softDeleteSchool(id));
  }
  await (await import("../src/services/errorMonitor.js")).default.disposeAndWait();
  const { pool, sessionPool } = await import("../src/db.js");
  const { schedulerPool, schedulerLockPool } = await import("../src/services/schedulerDb.js");
  await Promise.all([pool.end(), sessionPool.end(), schedulerPool.end(), schedulerLockPool.end()]);
});

function report(token = "", summary: unknown = body, school = schoolId) {
  return fetch(`${baseUrl}/api/classpilot/monitoring/client-health`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-school-id": school, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(summary),
  });
}

test("client health uses actual authentication, school membership and staff-role gates", async () => {
  assert.equal((await report()).status, 401);
  assert.equal((await report(teacherToken, body, otherSchoolId)).status, 403);
  assert.equal((await report(parentToken)).status, 403);
  assert.equal((await report(operatorToken)).status, 403, "Global operator privileges do not replace actual dashboard membership");
  assert.equal((await report(officeToken)).status, 204, "Office staff can report the health of an authorized supervision dashboard");
});

test("client health rejects private payloads, emits 204 and limits the verified actor", async () => {
  const invalid = await report(teacherToken, { ...body, studentId: "must-not-be-logged" });
  assert.equal(invalid.status, 400);
  assert.doesNotMatch(await invalid.text(), /must-not-be-logged/);
  const valid = await report(teacherToken);
  assert.equal(valid.status, 204);
  assert.equal(valid.headers.get("cache-control"), "no-store");
  assert.equal(await valid.text(), "");
  assert.equal((await report(teacherToken)).status, 429);
  assert.equal((await report(adminToken)).status, 204, "Another verified actor has an independent reporting allowance");
});

test("canonical entitlement revocation blocks client health even with an existing token", async () => {
  await storage.updateSchool(schoolId, { isActive: false });
  const denied = await report(adminToken);
  assert.equal(denied.status, 403);
  const payload = await denied.json();
  assert.ok(payload && typeof payload === "object" && "code" in payload);
  assert.equal(payload.code, "CLASSPILOT_NOT_ENTITLED");
});
