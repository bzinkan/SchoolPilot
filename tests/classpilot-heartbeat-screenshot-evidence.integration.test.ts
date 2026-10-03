import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { sql } from "drizzle-orm";

process.env.NODE_ENV = "test";
process.env.SCHEDULER_ENABLED = "false";
process.env.RLS_GUC_ENABLED = "true";
process.env.REDIS_URL = "";
const functionName = "classpilot_heartbeat_screenshot_evidence_v1";
function queryText(value: unknown): string {
  return typeof value === "string" ? value : value && typeof value === "object" && "text" in value ? String(value.text) : "";
}
function errorCode(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && (("code" in error && error.code === code)
    || ("cause" in error && errorCode(error.cause, code)));
}
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("native screenshot barrier not reached")), 5_000);
  })]); } finally { clearTimeout(timer); }
}

test("installed screenshot reader preserves owned delivery, branches and native authority locks", { timeout: 180_000 }, async t => {
  const { db, pool, sessionPool } = await import("../src/db.js");
  const storage = await import("../src/services/storage.js");
  const prepared = await import("../src/services/classpilotHeartbeatPreparedReads.js");
  const tenant = await import("../src/middleware/tenantContext.js");
  const observation = await import("../src/services/classpilotObservationLease.js");
  type Transaction = Parameters<Parameters<typeof prepared.withHeartbeatPreparedReadTransaction>[2]>[0];
  const scoped = <T>(schoolId: string, work: () => Promise<T>) => tenant.runWithTenantContext({ schoolId }, work);
  const owned = <T>(schoolId: string, work: (tx: Transaction) => Promise<T>) => scoped(schoolId,
    () => prepared.withHeartbeatPreparedReadTransaction(db, schoolId, work));
  const tag = `screenshot_${randomUUID().replaceAll("-", "")}`, schools: string[] = [];
  const writer = new pg.Client({ connectionString: process.env.DATABASE_URL, statement_timeout: 15_000 });
  const savedPreview = process.env.CLASSPILOT_SUPERVISION_PREVIEW_MODE;
  const savedScheduled = process.env.CLASSPILOT_SCHEDULED_CLASSROOM_MODE;
  const fixture = async () => {
    const key = `${tag}_${schools.length}`;
    const school = await storage.createSchool({ name: key, slug: key, domain: `${key}.example.invalid` }); schools.push(school.id);
    const teacher = await storage.createUser({ email: `${key}@${key}.example.invalid`, firstName: "Synthetic", lastName: "Screenshot" });
    await storage.createMembership({ schoolId: school.id, userId: teacher.id, role: "teacher", status: "active" });
    await storage.createProductLicense({ schoolId: school.id, product: "CLASSPILOT", status: "active" });
    return scoped(school.id, async () => {
      const student = await storage.createStudent({ schoolId: school.id, firstName: "Synthetic", lastName: "Screenshot", status: "active" });
      const group = await storage.createGroup({ schoolId: school.id, teacherId: teacher.id, name: key, groupType: "teacher_created" });
      await storage.addGroupStudentsDetailed(group.id, [student.id]);
      const deviceId = key; await storage.createDevice({ schoolId: school.id, deviceId, classId: "default" });
      const old = await storage.setActiveStudentForDevice(deviceId, student.id), sessionId = randomUUID();
      await db.execute(sql`UPDATE student_sessions SET is_active=false,ended_at=now() WHERE id=${old.id}`);
      await db.execute(sql`INSERT INTO student_sessions(id,student_id,device_id,auth_kind,manual_lease_expires_at,session_recovery_token_hash)
        VALUES(${sessionId},${student.id},${deviceId},'manual_shared',clock_timestamp()+interval '1 hour',${randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '')})`);
      const teaching = await storage.createTeachingSession({ groupId: group.id, teacherId: teacher.id, startTime: new Date(Date.now() - 60_000) });
      return { school, teacher, student, group, teaching, options: { schoolId: school.id, studentId: student.id, studentSessionId: sessionId, deviceId, freezeSsoPolicy: true } };
    });
  };
  const writerBegin = async (schoolId: string) => {
    await writer.query("BEGIN");
    await writer.query("SELECT set_config('app.school_id',$1,true),set_config('app.is_super','off',true)", [schoolId]);
  };
  const blocked = async (pid: number) => {
    const until = Date.now() + 5_000;
    while (Date.now() < until) {
      if ((await pool.query<{ blocked: boolean }>("SELECT cardinality(pg_blocking_pids($1))>0 AS blocked", [pid])).rows[0]?.blocked) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail("expected real PostgreSQL row-lock wait");
  };
  try {
    await writer.connect();
    const role = (await pool.query<{ name: string; bypass: boolean; owns: boolean }>(`SELECT current_user AS name,
      rolsuper OR rolbypassrls AS bypass,
      (SELECT proowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) FROM pg_proc
        WHERE oid='public.classpilot_heartbeat_screenshot_evidence_v1(text,text,text,text)'::regprocedure) AS owns
      FROM pg_roles WHERE rolname=current_user`)).rows[0]!;
    if (process.env.RLS_TEST_ROLE && process.env.RLS_TEST_ROLE !== "false") {
      assert.equal(role.bypass, false); assert.equal(role.owns, false, "runtime role must not own the function");
      const admitted = (await pool.query<{ enabled: boolean; forced: boolean; owns: boolean }>(`SELECT relrowsecurity AS enabled,relforcerowsecurity AS forced,
        relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owns FROM pg_class
        WHERE oid=ANY(ARRAY['students'::regclass,'devices'::regclass,'teaching_sessions'::regclass,
          'classpilot_student_control_states'::regclass,'classpilot_session_students'::regclass])`)).rows;
      assert.equal(admitted.length, 5); assert.ok(admitted.every(row => row.enabled && row.forced && !row.owns));
    }
    const a = await fixture(), b = await fixture();
    const reset = () => scoped(a.school.id, async () => {
      observation.resetClasspilotObservationLeasesForTests();
      await db.execute(sql`UPDATE student_sessions SET manual_lease_expires_at=clock_timestamp()+interval '1 hour' WHERE id=${a.options.studentSessionId}`);
      await db.execute(sql`UPDATE teaching_sessions SET session_mode='live',end_time=NULL,scheduled_date=NULL,
        scheduled_timezone=NULL,scheduled_start_at=NULL,scheduled_end_at=NULL,scheduled_state=NULL WHERE id=${a.teaching.id}`);
      await db.execute(sql`UPDATE classpilot_student_control_states SET teaching_session_id=${a.teaching.id},supervision_context_id=NULL,
        revision=8,scheduled_end_at=NULL,hard_expires_at=clock_timestamp()+interval '1 hour' WHERE school_id=${a.school.id} AND student_id=${a.student.id}`);
      await db.execute(sql`DELETE FROM classpilot_supervision_students WHERE school_id=${a.school.id}`);
      await db.execute(sql`DELETE FROM classpilot_supervision_contexts WHERE school_id=${a.school.id}`);
    });
    const compare = async () => scoped(a.school.id, async () => {
      const reference = await storage.withClasspilotStudentControlDeliveryAuthority(a.options,
        tx => storage.getClasspilotScreenshotAuthorityProjection(a.options, tx), (_rows, projection) => projection);
      const actual = await storage.withClasspilotHeartbeatDeliveryAuthority(a.options, (_tx, read) => read(), (_rows, projection) => projection);
      assert.equal(reference.authorized, true); assert.equal(actual.authorized, true);
      if (!reference.authorized || !actual.authorized) assert.fail("fixture binding must be current");
      assert.deepEqual(actual.value, reference.value); return actual.value;
    });

    await t.test("generic, super and RLS-off reference readers retain original queries and projection", async () => {
      await reset(); let functionCalls = 0; const original = pg.Client.prototype.query;
      const spy = t.mock.method(pg.Client.prototype, "query", function(this: pg.Client, ...args: unknown[]) {
        if (queryText(args[0]).includes(functionName)) functionCalls++;
        return Reflect.apply(original, this, args);
      });
      try {
        const reference = await scoped(a.school.id, () => storage.withClasspilotStudentControlDeliveryAuthority(a.options,
          tx => storage.getClasspilotScreenshotAuthorityProjection(a.options, tx), (_rows, projection) => projection));
        assert.equal(reference.authorized, true); if (!reference.authorized) assert.fail("expected current generic binding");
        const superResult = await tenant.runWithTenantContext({ isSuper: true }, () => storage.withClasspilotHeartbeatDeliveryAuthority(
          a.options, (_tx, read) => read(), (_rows, projection) => projection));
        assert.equal(superResult.authorized, true); if (!superResult.authorized) assert.fail("expected current super binding");
        assert.deepEqual(superResult.value, reference.value);
        const rlsOff = await scoped(a.school.id, async () => {
          const store = tenant.getOwnedTenantStore(); assert.ok(store);
          const saved = process.env.RLS_GUC_ENABLED;
          try {
            // Keep the fixture's explicit scoped executor: a restricted server
            // would correctly deny a global-pool read without its tenant GUC.
            process.env.RLS_GUC_ENABLED = "false";
            // These public functions type their reference executor as the
            // global database (including its Pool-only $client property).
            // Reflective invocation supplies the real scoped database and
            // transaction without fabricating that unused Pool property.
            return await Reflect.apply(prepared.withHeartbeatPreparedReadTransaction, undefined, [store.db, a.school.id, (tx: Transaction) => {
              assert.equal(prepared.readHeartbeatScreenshotEvidenceIfOwned(tx, a.options), undefined);
              return Reflect.apply(storage.getClasspilotScreenshotAuthorityProjection, undefined, [a.options, tx]);
            }]);
          } finally { process.env.RLS_GUC_ENABLED = saved; }
        });
        assert.deepEqual(rlsOff, reference.value); assert.equal(functionCalls, 0);
      } finally { spy.mock.restore(); }
    });

    await t.test("ordinary scoped raw invocation returns current evidence and respects restricted tenant isolation", async () => {
      await scoped(a.school.id, () => db.transaction(async tx => {
        const result = await tx.execute<{ evidence: { stage: string; session: { id: string } } }>(sql`SELECT public.classpilot_heartbeat_screenshot_evidence_v1(
          ${a.school.id}::text,${a.student.id}::text,${a.options.studentSessionId}::text,${a.options.deviceId}::text) AS evidence`);
        assert.equal(result.rows.length, 1); assert.equal(result.rows[0]!.evidence.stage, "owner");
        assert.equal(result.rows[0]!.evidence.session.id, a.options.studentSessionId);
      }));
      if (!(process.env.RLS_TEST_ROLE && process.env.RLS_TEST_ROLE !== "false")) return;
      await scoped(a.school.id, () => db.transaction(async tx => {
        const result = await tx.execute<{ evidence: unknown }>(sql`SELECT public.classpilot_heartbeat_screenshot_evidence_v1(
          ${b.school.id}::text,${b.student.id}::text,${b.options.studentSessionId}::text,${b.options.deviceId}::text) AS evidence`);
        assert.equal(result.rows.length, 1); assert.deepEqual(result.rows[0]!.evidence, { stage: "session_missing" });
      }));
    });

    await t.test("actual supervision on/observe continuation retains the canonical additional reads", async () => {
      for (const mode of ["on", "observe"] as const) {
        await reset(); process.env.CLASSPILOT_SUPERVISION_PREVIEW_MODE = mode;
        process.env.CLASSPILOT_SCHEDULED_CLASSROOM_MODE = "off";
        const supervisionId = randomUUID();
        await scoped(a.school.id, async () => {
          await db.execute(sql`INSERT INTO classpilot_supervision_contexts(id,school_id,context_type,name,assigned_staff_id,created_by,starts_at,ends_at)
            VALUES(${supervisionId},${a.school.id},'coverage','Synthetic screenshot',${a.teacher.id},${a.teacher.id},now()-interval '1 minute',now()+interval '30 minutes')`);
          await db.execute(sql`INSERT INTO classpilot_supervision_students(school_id,context_id,student_id,assigned_by)
            VALUES(${a.school.id},${supervisionId},${a.student.id},${a.teacher.id})`);
          await db.execute(sql`UPDATE classpilot_student_control_states SET teaching_session_id=NULL,supervision_context_id=${supervisionId}
            WHERE school_id=${a.school.id} AND student_id=${a.student.id}`);
        });
        const projection = await compare(); assert.ok(projection?.supervisionRetention);
        assert.equal(projection.authority.kind, mode === "on" ? "supervision_context" : "student_session");
        assert.equal(projection.supervisionRetention.supervisionContextId, supervisionId);
      }
    });

    await t.test("actual reporting Observe continuation retains its lease and never upgrades to teaching", async () => {
      await reset();
      await scoped(a.school.id, () => db.execute(sql`UPDATE teaching_sessions SET session_mode='scheduled_report',scheduled_state='active',
        scheduled_date=to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD'),scheduled_timezone='UTC',
        scheduled_start_at=now()-interval '1 minute',scheduled_end_at=now()+interval '30 minutes' WHERE id=${a.teaching.id}`));
      await observation.renewClasspilotObservationLease({ schoolId: a.school.id, teachingSessionId: a.teaching.id,
        viewerUserId: a.teacher.id, viewerInstanceId: "screenshot-native", scope: { kind: "class" } });
      const projection = await compare(); assert.ok(projection?.reportingObservation);
      assert.equal(projection.authority.kind, "student_session");
      assert.equal(projection.reportingObservation.teachingSessionId, a.teaching.id);
    });

    for (const shape of ["missing-control", "unowned-control", "ended-teaching"] as const) await t.test(`${shape} preserves actual fallback projection`, async () => {
      await reset();
      await scoped(a.school.id, async () => {
        if (shape === "missing-control") await db.execute(sql`DELETE FROM classpilot_student_control_states WHERE school_id=${a.school.id} AND student_id=${a.student.id}`);
        if (shape === "unowned-control") await db.execute(sql`UPDATE classpilot_student_control_states SET teaching_session_id=NULL,supervision_context_id=NULL,
          hard_expires_at=NULL,scheduled_end_at=NULL WHERE school_id=${a.school.id} AND student_id=${a.student.id}`);
        if (shape === "ended-teaching") await db.execute(sql`UPDATE teaching_sessions SET end_time=now() WHERE id=${a.teaching.id}`);
      });
      try { const projection = await compare(); assert.equal(projection?.authority.kind, "student_session"); }
      finally {
        // Make this fixture eligible for canonical repair, retaining its frozen
        // roster, so the initializer recreates its missing control authority.
        if (shape === "missing-control") await scoped(a.school.id, async () => {
          await db.execute(sql`UPDATE teaching_sessions SET class_name_snapshot=NULL WHERE id=${a.teaching.id}`);
          assert.equal(await storage.backfillOpenTeachingSessionRosterSnapshots(db, a.school.id), 1);
        });
      }
    });

    for (const awaited of [true, false]) for (const failure of ["SQL", "malformed envelope"] as const)
      await t.test(`${awaited ? "caught" : "unawaited"} ${failure} remains mandatory and suppresses all delivery`, async () => {
      await reset(); let intercepted = 0, http = 0, foreground = 0, recovery = 0;
      const original = pg.Client.prototype.query;
      const spy = t.mock.method(pg.Client.prototype, "query", function(this: pg.Client, ...args: unknown[]) {
        if (queryText(args[0]).includes(functionName)) {
          intercepted++;
          if (failure === "SQL") return Reflect.apply(original, this, ["SELECT 1/0"]);
          return Promise.resolve(Reflect.apply(original, this, args)).then(result => {
            assert.ok(result && Array.isArray(result.rows) && Array.isArray(result.rows[0]));
            // Drizzle's selected-field mapper receives the actual array-mode
            // row; corrupt only the JSON value returned by the real function.
            result.rows[0][0] = { stage: "owner", session: { authKind: "legacy" } }; return result;
          });
        }
        return Reflect.apply(original, this, args);
      });
      try {
        await assert.rejects(scoped(a.school.id, () => storage.withClasspilotHeartbeatDeliveryAuthority(a.options,
          async (_tx, read) => {
            if (awaited) {
              try { await read(); } catch { /* Caller cannot erase a mandatory read failure. */ }
            } else {
              // The actual delivery wrapper must join and poison this work
              // before any recovery, foreground or synchronous HTTP callback.
              void read();
            }
            return "prepared";
          },
          () => { http++; return "sent"; }, () => { recovery++; return "recovered"; },
          { teachingSessionId: a.teaching.id, controlRevision: 8, publish: async () => { foreground++; }, onFailure: () => {} })));
        assert.equal(intercepted, 1); assert.deepEqual({ http, foreground, recovery }, { http: 0, foreground: 0, recovery: 0 });
      } finally { spy.mock.restore(); }
    });

    await t.test("recognized foreign school and retained reader are poisoned before function execution", async () => {
      await reset(); let count = 0; const original = pg.Client.prototype.query;
      const spy = t.mock.method(pg.Client.prototype, "query", function(this: pg.Client, ...args: unknown[]) {
        if (queryText(args[0]).includes(functionName)) count++;
        return Reflect.apply(original, this, args);
      });
      let retained: Transaction | undefined;
      try {
        await assert.rejects(owned(a.school.id, async tx => {
          try { await prepared.readHeartbeatScreenshotEvidenceIfOwned(tx, b.options); } catch {}
          await prepared.sealHeartbeatPreparedReads(tx);
        }), /tenant mismatch/);
        assert.equal(count, 0);
        await owned(a.school.id, async tx => { retained = tx; await prepared.readHeartbeatScreenshotEvidenceIfOwned(tx, a.options); });
        assert.equal(count, 1); assert.ok(retained);
        assert.throws(() => prepared.readHeartbeatScreenshotEvidenceIfOwned(retained!, a.options), /no longer owned/);
        assert.equal(count, 1);
      } finally { spy.mock.restore(); }
    });

    for (const stage of ["session", "control"] as const) await t.test(`function retains a fresh later snapshot after ${stage} lock wait`, async () => {
      await reset();
      await scoped(a.school.id, () => db.execute(sql`UPDATE teaching_sessions SET end_time=now() WHERE id=${a.teaching.id}`));
      await writerBegin(a.school.id); let operation: Promise<unknown> | undefined;
      try {
        await writer.query(stage === "session" ? "UPDATE student_sessions SET last_seen_at=last_seen_at WHERE id=$1"
          : "UPDATE classpilot_student_control_states SET revision=revision WHERE student_id=$1", [stage === "session" ? a.options.studentSessionId : a.student.id]);
        let announce!: (pid: number) => void; const ready = new Promise<number>(resolve => { announce = resolve; });
        operation = owned(a.school.id, async tx => {
          const store = tenant.getOwnedTenantStore(); assert.ok(store);
          announce((await store.client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid);
          const evidence = await prepared.readHeartbeatScreenshotEvidenceIfOwned(tx, a.options);
          assert.equal(evidence?.stage, "owner");
          if (evidence?.stage !== "owner") assert.fail("newly eligible teaching candidate must be visible");
          assert.equal(evidence.control.revision, 9); assert.equal(evidence.candidate.controlRevision, 9);
        }); void operation.catch(() => {});
        await blocked(await bounded(ready));
        await writer.query("UPDATE classpilot_student_control_states SET revision=revision+1 WHERE student_id=$1", [a.student.id]);
        await writer.query("UPDATE teaching_sessions SET end_time=NULL WHERE id=$1", [a.teaching.id]);
        await writer.query("COMMIT"); await operation;
      } finally { await writer.query("ROLLBACK"); if (operation) await Promise.allSettled([operation]); }
    });

    await t.test("Q4 observes the newly winning owner committed while Q3 waits", async () => {
      await reset(); const winner = randomUUID(); let operation: Promise<unknown> | undefined;
      await writerBegin(a.school.id);
      try {
        await writer.query("UPDATE teaching_sessions SET control_updated_at=control_updated_at WHERE id=$1", [a.teaching.id]);
        let announce!: (pid: number) => void; const ready = new Promise<number>(resolve => { announce = resolve; });
        operation = owned(a.school.id, async tx => {
          const store = tenant.getOwnedTenantStore(); assert.ok(store);
          announce((await store.client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid);
          const evidence = await prepared.readHeartbeatScreenshotEvidenceIfOwned(tx, a.options);
          assert.equal(evidence?.stage, "owner");
          if (evidence?.stage !== "owner") assert.fail("expected exact original teaching candidate");
          assert.equal(evidence.candidate.teachingSessionId, a.teaching.id);
          assert.ok(evidence.owners.some(row => row.id === winner), "later SPI statement must see committed owner");
        }); void operation.catch(() => {});
        await blocked(await bounded(ready));
        assert.equal((await writer.query(`INSERT INTO teaching_sessions(id,group_id,teacher_id,school_id,start_time,
          control_updated_at,session_mode,roster_snapshot_completed_at,created_at)
          SELECT $1,group_id,teacher_id,school_id,start_time,COALESCE(control_updated_at,start_time)+interval '1 day',
            'live',roster_snapshot_completed_at,created_at FROM teaching_sessions WHERE id=$2 RETURNING id`, [winner, a.teaching.id])).rowCount, 1);
        assert.equal((await writer.query(`INSERT INTO classpilot_session_students(id,school_id,teaching_session_id,group_id,student_id,student_name_snapshot,captured_at)
          SELECT $1,school_id,$2,group_id,student_id,student_name_snapshot,captured_at FROM classpilot_session_students
          WHERE teaching_session_id=$3 AND student_id=$4 RETURNING id`, [randomUUID(), winner, a.teaching.id, a.student.id])).rowCount, 1);
        await writer.query("COMMIT"); await operation;
        assert.equal((await compare())?.authority.kind, "student_session", "unchanged ranker rejects original losing candidate");
      } finally {
        await writer.query("ROLLBACK"); if (operation) await Promise.allSettled([operation]);
        await writerBegin(a.school.id);
        try {
          await writer.query("DELETE FROM classpilot_session_students WHERE teaching_session_id=$1", [winner]);
          await writer.query("DELETE FROM teaching_sessions WHERE id=$1", [winner]); await writer.query("COMMIT");
        } finally { await writer.query("ROLLBACK"); }
      }
    });

    await t.test("function retains all six joined row locks after return until owned root releases", async () => {
      await reset(); let reached!: () => void, release!: () => void;
      const ready = new Promise<void>(resolve => { reached = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
      const operation = owned(a.school.id, async tx => {
        assert.equal((await prepared.readHeartbeatScreenshotEvidenceIfOwned(tx, a.options))?.stage, "owner"); reached(); await gate;
      }); void operation.catch(() => {});
      const rows: Array<[string, string[]]> = [
        ["SELECT id FROM student_sessions WHERE id=$1 FOR UPDATE NOWAIT", [a.options.studentSessionId]],
        ["SELECT id FROM students WHERE id=$1 FOR UPDATE NOWAIT", [a.student.id]],
        ["SELECT device_id FROM devices WHERE device_id=$1 FOR UPDATE NOWAIT", [a.options.deviceId]],
        ["SELECT id FROM classpilot_student_control_states WHERE student_id=$1 FOR UPDATE NOWAIT", [a.student.id]],
        ["SELECT id FROM teaching_sessions WHERE id=$1 FOR UPDATE NOWAIT", [a.teaching.id]],
        ["SELECT id FROM classpilot_session_students WHERE teaching_session_id=$1 AND student_id=$2 FOR UPDATE NOWAIT", [a.teaching.id, a.student.id]],
      ];
      try {
        await bounded(Promise.race([ready, operation]));
        for (const [query, values] of rows) {
          await writerBegin(a.school.id);
          try { await assert.rejects(writer.query(query, values), error => errorCode(error, "55P03")); }
          finally { await writer.query("ROLLBACK"); }
        }
        release(); await operation;
        for (const [query, values] of rows) {
          await writerBegin(a.school.id);
          try { assert.equal((await writer.query(query, values)).rowCount, 1); }
          finally { await writer.query("ROLLBACK"); }
        }
      } finally { release(); await Promise.allSettled([operation]); }
    });

    await t.test("caller abort retains SQL ownership until cancellation settles then rolls back before reuse", async () => {
      await reset(); await writerBegin(a.school.id);
      let operation: Promise<unknown> | undefined, settled = false, rolledBack = false, client: pg.PoolClient | undefined;
      const original = pg.Client.prototype.query;
      const spy = t.mock.method(pg.Client.prototype, "query", function(this: pg.Client, ...args: unknown[]) {
        if (this === client && /^rollback$/i.test(queryText(args[0]))) { assert.equal(settled, true); rolledBack = true; }
        return Reflect.apply(original, this, args);
      });
      try {
        await writer.query("UPDATE student_sessions SET last_seen_at=last_seen_at WHERE id=$1", [a.options.studentSessionId]);
        let announce!: (pid: number) => void; const ready = new Promise<number>(resolve => { announce = resolve; });
        operation = owned(a.school.id, async tx => {
          const store = tenant.getOwnedTenantStore(); assert.ok(store); client = store.client;
          const pid = (await store.client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
          const pending = prepared.readHeartbeatScreenshotEvidenceIfOwned(tx, a.options); assert.ok(pending);
          void pending.then(() => { settled = true; }, () => { settled = true; });
          announce(pid); throw new Error("intentional screenshot caller abort");
        }); void operation.catch(() => {});
        const pid = await bounded(ready); await blocked(pid); assert.equal(settled, false); assert.equal(rolledBack, false);
        assert.equal((await pool.query<{ cancelled: boolean }>("SELECT pg_cancel_backend($1) AS cancelled", [pid])).rows[0]?.cancelled, true);
        await assert.rejects(operation, /intentional screenshot caller abort/);
        assert.equal(settled, true); assert.equal(rolledBack, true); assert.equal(client?.getTransactionStatus(), "I");
      } finally { await writer.query("ROLLBACK"); if (operation) await Promise.allSettled([operation]); spy.mock.restore(); }
      assert.equal((await compare())?.authority.kind, "teaching_session");
    });
  } finally {
    if (savedPreview === undefined) delete process.env.CLASSPILOT_SUPERVISION_PREVIEW_MODE; else process.env.CLASSPILOT_SUPERVISION_PREVIEW_MODE = savedPreview;
    if (savedScheduled === undefined) delete process.env.CLASSPILOT_SCHEDULED_CLASSROOM_MODE; else process.env.CLASSPILOT_SCHEDULED_CLASSROOM_MODE = savedScheduled;
    observation.resetClasspilotObservationLeasesForTests();
    await writer.end();
    try {
      for (const schoolId of schools) await tenant.runWithTenantContext({ isSuper: true }, () => db.transaction(async tx => {
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
    } finally { await tenant.drainTenantContextReleases(); await Promise.all([pool.end(), sessionPool.end()]); }
  }
});
