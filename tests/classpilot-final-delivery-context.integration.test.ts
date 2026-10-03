import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { sql } from "drizzle-orm";

process.env.NODE_ENV = "test";
process.env.SCHEDULER_ENABLED = "false";
process.env.RLS_GUC_ENABLED = "true";
process.env.REDIS_URL = "";

test("final delivery context preserves independent defaults, tenant scope and authority lock snapshots", { timeout: 90_000 }, async t => {
  const { db, pool, sessionPool } = await import("../src/db.js");
  const storage = await import("../src/services/storage.js");
  const { runWithTenantContext, drainTenantContextReleases } = await import("../src/middleware/tenantContext.js");
  const { getTenantStore } = await import("../src/db/tenantContext.js");
  const { builtInClasspilotSsoProfiles, classpilotSsoPolicyFromSettings } = await import("../src/services/classpilotSsoPolicy.js");
  const tag = `final_context_${randomUUID().replaceAll("-", "")}`, schools: string[] = [];
  const scoped = <T>(schoolId: string, callback: () => Promise<T>) => runWithTenantContext({ schoolId }, callback);
  const policy = { schemaVersion: 1, enabled: true, defaultProfileId: "google", attemptTtlSeconds: 300, profiles: builtInClasspilotSsoProfiles() };
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
      const binding = await storage.setActiveStudentForDevice(deviceId, student.id);
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
    const exact = { schoolId: a.school.id, studentId: a.student.id, studentSessionId: a.binding.id, deviceId: a.deviceId, freezeSsoPolicy: true };
    const restricted = !(await pool.query<{ bypass: boolean }>("SELECT rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname=current_user")).rows[0]!.bypass;
    t.diagnostic(restricted ? "Restricted role with forced RLS" : "Owner role; explicit scope predicates exercised");
    if (restricted) {
      const rows = (await pool.query<{ enabled: boolean; forced: boolean }>(`SELECT relrowsecurity AS enabled,relforcerowsecurity AS forced
        FROM pg_class WHERE oid=ANY(ARRAY['settings'::regclass,'classpilot_student_control_states'::regclass,
        'students'::regclass,'devices'::regclass])`)).rows;
      assert.equal(rows.length, 4); assert.ok(rows.every(row => row.enabled && row.forced));
    }
    await scoped(a.school.id, () => db.execute(sql`INSERT INTO settings(school_id,school_name,ws_shared_key,classpilot_sso_policy,classpilot_sso_policy_revision)
      VALUES(${a.school.id},'Synthetic final context','synthetic',${JSON.stringify(policy)}::jsonb,7)
      ON CONFLICT(school_id) DO UPDATE SET classpilot_sso_policy=excluded.classpilot_sso_policy,classpilot_sso_policy_revision=7`));
    const prior = async (schoolId: string, studentId: string) => {
      const [controlState, ssoPolicy] = await Promise.all([storage.getClasspilotStudentControlState(schoolId, studentId), storage.getClasspilotSsoPolicyForSchool(schoolId)]);
      return { controlState, ssoPolicy };
    };
    const isolated = async (callback: () => Promise<void>) => {
      const rollback = new Error("rollback isolated context case");
      await assert.rejects(scoped(a.school.id, () => db.transaction(async () => { await callback(); throw rollback; })), error => error === rollback);
    };

    await t.test("one fresh statement equals both prior reads for every field and five date decoders", () => isolated(async () => {
      await db.execute(sql`UPDATE classpilot_student_control_states SET revision=9,
        desired_state='{"screenLocked":true,"synthetic":{"nested":true}}'::jsonb,
        scheduled_end_at='2026-11-01 01:30:00.123-04',hard_expires_at='2026-11-01 01:30:00.456-05',
        enforcement_health='failed',applied_revision=8,last_outcome='failed',last_error='synthetic error',
        last_acknowledged_at='2026-03-08 03:00:00.789-04',created_at='2026-01-01 00:00:00.001+00',updated_at='2026-02-01 00:00:00.002+00'
        WHERE school_id=${a.school.id} AND student_id=${a.student.id}`);
      const client = getTenantStore()!.client, original = client.query;
      const originalDescriptor = Object.getOwnPropertyDescriptor(client, "query");
      const queries: Array<{ text: string; values?: unknown[] }> = [];
      client.query = function (this: typeof client, ...args: unknown[]) {
        queries.push(typeof args[0] === "string" ? { text: args[0], values: Array.isArray(args[1]) ? args[1] : undefined }
          : args[0] as { text: string; values?: unknown[] });
        return Reflect.apply(original, this, args);
      } as typeof client.query;
      try {
        const expected = await prior(a.school.id, a.student.id);
        assert.equal(queries.length, 2); queries.length = 0;
        const actual = await storage.getClasspilotStudentControlDeliveryContext(a.school.id, a.student.id);
        assert.equal(queries.length, 1); assert.deepEqual(actual, expected);
        assert.equal(Object.keys(actual.controlState!).length, 17);
        for (const key of ["scheduledEndAt", "hardExpiresAt", "lastAcknowledgedAt", "createdAt", "updatedAt"] as const) assert.ok(actual.controlState?.[key] instanceof Date);
        assert.deepEqual(queries[0]!.values, [a.school.id, a.student.id, a.school.id]);
        t.diagnostic(JSON.stringify({ fixtureOnly: true, queryCountBefore: 2, queryCountAfter: 1, fields: Object.keys(actual.controlState!), sql: queries[0]!.text,
          parameterBindings: ["requested school", "requested student", "requested school"] }));
      } finally {
        // Restoring an inherited method as an own property would shadow the
        // later prototype-level writer spy on a reused physical connection.
        if (originalDescriptor) Object.defineProperty(client, "query", originalDescriptor);
        else Reflect.deleteProperty(client, "query");
      }
    }));

    await t.test("absent control, absent settings, disabled and malformed SSO preserve independent defaults", () => isolated(async () => {
      const compare = async () => {
        const actual = await storage.getClasspilotStudentControlDeliveryContext(a.school.id, a.student.id);
        assert.deepEqual(actual, await prior(a.school.id, a.student.id)); return actual;
      };
      await db.execute(sql`DELETE FROM classpilot_student_control_states WHERE school_id=${a.school.id} AND student_id=${a.student.id}`);
      assert.equal((await compare()).ssoPolicy.revision, 7);
      await db.execute(sql`UPDATE settings SET classpilot_sso_policy=${JSON.stringify({ ...policy, enabled: false, defaultProfileId: null })}::jsonb WHERE school_id=${a.school.id}`);
      assert.equal((await compare()).ssoPolicy.policy.enabled, false);
      await db.execute(sql`UPDATE settings SET classpilot_sso_policy='{"malformed":true}'::jsonb WHERE school_id=${a.school.id}`);
      assert.equal((await compare()).ssoPolicy.valid, false);
      await db.execute(sql`DELETE FROM settings WHERE school_id=${a.school.id}`);
      assert.deepEqual(await compare(), { controlState: undefined, ssoPolicy: classpilotSsoPolicyFromSettings(undefined) });
    }));
    await t.test("control remains present without settings and nullable dates remain null", () => isolated(async () => {
      await db.execute(sql`DELETE FROM settings WHERE school_id=${a.school.id}`);
      await db.execute(sql`UPDATE classpilot_student_control_states SET teaching_session_id=NULL,scheduled_end_at=NULL,hard_expires_at=NULL,last_acknowledged_at=NULL
        WHERE school_id=${a.school.id} AND student_id=${a.student.id}`);
      const actual = await storage.getClasspilotStudentControlDeliveryContext(a.school.id, a.student.id);
      assert.deepEqual(actual, await prior(a.school.id, a.student.id)); assert.ok(actual.controlState);
      assert.equal(actual.controlState.scheduledEndAt, null); assert.equal(actual.controlState.hardExpiresAt, null);
      assert.equal(actual.controlState.lastAcknowledgedAt, null);
    }));
    await t.test("foreign and missing scope cannot substitute control or policy through the joins", async () => {
      await scoped(a.school.id, async () => {
        for (const [schoolId, studentId] of [[randomUUID(), a.student.id], [a.school.id, b.student.id], [a.school.id, randomUUID()]]) {
          const actual = await storage.getClasspilotStudentControlDeliveryContext(schoolId!, studentId!);
          assert.deepEqual(actual, await prior(schoolId!, studentId!)); assert.equal(actual.controlState, undefined);
        }
        const foreign = await storage.getClasspilotStudentControlDeliveryContext(b.school.id, b.student.id);
        assert.deepEqual(foreign, await prior(b.school.id, b.student.id));
        assert.equal(foreign.controlState?.studentId, restricted ? undefined : b.student.id);
      });
      await scoped(b.school.id, async () => {
        const foreign = await storage.getClasspilotStudentControlDeliveryContext(a.school.id, a.student.id);
        assert.deepEqual(foreign, await prior(a.school.id, a.student.id));
        assert.equal(foreign.controlState?.studentId, restricted ? undefined : a.student.id);
        assert.equal(foreign.ssoPolicy.revision, restricted ? 0 : 7);
      });
    });

    await t.test("projection observes an SSO writer committed during shared-lock acquisition", async () => {
      const current = await scoped(a.school.id, () => storage.getClasspilotSsoPolicyForSchool(a.school.id));
      const original = pg.Client.prototype.query;
      let locked!: () => void, release!: () => void, intercepted = false;
      const reached = new Promise<void>(resolve => { locked = resolve; }), unblock = new Promise<void>(resolve => { release = resolve; });
      const mock = t.mock.method(pg.Client.prototype, "query", function(this: pg.Client, ...args: unknown[]) {
        const argument = args[0];
        const text = typeof argument === "string" ? argument : argument && typeof argument === "object" && "text" in argument ? String(argument.text) : "";
        const result = Reflect.apply(original, this, args);
        if (!intercepted && /pg_advisory_xact_lock\(/.test(text) && text.includes("classpilot-sso-policy")) {
          intercepted = true;
          return Promise.resolve(result).then(async value => { locked(); await unblock; return value; });
        }
        return result;
      });
      const writer = scoped(a.school.id, () => storage.updateClasspilotSsoPolicy({ schoolId: a.school.id, expectedRevision: current.revision,
        policy: { ...current.policy, enabled: false, defaultProfileId: null }, actorUserId: a.teacher.id, actorRole: "school_admin" }));
      let reader: Promise<unknown> | undefined;
      try {
        await waitUntilReady(reached);
        let readerStarted!: (pid: number) => void;
        const readerPid = new Promise<number>(resolve => { readerStarted = resolve; });
        reader = scoped(a.school.id, async () => {
          readerStarted((await db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid);
          return storage.withClasspilotStudentControlDeliveryAuthority(exact,
            transaction => storage.getClasspilotStudentControlDeliveryContext(a.school.id, a.student.id, transaction),
            (_messages, context) => ({ revision: context.ssoPolicy.revision, enabled: context.ssoPolicy.policy.enabled }));
        });
        await waitUntilBlocked(await readerPid); release();
        await writer;
        assert.deepEqual(await reader, { authorized: true, value: { revision: current.revision + 1, enabled: false } });
      } finally { release(); await Promise.allSettled([writer, ...(reader ? [reader] : [])]); mock.mock.restore(); }
    });

    await t.test("SSO writer waits until the joined snapshot is synchronously delivered", async () => {
      const current = await scoped(a.school.id, () => storage.getClasspilotSsoPolicyForSchool(a.school.id));
      let prepared!: () => void, release!: () => void;
      const reached = new Promise<void>(resolve => { prepared = resolve; }), unblock = new Promise<void>(resolve => { release = resolve; });
      let changed = false;
      const reader = scoped(a.school.id, () => storage.withClasspilotStudentControlDeliveryAuthority(exact,
        async transaction => { const context = await storage.getClasspilotStudentControlDeliveryContext(a.school.id, a.student.id, transaction); prepared(); await unblock; return context; },
        (_messages, context) => { assert.equal(changed, false); return context.ssoPolicy.revision; }));
      await reached;
      let writerStarted!: (pid: number) => void;
      const writerPid = new Promise<number>(resolve => { writerStarted = resolve; });
      const writer = scoped(a.school.id, async () => {
        writerStarted((await db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid);
        await storage.updateClasspilotSsoPolicy({ schoolId: a.school.id, expectedRevision: current.revision, policy: current.policy,
          actorUserId: a.teacher.id, actorRole: "school_admin" }); changed = true;
      });
      try { await waitUntilBlocked(await writerPid); }
      finally { release(); }
      assert.deepEqual(await reader, { authorized: true, value: current.revision }); await writer; assert.equal(changed, true);
    });

    await t.test("manual expiry after the joined preparation still suppresses the final response", async () => {
      const manual = randomUUID();
      await scoped(b.school.id, async () => {
        await db.execute(sql`UPDATE student_sessions SET is_active=false,ended_at=now() WHERE id=${b.binding.id}`);
        await db.execute(sql`INSERT INTO student_sessions(id,student_id,device_id,auth_kind,manual_lease_expires_at,session_recovery_token_hash)
          VALUES(${manual},${b.student.id},${b.deviceId},'manual_shared',clock_timestamp()+interval '2 seconds',${"c".repeat(64)})`);
        let prepared = false, delivered = false;
        const result = await storage.withClasspilotStudentControlDeliveryAuthority({ schoolId: b.school.id, studentId: b.student.id,
          studentSessionId: manual, deviceId: b.deviceId, freezeSsoPolicy: true }, async transaction => {
          const context = await storage.getClasspilotStudentControlDeliveryContext(b.school.id, b.student.id, transaction);
          assert.ok(context.controlState); prepared = true;
          await transaction.execute(sql`SELECT pg_sleep(greatest(0,extract(epoch FROM (manual_lease_expires_at-clock_timestamp())))+0.01)
            FROM student_sessions WHERE id=${manual}`);
          return context;
        }, () => { delivered = true; return true; });
        assert.equal(prepared, true); assert.equal(delivered, false); assert.deepEqual(result, { authorized: false });
      });
    });

    await t.test("binding replacement before authority acquisition prevents projection and delivery", async () => {
      let locked!: () => void, release!: () => void;
      const reached = new Promise<void>(resolve => { locked = resolve; }), unblock = new Promise<void>(resolve => { release = resolve; });
      const writer = scoped(a.school.id, () => db.transaction(async tx => {
        await storage.lockClasspilotStudentControlAuthorities(a.school.id, [a.student.id], tx);
        await tx.execute(sql`UPDATE student_sessions SET is_active=false,ended_at=now() WHERE id=${a.binding.id}`);
        await tx.execute(sql`INSERT INTO student_sessions(student_id,device_id) VALUES(${a.student.id},${a.deviceId})`);
        locked(); await unblock;
      }));
      await reached;
      let readerStarted!: (pid: number) => void, prepared = false;
      const readerPid = new Promise<number>(resolve => { readerStarted = resolve; });
      const reader = scoped(a.school.id, async () => {
        readerStarted((await db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid);
        return storage.withClasspilotStudentControlDeliveryAuthority(exact, transaction => {
          prepared = true; return storage.getClasspilotStudentControlDeliveryContext(a.school.id, a.student.id, transaction);
        }, () => true);
      });
      try { await waitUntilBlocked(await readerPid); }
      finally { release(); }
      await writer; assert.deepEqual(await reader, { authorized: false }); assert.equal(prepared, false);
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
