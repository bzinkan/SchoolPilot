import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { sql } from "drizzle-orm";
import express from "express";
import session from "express-session";

const tag = `cp_apps_${Date.now()}`;
process.env.NODE_ENV = "test";
process.env.REDIS_URL = "";
let storage: typeof import("../src/services/storage.js");
let context: typeof import("../src/middleware/tenantContext.js");
let signUserToken: typeof import("../src/services/jwt.js").signUserToken;
let dbModule: typeof import("../src/db.js");
let schedulerModule: typeof import("../src/services/schedulerDb.js");
let server: Server;
let base: string;
let school: { id: string };
let foreign: { id: string };
let teacherA: { id: string; email: string };
let teacherB: { id: string; email: string };
let admin: { id: string; email: string };
let outsider: { id: string; email: string };
let personalKey: string;
let schoolKey: string;

async function request(method: string, path: string, user: { id: string; email: string; isSuperAdmin?: boolean } = teacherA, body?: unknown, schoolId = school.id) {
  const response = await fetch(`${base}/api/classpilot/apps${path}`, { method, headers: {
    authorization: `Bearer ${signUserToken({ userId: user.id, email: user.email, isSuperAdmin: user.isSuperAdmin === true })}`,
    "x-school-id": schoolId, ...(body === undefined ? {} : { "content-type": "application/json" }),
  }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, text };
}

before(async () => {
  dbModule = await import("../src/db.js");
  storage = await import("../src/services/storage.js");
  context = await import("../src/middleware/tenantContext.js");
  ({ signUserToken } = await import("../src/services/jwt.js"));
  schedulerModule = await import("../src/services/schedulerDb.js");
  school = await storage.createSchool({ name: `${tag} School`, domain: `${tag}.example.edu`, slug: tag });
  foreign = await storage.createSchool({ name: `${tag} Foreign`, domain: `${tag}-foreign.example.edu`, slug: `${tag}-foreign` });
  const createdUsers = await Promise.all(["a", "b", "admin", "foreign"].map(name => storage.createUser({
    email: `${name}@${tag}${name === "foreign" ? "-foreign" : ""}.example.edu`, firstName: name, lastName: "Apps",
  })));
  teacherA = createdUsers[0]!;
  teacherB = createdUsers[1]!;
  admin = createdUsers[2]!;
  outsider = createdUsers[3]!;
  for (const [user, role, target] of [[teacherA, "teacher", school], [teacherB, "teacher", school], [admin, "school_admin", school], [outsider, "teacher", foreign]] as const) {
    await storage.createMembership({ userId: user.id, schoolId: target.id, role, status: "active" });
  }
  for (const target of [school, foreign]) {
    await storage.createProductLicense({ schoolId: target.id, product: "CLASSPILOT", status: "active" });
    await storage.upsertSettings(target.id, { schoolName: tag, wsSharedKey: "" });
  }
  const { createApp } = await import("../src/app.js");
  server = createServer(createApp());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  try {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (dbModule && context) for (const target of [school, foreign]) if (target) await context.runWithTenantContext({ isSuper: true }, async () => {
      await dbModule.default.execute(sql`DELETE FROM classpilot_app_button_preferences WHERE school_id = ${target.id}`);
      await dbModule.default.execute(sql`DELETE FROM classpilot_app_buttons WHERE school_id = ${target.id}`);
      await dbModule.default.execute(sql`DELETE FROM audit_logs WHERE school_id = ${target.id}`);
      await dbModule.default.execute(sql`DELETE FROM product_licenses WHERE school_id = ${target.id}`);
      await dbModule.default.execute(sql`DELETE FROM school_memberships WHERE school_id = ${target.id}`);
      await dbModule.default.execute(sql`DELETE FROM settings WHERE school_id = ${target.id}`);
    });
  } finally {
    await schedulerModule?.schedulerLockPool.end();
    await schedulerModule?.schedulerPool.end();
    await dbModule?.sessionPool.end();
    await dbModule?.pool.end();
  }
});

describe("ClassPilot app library HTTP authorization and persistence", { concurrency: false }, () => {
  it("requires a real active membership for a global superadministrator reading the library", async () => {
    const superUser = await storage.createUser({ email: `super-read@${tag}.example.edu`, firstName: "Super", lastName: "Reader", isSuperAdmin: true });
    const response = await request("GET", "", superUser);
    assert.equal(response.status, 403, response.text);
    await assert.rejects(() => storage.getClasspilotAppLibrary(school.id, { teacherId: superUser.id, isAdmin: true }),
      (error: unknown) => error instanceof Error && "status" in error && error.status === 403);
  });

  it("refuses a global superadministrator without membership in direct app writes", async () => {
    const superUser = await storage.createUser({ email: `super-write@${tag}.example.edu`, firstName: "Super", lastName: "Writer", isSuperAdmin: true });
    await assert.rejects(() => storage.createClasspilotAppButton(school.id, { teacherId: superUser.id, isAdmin: true },
      { scope: "personal", name: "Forbidden", launchUrl: "ixl.com" }),
    (error: unknown) => error instanceof Error && "status" in error && error.status === 403);
    await assert.rejects(() => storage.setClasspilotAppButtonPreference(school.id, { teacherId: superUser.id, isAdmin: true },
      "builtin:docs", { saved: true, favorite: true }),
    (error: unknown) => error instanceof Error && "status" in error && error.status === 403);
  });

  it("uses a superadministrator's real teacher role for school app permissions", async () => {
    const superUser = await storage.createUser({ email: `super-teacher@${tag}.example.edu`, firstName: "Super", lastName: "Teacher", isSuperAdmin: true });
    await storage.createMembership({ userId: superUser.id, schoolId: school.id, role: "teacher", status: "active" });
    const response = await request("GET", "", superUser);
    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.canManageSchoolApps, false);
    assert.equal((await request("POST", "", superUser, { scope: "school", name: "Forbidden", launchUrl: "ixl.com" })).status, 403);
  });
  it("lists the common catalog and saves a private website using authenticated ownership", async () => {
    const initial = await request("GET", "");
    assert.equal(initial.status, 200, initial.text);
    assert.equal(initial.body.apps.length, 9);
    assert.equal(initial.body.canManageSchoolApps, false);
    const created = await request("POST", "", teacherA, { scope: "personal", name: "My Math", launchUrl: "www.ixl.com/math" });
    assert.equal(created.status, 201, created.text);
    personalKey = created.body.app.key;
    assert.equal(created.body.app.saved, true);
    assert.equal(created.body.app.canEdit, true);
    assert.deepEqual(created.body.app.allowedDomains, ["ixl.com"]);
    assert.equal(created.body.app.launchUrl, "https://www.ixl.com/math");
    assert.doesNotMatch(created.text, /ownerTeacherId|schoolId|teacherId/);
    for (const viewer of [teacherB, admin]) {
      const list = await request("GET", "", viewer);
      assert.equal(list.body.apps.some((app: { key: string }) => app.key === personalKey), false);
      assert.equal((await request("PATCH", `/${personalKey}`, viewer, { name: "Stolen", launchUrl: "example.edu", expectedRevision: 1 })).status, 404);
      assert.equal((await request("DELETE", `/${personalKey}`, viewer, { expectedRevision: 1 })).status, 404);
      assert.equal((await request("PUT", `/${personalKey}/preferences`, viewer, { saved: true, favorite: true })).status, 404);
    }
  });

  it("allows school apps to all teachers while reserving mutations to administrators", async () => {
    assert.equal((await request("POST", "", teacherA, { scope: "school", name: "School Math", launchUrl: "ixl.com" })).status, 403);
    const created = await request("POST", "", admin, { scope: "school", name: "School Math", launchUrl: "ixl.com" });
    assert.equal(created.status, 201, created.text);
    schoolKey = created.body.app.key;
    const list = await request("GET", "", teacherB);
    assert.equal(list.body.apps.find((app: { key: string }) => app.key === schoolKey).canEdit, false);
    assert.equal((await request("PATCH", `/${schoolKey}`, teacherB, { name: "Wrong", launchUrl: "quill.org", expectedRevision: 1 })).status, 403);
    const changed = await request("PATCH", `/${schoolKey}`, admin, { name: "School Writing", launchUrl: "quill.org", expectedRevision: 1 });
    assert.equal(changed.status, 200, changed.text);
    assert.deepEqual(changed.body.app.allowedDomains, ["quill.org"]);
    const externalList = await request("GET", "", outsider, undefined, foreign.id);
    assert.equal(externalList.body.apps.some((app: { key: string }) => app.key === schoolKey), false);
    assert.equal((await request("PUT", `/${schoolKey}/preferences`, outsider, { saved: true, favorite: true }, foreign.id)).status, 404);
    assert.equal((await request("DELETE", `/${schoolKey}`, outsider, { expectedRevision: 1 }, foreign.id)).status, 404);
  });

  it("persists favorites per viewer, rejects invalid state, and keeps built-ins immutable", async () => {
    const saved = await request("PUT", "/builtin:docs/preferences", teacherA, { saved: true, favorite: true });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.body.app.favorite, true);
    const mine = await request("GET", "");
    const theirs = await request("GET", "", teacherB);
    assert.equal(mine.body.apps.find((app: { key: string }) => app.key === "builtin:docs").favorite, true);
    assert.equal(theirs.body.apps.find((app: { key: string }) => app.key === "builtin:docs").favorite, false);
    assert.equal((await request("PUT", "/builtin:docs/preferences", teacherA, { saved: false, favorite: true })).status, 400);
    assert.equal((await request("PATCH", "/builtin:docs", admin, { name: "Wrong", launchUrl: "quill.org", expectedRevision: 1 })).status, 403);
    assert.equal((await request("DELETE", "/builtin:docs", admin, { expectedRevision: 1 })).status, 403);
    assert.equal((await request("PUT", "/builtin:missing/preferences", teacherA, { saved: true, favorite: false })).status, 404);
    assert.equal((await request("PUT", "/builtin:docs/preferences", teacherA, { saved: false, favorite: false })).body.app.favorite, false);
  });

  it("rejects identity injection and invalid addresses without creating entries", async () => {
    for (const extra of [{ schoolId: foreign.id }, { teacherId: teacherB.id }, { ownerTeacherId: teacherB.id }]) {
      assert.equal((await request("POST", "", teacherA, { scope: "personal", name: "Injected", launchUrl: "ixl.com", ...extra })).status, 400);
    }
    for (const launchUrl of ["javascript:alert(1)", "https://a:b@example.edu", "http://127.0.0.1", "https://co.uk"]) {
      assert.equal((await request("POST", "", teacherA, { scope: "personal", name: "Invalid", launchUrl })).status, 400);
    }
  });

  it("deleting a school definition removes all saved preferences", async () => {
    await request("PUT", `/${schoolKey}/preferences`, teacherA, { saved: true, favorite: true });
    await request("PUT", `/${schoolKey}/preferences`, teacherB, { saved: true, favorite: true });
    assert.equal((await request("DELETE", `/${schoolKey}`, admin, { expectedRevision: 2 })).status, 204);
    assert.equal((await request("PUT", `/${schoolKey}/preferences`, teacherA, { saved: true, favorite: true })).status, 404);
    const result = await context.runWithTenantContext({ schoolId: school.id }, () => dbModule.default.execute(sql`SELECT app_key FROM classpilot_app_button_preferences WHERE school_id = ${school.id} AND app_key = ${schoolKey}`));
    assert.equal(result.rows.length, 0);
  });

  it("records administrator school-app changes without copying website URLs into audit logs", async () => {
    const result = await context.runWithTenantContext({ schoolId: school.id }, () => dbModule.default.execute(sql`
      SELECT action, changes, metadata FROM audit_logs WHERE school_id = ${school.id} AND entity_id = ${schoolKey.slice(6)} ORDER BY created_at, id`));
    assert.deepEqual(result.rows.map(row => row.action), ["classpilot.app.school.created", "classpilot.app.school.updated", "classpilot.app.school.deleted"]);
    assert.doesNotMatch(JSON.stringify(result.rows), /ixl\.com|quill\.org/);
  });

  it("blocks private app data and preferences through a real impersonation session, even with a bearer token", async () => {
    const app = express();
    app.use(session({ secret: "apps-test-support-session-secret", resave: false, saveUninitialized: false }));
    app.post("/fixture/impersonate", (req, res) => {
      req.session.userId = teacherA.id;
      req.session.originalUserId = admin.id;
      req.session.impersonating = true;
      req.session.authVersion = 1;
      res.json({ ok: true });
    });
    const { default: appRouter } = await import("../src/routes/classpilot/apps.js");
    const { errorHandler } = await import("../src/middleware/errorHandler.js");
    app.use("/api/classpilot/apps", express.json(), appRouter);
    app.use(errorHandler);
    const supportServer = createServer(app);
    await new Promise<void>(resolve => supportServer.listen(0, "127.0.0.1", resolve));
    const supportBase = `http://127.0.0.1:${(supportServer.address() as AddressInfo).port}`;
    try {
      const impersonate = await fetch(`${supportBase}/fixture/impersonate`, { method: "POST" });
      const cookie = impersonate.headers.get("set-cookie")?.split(";")[0];
      assert.ok(cookie);
      for (const [method, path, body] of [["GET", "", undefined], ["POST", "", { scope: "personal", name: "Support-created", launchUrl: "quill.org" }],
        ["PUT", "/builtin:docs/preferences", { saved: true, favorite: true }]] as const) {
        const response = await fetch(`${supportBase}/api/classpilot/apps${path}`, { method, headers: { cookie, "x-school-id": school.id,
          authorization: `Bearer ${signUserToken({ userId: admin.id, email: admin.email, isSuperAdmin: false })}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await response.text();
        assert.equal(response.status, 403, text);
        assert.equal(JSON.parse(text).code, "CLASSPILOT_APPS_IMPERSONATION_BLOCKED");
        assert.doesNotMatch(text, /ixl\.com|My Math/);
      }
    } finally { await new Promise<void>((resolve, reject) => supportServer.close(error => error ? reject(error) : resolve())); }
  });

  it("refuses stale school-button edits rather than overwriting the first administrator change", async () => {
    const actor = { teacherId: admin.id, isAdmin: true };
    const app = await storage.createClasspilotAppButton(school.id, actor, { scope: "school", name: "Concurrent original", launchUrl: "ixl.com" });
    const firstInput = { name: "Reviewed update", launchUrl: "quill.org", expectedRevision: 1 };
    const staleInput = { name: "Stale overwrite", launchUrl: "example.edu", expectedRevision: 1 };
    await storage.updateClasspilotAppButton(school.id, actor, app.key, firstInput);
    await assert.rejects(() => storage.updateClasspilotAppButton(school.id, actor, app.key, staleInput),
      (error: unknown) => error instanceof Error && "status" in error && error.status === 409);
    const list = await request("GET", "", admin);
    const latest = list.body.apps.find((row: { key: string }) => row.key === app.key);
    assert.equal(latest.name, firstInput.name);
    assert.equal(latest.revision, 2);
    const staleDelete = await request("DELETE", `/${app.key}`, admin, { expectedRevision: 1 });
    assert.equal(staleDelete.status, 409, staleDelete.text);
  });

  it("rechecks school-app administrator status inside the write rather than trusting stale middleware metadata", async () => {
    await assert.rejects(() => storage.createClasspilotAppButton(school.id, { teacherId: teacherA.id, isAdmin: true },
      { scope: "school", name: "Stale-role app", launchUrl: "ixl.com" }),
    (error: unknown) => error instanceof Error && "status" in error && error.status === 403);
  });

  it("rejects an administrator edit queued behind a committed role revocation", async () => {
    const created = await request("POST", "", admin, { scope: "school", name: "Queued original", launchUrl: "ixl.com" });
    assert.equal(created.status, 201, created.text);
    const blocker = await dbModule.pool.connect();
    let pending: ReturnType<typeof request> | undefined;
    let settled = false;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM schools WHERE id = $1 FOR UPDATE", [school.id]);
      const blockerPid = (await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      pending = request("PATCH", `/${created.body.app.key}`, admin, { name: "Queued forbidden", launchUrl: "quill.org", expectedRevision: 1 })
        .then(response => { settled = true; return response; });
      let queued = false;
      const deadline = Date.now() + 5_000;
      while (!settled && Date.now() < deadline) {
        const waiting = await blocker.query<{ waiting: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS waiting", [blockerPid]);
        if (waiting.rows[0]?.waiting) { queued = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(queued, true, "App mutation must wait behind the canonical school lifecycle lock");
      await blocker.query("UPDATE school_memberships SET role = 'teacher' WHERE school_id = $1 AND user_id = $2", [school.id, admin.id]);
      await blocker.query("COMMIT");
      const refused = await pending;
      assert.equal(refused.status, 403, refused.text);
      const result = await blocker.query<{ name: string }>("SELECT name FROM classpilot_app_buttons WHERE id = $1 AND school_id = $2", [created.body.app.key.slice(6), school.id]);
      assert.equal(result.rows[0]?.name, "Queued original");
    } finally {
      await blocker.query("ROLLBACK");
      await pending?.catch(() => undefined);
      blocker.release();
    }
  });

  it("refuses other-school context, revoked membership, and inactive school access", async () => {
    assert.equal((await request("GET", "", outsider, undefined, school.id)).status, 403);
    await context.runWithTenantContext({ isSuper: true }, () => dbModule.default.execute(sql`
      UPDATE school_memberships SET status = 'inactive' WHERE school_id = ${school.id} AND user_id = ${teacherB.id}`));
    assert.equal((await request("GET", "", teacherB)).status, 403);
    await assert.rejects(() => storage.setClasspilotAppButtonPreference(school.id, { teacherId: teacherB.id, isAdmin: false },
      "builtin:docs", { saved: true, favorite: true }),
    (error: unknown) => error instanceof Error && "status" in error && error.status === 403);
    await context.runWithTenantContext({ isSuper: true }, () => dbModule.default.execute(sql`UPDATE schools SET is_active = false WHERE id = ${foreign.id}`));
    assert.equal((await request("GET", "", outsider, undefined, foreign.id)).status, 403);
  });
});
