import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";

process.env.NODE_ENV = "test";
process.env.SCHEDULER_ENABLED = "false";
process.env.RLS_GUC_ENABLED = "true";
process.env.REDIS_URL = "";

test("fresh telemetry owner projection preserves discovery, authority and lock boundaries", { timeout: 90_000 }, async (t) => {
  const { db, pool, sessionPool } = await import("../src/db.js");
  const storage = await import("../src/services/storage.js");
  const { runWithTenantContext, drainTenantContextReleases } = await import("../src/middleware/tenantContext.js");
  const { getTenantStore } = await import("../src/db/tenantContext.js");
  const observation = await import("../src/services/classpilotObservationLease.js");
  const tag = `telemetry_projection_${randomUUID().replaceAll("-", "")}`;
  const schools: string[] = [];
  const scoped = <T>(schoolId: string, callback: () => Promise<T>) => runWithTenantContext({ schoolId }, callback);
  const rollback = new Error("rollback isolated projection case");
  type Tx = typeof db;
  const isolated = async (schoolId: string, callback: (tx: Tx) => Promise<void>) => {
    await assert.rejects(scoped(schoolId, () => db.transaction(async tx => {
      // Satisfy storage's pool-bearing type without changing the transaction's
      // query methods or physical lease. No tested query reads this property.
      await callback(Object.assign(tx, { $client: pool }));
      throw rollback;
    })), error => error === rollback);
  };
  const waitUntilBlocked = async (pid: number) => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await pool.query<{ blocked: boolean }>("SELECT cardinality(pg_blocking_pids($1))>0 AS blocked", [pid]);
      if (result.rows[0]?.blocked) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail("the competing transaction did not reach its expected database lock wait");
  };
  const createFixture = async () => {
    const school = await storage.createSchool({ name: `${tag}_${schools.length}`, slug: `${tag}_${schools.length}`, domain: `${tag}.example.invalid` });
    schools.push(school.id);
    const teacher = await storage.createUser({ email: `${randomUUID()}@${tag}.example.invalid`, firstName: "Projection", lastName: "Teacher" });
    await storage.createMembership({ schoolId: school.id, userId: teacher.id, role: "teacher", status: "active" });
    await storage.createProductLicense({ schoolId: school.id, product: "CLASSPILOT", status: "active" });
    return scoped(school.id, async () => {
      const student = await storage.createStudent({ schoolId: school.id, firstName: "Synthetic", lastName: "Projection", status: "active" });
      const group = await storage.createGroup({ schoolId: school.id, teacherId: teacher.id, name: tag, groupType: "teacher_created" });
      await storage.addGroupStudentsDetailed(group.id, [student.id]);
      const deviceId = `${tag}_${schools.length}`;
      await storage.createDevice({ deviceId, schoolId: school.id, classId: "default" });
      const binding = await storage.setActiveStudentForDevice(deviceId, student.id);
      const session = await storage.createTeachingSession({ groupId: group.id, teacherId: teacher.id, startTime: new Date(Date.now() - 60_000) });
      const control = await storage.getClasspilotStudentControlState(school.id, student.id);
      assert.ok(control);
      return { school, teacher, student, group, deviceId, binding, session, control };
    });
  };
  try {
    const a = await createFixture(), b = await createFixture();
    const authority = { schoolId: a.school.id, teachingSessionId: a.session.id, studentId: a.student.id,
      studentSessionId: a.binding.id, deviceId: a.deviceId, controlRevision: a.control.revision };
    const restricted = !(await pool.query<{ bypass: boolean }>("SELECT rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname=current_user")).rows[0]!.bypass;
    t.diagnostic(restricted ? "Restricted role with forced RLS" : "Owner role; explicit tenant predicates exercised");
    if (restricted) {
      const enforced = await pool.query<{ enabled: boolean; forced: boolean }>(`SELECT relrowsecurity AS enabled,relforcerowsecurity AS forced
        FROM pg_class WHERE oid=ANY(ARRAY['classpilot_session_students'::regclass,'teaching_sessions'::regclass,
        'classpilot_supervision_students'::regclass,'classpilot_supervision_contexts'::regclass])`);
      assert.equal(enforced.rows.length, 4);
      assert.ok(enforced.rows.every(row => row.enabled && row.forced));
    }
    const compare = async (database: Tx, schoolId = a.school.id, studentId = a.student.id) => {
      const supervision = await storage.getActiveSupervisionForStudents(schoolId, [studentId], database);
      const owner = await storage.getActiveClassOwnerForStudent(schoolId, studentId, database);
      const actual = await storage.getClasspilotTelemetryOwnerProjection(schoolId, studentId, database);
      assert.deepEqual(actual, { hasActiveSupervision: supervision.length > 0, teachingSessionId: owner?.session.id });
      return actual;
    };

    await t.test("one fresh statement replaces three and its exact SQL can be explained", () => isolated(a.school.id, async tx => {
      const client = getTenantStore()!.client;
      const original = client.query;
      const captured: Array<{ text: string; values?: unknown[] }> = [];
      client.query = function (this: typeof client, ...args: unknown[]) {
        const query = args[0];
        captured.push(typeof query === "string" ? { text: query, values: Array.isArray(args[1]) ? args[1] : undefined }
          : query as { text: string; values?: unknown[] });
        return Reflect.apply(original, this, args);
      } as typeof client.query;
      try {
        await storage.getActiveSupervisionForStudents(a.school.id, [a.student.id], tx);
        await storage.getActiveClassOwnerForStudent(a.school.id, a.student.id, tx);
        assert.equal(captured.length, 3);
        captured.length = 0;
        assert.equal((await storage.getClasspilotTelemetryOwnerProjection(a.school.id, a.student.id, tx)).teachingSessionId, a.session.id);
        assert.equal(captured.length, 1);
      } finally { client.query = original; }
      const query = captured[0]!;
      const explained = await client.query<{ "QUERY PLAN": Array<Record<string, unknown>> }>({
        text: `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.text}`, values: query.values,
      });
      const plan = explained.rows[0]!["QUERY PLAN"][0]!;
      const rootPlan = plan.Plan as Record<string, unknown>;
      const planShape = (node: Record<string, unknown>): Record<string, unknown> => ({
        nodeType: node["Node Type"], relation: node["Relation Name"], index: node["Index Name"], join: node["Join Type"],
        actualRows: node["Actual Rows"], actualLoops: node["Actual Loops"], sharedHitBlocks: node["Shared Hit Blocks"],
        sharedReadBlocks: node["Shared Read Blocks"],
        plans: Array.isArray(node.Plans) ? node.Plans.map(child => planShape(child as Record<string, unknown>)) : [],
      });
      t.diagnostic(JSON.stringify({ fixtureOnly: true, discoveryQueriesBefore: 3, discoveryQueriesAfter: 1,
        planningMs: plan["Planning Time"], executionMs: plan["Execution Time"], actualRows: rootPlan["Actual Rows"],
        sharedHitBlocks: rootPlan["Shared Hit Blocks"], sharedReadBlocks: rootPlan["Shared Read Blocks"], plan: planShape(rootPlan) }));
      await compare(tx);
    }));

    await t.test("frozen and legacy rosters preserve all timestamp and ID ranking ties", () => isolated(a.school.id, async tx => {
      const rival = randomUUID();
      await tx.execute(sql`INSERT INTO teaching_sessions(id,school_id,group_id,teacher_id,start_time,created_at)
        VALUES(${rival},${a.school.id},${a.group.id},${a.teacher.id},'2026-11-01 01:30:00.123456','2026-03-08 02:30:00.654321')`);
      for (const update of [
        sql`UPDATE teaching_sessions SET control_updated_at=NULL,start_time='2026-11-01 01:30:00.123456',created_at='2026-03-08 02:30:00.654321' WHERE id=${a.session.id}`,
        sql`UPDATE teaching_sessions SET control_updated_at='2026-12-01 00:00:00.000001' WHERE id=${rival}`,
        sql`UPDATE teaching_sessions SET control_updated_at='2026-12-01 00:00:00.000999' WHERE id=${a.session.id}`,
        sql`UPDATE teaching_sessions SET created_at='2026-03-09 00:00:00' WHERE id=${a.session.id}`,
        sql`UPDATE teaching_sessions SET start_time='2026-11-02 00:00:00' WHERE id=${a.session.id}`,
        sql`UPDATE teaching_sessions SET end_time=now() WHERE id=${a.session.id}`,
        sql`UPDATE teaching_sessions SET session_mode='scheduled_report' WHERE id=${rival}`,
      ]) {
        await tx.execute(update);
        const owner = await compare(tx);
        if (owner.teachingSessionId !== a.session.id) {
          assert.equal((await storage.getClasspilotScreenshotAuthorityProjection(authority, tx))?.authority.kind, "student_session");
        }
      }
      await tx.execute(sql`UPDATE teaching_sessions SET end_time=NULL WHERE id=${a.session.id}`);
      await tx.execute(sql`DELETE FROM group_students WHERE group_id=${a.group.id} AND student_id=${a.student.id}`);
      assert.equal((await compare(tx)).teachingSessionId, a.session.id, "frozen membership survives mutable roster removal");
      await tx.execute(sql`DELETE FROM classpilot_session_students WHERE teaching_session_id=${a.session.id}`);
      assert.equal((await compare(tx)).teachingSessionId, undefined);
    }));

    await t.test("supervision status, assignment, student status and time boundaries match", () => isolated(a.school.id, async tx => {
      const context = randomUUID();
      await tx.execute(sql`INSERT INTO classpilot_supervision_contexts(id,school_id,context_type,name,assigned_staff_id,created_by,starts_at,ends_at)
        VALUES(${context},${a.school.id},'office','Synthetic',${a.teacher.id},${a.teacher.id},now()-interval '1 minute',now()+interval '1 hour')`);
      await tx.execute(sql`INSERT INTO classpilot_supervision_students(school_id,context_id,student_id,assigned_by)
        VALUES(${a.school.id},${context},${a.student.id},${a.teacher.id})`);
      assert.equal((await compare(tx)).hasActiveSupervision, true);
      assert.equal(await storage.withClasspilotTeachingTelemetryAuthority(authority, () => "forbidden", tx), undefined);
      assert.equal((await storage.getClasspilotScreenshotAuthorityProjection(authority, tx))?.authority.kind, "student_session");
      for (const update of [
        sql`UPDATE classpilot_supervision_contexts SET starts_at=now()+interval '1 minute' WHERE id=${context}`,
        sql`UPDATE classpilot_supervision_contexts SET starts_at=now()-interval '2 minutes',ends_at=now() WHERE id=${context}`,
        sql`UPDATE classpilot_supervision_contexts SET ends_at=now()+interval '1 hour',status='ended' WHERE id=${context}`,
        sql`UPDATE classpilot_supervision_contexts SET status='active' WHERE id=${context}`,
        sql`UPDATE classpilot_supervision_students SET released_at=now() WHERE context_id=${context}`,
        sql`UPDATE classpilot_supervision_students SET released_at=NULL WHERE context_id=${context}`,
        sql`UPDATE students SET status='inactive' WHERE id=${a.student.id}`,
      ]) { await tx.execute(update); await compare(tx); }
    }));

    await t.test("foreign and absent bindings never substitute another owner", () => isolated(a.school.id, async tx => {
      for (const [schoolId, studentId] of [[a.school.id, b.student.id], [randomUUID(), a.student.id], [a.school.id, randomUUID()]]) {
        assert.deepEqual(await compare(tx, schoolId, studentId), { hasActiveSupervision: false, teachingSessionId: undefined });
      }
      const foreign = await compare(tx, b.school.id, b.student.id);
      assert.equal(foreign.teachingSessionId, restricted ? undefined : b.session.id);
    }));

    await t.test("callbacks and screenshot claims retain exact revision, actor and live-binding fences", () => isolated(a.school.id, async tx => {
      assert.equal(await storage.withClasspilotTeachingTelemetryAuthority(authority, () => "published", tx), "published");
      assert.equal((await storage.getClasspilotScreenshotAuthorityProjection(authority, tx))?.authority.kind, "teaching_session");
      assert.equal(await storage.withClasspilotTeachingTelemetryAuthority({ ...authority, actorId: a.teacher.id }, () => true, tx), true);
      for (const overrides of [{ actorId: b.teacher.id }, { controlRevision: a.control.revision - 1 },
        { studentSessionId: b.binding.id }, { deviceId: b.deviceId }, { teachingSessionId: b.session.id }]) {
        assert.equal(await storage.withClasspilotTeachingTelemetryAuthority({ ...authority, ...overrides }, () => "forbidden", tx), undefined);
      }
      await tx.execute(sql`UPDATE product_licenses SET status='expired' WHERE school_id=${a.school.id} AND product='CLASSPILOT'`);
      await assert.rejects(storage.withClasspilotTeachingTelemetryAuthority(authority, () => "forbidden", tx),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "CLASSPILOT_NOT_ENTITLED");
      await tx.execute(sql`UPDATE product_licenses SET status='active' WHERE school_id=${a.school.id} AND product='CLASSPILOT'`);
      await tx.execute(sql`UPDATE students SET status='inactive' WHERE id=${a.student.id}`);
      assert.equal(await storage.withClasspilotTeachingTelemetryAuthority(authority, () => "forbidden", tx), undefined);
      await tx.execute(sql`UPDATE students SET status='active' WHERE id=${a.student.id}`);
      await tx.execute(sql`UPDATE student_sessions SET is_active=false,ended_at=now() WHERE id=${a.binding.id}`);
      const manualSession = randomUUID();
      await tx.execute(sql`INSERT INTO student_sessions(id,student_id,device_id,auth_kind,manual_lease_expires_at,session_recovery_token_hash)
        VALUES(${manualSession},${a.student.id},${a.deviceId},'manual_shared',clock_timestamp()+interval '1 minute',${"a".repeat(64)})`);
      assert.equal(await storage.withClasspilotTeachingTelemetryAuthority({ ...authority, studentSessionId: manualSession }, () => true, tx), true);
      await tx.execute(sql`UPDATE student_sessions SET manual_lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${manualSession}`);
      assert.equal(await storage.withClasspilotTeachingTelemetryAuthority({ ...authority, studentSessionId: manualSession }, () => "forbidden", tx), undefined);
    }));

    await t.test("ended tombstones remain exact and cannot override a replacement binding", () => isolated(a.school.id, async tx => {
      await tx.execute(sql`UPDATE student_sessions SET is_active=false,ended_at=now() WHERE id=${a.binding.id}`);
      assert.equal(await storage.withClasspilotTeachingTelemetryAuthority(authority, () => "forbidden", tx), undefined);
      assert.equal(await storage.withClasspilotTeachingTelemetryAuthority({ ...authority, allowEndedBinding: true }, () => true, tx), true);
      await tx.execute(sql`INSERT INTO student_sessions(student_id,device_id) VALUES(${a.student.id},${a.deviceId})`);
      assert.equal(await storage.withClasspilotTeachingTelemetryAuthority({ ...authority, allowEndedBinding: true }, () => "forbidden", tx), undefined);
    }));

    await t.test("server classification is atomic with insertion, nullable by default and fenced by exact binding", () => isolated(a.school.id, async tx => {
      const payload = { schoolId: a.school.id, studentId: a.student.id, deviceId: a.deviceId, studentEmail: "ignored@example.invalid",
        activeTabTitle: "Synthetic educational page", activeTabUrl: "https://www.ixl.com/math" };
      const fields = { aiCategory: "educational", contentCategory: "Education", teacherIntentSource: "flight_path", safetyAlert: null };
      const explicitNull = { aiCategory: null, contentCategory: null, teacherIntentSource: null, safetyAlert: null };
      for (const input of [fields, {}, explicitNull]) {
        const recorded = await storage.createHeartbeatAndRefreshPresence({ ...payload, ...input }, a.binding.id);
        assert.equal(recorded.outcome, "recorded");
        if (recorded.outcome !== "recorded") assert.fail("expected accepted synthetic heartbeat");
        const stored = (await tx.execute(sql`SELECT ai_category AS "aiCategory",content_category AS "contentCategory",
          teacher_intent_source AS "teacherIntentSource",safety_alert AS "safetyAlert" FROM heartbeats WHERE id=${recorded.id}`)).rows[0];
        const expected = { ...explicitNull, ...input };
        assert.deepEqual(stored, expected);
        assert.deepEqual({ aiCategory: recorded.aiCategory, contentCategory: recorded.contentCategory,
          teacherIntentSource: recorded.teacherIntentSource, safetyAlert: recorded.safetyAlert }, expected);
      }
      const before = (await tx.execute(sql`SELECT count(*)::int AS n FROM heartbeats WHERE student_id=${a.student.id}`)).rows[0]!.n;
      assert.equal((await storage.createHeartbeatAndRefreshPresence({ ...payload, ...fields }, b.binding.id)).outcome, "replaced_session");
      assert.equal((await tx.execute(sql`SELECT count(*)::int AS n FROM heartbeats WHERE student_id=${a.student.id}`)).rows[0]!.n, before);
    }));

    await t.test("reporting observation remains opt-in, observed and excluded from actor authority", () => isolated(a.school.id, async tx => {
      await tx.execute(sql`UPDATE teaching_sessions SET session_mode='scheduled_report',scheduled_date=to_char(now(),'YYYY-MM-DD'),
        scheduled_timezone='UTC',scheduled_start_at=now()-interval '1 minute',scheduled_end_at=now()+interval '1 hour',scheduled_state='active' WHERE id=${a.session.id}`);
      assert.equal((await compare(tx)).teachingSessionId, undefined);
      const observed = { ...authority, allowReportingObservation: true };
      assert.equal(await storage.withClasspilotTeachingTelemetryAuthority(observed, () => "forbidden", tx), undefined);
      const viewer = { schoolId: a.school.id, teachingSessionId: a.session.id, viewerUserId: a.teacher.id, viewerInstanceId: randomUUID() };
      await observation.renewClasspilotObservationLease({ ...viewer, scope: { kind: "class" } });
      try {
        assert.equal(await storage.withClasspilotTeachingTelemetryAuthority(observed, () => true, tx), true);
        assert.equal(await storage.withClasspilotTeachingTelemetryAuthority(authority, () => "forbidden", tx), undefined);
        assert.equal(await storage.withClasspilotTeachingTelemetryAuthority({ ...observed, actorId: a.teacher.id }, () => "forbidden", tx), undefined);
        await tx.execute(sql`INSERT INTO teaching_sessions(school_id,group_id,teacher_id,start_time) VALUES(${a.school.id},${a.group.id},${a.teacher.id},now()-interval '1 minute')`);
        assert.equal(await storage.withClasspilotTeachingTelemetryAuthority(observed, () => "forbidden", tx), undefined);
      } finally { await observation.releaseClasspilotObservationLease(viewer); }
    }));

    await t.test("a writer preceding the advisory lock is observed after the wait", async () => {
      let unblock!: () => void, locked!: () => void;
      const held = new Promise<void>(resolve => { locked = resolve; });
      const release = new Promise<void>(resolve => { unblock = resolve; });
      const writer = scoped(a.school.id, () => db.transaction(async tx => {
        await storage.lockClasspilotStudentControlAuthorities(a.school.id, [a.student.id], tx);
        await tx.execute(sql`UPDATE classpilot_student_control_states SET revision=revision+1 WHERE school_id=${a.school.id} AND student_id=${a.student.id}`);
        locked(); await release;
      }));
      await held;
      let readerStarted!: (pid: number) => void;
      const readerPid = new Promise<number>(resolve => { readerStarted = resolve; });
      const reader = scoped(a.school.id, async () => {
        readerStarted((await db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid);
        return storage.withClasspilotTeachingTelemetryAuthority(authority, () => "forbidden");
      });
      try { await waitUntilBlocked(await readerPid); }
      finally { unblock(); }
      await writer;
      assert.equal(await reader, undefined);
      await scoped(a.school.id, () => db.execute(sql`UPDATE classpilot_student_control_states SET revision=${a.control.revision} WHERE school_id=${a.school.id} AND student_id=${a.student.id}`));
    });

    await t.test("authority and entitlement writers wait for callback completion; callback failure releases locks", async () => {
      for (const kind of ["control", "entitlement"] as const) {
        let entered!: () => void, finish!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const release = new Promise<void>(resolve => { finish = resolve; });
        const publication = scoped(a.school.id, () => storage.withClasspilotTeachingTelemetryAuthority(authority, async () => {
          entered(); await release; throw new Error("synthetic publication failed");
        }));
        const publicationRejected = assert.rejects(publication, /synthetic publication failed/);
        await started;
        let changed = false;
        let mutationStarted!: (pid: number) => void;
        const mutationPid = new Promise<number>(resolve => { mutationStarted = resolve; });
        const mutation = scoped(a.school.id, () => db.transaction(async tx => {
          mutationStarted((await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid);
          if (kind === "control") await storage.lockClasspilotStudentControlAuthorities(a.school.id, [a.student.id], tx);
          await tx.execute(kind === "control"
            ? sql`UPDATE classpilot_student_control_states SET revision=revision WHERE school_id=${a.school.id} AND student_id=${a.student.id}`
            : sql`UPDATE product_licenses SET status='active' WHERE school_id=${a.school.id} AND product='CLASSPILOT'`);
          changed = true;
        }));
        try { await waitUntilBlocked(await mutationPid); assert.equal(changed, false); }
        finally { finish(); }
        await Promise.all([publicationRejected, mutation]);
        assert.equal(changed, true);
      }
      assert.equal(await scoped(a.school.id, () => storage.withClasspilotTeachingTelemetryAuthority(authority, () => true)), true);
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
    } finally {
      await drainTenantContextReleases();
      await Promise.all([pool.end(), sessionPool.end()]);
    }
  }
});
