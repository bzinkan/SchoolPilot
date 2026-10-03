import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import pg from "pg";
import { sql } from "drizzle-orm";

process.env.NODE_ENV = "test";
process.env.SCHEDULER_ENABLED = "false";
process.env.RLS_GUC_ENABLED = "true";
process.env.REDIS_URL = "";

test("rollback heartbeat final clock fence retains exact binding and tenant authority", { timeout: 120_000 }, async t => {
  const { db, pool, sessionPool } = await import("../src/db.js");
  const storage = await import("../src/services/storage.js");
  const { runWithTenantContext, drainTenantContextReleases } = await import("../src/middleware/tenantContext.js");
  const schools: string[] = [], tag = `rollback_fence_${randomUUID().replaceAll("-", "")}`;
  const scoped = <T>(schoolId: string, action: () => Promise<T>) => runWithTenantContext({ schoolId }, action);
  const waitReady = async <T>(promise: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("native authority fixture did not reach its controlled hold")), 5_000);
      })]);
    } finally { clearTimeout(timer); }
  };
  const fixture = async () => {
    const school = await storage.createSchool({ name: `${tag}_${schools.length}`, slug: `${tag}_${schools.length}`, domain: `${tag}.example.invalid` });
    schools.push(school.id);
    await storage.createProductLicense({ schoolId: school.id, product: "CLASSPILOT", status: "active" });
    return scoped(school.id, async () => {
      const student = await storage.createStudent({ schoolId: school.id, firstName: "Synthetic", lastName: "Fence", status: "active" });
      const deviceId = `${tag}_${schools.length}`;
      await storage.createDevice({ schoolId: school.id, deviceId, classId: "default" });
      const { session } = await storage.startStudentSessionWithReplacements(school.id, student.id, deviceId, {
        authKind: "manual_shared",
        sessionRecoveryTokenHash: randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
      });
      assert.equal(session.authKind, "manual_shared", "canonical fixture retains its immutable authentication kind");
      return { school, student, deviceId, session };
    });
  };
  try {
    const route = readFileSync(new URL("../src/routes/classpilot/devices.ts", import.meta.url), "utf8");
    const start = route.indexOf("const finalDelivery = await runWithTenantContext");
    assert.ok(start >= 0);
    assert.match(route.slice(start, route.indexOf("return finalDelivery.value;", start)), /withClasspilotHeartbeatDeliveryAuthority\(/,
      "native cases must exercise the exact wrapper selected by the final heartbeat route");
    const restricted = !(await pool.query<{ bypass: boolean }>("SELECT rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname=current_user")).rows[0]!.bypass;
    t.diagnostic(restricted ? "Restricted role with forced RLS" : "Owner role; explicit tenant predicates exercised");
    if (process.env.RLS_TEST_ROLE === "true") {
      assert.equal(restricted, true);
      const policies = (await pool.query<{ enabled: boolean; forced: boolean }>(`SELECT relrowsecurity AS enabled,relforcerowsecurity AS forced
        FROM pg_class WHERE oid=ANY(ARRAY['students'::regclass,'devices'::regclass])`)).rows;
      assert.equal(policies.length, 2); assert.ok(policies.every(row => row.enabled && row.forced));
    }
    const a = await fixture(), b = await fixture();
    const binding = { schoolId: a.school.id, studentId: a.student.id, studentSessionId: a.session.id, deviceId: a.deviceId, freezeSsoPolicy: true };
    let sent = 0;
    const reset = () => scoped(a.school.id, async () => {
      await db.execute(sql`UPDATE schools SET status='active',is_active=true,active_until=NULL,disabled_at=NULL,deleted_at=NULL WHERE id=${a.school.id}`);
      await db.execute(sql`UPDATE product_licenses SET status='active',expires_at=NULL WHERE school_id=${a.school.id}`);
      await db.execute(sql`UPDATE student_sessions SET is_active=true,ended_at=NULL,manual_lease_expires_at=clock_timestamp()+interval '1 hour' WHERE id=${a.session.id}`);
      sent = 0;
    });
    const invoke = (prepare: (transaction: typeof db) => Promise<unknown> = async () => "prepared", exact = binding) => scoped(exact.schoolId,
      () => storage.withClasspilotHeartbeatDeliveryAuthority(exact, prepare, () => { sent++; return "HTTP200"; }));

    await t.test("valid final heartbeat succeeds through the actual fixed wrapper", async () => {
      await reset(); const result = await invoke();
      assert.equal(result.authorized, true); assert.equal(sent, 1);
    });

    for (const expiry of ["school", "license"] as const) await t.test(`${expiry} expiry during required preparation returns canonical403 without HTTP`, async () => {
      await reset();
      await assert.rejects(invoke(async transaction => {
        if (expiry === "school") await transaction.execute(sql`UPDATE schools SET active_until=clock_timestamp()+interval '60 milliseconds' WHERE id=${a.school.id}`);
        else await transaction.execute(sql`UPDATE product_licenses SET expires_at=clock_timestamp()+interval '60 milliseconds' WHERE school_id=${a.school.id}`);
        await transaction.execute(sql`SELECT pg_sleep(0.09)`);
      }), error => !!error && typeof error === "object" && "status" in error && error.status === 403
        && "code" in error && error.code === "CLASSPILOT_NOT_ENTITLED"
        && "reason" in error && error.reason === (expiry === "school" ? "school_inactive" : "license_inactive"));
      assert.equal(sent, 0);
      assert.equal((await scoped(a.school.id, () => db.execute<{ reverted: boolean }>(sql`SELECT active_until IS NULL AS reverted FROM schools WHERE id=${a.school.id}`))).rows[0]!.reverted, true);
      assert.equal((await scoped(a.school.id, () => db.execute<{ reverted: boolean }>(sql`SELECT expires_at IS NULL AS reverted FROM product_licenses WHERE school_id=${a.school.id} AND product='CLASSPILOT'`))).rows[0]!.reverted, true);
    });

    await t.test("manual lease expiry during preparation returns binding denial without prepared data", async () => {
      await reset();
      const result = await invoke(async transaction => {
        await transaction.execute(sql`UPDATE student_sessions SET manual_lease_expires_at=clock_timestamp()+interval '60 milliseconds' WHERE id=${a.session.id}`);
        await transaction.execute(sql`SELECT pg_sleep(0.09)`);
      });
      assert.equal(result.authorized, false); assert.equal(sent, 0);
    });

    await t.test("wrong school, student, device and session cannot reach preparation", async () => {
      for (const patch of [{ schoolId: b.school.id }, { studentId: b.student.id }, { studentSessionId: b.session.id }, { deviceId: b.deviceId }]) {
        await reset();
        const result = await invoke(async () => assert.fail("foreign binding reached preparation"), { ...binding, ...patch });
        assert.equal(result.authorized, false); assert.equal(sent, 0);
      }
    });

    for (const target of ["school", "license", "binding"] as const) await t.test(`${target} writer cannot commit before the synchronous final response`, async () => {
      await reset(); let release!: () => void, reached!: () => void, writerPid!: (pid: number) => void;
      const ready = new Promise<void>(resolve => { reached = resolve; });
      const resume = new Promise<void>(resolve => { release = resolve; });
      const pid = new Promise<number>(resolve => { writerPid = resolve; });
      const delivery = invoke(async () => { reached(); await resume; });
      void delivery.catch(() => {});
      let writer: Promise<unknown> | undefined;
      try {
        await waitReady(ready);
        writer = scoped(a.school.id, async () => {
          writerPid((await db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid);
          if (target === "school") await db.execute(sql`UPDATE schools SET is_active=false WHERE id=${a.school.id}`);
          else if (target === "license") await db.execute(sql`UPDATE product_licenses SET status='inactive' WHERE school_id=${a.school.id}`);
          else await db.execute(sql`UPDATE student_sessions SET is_active=false,ended_at=clock_timestamp() WHERE id=${a.session.id}`);
          assert.equal(sent, 1);
        });
        void writer.catch(() => {});
        const backendPid = await waitReady(pid), deadline = Date.now() + 5_000;
        let blocked = false;
        while (Date.now() < deadline) {
          blocked = (await pool.query<{ blocked: boolean }>("SELECT cardinality(pg_blocking_pids($1))>0 AS blocked", [backendPid])).rows[0]!.blocked;
          if (blocked) break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(blocked, true, "competing writer must actually wait on retained authority");
        assert.equal(sent, 0); release(); assert.equal((await delivery).authorized, true); await writer;
      } finally { release(); await Promise.allSettled([delivery, ...(writer ? [writer] : [])]); }
    });

    await t.test("required final PostgreSQL failure is not swallowed and its connection is usable after cleanup", async () => {
      await reset(); const original = pg.Client.prototype.query; let intercepted = false;
      const spy = t.mock.method(pg.Client.prototype, "query", function(this: pg.Client, ...args: unknown[]) {
        const arg = args[0]; const text = typeof arg === "string" ? arg : arg && typeof arg === "object" && "text" in arg ? String(arg.text) : "";
        if (!intercepted && text.includes("AS entitled") && text.includes("AS bound")) {
          intercepted = true; return Reflect.apply(original, this, ["SELECT 1/0"]);
        }
        return Reflect.apply(original, this, args);
      });
      try {
        await assert.rejects(invoke(), error => error instanceof Error && error.cause instanceof Error
          && "code" in error.cause && error.cause.code === "22012");
        assert.equal(intercepted, true); assert.equal(sent, 0);
      }
      finally { spy.mock.restore(); }
      const next = await invoke(); assert.equal(next.authorized, true); assert.equal(sent, 1);
    });

    for (const kind of ["generic", "websocket"] as const) await t.test(`${kind} retains its existing admission semantics`, async () => {
      await reset();
      const deliver = kind === "generic" ? storage.withClasspilotStudentControlDeliveryAuthority : storage.withClasspilotStudentWebSocketBootstrapAuthority;
      const result = await scoped(a.school.id, () => deliver(binding, async transaction => {
        await transaction.execute(sql`UPDATE product_licenses SET expires_at=clock_timestamp()+interval '60 milliseconds' WHERE school_id=${a.school.id}`);
        await transaction.execute(sql`SELECT pg_sleep(0.09)`);
        return "prepared";
      }, () => { sent++; return "HTTP200"; }));
      assert.equal(result.authorized, true); assert.equal(sent, 1);
    });
  } finally {
    try {
      for (const schoolId of schools) await runWithTenantContext({ isSuper: true }, () => db.transaction(async tx => {
        await tx.execute(sql`DELETE FROM student_sessions WHERE student_id IN (SELECT id FROM students WHERE school_id=${schoolId})`);
        await tx.execute(sql`DELETE FROM student_devices WHERE student_id IN (SELECT id FROM students WHERE school_id=${schoolId})`);
        for (const table of ["devices", "students", "audit_logs", "settings", "product_licenses"])
          await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE school_id=${schoolId}`);
        await tx.execute(sql`UPDATE schools SET status='suspended',is_active=false,deleted_at=now() WHERE id=${schoolId}`);
      }));
    } finally { await drainTenantContextReleases(); await Promise.all([pool.end(), sessionPool.end()]); }
  }
});
