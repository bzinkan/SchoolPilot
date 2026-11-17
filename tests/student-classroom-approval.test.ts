import assert from "node:assert/strict";
import test from "node:test";

const access = await import("../src/services/googleClassroomAccess.js").catch(() => ({}));
function exported(name: string): (...args: any[]) => any {
  const value = Reflect.get(access, name);
  assert.equal(typeof value, "function", `${name} must exist`);
  return value as (...args: any[]) => any;
}
const rosterScopes = ["https://www.googleapis.com/auth/admin.directory.user.readonly", "https://www.googleapis.com/auth/admin.directory.orgunit.readonly", "https://www.googleapis.com/auth/classroom.courses.readonly", "https://www.googleapis.com/auth/classroom.rosters.readonly", "https://www.googleapis.com/auth/classroom.profile.emails"];
const contentScopes = ["https://www.googleapis.com/auth/classroom.courses.readonly", "https://www.googleapis.com/auth/classroom.coursework.me.readonly", "https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly", "https://www.googleapis.com/auth/classroom.announcements.readonly", "https://www.googleapis.com/auth/classroom.profile.emails"];
function fixture() {
  let connector: any = { id: "connector", schoolId: "school", domain: "school.example", status: "verified", delegatedAdminEmail: "admin@school.example", serviceAccountClientId: "client", approvedScopes: [...rosterScopes], classroomAccessApproval: null, updatedAt: new Date(1) };
  let writes = 0;
  const dependencies = {
    getSchool: async () => ({ id: "school", domain: "school.example" }),
    getConnector: async () => structuredClone(connector),
    getServiceAccountInfo: () => ({ configured: true, clientId: "client", email: "service@example.iam.gserviceaccount.com", authMode: "workload_identity_federation" }),
    getStudent: async (id: string) => ({ id, schoolId: "school", status: "active", email: "a@school.example", googleUserId: "google-a" }),
    createClient: async () => ({ profile: async () => ({ data: { id: "google-a", emailAddress: "a@school.example" } }), courses: async () => ({ data: { courses: [] } }), work: async () => ({ data: {} }), materials: async () => ({ data: {} }), announcements: async () => ({ data: {} }) }),
    compareAndSetScopes: async (_school: string, expected: any, scopes: string[], approval: any) => { if (connector.id !== expected.id || +connector.updatedAt !== +expected.updatedAt || connector.status !== "verified") return undefined; writes++; connector.approvedScopes = scopes; connector.classroomAccessApproval = approval; connector.updatedAt = new Date(+connector.updatedAt + 1); return structuredClone(connector); },
  };
  return { dependencies, get: () => connector, set: (value: any) => { connector = value; }, writes: () => writes };
}

test("content setup is a separate purpose and its copied scopes preserve every roster grant", async () => {
  const fx = fixture();
  const setup = await exported("getStudentClassroomAccessSetupInfo")("school", fx.dependencies);
  assert.equal(setup.purpose, "student_classroom_access");
  assert.equal(setup.enabled, false);
  for (const scope of [...rosterScopes, ...contentScopes]) assert.ok(setup.scopes.includes(scope), scope);
  assert.equal(setup.scopesCsv, setup.scopes.join(","));
  assert.equal(setup.serviceAccountClientId, "client");
});

test("content verification binds Google's actual student identity and preserves the roster connection", async () => {
  const fx = fixture();
  const result = await exported("verifyStudentClassroomAccessForSchool")("school", "student-a", "admin-actor", fx.dependencies);
  assert.equal(result.classroomAccess.enabled, true);
  assert.equal(fx.get().status, "verified");
  assert.equal(fx.writes(), 1);
  for (const scope of [...rosterScopes, ...contentScopes]) assert.ok(fx.get().approvedScopes.includes(scope));
  assert.equal(JSON.stringify(result).includes("google-a"), false);
});

test("wrong subject, foreign school, missing roster consent and provider failure never approve content or disconnect roster", async () => {
  for (const bad of ["subject", "school", "scope", "provider"] as const) {
    const fx = fixture();
    if (bad === "subject") fx.dependencies.createClient = async () => ({ ...await fixture().dependencies.createClient(), profile: async () => ({ data: { id: "google-b", emailAddress: "a@school.example" } }) });
    if (bad === "school") fx.dependencies.getStudent = async id => ({ id, schoolId: "foreign", status: "active", email: "a@school.example", googleUserId: "google-a" });
    if (bad === "scope") fx.get().approvedScopes = [];
    if (bad === "provider") fx.dependencies.createClient = async () => { throw new Error("secret provider token detail"); };
    await assert.rejects(exported("verifyStudentClassroomAccessForSchool")("school", "student-a", "admin-actor", fx.dependencies), (error: any) => {
      assert.equal(String(error.message).includes("secret provider token detail"), false);
      return true;
    });
    assert.equal(fx.get().status, "verified");
    assert.equal(fx.writes(), 0);
  }
});

test("a concurrent disconnect or connector replacement cannot be overwritten after Google awaits", async () => {
  const fx = fixture();
  fx.dependencies.createClient = async () => {
    fx.set({ ...fx.get(), status: "disabled", updatedAt: new Date(10) });
    return fixture().dependencies.createClient();
  };
  await assert.rejects(exported("verifyStudentClassroomAccessForSchool")("school", "student-a", "admin-actor", fx.dependencies), /changed|stale|connect/i);
  assert.equal(fx.get().status, "disabled");
  assert.equal(fx.writes(), 0);
});

test("local content revocation keeps roster status and original scopes", async () => {
  const fx = fixture();
  fx.get().approvedScopes = [...new Set([...rosterScopes, ...contentScopes])];
  await exported("disableStudentClassroomAccessForSchool")("school", fx.dependencies);
  assert.equal(fx.get().status, "verified");
  assert.deepEqual(fx.get().approvedScopes, rosterScopes);
});

test("approval caching expires and an invalidation fences an in-flight stale approval", async () => {
  let now = 0;
  let reads = 0;
  let resolveRead: (value: string | null) => void = () => {};
  const approvalKey = "a".repeat(64);
  const cache = exported("createStudentClassroomAccessApprovalCache")(async () => { reads++; return reads === 1 ? approvalKey : new Promise<string | null>(resolve => { resolveRead = resolve; }); }, { now: () => now, ttlMs: 10 });
  assert.equal(await cache.read("school"), approvalKey);
  assert.equal(cache.peek("school"), approvalKey);
  assert.equal(await cache.read("school"), approvalKey);
  assert.equal(reads, 1);
  now = 11;
  assert.equal(cache.peek("school"), null);
  const pending = cache.read("school");
  await Promise.resolve();
  cache.invalidate("school");
  resolveRead(approvalKey);
  assert.equal(await pending, null);
  assert.equal(cache.peek("school"), null);
});

test("content approval has its own opaque generation and never reuses roster verification time", async () => {
  const fx = fixture();
  fx.get().approvedScopes = [...new Set([...rosterScopes, ...contentScopes])];
  assert.equal((await exported("getStudentClassroomAccessSetupInfo")("school", fx.dependencies)).enabled, false, "scopes alone are not explicit content approval");
  await exported("verifyStudentClassroomAccessForSchool")("school", "student-a", "admin-actor", fx.dependencies);
  const firstApproval = fx.get().classroomAccessApproval;
  assert.equal(firstApproval.schemaVersion, 1);
  assert.equal(firstApproval.approvedByUserId, "admin-actor");
  assert.match(firstApproval.approvalId, /^[a-f0-9-]{36}$/);
  assert.equal((await exported("getStudentClassroomAccessSetupInfo")("school", fx.dependencies)).enabled, true);
  await exported("verifyStudentClassroomAccessForSchool")("school", "student-a", "admin-actor", fx.dependencies);
  assert.notEqual(fx.get().classroomAccessApproval.approvalId, firstApproval.approvalId);
  const publicSetup = await exported("getStudentClassroomAccessSetupInfo")("school", fx.dependencies);
  assert.equal(JSON.stringify(publicSetup).includes(firstApproval.approvalId), false);
  await exported("disableStudentClassroomAccessForSchool")("school", fx.dependencies);
  assert.equal(fx.get().classroomAccessApproval, null);
});

test("IT Readiness recognizes content scopes only for separately approved content access", () => {
  const classify = exported("classifyGoogleRosterScopeReadiness");
  assert.deepEqual(classify(rosterScopes, false), { missingRosterScopes: [], extraRosterScopes: [] });
  const combined = [...new Set([...rosterScopes, ...contentScopes])];
  assert.equal(classify(combined, false).extraRosterScopes.length, 3);
  assert.deepEqual(classify(combined, true), { missingRosterScopes: [], extraRosterScopes: [] });
  assert.deepEqual(classify([...combined, "https://mail.google.com/"], true).extraRosterScopes, ["https://mail.google.com/"]);
  assert.deepEqual(classify([...combined, "https://www.googleapis.com/auth/classroom.coursework.students.readonly"], true).extraRosterScopes, ["https://www.googleapis.com/auth/classroom.coursework.students.readonly"]);
  assert.equal(classify(contentScopes, true).missingRosterScopes.length, 3, "content approval cannot substitute for a complete roster grant");
});

test("invalidating one school's approval never cancels another school's in-flight approval", async () => {
  const resolvers = new Map<string, (value: string) => void>();
  const cache = exported("createStudentClassroomAccessApprovalCache")((schoolId: string) => new Promise<string>(resolve => resolvers.set(schoolId, resolve)));
  const first = cache.read("first-school");
  const second = cache.read("second-school");
  await Promise.resolve();
  cache.invalidate("first-school");
  resolvers.get("second-school")!("b".repeat(64));
  assert.equal(await second, "b".repeat(64));
  assert.equal(cache.peek("second-school"), "b".repeat(64));
  resolvers.get("first-school")!("a".repeat(64));
  assert.equal(await first, null);
});

test("server credential errors are sanitized and content disable does not require provider credentials", async () => {
  const fx = fixture();
  fx.dependencies.getServiceAccountInfo = () => { throw new Error("private key from malformed configuration"); };
  await assert.rejects(exported("getStudentClassroomAccessSetupInfo")("school", fx.dependencies), (error: any) => {
    assert.equal(String(error.message).includes("private key"), false); return true;
  });
  fx.get().approvedScopes = [...new Set([...rosterScopes, ...contentScopes])];
  await exported("disableStudentClassroomAccessForSchool")("school", fx.dependencies);
  assert.deepEqual(fx.get().approvedScopes, rosterScopes);
});
