import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { sql } from "drizzle-orm";

process.env.NODE_ENV = "test";
process.env.SCHEDULER_ENABLED = "false";
process.env.RLS_GUC_ENABLED = "true";
process.env.REDIS_URL = "";

test("heartbeat inbox shares final ownership while preserving durable command recovery", { timeout: 120_000 }, async t => {
  const { db, pool, sessionPool } = await import("../src/db.js");
  const storage = await import("../src/services/storage.js");
  const { runWithTenantContext, drainTenantContextReleases } = await import("../src/middleware/tenantContext.js");
  const { getTenantStore } = await import("../src/db/tenantContext.js");
  const tag = `inbox_${randomUUID().replaceAll("-", "")}`, schools: string[] = [];
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
        'students'::regclass,'devices'::regclass,'messages'::regclass,'classpilot_commands'::regclass,'classpilot_command_targets'::regclass])`)).rows;
      assert.equal(policies.length, 10); assert.ok(policies.every(row => row.enabled && row.forced));
    }
    const reset = () => scoped(a.school.id, async () => {
      await db.execute(sql`DELETE FROM messages WHERE school_id=${a.school.id}`);
      await db.execute(sql`DELETE FROM classpilot_command_targets WHERE school_id=${a.school.id}`);
      await db.execute(sql`DELETE FROM classpilot_commands WHERE school_id=${a.school.id}`);
      await storage.upsertSettings(a.school.id, {});
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
    type Inbox = Awaited<ReturnType<typeof storage.getPendingMessagesForStudent>>;
    const legacy = () => scoped(a.school.id, () => storage.createMessage({ schoolId: a.school.id, toStudentId: a.student.id, fromUserId: a.teacher.id, message: 'Synthetic legacy' }));
    const command = async (insertMessage = true) => scoped(a.school.id, async () => {
      const id = randomUUID();
      await db.execute(sql`INSERT INTO classpilot_commands(id,school_id,teaching_session_id,teacher_id,target_scope,command_type,command_payload)
        VALUES(${id},${a.school.id},${a.session.id},${a.teacher.id},'students','teacher-message','{"message":"Synthetic announcement"}')`);
      await db.execute(sql`INSERT INTO classpilot_command_targets(command_id,school_id,teaching_session_id,student_id,status,result)
        VALUES(${id},${a.school.id},${a.session.id},${a.student.id},'unavailable','{"durableAuthorityRevision":8}')`);
      const insert = () => scoped(a.school.id, () => storage.createMessage({ schoolId: a.school.id, toStudentId: a.student.id,
        fromUserId: a.teacher.id, message: 'Synthetic announcement', commandId: id, teachingSessionId: a.session.id }));
      return { id, insert, message: insertMessage ? await insert() : undefined };
    });
    let inbox: import("../src/services/storage.js").ClasspilotHeartbeatInboxOutcome = { checked: false };
    const invoke = async (options: { publish?: () => Promise<void>; excludes?: string[]; exact?: typeof binding; noReader?: boolean } = {}) => {
      inbox = { checked: false };
      const exact = options.exact ?? binding;
      return scoped(exact.schoolId, () => storage.withClasspilotHeartbeatDeliveryAuthority(exact, async (_tx, read) => {
        if (!options.noReader) await read(); return 'prepared';
      }, (_claimed, value, outcome) => { inbox = outcome; return value; }, undefined,
      { teachingSessionId: a.session.id, controlRevision: 8, publish: options.publish ?? (async () => {}), onFailure() {} },
      { excludeMessageIds: options.excludes }));
    };
    const rows = (): Inbox => { assert.equal(inbox.checked, true); return inbox.checked ? inbox.messages : []; };
    await t.test('teaching inbox keeps its fresh row lock and replaces five authority reads with two', async () => {
      await reset(); const item = await command();
      const original = pg.Client.prototype.query, queries: string[] = [];
      const spy = t.mock.method(pg.Client.prototype, 'query', function(this: pg.Client, ...args: unknown[]) {
        const query = args[0];
        queries.push(typeof query === 'string' ? query : query && typeof query === 'object' && 'text' in query ? String(query.text) : '');
        return Reflect.apply(original, this, args);
      });
      try {
        const expected = await scoped(a.school.id, () => storage.getPendingMessagesForStudent(binding));
        const referenceStart = queries.findIndex(query => query.includes('from "classpilot_student_control_states"'));
        const referenceEnd = queries.findIndex(query => query.includes('from "messages"'));
        assert.ok(referenceStart >= 0 && referenceEnd > referenceStart);
        const reference = queries.slice(referenceStart, referenceEnd);
        assert.equal(reference.length, 5); assert.match(reference[0]!, /for share/i);
        queries.length = 0;
        const diagnostics = await import('../src/services/usageCapacityDiagnostics.js');
        diagnostics.resetUsageCapacityDiagnostics(); await invoke({ noReader: true });
        const start = queries.indexOf('SAVEPOINT classpilot_heartbeat_inbox') + 1;
        const end = queries.findIndex((query, index) => index >= start && query.includes('from "messages"'));
        assert.ok(start > 0 && end > start);
        const optimized = queries.slice(start, end);
        assert.equal(optimized.length, 2); assert.match(optimized[0]!, /for share/i);
        assert.match(optimized[1]!, /WITH owner_candidates/);
        assert.match(optimized[1]!, /context\.starts_at<=clock_timestamp\(\)/);
        assert.match(optimized[1]!, /context\.ends_at>clock_timestamp\(\)/);
        assert.deepEqual(rows().map(row => row.id), expected.map(row => row.id));
        assert.equal(rows()[0]?.commandId, item.id);
        assert.equal(diagnostics.getUsageCapacityDiagnostics().operations.heartbeat_final_delivery!.counters.heartbeatInboxChecks, 1);
        t.diagnostic(JSON.stringify({ authorityReadsBefore: reference.length, authorityReadsAfter: optimized.length,
          initialRowLockRetained: true, clock: 'current', measuredCapacity: false }));
      } finally { spy.mock.restore(); }
    });
    await t.test('fresh teaching inbox projection matches canonical frozen and legacy owner ranking and absent scope', async () => {
      await reset(); await command(); const rival = randomUUID();
      await scoped(a.school.id, () => db.execute(sql`INSERT INTO teaching_sessions(id,school_id,group_id,teacher_id,start_time,created_at)
        VALUES(${rival},${a.school.id},${a.session.groupId},${a.teacher.id},'2026-11-01 01:30:00.123456','2026-03-08 02:30:00.654321')`));
      try {
        for (const change of [
          sql`UPDATE teaching_sessions SET control_updated_at=NULL,start_time='2026-11-01 01:30:00.123456',created_at='2026-03-08 02:30:00.654321' WHERE id=${a.session.id}`,
          sql`UPDATE teaching_sessions SET control_updated_at='2026-12-01 00:00:00.000001' WHERE id=${rival}`,
          sql`UPDATE teaching_sessions SET control_updated_at='2026-12-01 00:00:00.000999' WHERE id=${a.session.id}`,
          sql`UPDATE teaching_sessions SET created_at='2026-03-09 00:00:00' WHERE id=${a.session.id}`,
          sql`UPDATE teaching_sessions SET start_time='2026-11-02 00:00:00' WHERE id=${a.session.id}`,
          sql`UPDATE teaching_sessions SET end_time=now() WHERE id=${a.session.id}`,
          sql`UPDATE teaching_sessions SET session_mode='scheduled_report' WHERE id=${rival}`,
          sql`UPDATE classpilot_student_control_states SET teaching_session_id=NULL,hard_expires_at=NULL,scheduled_end_at=NULL WHERE school_id=${a.school.id} AND student_id=${a.student.id}`,
        ]) {
          await scoped(a.school.id, () => db.execute(change));
          const expected = await scoped(a.school.id, () => storage.getPendingMessagesForStudent(binding));
          await invoke({ noReader: true });
          assert.deepEqual(rows().map(row => row.id), expected.map(row => row.id));
        }
      } finally {
        await scoped(a.school.id, async () => {
          await db.execute(sql`DELETE FROM teaching_sessions WHERE id=${rival}`);
          await db.execute(sql`UPDATE teaching_sessions SET start_time=${a.session.startTime},created_at=${a.session.createdAt},
            control_updated_at=${a.session.controlUpdatedAt} WHERE id=${a.session.id}`);
        });
        await reset();
      }
    });
    await t.test('fused inbox equals public recovery with one physical checkout and fewer statements', async () => {
      await reset(); const item = await command(); const old = await scoped(a.school.id, () => storage.getPendingMessagesForStudent(binding));
      await scoped(a.school.id, () => db.execute(sql`UPDATE classpilot_command_targets SET status='unavailable',student_session_id=NULL,device_id=NULL WHERE command_id=${item.id}`));
      const diagnostics = await import('../src/services/usageCapacityDiagnostics.js');
      const original = pg.Client.prototype.query; let statements = 0;
      const spy = t.mock.method(pg.Client.prototype, 'query', function(this: pg.Client, ...args: unknown[]) { statements++; return Reflect.apply(original, this, args); });
      try {
        diagnostics.resetUsageCapacityDiagnostics();
        await scoped(a.school.id, () => storage.getPendingMessagesForStudent(binding));
        await scoped(a.school.id, () => storage.withClasspilotHeartbeatDeliveryAuthority(binding, async (_tx, read) => read(), () => true, undefined,
          { teachingSessionId: a.session.id, controlRevision: 8, publish: async () => {}, onFailure() {} }));
        const before = diagnostics.getUsageCapacityDiagnostics().operations.tenant_background; assert.ok(before);
        const oldStatements = statements, oldCheckouts = before.counters.checkoutSuccess;
        statements = 0; diagnostics.resetUsageCapacityDiagnostics(); await invoke();
        const after = diagnostics.getUsageCapacityDiagnostics().operations.tenant_background; assert.ok(after);
        assert.equal(oldCheckouts, 2); assert.equal(after.counters.checkoutSuccess, 1); assert.ok(statements < oldStatements);
        assert.deepEqual(rows().map(row => row.id), old.map(row => row.id));
        t.diagnostic(JSON.stringify({ oldStatements, newStatements: statements, oldCheckouts, newCheckouts: after.counters.checkoutSuccess, measuredCapacity: false }));
      } finally { spy.mock.restore(); }
    });
    await t.test('message inserted after command commit is discovered on later recovery without a negative existence shortcut', async () => {
      await reset(); const item = await command(false); await invoke(); assert.equal(rows().length, 0);
      await item.insert(); await invoke(); assert.equal(rows()[0]?.commandId, item.id);
    });
    for (const temporal of ['command', 'legacy', 'supervision-start', 'supervision-end'] as const) await t.test(`current clock observes ${temporal} crossing during foreground wait`, async () => {
      await reset(); const item = temporal === 'legacy' ? await legacy() : (await command()).message!;
      if (temporal === 'command') await scoped(a.school.id, () => db.execute(sql`UPDATE classpilot_commands SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE id=${item.commandId}`));
      if (temporal === 'legacy') await scoped(a.school.id, () => db.execute(sql`UPDATE messages SET timestamp=clock_timestamp()-interval '5 minutes'+interval '500 milliseconds' WHERE id=${item.id}`));
      if (temporal.startsWith('supervision')) await scoped(a.school.id, async () => {
        const id = randomUUID();
        await db.execute(sql`INSERT INTO classpilot_supervision_contexts(id,school_id,context_type,name,assigned_staff_id,created_by,starts_at,ends_at)
          VALUES(${id},${a.school.id},'manual','Synthetic clock',${a.teacher.id},${a.teacher.id},
          ${temporal === 'supervision-start' ? sql`clock_timestamp()+interval '500 milliseconds'` : sql`clock_timestamp()-interval '1 hour'`},
          ${temporal === 'supervision-end' ? sql`clock_timestamp()+interval '500 milliseconds'` : sql`clock_timestamp()+interval '1 hour'`})`);
        await db.execute(sql`INSERT INTO classpilot_supervision_students(school_id,context_id,student_id,assigned_by) VALUES(${a.school.id},${id},${a.student.id},${a.teacher.id})`);
      });
      // On a current supervision proof, foreground correctly falls back. Delay
      // preparation as well so the inbox path still crosses BEGIN's timestamp.
      const result = await scoped(a.school.id, () => storage.withClasspilotHeartbeatDeliveryAuthority(binding, async tx => {
        await tx.execute(sql`SELECT pg_sleep(0.65)`); return true;
      }, (_claimed, value, outcome) => { inbox = outcome; return value; }, undefined, undefined, {}));
      assert.equal(result.authorized, true); assert.equal(rows().length, temporal === 'supervision-end' ? 1 : 0);
    });
    await t.test('optional SQL failure rolls back its savepoint and keeps required preparation, without a checked outcome', async () => {
      await reset(); await legacy();
      const original = pg.Client.prototype.query; let intercepted = false;
      const spy = t.mock.method(pg.Client.prototype, 'query', function(this: pg.Client, ...args: unknown[]) {
        const arg = args[0], text = typeof arg === 'string' ? arg : arg && typeof arg === 'object' && 'text' in arg ? String(arg.text) : '';
        if (!intercepted && text.includes('from "messages"')) { intercepted = true; return Reflect.apply(original, this, ['SELECT 1/0']); }
        return Reflect.apply(original, this, args);
      });
      try { const result = await invoke(); assert.equal(intercepted, true); assert.equal(result.authorized, true); assert.equal(inbox.checked, false); }
      finally { spy.mock.restore(); }
    });
    for (const failure of ['ROLLBACK TO SAVEPOINT classpilot_heartbeat_inbox', 'RELEASE SAVEPOINT classpilot_heartbeat_inbox', 'commit'] as const) await t.test(`${failure} failure cannot return a committed result`, async () => {
      await reset(); await legacy(); const original = pg.Client.prototype.query; let faulted = false;
      const spy = t.mock.method(pg.Client.prototype, 'query', function(this: pg.Client, ...args: unknown[]) {
        const arg = args[0], text = typeof arg === 'string' ? arg : arg && typeof arg === 'object' && 'text' in arg ? String(arg.text) : '';
        if (failure.startsWith('ROLLBACK') && text.includes('from "messages"')) return Reflect.apply(original, this, ['SELECT 1/0']);
        if (!faulted && text.trim() === failure) { faulted = true; return Reflect.apply(original, this, ['SELECT 1/0']); }
        return Reflect.apply(original, this, args);
      });
      try { await assert.rejects(invoke()); assert.equal(faulted, true); }
      finally { spy.mock.restore(); }
    });
    await t.test('batch and exclusion bounds retain newest-first paging and reject stale/foreign exact bindings', async () => {
      await reset(); const ids: string[] = [];
      for (let i = 0; i < 55; i++) { const item = await legacy(); ids.push(item.id); await scoped(a.school.id, () => db.execute(sql`UPDATE messages SET timestamp=clock_timestamp()-(${55-i} * interval '1 second') WHERE id=${item.id}`)); }
      await invoke(); assert.equal(rows().length, 50); assert.equal(rows()[0]?.id, ids[54]);
      await invoke({ excludes: [...Array.from({ length: 500 }, () => randomUUID()), ids[54]!] }); assert.equal(rows()[0]?.id, ids[54]);
      await invoke({ excludes: [` ${ids[54]} `, ids[54]!] }); assert.notEqual(rows()[0]?.id, ids[54]);
      for (const exact of [{ ...binding, studentId: b.student.id }, { ...binding, studentSessionId: b.binding.id }, { ...binding, deviceId: b.deviceId }]) {
        assert.equal((await invoke({ exact })).authorized, false); assert.equal(inbox.checked, false);
      }
    });
    await t.test('message insertion during held foreground is seen by the later canonical inbox query', async () => {
      await reset(); const item = await command(false);
      let resume!: () => void, reached!: () => void;
      const hold = new Promise<void>(resolve => { resume = resolve; }), ready = new Promise<void>(resolve => { reached = resolve; });
      const operation = invoke({ publish: async () => { reached(); await hold; } });
      try { await waitUntilReady(ready); await item.insert(); resume(); await operation; assert.equal(rows()[0]?.commandId, item.id); }
      finally { resume(); await operation; }
    });
    await t.test('competing completed ACK waits for owned recovery, then prevents further delivery', async () => {
      await reset(); const item = await command();
      // First claim binds the formerly offline target, then its ACK races the
      // next heartbeat under the same canonical student advisory lock.
      await invoke();
      let resume!: () => void, reached!: () => void;
      const hold = new Promise<void>(resolve => { resume = resolve; }), ready = new Promise<void>(resolve => { reached = resolve; });
      const operation = invoke({ publish: async () => { reached(); await hold; } });
      let writer: Promise<unknown> | undefined;
      try {
        await waitUntilReady(ready); let writerReady!: (pid: number) => void;
        const pid = new Promise<number>(resolve => { writerReady = resolve; });
        writer = scoped(a.school.id, async () => {
          writerReady((await db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid);
          return storage.updateClasspilotCommandTargetAck({ commandId: item.id, schoolId: a.school.id,
            studentId: a.student.id, studentSessionId: a.binding.id, deviceId: a.deviceId, ackState: 'completed', result: { messageId: item.message!.id } });
        });
        await waitUntilBlocked(await pid); resume(); await operation; assert.equal(rows()[0]?.commandId, item.id); await writer;
        await invoke(); assert.equal(rows().length, 0);
      } finally { resume(); await Promise.allSettled([operation, ...(writer ? [writer] : [])]); }
    });
    await t.test('command deadline crossing actual foreground transport is excluded before HTTP', async () => {
      await reset(); const item = await command();
      await scoped(a.school.id, () => db.execute(sql`UPDATE classpilot_commands SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE id=${item.id}`));
      const result = await invoke({ publish: async () => { await db.execute(sql`SELECT pg_sleep(0.65)`); } });
      assert.equal(result.authorized, true); assert.equal(result.foreground.status, 'settled'); assert.equal(rows().length, 0);
    });
    for (const failure of ['final-fence', 'commit'] as const) await t.test(`actual claimed command rolls back on ${failure} failure`, async () => {
      await reset(); const item = await command(); const original = pg.Client.prototype.query;
      let claimWritten = false, faulted = false;
      const spy = t.mock.method(pg.Client.prototype, 'query', function(this: pg.Client, ...args: unknown[]) {
        const arg = args[0], text = typeof arg === 'string' ? arg : arg && typeof arg === 'object' && 'text' in arg ? String(arg.text) : '';
        if (text.startsWith('update "classpilot_command_targets"')) claimWritten = true;
        if (!faulted && claimWritten && (failure === 'commit' ? text.trim() === 'commit' : text.includes('AS entitled'))) {
          faulted = true; return Reflect.apply(original, this, ['SELECT 1/0']);
        }
        return Reflect.apply(original, this, args);
      });
      try { await assert.rejects(invoke()); assert.equal(claimWritten, true); assert.equal(faulted, true); }
      finally { spy.mock.restore(); }
      const result = await scoped(a.school.id, () => storage.getClasspilotCommandByIdAndSchool(item.id, a.school.id));
      assert.equal(result?.targets[0]?.status, 'unavailable');
      assert.equal(result?.targets[0]?.studentSessionId, null); assert.equal(result?.targets[0]?.deviceId, null);
    });
    await t.test('optional claim failure rolls back its actual target mutation and preserves durable required preparation', async () => {
      await reset(); const item = await command(); const original = pg.Client.prototype.query; let faulted = false;
      const spy = t.mock.method(pg.Client.prototype, 'query', function(this: pg.Client, ...args: unknown[]) {
        const arg = args[0], text = typeof arg === 'string' ? arg : arg && typeof arg === 'object' && 'text' in arg ? String(arg.text) : '';
        if (!faulted && text.startsWith('update "classpilot_command_targets"')) {
          faulted = true;
          return Reflect.apply(original, this, args).then(() => Reflect.apply(original, this, ['SELECT 1/0']));
        }
        return Reflect.apply(original, this, args);
      });
      try {
        const result = await scoped(a.school.id, () => storage.withClasspilotHeartbeatDeliveryAuthority(binding, async tx => {
          await tx.execute(sql`UPDATE students SET last_name='required-preparation-retained' WHERE id=${a.student.id}`);
          return true;
        }, (_claimed, value, outcome) => { inbox = outcome; return value; }, undefined, undefined, {}));
        assert.equal(result.authorized, true); assert.equal(inbox.checked, false); assert.equal(faulted, true);
      } finally { spy.mock.restore(); }
      const result = await scoped(a.school.id, () => storage.getClasspilotCommandByIdAndSchool(item.id, a.school.id));
      assert.equal(result?.targets[0]?.status, 'unavailable');
      assert.equal(result?.targets[0]?.studentSessionId, null); assert.equal(result?.targets[0]?.deviceId, null);
      const student = await scoped(a.school.id, () => storage.getStudentById(a.student.id));
      assert.equal(student?.lastName, 'required-preparation-retained');
    });
    await t.test('unavailable claim, failed ACK retry, completed ACK exclusion and announcement hard-off remain canonical', async () => {
      await reset(); const item = await command();
      await scoped(a.school.id, () => db.execute(sql`UPDATE settings SET private_chat_lifecycle_required=true,student_messaging_enabled=false WHERE school_id=${a.school.id}`));
      await legacy(); await invoke(); assert.deepEqual(rows().map(row => row.commandId), [item.id]);
      const target = await scoped(a.school.id, () => storage.getClasspilotCommandByIdAndSchool(item.id, a.school.id));
      assert.equal(target?.targets[0]?.studentSessionId, a.binding.id); assert.equal(target?.targets[0]?.deviceId, a.deviceId);
      const ack = { commandId: item.id, schoolId: a.school.id, studentId: a.student.id, studentSessionId: a.binding.id, deviceId: a.deviceId };
      await scoped(a.school.id, () => storage.updateClasspilotCommandTargetAck({ ...ack, ackState: 'failed', errorMessage: 'Synthetic retry' }));
      await invoke(); assert.equal(rows().length, 1);
      await scoped(a.school.id, () => storage.updateClasspilotCommandTargetAck({ ...ack, ackState: 'completed', result: { messageId: item.message!.id } }));
      await invoke(); assert.equal(rows().length, 0);
    });
  } finally {
    try {
      for (const schoolId of schools) await runWithTenantContext({ isSuper: true }, () => db.transaction(async tx => {
        for (const table of ["messages", "classpilot_command_targets", "classpilot_commands", "classpilot_session_summary_deliveries", "classpilot_monitoring_events", "classpilot_session_student_reports",
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
