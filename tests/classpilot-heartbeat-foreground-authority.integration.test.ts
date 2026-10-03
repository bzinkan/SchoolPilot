import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { sql } from "drizzle-orm";

process.env.NODE_ENV = "test";
process.env.SCHEDULER_ENABLED = "false";
process.env.RLS_GUC_ENABLED = "true";
process.env.REDIS_URL = "";

test("heartbeat foreground reuses owned proof with fresh clock and retained final delivery locks", { timeout: 120_000 }, async t => {
  const { db, pool, sessionPool } = await import("../src/db.js");
  const storage = await import("../src/services/storage.js");
  const { runWithTenantContext, drainTenantContextReleases } = await import("../src/middleware/tenantContext.js");
  const { getTenantStore } = await import("../src/db/tenantContext.js");
  const tag = `foreground_${randomUUID().replaceAll("-", "")}`, schools: string[] = [];
  const scoped = <T>(schoolId: string, callback: () => Promise<T>) => runWithTenantContext({ schoolId }, callback);
  const createFixture = async () => {
    const school = await storage.createSchool({ name: `${tag}_${schools.length}`, slug: `${tag}_${schools.length}`, domain: `${tag}.example.invalid` });
    schools.push(school.id);
    const teacher = await storage.createUser({ email: `${randomUUID()}@${tag}.example.invalid`, firstName: "Final", lastName: "Context" });
    await storage.createMembership({ schoolId: school.id, userId: teacher.id, role: "teacher", status: "active" });
    await storage.createProductLicense({ schoolId: school.id, product: "CLASSPILOT", status: "active" });
    return scoped(school.id, async () => {
      const student = await storage.createStudent({ schoolId: school.id, firstName: "Synthetic", lastName: "Context", status: "active" });
      const group = await storage.createGroup({ schoolId: school.id, teacherId: teacher.id, name: tag, groupType: "teacher_created" });
      await storage.addGroupStudentsDetailed(group.id, [student.id]);
      const deviceId = `${tag}_${schools.length}`;
      await storage.createDevice({ deviceId, schoolId: school.id, classId: "default" });
      const originalBinding = await storage.setActiveStudentForDevice(deviceId, student.id);
      const manualId = randomUUID();
      await db.execute(sql`UPDATE student_sessions SET is_active=false,ended_at=now() WHERE id=${originalBinding.id}`);
      await db.execute(sql`INSERT INTO student_sessions(id,student_id,device_id,auth_kind,manual_lease_expires_at,session_recovery_token_hash)
        VALUES(${manualId},${student.id},${deviceId},'manual_shared',clock_timestamp()+interval '1 hour',${randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '')})`);
      const binding = { ...originalBinding, id: manualId };
      const session = await storage.createTeachingSession({ groupId: group.id, teacherId: teacher.id, startTime: new Date(Date.now() - 60_000) });
      return { school, teacher, student, deviceId, binding, session };
    });
  };
  const waitUntilBlocked = async (pid: number) => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if ((await pool.query<{ blocked: boolean }>("SELECT cardinality(pg_blocking_pids($1))>0 AS blocked", [pid])).rows[0]?.blocked) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail("competing native operation never reached the expected authority lock");
  };
  const waitUntilReady = async (ready: Promise<void>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([ready, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("native writer never reached its lock interception")), 5_000);
      })]);
    } finally { clearTimeout(timer); }
  };
  try {
    const a = await createFixture(), b = await createFixture();
    const binding = { schoolId: a.school.id, studentId: a.student.id, studentSessionId: a.binding.id, deviceId: a.deviceId, freezeSsoPolicy: true };
    const restricted = !(await pool.query<{ bypass: boolean }>("SELECT rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname=current_user")).rows[0]!.bypass;
    t.diagnostic(restricted ? "Restricted role with forced RLS" : "Owner role; explicit tenant predicates exercised");
    if (process.env.RLS_TEST_ROLE === "true") {
      assert.equal(restricted, true, "restricted lane must never execute as a bypass owner");
      const policies = (await pool.query<{ enabled: boolean; forced: boolean }>(`SELECT relrowsecurity AS enabled,relforcerowsecurity AS forced
        FROM pg_class WHERE oid=ANY(ARRAY['classpilot_student_control_states'::regclass,'teaching_sessions'::regclass,
        'classpilot_session_students'::regclass,'classpilot_supervision_students'::regclass,'classpilot_supervision_contexts'::regclass,
        'students'::regclass,'devices'::regclass])`)).rows;
      assert.equal(policies.length, 7); assert.ok(policies.every(row => row.enabled && row.forced));
    }
    const reset = () => scoped(a.school.id, async () => {
      await db.execute(sql`UPDATE schools SET status='active',is_active=true,active_until=NULL,disabled_at=NULL,deleted_at=NULL WHERE id=${a.school.id}`);
      await db.execute(sql`UPDATE product_licenses SET status='active',expires_at=NULL WHERE school_id=${a.school.id}`);
      await db.execute(sql`UPDATE students SET status='active' WHERE id=${a.student.id}`);
      await db.execute(sql`UPDATE student_sessions SET is_active=true,ended_at=NULL,manual_lease_expires_at=clock_timestamp()+interval '1 hour' WHERE id=${a.binding.id}`);
      await db.execute(sql`UPDATE teaching_sessions SET session_mode='live',end_time=NULL,scheduled_date=NULL,scheduled_timezone=NULL,scheduled_start_at=NULL,scheduled_end_at=NULL,scheduled_state=NULL WHERE id=${a.session.id}`);
      await db.execute(sql`UPDATE classpilot_student_control_states SET teaching_session_id=${a.session.id},supervision_context_id=NULL,revision=8,
        hard_expires_at=clock_timestamp()+interval '1 hour',scheduled_end_at=NULL WHERE school_id=${a.school.id} AND student_id=${a.student.id}`);
      await db.execute(sql`DELETE FROM classpilot_supervision_students WHERE school_id=${a.school.id}`);
      await db.execute(sql`DELETE FROM classpilot_supervision_contexts WHERE school_id=${a.school.id}`);
    });
    let published = 0, failed = 0, http = 0;
    const invoke = (prepare?: (transaction: typeof db, read: () => ReturnType<typeof storage.getClasspilotScreenshotAuthorityProjection>) => Promise<void>,
      publish?: () => Promise<void>, exact = binding, authority = { teachingSessionId: a.session.id, controlRevision: 8 }) => scoped(exact.schoolId,
        () => storage.withClasspilotHeartbeatDeliveryAuthority(exact, async (transaction, read) => {
          if (prepare) await prepare(transaction, read); else {
            await storage.getClasspilotStudentControlDeliveryContext(exact.schoolId, exact.studentId, transaction);
            const raw = await read(); assert.equal(raw?.authority.kind, 'teaching_session');
          }
          return "required-prepared";
        }, (_rows, value) => { http++; return value; }, undefined,
        { ...authority, publish: async () => { published++; await publish?.(); }, onFailure: () => { failed++; } }));
    const begin = async () => { await reset(); published = 0; failed = 0; http = 0; };

    await t.test("same valid foreground uses one physical lease and fewer statements than separate old publisher and final delivery", async () => {
      await begin();
      const diagnostics = await import("../src/services/usageCapacityDiagnostics.js");
      const original = pg.Client.prototype.query;
      let statements = 0;
      const spy = t.mock.method(pg.Client.prototype, "query", function(this: pg.Client, ...args: unknown[]) { statements++; return Reflect.apply(original, this, args); });
      try {
        diagnostics.resetUsageCapacityDiagnostics();
        await scoped(a.school.id, () => storage.withClasspilotTeachingTelemetryAuthority({ ...binding, teachingSessionId: a.session.id, controlRevision: 8 }, async () => { published++; }));
        await scoped(a.school.id, () => storage.withClasspilotStudentControlDeliveryAuthority(binding, async transaction => {
          await storage.getClasspilotStudentControlDeliveryContext(binding.schoolId, binding.studentId, transaction);
          await storage.getClasspilotScreenshotAuthorityProjection(binding, transaction);
          return "required-prepared";
        }, (_rows, value) => value));
        const oldOperation = diagnostics.getUsageCapacityDiagnostics().operations.tenant_background;
        assert.ok(oldOperation, "the original path must expose actual checkout diagnostics");
        const oldStatements = statements, oldCheckouts = oldOperation.counters.checkoutSuccess;
        statements = 0; diagnostics.resetUsageCapacityDiagnostics();
        const result = await invoke();
        const newOperation = diagnostics.getUsageCapacityDiagnostics().operations.tenant_background;
        assert.ok(newOperation, "the fused path must expose actual checkout diagnostics");
        const newStatements = statements, newCheckouts = newOperation.counters.checkoutSuccess;
        assert.equal(result.authorized, true); assert.deepEqual(result.foreground, { status: "settled", succeeded: true });
        assert.equal(oldCheckouts, 2); assert.equal(newCheckouts, 1); assert.ok(newStatements < oldStatements);
        t.diagnostic(JSON.stringify({ oldStatements, newStatements, oldCheckouts, newCheckouts, measuredCapacity: false }));
      } finally { spy.mock.restore(); }
    });

    await t.test("prepared SELECT metadata preserves reference projections on the same physical client across schools", async () => {
      await begin();
      const original = pg.Client.prototype.query; const configs: Array<{ text: string; name: unknown; values: unknown[] }> = [];
      const spy = t.mock.method(pg.Client.prototype, "query", function(this: pg.Client, ...args: unknown[]) {
        const request = args[0];
        if (request && typeof request === "object" && "text" in request && "name" in request && request.name === "") {
          configs.push({ text: String(request.text), name: request.name, values: Array.isArray(args[1]) ? [...args[1]] : [] });
        }
        return Reflect.apply(original, this, args);
      });
      let firstClient: object | undefined;
      try {
        for (const fixture of [a, b, a]) {
          const exact = { schoolId: fixture.school.id, studentId: fixture.student.id, studentSessionId: fixture.binding.id, deviceId: fixture.deviceId, freezeSsoPolicy: true };
          await scoped(fixture.school.id, async () => {
            const client = getTenantStore()?.client; assert.ok(client);
            if (firstClient) assert.equal(client, firstClient, "prove physical client reuse across school GUCs"); else firstClient = client;
            const reference = await storage.withClasspilotStudentControlDeliveryAuthority(exact,
              tx => storage.getClasspilotScreenshotAuthorityProjection(exact, tx), (_rows, projection) => projection);
            const before = configs.length;
            const prepared = await storage.withClasspilotHeartbeatDeliveryAuthority(exact, async (_tx, read) => read(), (_rows, projection) => projection);
            assert.deepEqual(prepared.authorized && prepared.value, reference.authorized && reference.value);
            const selected = configs.slice(before);
            assert.equal(selected.length, 5, "exactly the five eligible SELECTs use unnamed prepared metadata");
            assert.ok(selected.every(row => row.name === "" && row.values.includes(fixture.school.id)));
          });
        }
      } finally { spy.mock.restore(); }
    });

    await t.test("orphan multi-query reader failure seals before any foreground or HTTP", async () => {
      await begin();
      let release: () => void = () => {}; let reached: () => void = () => {};
      const gate = new Promise<void>(resolve => { release = resolve; }); const ready = new Promise<void>(resolve => { reached = resolve; });
      const original = pg.Client.prototype.query; let held = false;
      const spy = t.mock.method(pg.Client.prototype, "query", function(this: pg.Client, ...args: unknown[]) {
        const request = args[0], text = typeof request === "string" ? request : request && typeof request === "object" && "text" in request ? String(request.text) : "";
        if (!held && text.startsWith('select "student_sessions"."id", "student_sessions"."started_at"')) {
          held = true; reached(); return gate.then(() => Reflect.apply(original, this, args));
        }
        return Reflect.apply(original, this, args);
      });
      const operation = invoke(async (_tx, read) => { void read(); await ready; });
      void operation.catch(() => {});
      try {
        await waitUntilReady(ready);
        await new Promise<void>(resolve => setImmediate(resolve));
        release(); await assert.rejects(operation, /outlived preparation/);
        assert.equal(http, 0); assert.equal(published, 0);
      }
      finally { release(); await Promise.allSettled([operation]); spy.mock.restore(); }
    });

    await t.test("an optional foreground catch cannot clear a sealed prepared-read ownership failure", async t => {
      await begin();
      const { readHeartbeatSchool } = await import("../src/services/classpilotHeartbeatPreparedReads.js");
      let captured: typeof db | undefined, poisoned = false, schoolSelects = 0;
      const original = pg.Client.prototype.query;
      const spy = t.mock.method(pg.Client.prototype, "query", function(this: pg.Client, ...args: unknown[]) {
        const request = args[0], text = typeof request === "string" ? request : request && typeof request === "object" && "text" in request ? String(request.text) : "";
        if (text.startsWith("select ") && text.includes('from "schools"')) schoolSelects++;
        if (!poisoned && text.includes("SELECT 1 AS allowed")) {
          poisoned = true; assert.ok(captured);
          assert.throws(() => readHeartbeatSchool(captured!, a.school.id), /phase is closed/);
        }
        return Reflect.apply(original, this, args);
      });
      try {
        await assert.rejects(invoke(async (tx, read) => { captured = tx; await read(); }), /phase is closed/);
        assert.equal(poisoned, true); assert.equal(schoolSelects, 1, "sealed read must issue no additional school SQL");
        assert.deepEqual({ published, http, failed }, { published: 0, http: 0, failed: 1 });
      } finally { spy.mock.restore(); }
    });

    await t.test("wrong exact bindings cannot reach preparation or foreground and a foreign original owner cannot be substituted", async () => {
      for (const patch of [{ studentId: b.student.id }, { studentSessionId: b.binding.id }, { deviceId: b.deviceId }, { schoolId: b.school.id }]) {
        await begin(); const result = await invoke(async () => assert.fail("invalid binding cannot prepare"), undefined, { ...binding, ...patch });
        assert.equal(result.authorized, false); assert.equal(published, 0); assert.equal(http, 0);
      }
      await begin(); const wrong = await invoke(undefined, undefined, binding, { teachingSessionId: b.session.id, controlRevision: 8 });
      assert.equal(wrong.authorized, true); assert.equal(wrong.foreground.status, 'fallback'); assert.equal(published, 0);
    });

    for (const expiry of ["control-hard", "control-scheduled", "teaching-scheduled", "school", "license", "future-supervision"] as const) {
      await t.test(`fresh publication statement denies ${expiry} crossing after raw proof while HTTP remains exact-bound`, async () => {
        await begin();
        if (expiry === 'future-supervision') await scoped(a.school.id, async () => {
          const id = randomUUID();
          await db.execute(sql`INSERT INTO classpilot_supervision_contexts(id,school_id,context_type,name,assigned_staff_id,created_by,starts_at,ends_at)
            VALUES(${id},${a.school.id},'manual','Synthetic future claim',${a.teacher.id},${a.teacher.id},clock_timestamp()+interval '1 second',clock_timestamp()+interval '1 hour')`);
          await db.execute(sql`INSERT INTO classpilot_supervision_students(school_id,context_id,student_id,assigned_by) VALUES(${a.school.id},${id},${a.student.id},${a.teacher.id})`);
        });
        const operation = invoke(async (tx, read) => {
          // Materialize the raw proof before passage of time. Changes below are
          // fixture writes by the owning transaction, never cached authority.
          const raw = await read(); assert.equal(raw?.authority.kind, 'teaching_session');
          if (expiry === 'control-hard') await tx.execute(sql`UPDATE classpilot_student_control_states SET hard_expires_at=clock_timestamp()+interval '60 milliseconds' WHERE school_id=${a.school.id} AND student_id=${a.student.id}`);
          if (expiry === 'control-scheduled') await tx.execute(sql`UPDATE classpilot_student_control_states SET scheduled_end_at=clock_timestamp()+interval '60 milliseconds' WHERE school_id=${a.school.id} AND student_id=${a.student.id}`);
          if (expiry === 'teaching-scheduled') await tx.execute(sql`UPDATE teaching_sessions SET scheduled_date=to_char(now(),'YYYY-MM-DD'),scheduled_timezone='UTC',scheduled_start_at=clock_timestamp()-interval '1 hour',scheduled_state='active',scheduled_end_at=clock_timestamp()+interval '60 milliseconds' WHERE id=${a.session.id}`);
          if (expiry === 'school') await tx.execute(sql`UPDATE schools SET active_until=clock_timestamp()+interval '60 milliseconds' WHERE id=${a.school.id}`);
          if (expiry === 'license') await tx.execute(sql`UPDATE product_licenses SET expires_at=clock_timestamp()+interval '60 milliseconds' WHERE school_id=${a.school.id}`);
          if (expiry === 'future-supervision') await tx.execute(sql`SELECT pg_sleep(greatest(0,extract(epoch FROM (starts_at-clock_timestamp())))+0.02)
            FROM classpilot_supervision_contexts WHERE school_id=${a.school.id}`);
          await tx.execute(sql`SELECT pg_sleep(0.09)`);
        });
        if (expiry === 'school' || expiry === 'license') {
          await assert.rejects(operation, error => !!error && typeof error === 'object' && 'code' in error && error.code === 'CLASSPILOT_NOT_ENTITLED');
          assert.equal(http, 0);
        } else {
          const result = await operation; assert.equal(result.authorized, true); assert.equal(result.foreground.status, 'suppressed'); assert.equal(http, 1);
        }
        assert.equal(published, 0);
      });
    }

    for (const expiry of ['school', 'license'] as const) await t.test(`${expiry} expiring during awaited publication prevents HTTP with canonical403`, async () => {
      await begin();
      const operation = invoke(async (tx, read) => {
        if (expiry === 'school') await tx.execute(sql`UPDATE schools SET active_until=clock_timestamp()+interval '300 milliseconds' WHERE id=${a.school.id}`);
        else await tx.execute(sql`UPDATE product_licenses SET expires_at=clock_timestamp()+interval '300 milliseconds' WHERE school_id=${a.school.id}`);
        await read();
      }, async () => { await db.execute(sql`SELECT pg_sleep(0.35)`); });
      await assert.rejects(operation, error => !!error && typeof error === 'object' && 'code' in error && error.code === 'CLASSPILOT_NOT_ENTITLED'
        && 'status' in error && error.status === 403 && 'reason' in error && error.reason === (expiry === 'school' ? 'school_inactive' : 'license_inactive'));
      assert.equal(published, 1); assert.equal(http, 0); assert.equal(failed, 0, 'mandatory expiry is not swallowed as optional transport failure');
    });

    await t.test("manual lease expires after the mandatory pre-publication fence but before temporal SQL and never publishes", async () => {
      await begin();
      await scoped(a.school.id, () => db.execute(sql`UPDATE student_sessions SET manual_lease_expires_at=clock_timestamp()+interval '1 hour' WHERE id=${a.binding.id}`));
      const original = pg.Client.prototype.query; let intercepted = false;
      const fault = t.mock.method(pg.Client.prototype, "query", function(this: pg.Client, ...args: unknown[]) {
        const arg = args[0]; const text = typeof arg === 'string' ? arg : arg && typeof arg === 'object' && 'text' in arg ? String(arg.text) : '';
        if (!intercepted && text.includes('SELECT 1 AS allowed')) {
          intercepted = true;
          return Reflect.apply(original, this, ["UPDATE student_sessions SET manual_lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [a.binding.id]])
            .then(() => Reflect.apply(original, this, args));
        }
        return Reflect.apply(original, this, args);
      });
      try {
        const result = await invoke(); assert.equal(intercepted, true); assert.equal(result.authorized, false); assert.equal(published, 0); assert.equal(http, 0);
      } finally { fault.mock.restore(); }
    });

    await t.test("manual lease expiring during transport cannot receive HTTP", async () => {
      await begin();
      const result = await invoke(async (tx, read) => {
        await tx.execute(sql`UPDATE student_sessions SET manual_lease_expires_at=clock_timestamp()+interval '300 milliseconds' WHERE id=${a.binding.id}`);
        await read();
      }, async () => { await db.execute(sql`SELECT pg_sleep(0.35)`); });
      assert.equal(result.authorized, false); assert.equal(published, 1); assert.equal(http, 0); assert.equal(failed, 0);
    });

    for (const failure of ['ROLLBACK TO SAVEPOINT', 'RELEASE SAVEPOINT', 'mandatory-final'] as const) await t.test(`${failure} SQL failure propagates outside optional handling and prevents HTTP`, async () => {
      await begin(); const original = pg.Client.prototype.query; let intercepted = false;
      const fault = t.mock.method(pg.Client.prototype, 'query', function(this: pg.Client, ...args: unknown[]) {
        const arg = args[0]; const text = typeof arg === 'string' ? arg : arg && typeof arg === 'object' && 'text' in arg ? String(arg.text) : '';
        if (!intercepted && (failure === 'mandatory-final' ? text.includes('AS entitled') : text.startsWith(failure))) {
          intercepted = true; return Reflect.apply(original, this, ['SELECT 1/0']);
        }
        return Reflect.apply(original, this, args);
      });
      try {
        await assert.rejects(invoke(undefined, async () => { if (failure !== 'mandatory-final') throw new Error('Synthetic partial send'); }));
        assert.equal(intercepted, true); assert.equal(http, 0); assert.equal(published, 1);
        if (failure === 'mandatory-final') assert.equal(failed, 0);
      } finally { fault.mock.restore(); }
    });

    for (const mutation of ["control", "teaching", "student", "device-binding", "license"] as const) await t.test(`${mutation} revocation writer remains blocked through awaited foreground transport and HTTP`, async () => {
      await begin(); let reached!: () => void, release!: () => void;
      const started = new Promise<void>(resolve => { reached = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
      const run = invoke(undefined, async () => { reached(); await resume; });
      let writer: Promise<unknown> | undefined;
      try {
        await waitUntilReady(started); let writerReady!: (pid: number) => void;
        const pid = new Promise<number>(resolve => { writerReady = resolve; });
        writer = scoped(a.school.id, async () => {
          writerReady((await db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid);
          if (mutation === 'control') await db.execute(sql`UPDATE classpilot_student_control_states SET revision=revision+1 WHERE school_id=${a.school.id} AND student_id=${a.student.id}`);
          if (mutation === 'teaching') await db.execute(sql`UPDATE teaching_sessions SET end_time=now() WHERE id=${a.session.id}`);
          if (mutation === 'student') await db.execute(sql`UPDATE students SET status='inactive' WHERE id=${a.student.id}`);
          if (mutation === 'device-binding') await db.execute(sql`UPDATE student_sessions SET is_active=false,ended_at=now() WHERE id=${a.binding.id}`);
          if (mutation === 'license') await db.execute(sql`UPDATE product_licenses SET status='inactive' WHERE school_id=${a.school.id}`);
          assert.equal(http, 1, "writer cannot commit before synchronous exact-bound HTTP delivery");
        });
        await waitUntilBlocked(await pid); assert.equal(http, 0); release();
        assert.equal((await run).authorized, true); await writer;
      } finally { release(); await Promise.allSettled([run, ...(writer ? [writer] : [])]); }
    });

    for (const failure of ['predicate SQL', 'partial transport'] as const) await t.test(`${failure} failure restores transaction without undoing required preparation or duplicating publication`, async () => {
      await begin(); const original = pg.Client.prototype.query; let intercepted = false;
      const fault = failure === 'predicate SQL' ? t.mock.method(pg.Client.prototype, 'query', function(this: pg.Client, ...args: unknown[]) {
        const arg = args[0]; const text = typeof arg === 'string' ? arg : arg && typeof arg === 'object' && 'text' in arg ? String(arg.text) : '';
        if (!intercepted && text.includes('SELECT 1 AS allowed')) { intercepted = true; return Reflect.apply(original, this, ['SELECT 1/0']); }
        return Reflect.apply(original, this, args);
      }) : undefined;
      try {
        const result = await invoke(async (tx, read) => { await read(); await tx.execute(sql`UPDATE students SET last_name='required-preparation-kept' WHERE id=${a.student.id}`); },
          async () => { throw new Error('Synthetic partial transport failure'); });
        assert.equal(result.authorized, true); assert.deepEqual(result.foreground, { status: 'settled', succeeded: false });
        assert.equal(failed, 1); assert.equal(published, failure === 'predicate SQL' ? 0 : 1); assert.equal(http, 1);
        assert.equal((await scoped(a.school.id, () => db.execute<{ last_name: string }>(sql`SELECT last_name FROM students WHERE id=${a.student.id}`))).rows[0]!.last_name, 'required-preparation-kept');
      } finally { fault?.mock.restore(); }
    });
  } finally {
    try {
      for (const schoolId of schools) await runWithTenantContext({ isSuper: true }, () => db.transaction(async tx => {
        for (const table of ["classpilot_session_summary_deliveries", "classpilot_monitoring_events", "classpilot_session_student_reports",
          "classpilot_session_reports", "classpilot_session_staff", "classpilot_student_control_states", "classpilot_classroom_states",
          "classpilot_active_hands", "classpilot_session_students", "classpilot_supervision_students", "classpilot_supervision_contexts"])
          await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE school_id=${schoolId}`);
        await tx.execute(sql`DELETE FROM session_settings WHERE session_id IN (SELECT id FROM teaching_sessions WHERE school_id=${schoolId})`);
        await tx.execute(sql`DELETE FROM teaching_sessions WHERE school_id=${schoolId}`);
        await tx.execute(sql`DELETE FROM student_sessions WHERE student_id IN (SELECT id FROM students WHERE school_id=${schoolId})`);
        await tx.execute(sql`DELETE FROM student_devices WHERE student_id IN (SELECT id FROM students WHERE school_id=${schoolId})`);
        await tx.execute(sql`DELETE FROM group_students WHERE group_id IN (SELECT id FROM groups WHERE school_id=${schoolId})`);
        await tx.execute(sql`DELETE FROM group_teachers WHERE group_id IN (SELECT id FROM groups WHERE school_id=${schoolId})`);
        for (const table of ["devices", "groups", "students", "audit_logs", "settings", "product_licenses", "school_memberships"])
          await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE school_id=${schoolId}`);
        await tx.execute(sql`UPDATE schools SET status='suspended',is_active=false,deleted_at=now() WHERE id=${schoolId}`);
      }));
    } finally { await drainTenantContextReleases(); await Promise.all([pool.end(), sessionPool.end()]); }
  }
});
