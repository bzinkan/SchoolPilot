import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { sql } from "drizzle-orm";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";

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
    const createOpenCommand = (expiresAt = new Date(Date.now() + 15_000)) => storage.createClasspilotCommandWithTargets({
      schoolId: a.school.id, teacherId: a.teacher.id, teachingSessionId: a.session.id, supervisionContextId: null,
      targetScope: "students", commandType: "open-tab", commandPayload: { url: "https://example.invalid/synthetic" }, expiresAt },
    [{ commandId: "reserved", schoolId: a.school.id, teachingSessionId: a.session.id, studentId: a.student.id,
      studentSessionId: a.binding.id, deviceId: a.deviceId }],
    { authority: { schoolId: a.school.id, actorId: a.teacher.id, teachingSessionId: a.session.id } });

    await t.test("command creation rejects elapsed or future classes before the scheduler finalizes them", async () => {
      for (const window of ["scheduled_end", "hard_expiry", "future_start"] as const) await isolated(async () => {
        const now = Date.now();
        const start = new Date(now + (window === "future_start" ? 60_000 : window === "hard_expiry" ? -13 * 3600_000 : -60_000));
        const end = window === "scheduled_end" ? new Date(now - 1_000) : null;
        if (end) await db.execute(sql`UPDATE teaching_sessions SET start_time=${start.toISOString()},
          scheduled_date=${start.toISOString().slice(0, 10)},scheduled_timezone='UTC',scheduled_start_at=${start.toISOString()},
          scheduled_end_at=${end.toISOString()},scheduled_state='active' WHERE id=${a.session.id}`);
        else await db.execute(sql`UPDATE teaching_sessions SET start_time=${start.toISOString()} WHERE id=${a.session.id}`);
        assert.deepEqual(await storage.getActiveClassOwnersForStudents(a.school.id, [a.student.id], db, new Date()), [],
          "a clock-filtered owner projection must exclude the same inactive class");
        await assert.rejects(createOpenCommand(new Date(now + 15_000)),
        { code: "COMMAND_SESSION_STALE" }, window);
        const commands = await db.execute<{ count: number }>(sql`SELECT count(*)::int AS count FROM classpilot_commands WHERE teaching_session_id=${a.session.id}`);
        assert.equal(commands.rows[0]!.count, 0, "an invalid class must never record or dispatch a command");
      });
    });

    await t.test("current classes retain earlier delivery deadlines and cap commands at the class lifetime", async () => {
      await isolated(async () => {
        const expiresAt = new Date(Date.now() + 15_000);
        const command = await createOpenCommand(expiresAt);
        assert.equal(command.targets[0]!.status, "requested");
        assert.equal(command.expiresAt!.getTime(), expiresAt.getTime());
      });
      await isolated(async () => {
        const command = await createOpenCommand(new Date(Date.now() + 24 * 3600_000));
        assert.equal(command.expiresAt!.getTime(), a.session.startTime.getTime() + 12 * 3600_000);
      });
      await isolated(async () => {
        const end = new Date(Date.now() + 60_000);
        await db.execute(sql`UPDATE teaching_sessions SET scheduled_date=${a.session.startTime.toISOString().slice(0, 10)},
          scheduled_timezone='UTC',scheduled_start_at=${a.session.startTime.toISOString()},scheduled_end_at=${end.toISOString()},
          scheduled_state='active' WHERE id=${a.session.id}`);
        const command = await createOpenCommand(new Date(Date.now() + 3600_000));
        assert.equal(command.expiresAt!.getTime(), end.getTime());
      });
    });

    await t.test("ordinary command frames use the committed class deadline", () => isolated(async () => {
      const dispatcher = await import("../src/services/classpilotCommandDispatcher.js");
      const broadcast = await import("../src/realtime/ws-broadcast.js");
      const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      await once(wss, "listening");
      const address = wss.address(); assert.ok(address && typeof address !== "string");
      const accepted = once(wss, "connection");
      const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
      const frames: Array<{ type: string; commandId?: string; expiresAt?: string; command?: { expiresAt?: string } }> = [];
      client.on("message", data => frames.push(JSON.parse(data.toString())));
      await once(client, "open");
      const [server] = await accepted;
      broadcast.registerWsClient(server);
      broadcast.authenticateWsClient(server, { schoolId: a.school.id, studentId: a.student.id,
        studentSessionId: a.binding.id, deviceId: a.deviceId, role: "student", acceptedCapabilities: [] });
      try {
        const end = new Date(Date.now() + 10_000);
        await db.execute(sql`UPDATE teaching_sessions SET scheduled_date=${a.session.startTime.toISOString().slice(0, 10)},
          scheduled_timezone='UTC',scheduled_start_at=${a.session.startTime.toISOString()},scheduled_end_at=${end.toISOString()},
          scheduled_state='active' WHERE id=${a.session.id}`);
        const result = await dispatcher.executeClasspilotCommand({ schoolId: a.school.id, actorId: a.teacher.id,
          teachingSessionId: a.session.id, targetScope: "students", commandType: "close-tabs", rawCommandPayload: { closeAll: true },
          targets: [{ studentId: a.student.id, studentName: "Synthetic student", studentSessionId: a.binding.id,
            deviceId: a.deviceId, available: true, stateAuthorized: true }] });
        const deadline = Date.now() + 2_000;
        while (!frames.some(frame => frame.commandId === result.command.id) && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        const frame = frames.find(value => value.type === "remote-control" && value.commandId === result.command.id);
        assert.ok(frame, "a fake exact-bound socket must receive the ordinary command");
        assert.equal(frame.expiresAt, end.toISOString());
        assert.equal(frame.command?.expiresAt, end.toISOString());
        assert.equal(result.command.expiresAt?.getTime(), end.getTime());
      } finally { client.terminate(); server.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); }
    }));

    type CommandFixture = Awaited<ReturnType<typeof createFixture>>;
    // Session-ending writers own their transaction, so each case uses its own
    // real fixture rather than relying on the projection-only rollback helper.
    const signOutCase = (callback: (row: CommandFixture) => Promise<void>) => async () => {
      const row = await createFixture();
      await scoped(row.school.id, () => callback(row));
    };
    const fixtureBinding = (row: CommandFixture) => ({ schoolId: row.school.id, studentId: row.student.id,
      studentSessionId: row.binding.id, deviceId: row.deviceId });
    const createTrackedCommand = (row: CommandFixture, commandType = "student-sign-out") => storage.createClasspilotCommandWithTargets({
      schoolId: row.school.id, teacherId: row.teacher.id, teachingSessionId: row.session.id, supervisionContextId: null,
      targetScope: "students", commandType, commandPayload: {}, requestedCount: 1 },
    [{ commandId: "reserved", schoolId: row.school.id, teachingSessionId: row.session.id, studentId: row.student.id,
      studentSessionId: row.binding.id, deviceId: row.deviceId }],
    { authority: { schoolId: row.school.id, actorId: row.teacher.id, teachingSessionId: row.session.id } });
    const signOutCompletion = (row: CommandFixture, commandId: string) => ({ commandId, schoolId: row.school.id,
      endedBindings: [{ studentId: row.student.id, studentSessionId: row.binding.id, deviceId: row.deviceId }] });
    await t.test("device completed sign-out is only a transport receipt until the exact server binding ends", signOutCase(async row => {
      const exact = fixtureBinding(row), command = await createTrackedCommand(row);
      const first = await storage.persistClasspilotCommandTargetAck({ ...exact, commandId: command.id,
        ackState: "completed", result: { serverAuthoritative: true } });
      assert.equal(first.disposition, "applied");
      await storage.updateClasspilotCommandSummary(command.id);
      const receipt = await storage.getClasspilotCommandByIdAndSchool(command.id, row.school.id);
      assert.equal(receipt!.status, "received");
      assert.equal(receipt!.completedCount, 0);
      assert.equal(receipt!.targets[0]!.status, "received");
      assert.equal(receipt!.targets[0]!.ackState, "received");
      assert.ok(receipt!.targets[0]!.receivedAt);
      assert.equal(receipt!.targets[0]!.completedAt, null);
      assert.equal(Reflect.get(receipt!.targets[0]!.result!, "serverAuthoritative"), undefined);
      assert.equal((await storage.getActiveSessionByStudent(row.student.id))!.id, row.binding.id);
      assert.equal((await storage.persistClasspilotCommandTargetAck({ ...exact, commandId: command.id, ackState: "completed" })).disposition, "idempotent");
      assert.deepEqual(await storage.markClasspilotCommandTargetsServerCompleted(signOutCompletion(row, command.id)), []);
    }));
    await t.test("generic device completed ACKs still complete their exact command", signOutCase(async row => {
      const command = await createTrackedCommand(row, "open-tab");
      assert.equal((await storage.persistClasspilotCommandTargetAck({ ...fixtureBinding(row), commandId: command.id,
        ackState: "completed" })).disposition, "applied");
      await storage.updateClasspilotCommandSummary(command.id);
      const completed = await storage.getClasspilotCommandByIdAndSchool(command.id, row.school.id);
      assert.equal(completed!.targets[0]!.status, "completed");
      assert.equal(completed!.completedCount, 1);
    }));
    await t.test("sign-out follow-up verifies a binding honestly ended before its own exact end", signOutCase(async row => {
      const dispatcher = await import("../src/services/classpilotCommandDispatcher.js");
      const original = pg.Client.prototype.query;
      let intercepted = false;
      const mock = t.mock.method(pg.Client.prototype, "query", function(this: pg.Client, ...args: unknown[]) {
        const argument = args[0];
        const text = typeof argument === "string" ? argument : argument && typeof argument === "object" && "text" in argument ? String(argument.text) : "";
        const result = Reflect.apply(original, this, args);
        if (!intercepted && text.startsWith('update "classpilot_command_targets" set "status" = case') && text.includes('"sent_at"')) {
          intercepted = true;
          return Promise.resolve(result).then(async value => {
            assert.ok(await storage.endStudentSessionExact(fixtureBinding(row)), "the device's own exact server sign-out wins first");
            return value;
          });
        }
        return result;
      });
      try {
        const result = await dispatcher.executeClasspilotCommand({ schoolId: row.school.id, actorId: row.teacher.id,
          teachingSessionId: row.session.id, targetScope: "students", commandType: "student-sign-out", rawCommandPayload: {},
          targets: [{ studentId: row.student.id, studentName: "Synthetic student", studentSessionId: row.binding.id,
            deviceId: row.deviceId, available: true, stateAuthorized: true }] });
        assert.equal(intercepted, true, "the deterministic device sign-out must precede the dispatcher follow-up");
        assert.equal(result.command.targets[0]!.status, "completed");
        assert.equal(Reflect.get(result.command.targets[0]!.result!, "serverAuthoritative"), true);
        assert.equal(result.summary.completed, 1);
        assert.equal(await storage.endStudentSessionExact(fixtureBinding(row)), undefined, "the exact binding must already be ended");
      } finally { mock.mock.restore(); }
    }));
    for (const ackState of ["failed", "expired"] as const) await t.test(
      `verified server sign-out completes after an earlier ${ackState} device ACK`, signOutCase(async row => {
        const exact = fixtureBinding(row), command = await createTrackedCommand(row);
        if (ackState === "expired") await db.execute(sql`UPDATE classpilot_commands SET expires_at=clock_timestamp()-interval '1 millisecond' WHERE id=${command.id}`);
        const ack = await storage.persistClasspilotCommandTargetAck({ ...exact, commandId: command.id, ackState,
          result: { serverAuthoritative: true }, errorMessage: "Command belongs to an inactive teaching session" });
        assert.equal(ack.disposition, "applied");
        await storage.updateClasspilotCommandSummary(command.id);
        const deviceOutcome = await storage.getClasspilotCommandByIdAndSchool(command.id, row.school.id);
        assert.equal(Reflect.get(deviceOutcome!.targets[0]!.result!, "serverAuthoritative"), undefined,
          "a device ACK must not invent server completion proof");
        if (ackState === "failed") assert.equal(deviceOutcome!.failedCount, 1);
        assert.ok(await storage.endStudentSessionExact({ ...exact,
          teachingClassroom: { teachingSessionId: row.session.id, actorId: row.teacher.id } }), "the real exact server transition must succeed");
        const updated = await storage.markClasspilotCommandTargetsServerCompleted(signOutCompletion(row, command.id));
        assert.equal(updated.length, 1);
        const completed = await storage.getClasspilotCommandByIdAndSchool(command.id, row.school.id);
        assert.ok(completed);
        assert.equal(completed.status, "completed");
        assert.equal(completed.completedCount, 1);
        assert.equal(completed.failedCount, 0, "the persisted header must not retain the superseded device failure");
        assert.equal(completed.targets[0]!.status, "completed");
        assert.equal(completed.targets[0]!.ackState, ackState, "keep the device ACK history distinct from the server outcome");
        assert.ok(completed.targets[0]!.completedAt);
        assert.equal(completed.targets[0]!.errorMessage, null);
        assert.equal(Reflect.get(completed.targets[0]!.result!, "serverAuthoritative"), true);
        const late = await storage.persistClasspilotCommandTargetAck({ ...exact, commandId: command.id, ackState: "failed", result: { serverAuthoritative: false } });
        assert.equal(late.disposition, "terminal_rejected");
        const afterLate = await storage.getClasspilotCommandByIdAndSchool(command.id, row.school.id);
        assert.equal(afterLate!.targets[0]!.status, "completed");
        assert.equal(Reflect.get(afterLate!.targets[0]!.result!, "serverAuthoritative"), true);
      })
    );
    await t.test("server sign-out completion remains successful when it precedes the device failure", signOutCase(async row => {
      const exact = fixtureBinding(row), command = await createTrackedCommand(row);
      assert.ok(await storage.endStudentSessionExact({ ...exact,
        teachingClassroom: { teachingSessionId: row.session.id, actorId: row.teacher.id } }));
      assert.equal((await storage.markClasspilotCommandTargetsServerCompleted(signOutCompletion(row, command.id))).length, 1);
      const late = await storage.persistClasspilotCommandTargetAck({ ...exact, commandId: command.id, ackState: "failed" });
      assert.equal(late.disposition, "terminal_rejected");
      const completed = await storage.getClasspilotCommandByIdAndSchool(command.id, row.school.id);
      assert.equal(completed!.targets[0]!.status, "completed");
      assert.equal(completed!.failedCount, 0);
    }));
    for (const kind of ["scalar", "array"] as const) await t.test(
      `server sign-out preserves ${kind} device outcomes beneath its object completion proof`, signOutCase(async row => {
        const exact = fixtureBinding(row), command = await createTrackedCommand(row);
        const result = kind === "scalar" ? "Synthetic device failure" : [{ serverAuthoritative: true }, "Synthetic device failure"];
        assert.equal((await storage.persistClasspilotCommandTargetAck({ ...exact, commandId: command.id, ackState: "failed", result })).disposition, "applied");
        assert.ok(await storage.endStudentSessionExact({ ...exact,
          teachingClassroom: { teachingSessionId: row.session.id, actorId: row.teacher.id } }));
        assert.equal((await storage.markClasspilotCommandTargetsServerCompleted(signOutCompletion(row, command.id))).length, 1);
        const completed = await storage.getClasspilotCommandByIdAndSchool(command.id, row.school.id);
        assert.equal(completed!.targets[0]!.status, "completed");
        assert.equal(Reflect.get(completed!.targets[0]!.result!, "serverAuthoritative"), true);
        assert.deepEqual(Reflect.get(completed!.targets[0]!.result!, "ackResult"), result);
      })
    );
    await t.test("server completion cannot replace a generic command failure or its terminal ACK", signOutCase(async row => {
      const exact = fixtureBinding(row), command = await createTrackedCommand(row, "open-tab");
      assert.equal((await storage.persistClasspilotCommandTargetAck({ ...exact, commandId: command.id, ackState: "failed" })).disposition, "applied");
      assert.equal((await storage.persistClasspilotCommandTargetAck({ ...exact, commandId: command.id, ackState: "completed" })).disposition, "terminal_rejected");
      assert.ok(await storage.endStudentSessionExact(exact));
      assert.deepEqual(await storage.markClasspilotCommandTargetsServerCompleted(signOutCompletion(row, command.id)), []);
      const failed = await storage.getClasspilotCommandByIdAndSchool(command.id, row.school.id);
      assert.equal(failed!.targets[0]!.status, "failed");
      assert.equal(failed!.failedCount, 1);
    }));
    await t.test("device outcome fields cannot overwrite stored server completion proof", signOutCase(async row => {
      const command = await createTrackedCommand(row);
      // Seed the server-only field to exercise its sanitizer independently of
      // the normal post-sign-out active-binding rejection.
      await db.execute(sql`UPDATE classpilot_command_targets SET result='{"serverAuthoritative":true}'::jsonb WHERE command_id=${command.id}`);
      const ack = await storage.persistClasspilotCommandTargetAck({ ...fixtureBinding(row), commandId: command.id,
        ackState: "received", result: { serverAuthoritative: false, syntheticOutcome: true } });
      assert.equal(ack.disposition, "applied");
      const stored = await storage.getClasspilotCommandByIdAndSchool(command.id, row.school.id);
      assert.equal(Reflect.get(stored!.targets[0]!.result!, "serverAuthoritative"), true);
      assert.equal(Reflect.get(stored!.targets[0]!.result!, "syntheticOutcome"), true);
    }));
    await t.test("teaching sign-out refuses an exact binding handed to a replacement class", signOutCase(async row => {
      await createTrackedCommand(row);
      const replacementGroup = await storage.createGroup({ schoolId: row.school.id, teacherId: row.teacher.id,
        name: `${tag}_replacement`, groupType: "teacher_created" });
      await storage.addGroupStudentsDetailed(replacementGroup.id, [row.student.id]);
      const replacement = await storage.createTeachingSession({ groupId: replacementGroup.id, teacherId: row.teacher.id,
        startTime: new Date() });
      assert.equal((await storage.getClasspilotStudentControlState(row.school.id, row.student.id))!.teachingSessionId, replacement.id);
      assert.equal((await storage.getActiveSessionByStudent(row.student.id))!.id, row.binding.id,
        "class handoff must retain the exact authenticated binding");
      const ended = await storage.endStudentSessionExact({ ...fixtureBinding(row),
        teachingClassroom: { teachingSessionId: row.session.id, actorId: row.teacher.id } });
      assert.equal(ended, undefined, "the previous classroom cannot sign out the replacement classroom's current binding");
      assert.equal((await storage.getActiveSessionByStudent(row.student.id))!.id, row.binding.id);
    }));
    for (const mismatch of ["active", "school", "student", "session", "device", "prior_end"] as const) await t.test(
      `server sign-out completion refuses an unverified ${mismatch} binding`, signOutCase(async row => {
        const exact = fixtureBinding(row), command = await createTrackedCommand(row);
        assert.equal((await storage.persistClasspilotCommandTargetAck({ ...exact, commandId: command.id, ackState: "failed" })).disposition, "applied");
        if (mismatch !== "active") assert.ok(await storage.endStudentSessionExact(exact));
        const proof = signOutCompletion(row, command.id);
        if (mismatch === "school") proof.schoolId = b.school.id;
        if (mismatch === "student") proof.endedBindings[0]!.studentId = b.student.id;
        if (mismatch === "session") proof.endedBindings[0]!.studentSessionId = b.binding.id;
        if (mismatch === "device") proof.endedBindings[0]!.deviceId = b.deviceId;
        if (mismatch === "prior_end") await db.execute(sql`UPDATE student_sessions SET ended_at=${new Date(command.createdAt.getTime() - 1_000).toISOString()}
          WHERE id=${row.binding.id}`);
        assert.deepEqual(await storage.markClasspilotCommandTargetsServerCompleted(proof), []);
        const failed = await storage.getClasspilotCommandByIdAndSchool(command.id, row.school.id);
        assert.equal(failed!.targets[0]!.status, "failed");
        assert.equal(failed!.failedCount, 1);
      })
    );

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
