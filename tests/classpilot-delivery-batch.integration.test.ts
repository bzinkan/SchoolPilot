import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { before, after, test } from "node:test";
import { sql } from "drizzle-orm";
import pg from "pg";
import { getDatabaseErrorDetails } from "../src/util/databaseError.js";

process.env.RLS_GUC_ENABLED = "true";
process.env.SCHEDULER_ENABLED = "false";
process.env.REDIS_URL = "";

const schoolId = randomUUID();
const students = Array.from({ length: 41 }, () => randomUUID());
const bindings = students.map(studentId => ({ schoolId, studentId, studentSessionId: randomUUID(), deviceId: randomUUID() }));
let admin: pg.Pool;
let storage: typeof import("../src/services/storage.js");
let tenant: typeof import("../src/middleware/tenantContext.js");
const inSchool = <T>(work: () => Promise<T>) => tenant.runWithTenantContext({ schoolId }, work);
const lockKey = (studentId: string) => `classpilot:student-control:${schoolId}:${studentId}`;

before(async () => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(process.env.DATABASE_URL || "").hostname), "only a local fixture is permitted");
  admin = new pg.Pool({ connectionString: process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL, max: 2 });
  storage = await import("../src/services/storage.js");
  tenant = await import("../src/middleware/tenantContext.js");
  await admin.query("INSERT INTO schools(id,name,domain,status,plan_status) VALUES($1,'Synthetic delivery batch',$2,'active','active')", [schoolId, `${schoolId}.example.edu`]);
  await admin.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')", [schoolId]);
  for (const binding of bindings) {
    await admin.query("INSERT INTO students(id,school_id,first_name,last_name,status) VALUES($1,$2,'Synthetic','Batch','active')", [binding.studentId, schoolId]);
    await admin.query("INSERT INTO devices(device_id,school_id,class_id) VALUES($1,$2,'synthetic')", [binding.deviceId, schoolId]);
    if (binding === bindings[0]) {
      await admin.query("INSERT INTO student_sessions(id,student_id,device_id,auth_kind,manual_lease_expires_at,session_recovery_token_hash) VALUES($1,$2,$3,'manual_shared',clock_timestamp()+interval '5 minutes',$4)",
        [binding.studentSessionId, binding.studentId, binding.deviceId, randomBytes(32).toString("hex")]);
    } else await admin.query("INSERT INTO student_sessions(id,student_id,device_id,auth_kind) VALUES($1,$2,$3,'managed_profile')", [binding.studentSessionId, binding.studentId, binding.deviceId]);
  }
});

after(async () => {
  if (admin) {
    for (const table of ["classpilot_command_targets", "classpilot_commands", "classpilot_student_control_states", "classpilot_supervision_students", "classpilot_supervision_contexts"]) {
      await admin.query(`DELETE FROM ${table} WHERE school_id=$1`, [schoolId]);
    }
    await admin.query("DELETE FROM student_sessions WHERE student_id=ANY($1::text[])", [students]);
    await admin.query("DELETE FROM devices WHERE school_id=$1", [schoolId]);
    await admin.query("DELETE FROM students WHERE school_id=$1", [schoolId]);
    await admin.query("DELETE FROM product_licenses WHERE school_id=$1", [schoolId]);
    await admin.query("DELETE FROM school_memberships WHERE school_id=$1", [schoolId]);
    // Real lifecycle guards retain staff identities and their school roots.
    // These roots are synthetic and live only in the disposable local fixture.
    await admin.end();
  }
  const { pool, sessionPool } = await import("../src/db.js");
  await (await import("../src/services/errorMonitor.js")).default.disposeAndWait();
  await (await import("../src/realtime/ws-redis.js")).disposeWSRedis();
  await Promise.all([pool.end(), sessionPool.end()]);
});

test("41 deliveries use sequential savepoints in two owned cohorts and retain every cohort lock until all sends", { timeout: 20_000 }, async () => {
  const notices: string[] = [];
  const transactionIds: string[] = [];
  const sent: string[] = [];
  const batchReadSizes: number[] = [];
  await inSchool(async () => {
    const store = tenant.getOwnedTenantStore(); assert.ok(store);
    const onNotice = (notice: { code?: string }) => notices.push(notice.code || "");
    const originalQuery = store.client.query;
    store.client.query = function (this: pg.PoolClient, ...args: unknown[]) {
      const query = args[0] as string | { text?: string; values?: unknown[] };
      const text = typeof query === "string" ? query : query.text || "";
      if (text.includes("classpilot_delivery_batch_bindings")) {
        const values = (typeof query === "string" ? args[1] : query.values ?? args[1]) as unknown[];
        const fixtureStudents = new Set<string>(students);
        batchReadSizes.push(values.filter(value => fixtureStudents.has(String(value))).length);
      }
      return Reflect.apply(originalQuery, this, args);
    } as typeof store.client.query;
    store.client.on("notice", onNotice);
    try {
      const outcomes = await storage.withClasspilotStudentControlDeliveryBatch(schoolId, bindings,
        binding => binding.studentId, binding => storage.withClasspilotStudentControlDeliveryAuthority(binding,
          async database => {
            const id = await database.execute<{ id: string }>(sql`SELECT txid_current()::text AS id`);
            transactionIds.push(id.rows[0]!.id);
            const cohort = bindings.indexOf(binding) < 40 ? bindings.slice(0, 40) : bindings.slice(40);
            for (const candidate of [cohort[0]!, cohort[cohort.length - 1]!]) {
              const probe = await admin.query<{ acquired: boolean }>(
                "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0::bigint)) AS acquired", [lockKey(candidate.studentId)]);
              assert.equal(probe.rows[0]!.acquired, false, "an earlier target cannot release a later target's cohort lock");
            }
            return binding.studentId;
          }, (_claimed, id) => { sent.push(id); return id; }));
      assert.ok(outcomes.every(outcome => outcome.authorized));
    } finally { store.client.off("notice", onNotice); store.client.query = originalQuery; }
  });
  assert.deepEqual(sent, students);
  assert.equal(new Set(transactionIds.slice(0, 40)).size, 1);
  assert.notEqual(transactionIds[39], transactionIds[40]);
  assert.deepEqual(notices.filter(code => code === "25001" || code === "25P01"), []);
  assert.deepEqual(batchReadSizes, [40, 1], "each cohort performs exactly one initial joined binding read");
});

test("a mismatched exact target stays unavailable without broadening or skipping other targets", async () => {
  const first = bindings[0]!, second = bindings[1]!;
  const chosen = [first, { ...second, studentSessionId: randomUUID() }, bindings[2]!];
  const sent: string[] = [];
  const outcomes = await inSchool(() => storage.withClasspilotStudentControlDeliveryBatch(schoolId, chosen,
    binding => binding.studentId, binding => storage.withClasspilotStudentControlDeliveryAuthority(binding,
      async () => binding.studentId, (_claimed, id) => { sent.push(id); return id; })));
  assert.deepEqual(outcomes.map(outcome => outcome.authorized), [true, false, true]);
  assert.deepEqual(sent, [first.studentId, bindings[2]!.studentId]);
});

test("concurrent command delivery cohorts retain separate request transactions and sort overlapping reverse-order targets", { timeout: 20_000 }, async () => {
  const ascending = bindings.slice(1, 7).sort((left, right) => left.studentId.localeCompare(right.studentId));
  const descending = [...ascending].reverse();
  const blocker = await admin.connect();
  const requestPids = new Map<string, number>();
  const transactionIds = new Map<string, string[]>();
  const events: string[] = [];
  const notices: string[] = [];
  let first: Promise<void> | undefined, second: Promise<void> | undefined;
  let released = false;
  await blocker.query("BEGIN");
  const blockerPid = (await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
  await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0::bigint))", [lockKey(ascending[0]!.studentId)]);
  const dispatch = (command: string, targets: typeof ascending) => inSchool(async () => {
    const store = tenant.getOwnedTenantStore(); assert.ok(store);
    const onNotice = (notice: { code?: string }) => notices.push(notice.code || "");
    store.client.on("notice", onNotice);
    try {
      const identity = await store.db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      requestPids.set(command, identity.rows[0]!.pid);
      const ids: string[] = []; transactionIds.set(command, ids);
      const outcomes = await storage.withClasspilotStudentControlDeliveryBatch(schoolId, targets,
        binding => binding.studentId, binding => storage.withClasspilotStudentControlDeliveryAuthority(binding, async database => {
          const row = (await database.execute<{ pid: number; transaction: string }>(sql`SELECT pg_backend_pid() AS pid, txid_current()::text AS transaction`)).rows[0]!;
          assert.equal(row.pid, requestPids.get(command), "all cohort preparation stays on its request-owned client");
          ids.push(row.transaction);
          return `${command}:${binding.studentId}`;
        }, (_claimed, prepared) => { events.push(prepared); return prepared; }));
      assert.ok(outcomes.every(outcome => outcome.authorized));
    } finally { store.client.off("notice", onNotice); }
  });
  const waitBlocked = async (command: string) => {
    const deadline = performance.now() + 3_000;
    while (performance.now() < deadline) {
      const pid = requestPids.get(command);
      if (pid !== undefined) {
        const row = (await admin.query<{ blockers: number[] }>("SELECT pg_blocking_pids($1) AS blockers", [pid])).rows[0]!;
        if (row.blockers.includes(blockerPid)) return;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(`${command} did not reach the deterministic shared authority-lock barrier`);
  };
  try {
    first = dispatch("command-a", ascending); first.catch(() => {});
    await waitBlocked("command-a");
    second = dispatch("command-b", descending); second.catch(() => {});
    await waitBlocked("command-b");
    assert.notEqual(requestPids.get("command-a"), requestPids.get("command-b"), "independent requests cannot share a leased client");
    assert.deepEqual(events, [], "no send precedes acquisition of its complete cohort authority");
    const laterLock = (await admin.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0::bigint)) AS acquired", [lockKey(ascending[ascending.length - 1]!.studentId)])).rows[0]!;
    assert.equal(laterLock.acquired, true, "reverse input must wait on the same first sorted lock instead of holding a later lock");
    await blocker.query("ROLLBACK"); released = true;
    await Promise.all([first, second]);
    assert.deepEqual(events, [
      ...ascending.map(binding => `command-a:${binding.studentId}`),
      ...descending.map(binding => `command-b:${binding.studentId}`),
    ], "each command delivers every exact target once, with no interleaved or lost cohort send");
    assert.equal(new Set(transactionIds.get("command-a")).size, 1);
    assert.equal(new Set(transactionIds.get("command-b")).size, 1);
    assert.notEqual(transactionIds.get("command-a")![0], transactionIds.get("command-b")![0]);
    assert.deepEqual(notices.filter(code => code === "25001" || code === "25P01"), []);
  } finally {
    if (!released) await blocker.query("ROLLBACK");
    blocker.release();
    await Promise.allSettled([first, second].filter((request): request is Promise<void> => request !== undefined));
  }
});

for (const acknowledgement of ["command", "control-state"] as const) test(`forty-target sent bookkeeping and an exact relay do not deadlock a concurrent ${acknowledgement} ACK`, { timeout: 15_000 }, async () => {
  const chosen = bindings.slice(1, 41), first = chosen[0]!, acknowledged = chosen[1]!;
  const actorId = randomUUID(), contextId = randomUUID(), commandId = randomUUID();
  await admin.query("INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'Synthetic','ACK race')", [actorId, `${actorId}@${schoolId}.example.edu`]);
  await admin.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,'teacher','active')", [schoolId, actorId]);
  await admin.query("INSERT INTO classpilot_supervision_contexts(id,school_id,context_type,name,assigned_staff_id,created_by,starts_at,ends_at) VALUES($1,$2,'other','Synthetic ACK race',$3,$3,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour')", [contextId, schoolId, actorId]);
  for (const binding of chosen) await admin.query("INSERT INTO classpilot_supervision_students(school_id,context_id,student_id,assigned_by) VALUES($1,$2,$3,$4)", [schoolId, contextId, binding.studentId, actorId]);
  await inSchool(() => storage.initializeClasspilotSupervisionControlStates({ schoolId, supervisionContextId: contextId, studentIds: chosen.map(binding => binding.studentId) }));
  await admin.query("INSERT INTO classpilot_commands(id,school_id,supervision_context_id,teacher_id,target_scope,command_type,requested_count,expires_at) VALUES($1,$2,$3,$4,'context',$5,40,clock_timestamp()+interval '5 minutes')", [commandId, schoolId, contextId, actorId, acknowledgement === "command" ? "open-tab" : "lock-screen"]);
  for (const binding of chosen) await admin.query("INSERT INTO classpilot_command_targets(command_id,school_id,supervision_context_id,student_id,student_session_id,device_id) VALUES($1,$2,$3,$4,$5,$6)", [commandId, schoolId, contextId, binding.studentId, binding.studentSessionId, binding.deviceId]);
  const controlStates = acknowledgement === "control-state"
    ? await inSchool(() => storage.replaceClasspilotSupervisionControlSnapshots({ schoolId, supervisionContextId: contextId,
      studentIds: chosen.map(binding => binding.studentId), sourceCommandId: commandId, desiredState: { restrictions: {} }, forceRevision: true }))
    : [];
  const controlRevision = controlStates.find(state => state.studentId === acknowledged.studentId)?.revision;

  let releaseSent!: () => void, sentLocked!: () => void;
  const continueSent = new Promise<void>(resolve => { releaseSent = resolve; });
  const firstTargetLocked = new Promise<void>(resolve => { sentLocked = resolve; });
  const pids = new Map<string, number>();
  const errors: string[] = [];
  const observe = <T>(work: Promise<T>) => work.catch(error => {
    errors.push(getDatabaseErrorDetails(error).code || "UNKNOWN");
    return undefined;
  });
  const identify = async (name: string) => {
    const store = tenant.getOwnedTenantStore(); assert.ok(store);
    const result = await store.client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    pids.set(name, result.rows[0]!.pid);
    return store;
  };
  const waitFor = async (predicate: () => Promise<boolean>, message: string) => {
    const deadline = performance.now() + 3_000;
    while (performance.now() < deadline) {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(message);
  };
  const blockedBy = async (name: string, blocker: string) => {
    const pid = pids.get(name), blockerPid = pids.get(blocker);
    if (pid === undefined || blockerPid === undefined) return false;
    const row = (await admin.query<{ blockers: number[] }>("SELECT pg_blocking_pids($1) AS blockers", [pid])).rows[0]!;
    return row.blockers.includes(blockerPid);
  };
  let sent: Promise<unknown> | undefined, relay: Promise<unknown> | undefined, ack: Promise<unknown> | undefined;
  let ackSettled = false;
  try {
    sent = observe(inSchool(async () => {
      const store = await identify("sent"), originalQuery = store.client.query;
      // Pause a native bulk update after its first target lock. Commit that
      // statement's locks before the native summary query, exactly as its
      // ordinary autocommit path does; retaining them would invent a cycle.
      await store.client.query("BEGIN");
      await store.client.query("SELECT id FROM classpilot_command_targets WHERE command_id=$1 AND student_id=$2 FOR UPDATE", [commandId, first.studentId]);
      store.client.query = function (this: pg.PoolClient, ...args: unknown[]) {
        const query = args[0] as string | { text?: string };
        const text = typeof query === "string" ? query : query.text || "";
        const result = Reflect.apply(originalQuery, this, args);
        if (!text.startsWith('update "classpilot_command_targets"')) return result;
        return Promise.resolve(result).then(async value => {
          await Reflect.apply(originalQuery, this, ["COMMIT"]);
          return value;
        });
      } as typeof store.client.query;
      sentLocked();
      try {
        await continueSent;
        return await storage.markClasspilotCommandTargetsSent(commandId, chosen.map(binding => binding.deviceId));
      } finally {
        store.client.query = originalQuery;
        await store.client.query("ROLLBACK");
      }
    }));
    await Promise.race([
      firstTargetLocked,
      sent.then(() => { throw new Error("Sent writer ended before its first target barrier"); }),
    ]);
    relay = observe(inSchool(async () => {
      await identify("relay");
      return storage.withClasspilotStudentControlDeliveryAuthority(first,
        database => storage.classpilotStudentRelayMessageAllowed(first, {
          commandId, authority: { teachingSessionId: null, supervisionContextId: contextId },
        }, database), (_claimed, allowed) => allowed);
    }));
    await waitFor(() => blockedBy("relay", "sent"), "exact relay must reach the first target's native row-lock barrier");
    ack = observe(inSchool(async () => {
      await identify("ack");
      if (acknowledgement === "command") {
        return storage.persistClasspilotCommandTargetAck({ ...acknowledged, commandId, ackState: "completed", result: { ok: true } });
      }
      assert.ok(controlRevision !== undefined);
      return storage.acknowledgeClasspilotStudentControlState({ ...acknowledged, appliedRevision: controlRevision, outcome: "applied" });
    }).finally(() => { ackSettled = true; }));
    // Original code holds this target while waiting for the relay's shared
    // header lock. Correct target-only locking lets this ACK settle directly.
    await waitFor(async () => ackSettled || await blockedBy("ack", "relay"), "ACK must either settle or reach the shared-header barrier");
    releaseSent();
    const [, relayOutcome, ackOutcome] = await Promise.all([sent, relay, ack]);
    assert.deepEqual(errors, [], "native ACK, relay and bulk sent update must settle without SQLSTATE failures");
    assert.ok(relayOutcome && typeof relayOutcome === "object" && "authorized" in relayOutcome && "value" in relayOutcome);
    assert.equal(relayOutcome.authorized, true);
    assert.ok(relayOutcome.value && typeof relayOutcome.value === "object" && "expiresAt" in relayOutcome.value);
    assert.ok(typeof relayOutcome.value.expiresAt === "number" && Number.isFinite(relayOutcome.value.expiresAt));
    assert.ok(ackOutcome && typeof ackOutcome === "object");
    if (acknowledgement === "command") {
      assert.ok("disposition" in ackOutcome);
      assert.equal(ackOutcome.disposition, "applied");
    } else {
      assert.ok("appliedRevision" in ackOutcome && "enforcementHealth" in ackOutcome && "sourceCommandId" in ackOutcome);
      assert.equal(ackOutcome.appliedRevision, controlRevision);
      assert.equal(ackOutcome.enforcementHealth, "synced");
      assert.equal(ackOutcome.sourceCommandId, commandId);
    }
    const command = await inSchool(() => storage.getClasspilotCommandByIdAndSchool(commandId, schoolId));
    assert.equal(command?.requestedCount, 40);
    assert.equal(command?.sentCount, 40);
    assert.equal(command?.completedCount, 1);
    const completed = command?.targets.find(target => target.studentId === acknowledged.studentId);
    assert.equal(completed?.status, "completed", "late sent bookkeeping cannot regress a terminal ACK");
    assert.equal(completed?.ackState, "completed");
    assert.ok(completed?.receivedAt && completed.completedAt && completed.sentAt);
  } finally {
    releaseSent();
    await Promise.allSettled([sent, relay, ack].filter((work): work is Promise<unknown> => work !== undefined));
    await admin.query("DELETE FROM classpilot_command_targets WHERE command_id=$1", [commandId]);
    await admin.query("DELETE FROM classpilot_commands WHERE id=$1", [commandId]);
    await admin.query("DELETE FROM classpilot_student_control_states WHERE supervision_context_id=$1", [contextId]);
    await admin.query("DELETE FROM classpilot_supervision_students WHERE context_id=$1", [contextId]);
    await admin.query("DELETE FROM classpilot_supervision_contexts WHERE id=$1", [contextId]);
    await admin.query("DELETE FROM school_memberships WHERE school_id=$1 AND user_id=$2", [schoolId, actorId]);
    // The unconditional staff_identity_history_hard_delete guard retains
    // synthetic identity roots; all new memberships and activity rows above
    // are removed without bypassing that production retention contract.
  }
});

test("manual lease expiry during a batch savepoint prevents its send and preserves following targets", async () => {
  const expiring = bindings[0]!;
  await admin.query("UPDATE student_sessions SET manual_lease_expires_at=clock_timestamp()+interval '1 second' WHERE id=$1", [expiring.studentSessionId]);
  const sent: string[] = [];
  try {
    const outcomes = await inSchool(() => storage.withClasspilotStudentControlDeliveryBatch(schoolId, bindings.slice(0, 2),
      binding => binding.studentId, binding => storage.withClasspilotStudentControlDeliveryAuthority(binding,
        async database => {
          if (binding === expiring) await database.execute(sql`SELECT pg_sleep(1.1)`);
          return binding.studentId;
        }, (_claimed, id) => { sent.push(id); return id; })));
    assert.deepEqual(outcomes.map(outcome => outcome.authorized), [false, true]);
    assert.deepEqual(sent, [bindings[1]!.studentId]);
  } finally {
    await admin.query("UPDATE student_sessions SET manual_lease_expires_at=clock_timestamp()+interval '5 minutes' WHERE id=$1", [expiring.studentSessionId]);
  }
});

test("initial joined binding row locks block a native transfer through the cohort's last synchronous send", async () => {
  const competitor = await admin.connect();
  await competitor.query("BEGIN");
  const pid = (await competitor.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
  let transfer: Promise<pg.QueryResult> | undefined;
  try {
    const chosen = bindings.slice(1, 3);
    const delivered = await inSchool(() => storage.withClasspilotStudentControlDeliveryBatch(schoolId, chosen,
      binding => binding.studentId, binding => storage.withClasspilotStudentControlDeliveryAuthority(binding, async () => {
        if (binding === chosen[0]) {
          transfer = competitor.query("UPDATE student_sessions SET is_active=false WHERE id=$1", [chosen[1]!.studentSessionId]);
          const deadline = Date.now() + 2_000;
          let blocked = false;
          while (Date.now() < deadline && !blocked) {
            blocked = (await admin.query<{ blocked: boolean }>("SELECT cardinality(pg_blocking_pids($1))>0 AS blocked", [pid])).rows[0]!.blocked;
            if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
          }
          assert.equal(blocked, true, "the not-yet-prepared target is already row-locked by the initial batch read");
        }
        return binding.studentId;
      }, (_claimed, studentId) => studentId)));
    assert.ok(delivered.every(result => result.authorized));
    await transfer;
  } finally { await competitor.query("ROLLBACK"); competitor.release(); }
});

test("actual receiver fences persistent source revisions and the existing narrow admin coverage authority", async () => {
  const assigned = randomUUID(), teacher = randomUUID(), administrator = randomUUID(), schoolAdministrator = randomUUID(), superAdministrator = randomUUID();
  for (const [actorId, role] of [[assigned, "teacher"], [teacher, "teacher"], [administrator, "admin"], [schoolAdministrator, "school_admin"], [superAdministrator, null]] as const) {
    await admin.query("INSERT INTO users(id,email,first_name,last_name,is_super_admin) VALUES($1,$2,'Synthetic','Receiver',$3)", [actorId, `${actorId}@example.test`, actorId === superAdministrator]);
    if (role) await admin.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,$3,'active')", [schoolId, actorId, role]);
  }
  const binding = bindings[1]!;
  const contextId = randomUUID();
  await admin.query("INSERT INTO classpilot_supervision_contexts(id,school_id,context_type,name,assigned_staff_id,created_by,starts_at,ends_at) VALUES($1,$2,'other','Synthetic receiver',$3,$3,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour')", [contextId, schoolId, assigned]);
  await admin.query("INSERT INTO classpilot_supervision_students(school_id,context_id,student_id,assigned_by) VALUES($1,$2,$3,$4)", [schoolId, contextId, binding.studentId, assigned]);
  await inSchool(() => storage.initializeClasspilotSupervisionControlStates({ schoolId, supervisionContextId: contextId, studentIds: [binding.studentId] }));
  const storedCommand = async (actorId: string, commandType: string, result: Record<string, unknown> = {}) => {
    const commandId = randomUUID();
    await admin.query("INSERT INTO classpilot_commands(id,school_id,supervision_context_id,teacher_id,target_scope,command_type,command_payload) VALUES($1,$2,$3,$4,'context',$5,'{}'::jsonb)", [commandId, schoolId, contextId, actorId, commandType]);
    await admin.query("INSERT INTO classpilot_command_targets(command_id,school_id,supervision_context_id,student_id,student_session_id,device_id,result) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)", [commandId, schoolId, contextId, binding.studentId, binding.studentSessionId, binding.deviceId, JSON.stringify(result)]);
    return commandId;
  };
  const sourceState = async (commandId: string) => (await inSchool(() => storage.replaceClasspilotSupervisionControlSnapshots({ schoolId, supervisionContextId: contextId,
    studentIds: [binding.studentId], sourceCommandId: commandId, desiredState: { restrictions: {} }, forceRevision: true })))[0]!;
  const relay = async (commandId: string, revision?: number) => {
    const delivery = await inSchool(() => storage.withClasspilotStudentControlDeliveryAuthority(binding,
      database => storage.classpilotStudentRelayMessageAllowed(binding, { commandId,
        authority: { teachingSessionId: null, supervisionContextId: contextId },
        ...(revision === undefined ? {} : { classroomState: { revision } }) }, database), (_claimed, allowed) => allowed));
    assert.equal(delivery.authorized, true, "fixture retains exact current binding");
    return delivery.authorized ? delivery.value : null;
  };
  const before = await inSchool(() => storage.getClasspilotStudentControlState(schoolId, binding.studentId));
  assert.ok(before);
  const persistent = await storedCommand(assigned, "apply-flight-path", { frozenControlRevision: before.revision });
  const committed = await sourceState(persistent);
  assert.ok(committed.revision > before.revision);
  assert.ok(await relay(persistent, committed.revision), "its own persisted revision supersedes its creation revision");
  assert.equal(await relay(persistent, before.revision), null, "a mismatched attached snapshot cannot ride the valid command");
  const transient = await storedCommand(assigned, "close-tabs", { frozenControlRevision: committed.revision });
  assert.ok(await relay(transient));
  const newer = await storedCommand(assigned, "lock-screen");
  await sourceState(newer);
  assert.equal(await relay(persistent, committed.revision), null, "a superseded persistent source cannot deliver");
  assert.equal(await relay(transient), null, "transient exact actions retain their frozen revision fence");
  const narrow = ["open-tab", "close-tabs", "lock-screen", "unlock-screen", "teacher-message", "apply-flight-path", "remove-flight-path", "apply-block-list", "remove-block-list"];
  for (const actorId of [administrator, schoolAdministrator, superAdministrator]) for (const commandType of narrow) {
    const commandId = await storedCommand(actorId, commandType);
    const current = await sourceState(commandId);
    assert.ok(await relay(commandId, current.revision), `current admin coverage exception remains deliverable: ${commandType}`);
  }
  for (const actorId of [teacher, administrator, superAdministrator]) {
    const commandId = await storedCommand(actorId, "poll");
    assert.equal(await relay(commandId), null, "broader classroom tools cannot use the narrow admin exception");
  }
  const revoked = await storedCommand(administrator, "open-tab");
  await admin.query("UPDATE school_memberships SET status='inactive' WHERE school_id=$1 AND user_id=$2", [schoolId, administrator]);
  assert.equal(await relay(revoked), null, "revoked membership does not retain admin coverage authority");
  const expired = await storedCommand(assigned, "open-tab");
  await admin.query("UPDATE classpilot_commands SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expired]);
  assert.equal(await relay(expired), null);
});

async function plainOpenFixture(chosen = bindings.slice(1, 41), supervision = false) {
  const actorId = randomUUID(), authorityId = randomUUID(), groupId = randomUUID(), commandId = randomUUID();
  await admin.query("INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'Synthetic','Plain open')", [actorId, `${actorId}@${schoolId}.example.edu`]);
  await admin.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,'teacher','active')", [schoolId, actorId]);
  await admin.query("DELETE FROM classpilot_supervision_students WHERE school_id=$1 AND student_id=ANY($2::text[])", [schoolId, chosen.map(binding => binding.studentId)]);
  await admin.query("DELETE FROM classpilot_student_control_states WHERE school_id=$1 AND student_id=ANY($2::text[])", [schoolId, chosen.map(binding => binding.studentId)]);
  if (supervision) {
    await admin.query("INSERT INTO classpilot_supervision_contexts(id,school_id,context_type,name,assigned_staff_id,created_by,starts_at,ends_at) VALUES($1,$2,'other','Synthetic plain open',$3,$3,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour')", [authorityId, schoolId, actorId]);
    await admin.query("INSERT INTO classpilot_supervision_students(school_id,context_id,student_id,assigned_by) SELECT $1,$2,student,$4 FROM unnest($3::text[]) student", [schoolId, authorityId, chosen.map(binding => binding.studentId), actorId]);
    await inSchool(() => storage.initializeClasspilotSupervisionControlStates({ schoolId, supervisionContextId: authorityId, studentIds: chosen.map(binding => binding.studentId) }));
  } else {
    const writer = await admin.connect();
    try {
      await writer.query("BEGIN");
      await writer.query("INSERT INTO groups(id,school_id,teacher_id,name,group_type) VALUES($1,$2,$3,'Synthetic plain open','admin_class')", [groupId, schoolId, actorId]);
      await writer.query("INSERT INTO group_teachers(group_id,teacher_id,role) VALUES($1,$2,'primary')", [groupId, actorId]);
      await writer.query("COMMIT");
    } finally { writer.release(); }
    await admin.query("INSERT INTO teaching_sessions(id,school_id,group_id,teacher_id,session_mode,start_time,roster_snapshot_completed_at) VALUES($1,$2,$3,$4,'live',clock_timestamp()-interval '1 minute',clock_timestamp())", [authorityId, schoolId, groupId, actorId]);
    await admin.query("INSERT INTO classpilot_session_staff(school_id,teaching_session_id,staff_id,role) VALUES($1,$2,$3,'primary')", [schoolId, authorityId, actorId]);
    await admin.query("INSERT INTO classpilot_session_students(school_id,teaching_session_id,group_id,student_id) SELECT $1,$2,$3,student FROM unnest($4::text[]) student", [schoolId, authorityId, groupId, chosen.map(binding => binding.studentId)]);
    await inSchool(() => storage.replaceClasspilotStudentControlSnapshots({ schoolId, teachingSessionId: authorityId,
      studentIds: chosen.map(binding => binding.studentId), desiredState: { restrictions: {} },
      hardExpiresAt: new Date(Date.now() + 3600_000), authorityMode: "filter" }));
  }
  const authority = supervision ? { teachingSessionId: null, supervisionContextId: authorityId }
    : { teachingSessionId: authorityId, supervisionContextId: null };
  await admin.query("INSERT INTO classpilot_commands(id,school_id,teaching_session_id,supervision_context_id,teacher_id,target_scope,command_type,command_payload,requested_count,expires_at) VALUES($1,$2,$3,$4,$5,$6,'open-tab','{\"url\":\"https://example.invalid/lesson\"}'::jsonb,$7,clock_timestamp()+interval '15 seconds')", [commandId, schoolId, authority.teachingSessionId, authority.supervisionContextId, actorId, supervision ? "context" : "class", chosen.length]);
  await admin.query(`INSERT INTO classpilot_command_targets(command_id,school_id,teaching_session_id,supervision_context_id,student_id,student_session_id,device_id,result)
    SELECT $1,$2,$3,$4,b.student_id,b.session_id,b.device_id,jsonb_build_object('frozenControlRevision',control.revision)
    FROM unnest($5::text[],$6::text[],$7::text[]) b(student_id,session_id,device_id)
    JOIN classpilot_student_control_states control ON control.school_id=$2 AND control.student_id=b.student_id`,
  [commandId, schoolId, authority.teachingSessionId, authority.supervisionContextId, chosen.map(binding => binding.studentId), chosen.map(binding => binding.studentSessionId), chosen.map(binding => binding.deviceId)]);
  return { actorId, authorityId, groupId, commandId, chosen, authority,
    async dispose() {
      await admin.query("DELETE FROM classpilot_command_targets WHERE command_id=$1", [commandId]);
      await admin.query("DELETE FROM classpilot_commands WHERE id=$1", [commandId]);
      await admin.query("DELETE FROM classpilot_student_control_states WHERE school_id=$1 AND student_id=ANY($2::text[])", [schoolId, chosen.map(binding => binding.studentId)]);
      if (supervision) {
        await admin.query("DELETE FROM classpilot_supervision_students WHERE context_id=$1", [authorityId]);
        await admin.query("DELETE FROM classpilot_supervision_contexts WHERE id=$1", [authorityId]);
      } else {
        await admin.query("DELETE FROM classpilot_session_staff WHERE teaching_session_id=$1", [authorityId]);
        await admin.query("DELETE FROM classpilot_session_students WHERE teaching_session_id=$1", [authorityId]);
        await admin.query("DELETE FROM teaching_sessions WHERE id=$1", [authorityId]);
        const writer = await admin.connect();
        try {
          await writer.query("BEGIN");
          await writer.query("DELETE FROM group_teachers WHERE group_id=$1", [groupId]);
          await writer.query("DELETE FROM groups WHERE id=$1", [groupId]);
          await writer.query("COMMIT");
        } finally { writer.release(); }
      }
      await admin.query("DELETE FROM school_memberships WHERE school_id=$1 AND user_id=$2", [schoolId, actorId]);
    } };
}

type CreationInput = Parameters<typeof storage.createClasspilotCommandWithTargets>;
type PlainOpenFixture = Awaited<ReturnType<typeof plainOpenFixture>>;

function creationInput(fixture: PlainOpenFixture): CreationInput {
  return [{
    id: randomUUID(), schoolId, ...fixture.authority, teacherId: fixture.actorId,
    targetScope: fixture.authority.teachingSessionId ? "class" : "context",
    commandType: "open-tab", commandPayload: { url: "https://example.invalid/created" },
    requestedCount: fixture.chosen.length, expiresAt: new Date(Date.now() + 15_000),
  }, fixture.chosen.map(binding => ({
    ...binding, ...fixture.authority, commandId: "assigned-by-transaction", status: "requested",
  })), { authority: {
    schoolId, actorId: fixture.actorId,
    ...(fixture.authority.teachingSessionId ? { teachingSessionId: fixture.authority.teachingSessionId }
      : { supervisionContextId: fixture.authority.supervisionContextId! }),
  } }];
}

function creationTrace() {
  return { cohortKeys: [] as string[][], serialKeys: [] as string[], begins: 0, commits: 0 };
}

async function observeCreation(input: CreationInput, trace = creationTrace()) {
  return inSchool(async () => {
    const store = tenant.getOwnedTenantStore(); assert.ok(store);
    const original = store.client.query;
    store.client.query = function (this: pg.PoolClient, ...args: unknown[]) {
      const query = args[0] as string | { text?: string; values?: unknown[] };
      const text = typeof query === "string" ? query : query.text || "";
      const values = (typeof query === "string" ? args[1] : query.values ?? args[1]) as unknown[] | undefined;
      if (text.includes("classpilot_plain_open_tab_locks")) {
        assert.equal(this, store.client, "cohort locks stay on the owned tenant connection");
        const keys = values?.[0]; assert.ok(Array.isArray(keys));
        trace.cohortKeys.push(keys.map(String));
      } else if (/pg_advisory_xact_lock\(hashtextextended/i.test(text)) {
        for (const value of values ?? []) if (typeof value === "string" && value.startsWith(`classpilot:student-control:${schoolId}:`)) trace.serialKeys.push(value);
      }
      if (/^begin(?:\s|$)/i.test(text)) trace.begins++;
      if (/^commit(?:\s|$)/i.test(text)) trace.commits++;
      return Reflect.apply(original, this, args);
    } as typeof original;
    try { return await storage.createClasspilotCommandWithTargets(...input); }
    finally { store.client.query = original; }
  });
}

async function removeCreatedCommand(input: CreationInput) {
  await admin.query("DELETE FROM classpilot_command_targets WHERE command_id=$1", [input[0].id]);
  await admin.query("DELETE FROM classpilot_commands WHERE id=$1", [input[0].id]);
}

// Exercise the real creation transaction after it has waited behind a writer
// holding the same first canonical student lock; do not stub authority reads.
async function createAfterLockedChange(input: CreationInput, change: (writer: pg.PoolClient) => Promise<void>) {
  const blocker = await admin.connect();
  let pending: Promise<Awaited<ReturnType<typeof storage.createClasspilotCommandWithTargets>>> | undefined;
  try {
    await blocker.query("BEGIN");
    const first = [...new Set(input[1].map(target => target.studentId))].sort((a, b) => a.localeCompare(b))[0]!;
    await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0::bigint))", [lockKey(first)]);
    const blockerPid = (await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    let creationPid: number | undefined;
    pending = inSchool(async () => {
      const store = tenant.getOwnedTenantStore(); assert.ok(store);
      creationPid = (await store.client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      return storage.createClasspilotCommandWithTargets(...input);
    });
    pending.catch(() => {});
    let blocked = false;
    const deadline = performance.now() + 3_000;
    while (!blocked && performance.now() < deadline) {
      blocked = creationPid !== undefined && (await admin.query<{ blockers: number[] }>("SELECT pg_blocking_pids($1) AS blockers", [creationPid])).rows[0]!.blockers.includes(blockerPid);
      if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(blocked, true, "creation must wait on the existing canonical student lock before re-reading authority");
    await change(blocker);
    await blocker.query("COMMIT");
    return await pending;
  } finally {
    await blocker.query("ROLLBACK"); blocker.release();
    if (pending) await Promise.allSettled([pending]);
  }
}

for (const supervision of [false, true]) test(`plain ${supervision ? "supervision" : "class"} creation persists forty exact targets using one sorted owned lock query`, async () => {
  const fixture = await plainOpenFixture([...bindings.slice(1, 41)].reverse(), supervision);
  const input = creationInput(fixture), trace = creationTrace();
  try {
    const created = await observeCreation(input, trace);
    assert.deepEqual(trace.cohortKeys, [[...fixture.chosen].sort((a, b) => a.studentId.localeCompare(b.studentId)).map(binding => lockKey(binding.studentId))]);
    assert.deepEqual(trace.serialKeys, []);
    assert.equal(trace.begins, 1); assert.equal(trace.commits, 1);
    assert.equal(created.id, input[0].id); assert.equal(created.targets.length, 40);
    assert.deepEqual(created.commandPayload, input[0].commandPayload);
    assert.equal(created.expiresAt!.getTime(), input[0].expiresAt!.getTime());
    assert.equal((await admin.query("SELECT 1 FROM classpilot_commands WHERE id=$1", [created.id])).rowCount, 1);
    for (const binding of fixture.chosen) {
      const target = created.targets.find(target => target.studentId === binding.studentId)!;
      assert.equal(target.schoolId, schoolId);
      assert.equal(target.studentSessionId, binding.studentSessionId); assert.equal(target.deviceId, binding.deviceId);
      assert.equal(target.teachingSessionId, fixture.authority.teachingSessionId);
      assert.equal(target.supervisionContextId, fixture.authority.supervisionContextId);
      assert.equal(target.status, "requested"); assert.equal(target.sentAt, null, "creation cannot pre-mark a send");
    }
    const { publicClasspilotCommand } = await import("../src/services/classpilotCommandPublic.js");
    assert.doesNotMatch(JSON.stringify(publicClasspilotCommand(created)), /deviceId|studentSessionId|frozenControlRevision/);
  } finally { await removeCreatedCommand(input); await fixture.dispose(); }
});

test("creation keeps serialized locks and persisted target cardinality for rich, other-type, duplicate, empty and 41-target commands", async () => {
  const fixture = await plainOpenFixture(bindings);
  const inputs: CreationInput[] = [];
  try {
    for (const variant of ["rich", "other-type", "duplicate", "empty", "oversize"] as const) {
      const input = creationInput(fixture); inputs.push(input);
      if (variant !== "oversize") input[1] = input[1].slice(1, 4);
      if (variant === "rich") input[0].commandPayload = { url: "https://example.invalid/created", focusAfterOpen: false };
      if (variant === "other-type") { input[0].commandType = "close-tabs"; input[0].commandPayload = {}; }
      if (variant === "duplicate") input[1] = [input[1][0]!, { ...input[1][0]! }];
      if (variant === "empty") input[1] = [];
      input[0].requestedCount = input[1].length;
      const trace = creationTrace(), created = await observeCreation(input, trace);
      const ids = [...new Set(input[1].map(target => target.studentId))].sort((a, b) => a.localeCompare(b));
      assert.deepEqual(trace.cohortKeys, [], variant);
      assert.deepEqual(trace.serialKeys, ids.map(lockKey), variant);
      assert.equal(created.targets.length, input[1].length, `${variant}: preserve the existing transaction's target cardinality`);
      assert.equal(created.requestedCount, input[1].length);
      assert.equal(trace.begins, 1); assert.equal(trace.commits, 1);
    }
  } finally { for (const input of inputs) await removeCreatedCommand(input); await fixture.dispose(); }
});

for (const supervision of [false, true]) test(`creation rechecks ${supervision ? "supervision assignment" : "class staff"} after waiting for student locks and rolls back without a command`, { timeout: 15_000 }, async () => {
  const fixture = await plainOpenFixture(bindings.slice(2, 4), supervision), input = creationInput(fixture);
  try {
    await assert.rejects(createAfterLockedChange(input, async writer => {
      if (supervision) {
        const successor = randomUUID();
        await writer.query("INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'Synthetic','Successor')", [successor, `${successor}@${schoolId}.example.edu`]);
        await writer.query("UPDATE classpilot_supervision_contexts SET assigned_staff_id=$2 WHERE id=$1", [fixture.authorityId, successor]);
      } else await writer.query("DELETE FROM classpilot_session_staff WHERE teaching_session_id=$1 AND staff_id=$2", [fixture.authorityId, fixture.actorId]);
    }), (error: unknown) => getDatabaseErrorDetails(error).code === "COMMAND_ACTOR_AUTHORITY_STALE");
    assert.equal((await admin.query("SELECT 1 FROM classpilot_commands WHERE id=$1", [input[0].id])).rowCount, 0);
    assert.equal((await admin.query("SELECT 1 FROM classpilot_command_targets WHERE command_id=$1", [input[0].id])).rowCount, 0);
  } finally { await removeCreatedCommand(input); await fixture.dispose(); }
});

test("creation waiting behind a binding retirement persists only that target as unavailable", { timeout: 15_000 }, async () => {
  const fixture = await plainOpenFixture(bindings.slice(2, 4)), input = creationInput(fixture);
  const retired = fixture.chosen[0]!;
  try {
    const created = await createAfterLockedChange(input, async writer => {
      await writer.query("UPDATE student_sessions SET is_active=false WHERE id=$1", [retired.studentSessionId]);
    });
    const target = created.targets.find(target => target.studentId === retired.studentId)!;
    assert.equal(target.status, "unavailable"); assert.equal(target.studentSessionId, null); assert.equal(target.deviceId, null);
    assert.equal(created.unavailableCount, 1);
    assert.equal(created.targets.find(target => target.studentId !== retired.studentId)!.status, "requested");
  } finally {
    await admin.query("UPDATE student_sessions SET is_active=true WHERE id=$1", [retired.studentSessionId]);
    await removeCreatedCommand(input); await fixture.dispose();
  }
});

test("creation cannot transfer an old target grant onto a genuinely replaced student session", async () => {
  const fixture = await plainOpenFixture(bindings.slice(2, 4)), input = creationInput(fixture);
  const old = fixture.chosen[0]!, replacementDevice = randomUUID(), replacementSession = randomUUID();
  try {
    await admin.query("INSERT INTO devices(device_id,school_id,class_id) VALUES($1,$2,'synthetic')", [replacementDevice, schoolId]);
    const transfer = await inSchool(() => storage.startStudentSessionWithReplacements(schoolId, old.studentId, replacementDevice,
      { authKind: "managed_profile", sessionId: replacementSession }));
    assert.equal(transfer.session.id, replacementSession);
    assert.ok(transfer.replacedSessions.some(session => session.id === old.studentSessionId));
    const created = await observeCreation(input);
    const stale = created.targets.find(target => target.studentId === old.studentId)!;
    assert.equal(stale.status, "unavailable"); assert.equal(stale.studentSessionId, null); assert.equal(stale.deviceId, null);
    assert.equal(created.targets.find(target => target.studentId !== old.studentId)!.status, "requested");
    assert.ok(created.targets.every(target => target.studentSessionId !== replacementSession && target.deviceId !== replacementDevice));
  } finally {
    await removeCreatedCommand(input); await fixture.dispose();
    await admin.query("DELETE FROM student_sessions WHERE id=$1", [replacementSession]);
    await admin.query("DELETE FROM student_devices WHERE student_id=$1 AND device_id=$2", [old.studentId, replacementDevice]);
    await admin.query("DELETE FROM devices WHERE device_id=$1 AND school_id=$2", [replacementDevice, schoolId]);
    await admin.query("UPDATE student_sessions SET is_active=true,ended_at=NULL WHERE id=$1", [old.studentSessionId]);
  }
});

test("creation rechecks roster removal after canonical student locks without persisting a partial command", { timeout: 15_000 }, async () => {
  const fixture = await plainOpenFixture(bindings.slice(2, 4)), input = creationInput(fixture);
  try {
    await assert.rejects(createAfterLockedChange(input, async writer => {
      await writer.query("DELETE FROM classpilot_session_students WHERE teaching_session_id=$1 AND student_id=$2", [fixture.authorityId, fixture.chosen[0]!.studentId]);
    }), (error: unknown) => getDatabaseErrorDetails(error).code === "COMMAND_TARGET_ROSTER_STALE");
    assert.equal((await admin.query("SELECT 1 FROM classpilot_commands WHERE id=$1", [input[0].id])).rowCount, 0);
    assert.equal((await admin.query("SELECT 1 FROM classpilot_command_targets WHERE command_id=$1", [input[0].id])).rowCount, 0);
  } finally { await removeCreatedCommand(input); await fixture.dispose(); }
});

test("a command expiring while creation waits keeps its original deadline and cannot send afterward", { timeout: 15_000 }, async () => {
  const fixture = await plainOpenFixture(bindings.slice(2, 4)), input = creationInput(fixture);
  input[0].expiresAt = new Date(Date.now() + 500);
  try {
    const created = await createAfterLockedChange(input, async writer => { await writer.query("SELECT pg_sleep(0.6)"); });
    assert.equal(created.expiresAt!.getTime(), input[0].expiresAt.getTime());
    const outcomes = await inSchool(() => storage.withClasspilotPlainOpenTabDeliveryBatch({ schoolId, commandId: created.id, targets: fixture.chosen }, () => assert.fail("expired creation sent a frame")));
    assert.ok(outcomes.every(outcome => !outcome.authorized));
    assert.ok(created.targets.every(target => target.status === "requested" && target.sentAt === null));
  } finally { await removeCreatedCommand(input); await fixture.dispose(); }
});

test("plain class open-tab retains reference authority with a constant SQL cohort and no savepoints", { timeout: 20_000 }, async () => {
  const fixture = await plainOpenFixture();
  try {
    const counts: number[] = [];
    const measure = (work: () => Promise<unknown>) => inSchool(async () => {
      const store = tenant.getOwnedTenantStore(); assert.ok(store);
      const original = store.client.query; let statements = 0, savepoints = 0;
      store.client.query = function (this: pg.PoolClient, ...args: unknown[]) {
        const query = args[0] as string | { text?: string }; const text = typeof query === "string" ? query : query.text || "";
        statements++; if (/^savepoint /i.test(text)) savepoints++;
        return Reflect.apply(original, this, args);
      } as typeof original;
      try { const result = await work(); counts.push(statements); return { result, savepoints }; }
      finally { store.client.query = original; }
    });
    const reference = await measure(() => storage.withClasspilotStudentControlDeliveryBatch(schoolId, fixture.chosen,
      binding => binding.studentId, binding => storage.withClasspilotStudentControlDeliveryAuthority(binding,
        database => storage.classpilotStudentRelayMessageAllowed(binding, { commandId: fixture.commandId, authority: fixture.authority }, database),
        (_claimed, allowed) => allowed ? binding.studentId : null)));
    const sent: string[] = [];
    const fast = await measure(() => storage.withClasspilotPlainOpenTabDeliveryBatch({ schoolId, commandId: fixture.commandId, targets: fixture.chosen },
      (binding, authority) => { assert.ok(authority.isCurrent()); sent.push(binding.studentId); return binding.studentId; }));
    assert.ok((reference.result as Array<{ authorized: boolean; value: unknown }>).every(outcome => outcome.authorized && outcome.value));
    assert.ok((fast.result as Array<{ authorized: boolean; value: unknown }>).every(outcome => outcome.authorized && outcome.value));
    assert.deepEqual(sent, fixture.chosen.map(binding => binding.studentId));
    assert.equal(reference.savepoints, 40);
    assert.equal(fast.savepoints, 0);
    assert.ok(counts[0]! > 400, "retain measured reference N+1 evidence");
    assert.ok(counts[1]! <= 16, "all forty targets share a bounded constant number of SQL statements");
    console.log(`Plain open-tab SQL statements: reference=${counts[0]} cohort=${counts[1]}`);
  } finally { await fixture.dispose(); }
});

test("plain cohort lock query preserves canonical sort/dedup and overlapping reverse input", { timeout: 15_000 }, async () => {
  const chosen = bindings.slice(2, 8).sort((left, right) => left.studentId.localeCompare(right.studentId));
  const blocker = await admin.connect(); await blocker.query("BEGIN");
  await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0::bigint))", [lockKey(chosen[0]!.studentId)]);
  const blockerPid = (await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
  const pids: number[] = [], held: Promise<unknown>[] = [];
  let release!: () => void; const continueBatch = new Promise<void>(resolve => { release = resolve; });
  const start = (ids: string[]) => inSchool(() => import("../src/db.js").then(({ db }) => db.transaction(async tx => {
    const store = tenant.getOwnedTenantStore(); assert.ok(store);
    pids.push((await store.client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid);
    const normalized = await storage.lockClasspilotStudentControlAuthorityCohort(schoolId, ids, tx);
    assert.deepEqual(normalized, chosen.map(binding => binding.studentId));
    await continueBatch;
  })));
  const waitBlocked = async (pidIndex: number) => {
    const deadline = performance.now() + 3_000;
    while (performance.now() < deadline) {
      if (pids[pidIndex] && (await admin.query<{ blockers: number[] }>("SELECT pg_blocking_pids($1) AS blockers", [pids[pidIndex]])).rows[0]!.blockers.includes(blockerPid)) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail("cohort did not block on the first canonical key");
  };
  try {
    const reverseInput: string[] = [...chosen].reverse().map(binding => binding.studentId);
    reverseInput.push(` ${chosen[0]!.studentId} `, " ", chosen[1]!.studentId);
    held.push(start(reverseInput)); held[0]!.catch(() => {});
    await waitBlocked(0);
    held.push(start(chosen.map(binding => binding.studentId))); held[1]!.catch(() => {});
    await waitBlocked(1);
    for (const binding of chosen.slice(1)) assert.equal((await admin.query<{ acquired: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0::bigint)) AS acquired", [lockKey(binding.studentId)])).rows[0]!.acquired, true);
    await blocker.query("ROLLBACK");
    const deadline = performance.now() + 3_000;
    let firstHoldsAll = false;
    while (!firstHoldsAll && performance.now() < deadline) {
      firstHoldsAll = !(await admin.query<{ acquired: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0::bigint)) AS acquired", [lockKey(chosen.at(-1)!.studentId)])).rows[0]!.acquired;
      if (!firstHoldsAll) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(firstHoldsAll, true);
    for (const binding of chosen) assert.equal((await admin.query<{ acquired: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0::bigint)) AS acquired", [lockKey(binding.studentId)])).rows[0]!.acquired, false);
    release(); await Promise.all(held);
    for (const binding of chosen) assert.equal((await admin.query<{ acquired: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0::bigint)) AS acquired", [lockKey(binding.studentId)])).rows[0]!.acquired, true);
  } finally { release(); await blocker.query("ROLLBACK"); blocker.release(); await Promise.allSettled(held); }
});

test("plain delivery denies changed bindings, revisions, terminal targets and foreign tuples individually", async () => {
  const fixture = await plainOpenFixture(bindings.slice(2, 8));
  try {
    const selected = [...fixture.chosen];
    selected[0] = { ...selected[0]!, studentSessionId: randomUUID() };
    selected[1] = { ...selected[1]!, schoolId: randomUUID() };
    await admin.query("UPDATE classpilot_command_targets SET result=jsonb_set(result,'{frozenControlRevision}',to_jsonb((result->>'frozenControlRevision')::int+1)) WHERE command_id=$1 AND student_id=$2", [fixture.commandId, selected[2]!.studentId]);
    await admin.query("UPDATE classpilot_command_targets SET status='completed' WHERE command_id=$1 AND student_id=$2", [fixture.commandId, selected[3]!.studentId]);
    await admin.query("DELETE FROM classpilot_student_control_states WHERE school_id=$1 AND student_id=$2", [schoolId, selected[4]!.studentId]);
    const sent: string[] = [];
    const outcomes = await inSchool(() => storage.withClasspilotPlainOpenTabDeliveryBatch({ schoolId, commandId: fixture.commandId, targets: selected },
      binding => { sent.push(binding.studentId); return binding.studentId; }));
    assert.deepEqual(outcomes.map(outcome => outcome.authorized), [false, false, false, false, false, true]);
    assert.deepEqual(sent, [selected[5]!.studentId]);
  } finally { await fixture.dispose(); }
});

test("plain fast entry preserves legacy reference targets and excludes every rich open-tab variant", async () => {
  const dispatcher = await import("../src/services/classpilotCommandDispatcher.js");
  const fixture = await plainOpenFixture(bindings.slice(2, 4));
  try {
    const resolved = fixture.chosen.map(binding => ({ ...binding, studentName: "Synthetic", available: true, controlRevision: 1 }));
    assert.equal(dispatcher.classpilotPlainOpenTabTargetsEligible(resolved), true);
    assert.equal(dispatcher.classpilotPlainOpenTabTargetsEligible(resolved.map(target => ({ ...target, controlRevision: undefined }))), true);
    assert.equal(storage.isClasspilotPlainOpenTabTargetMetadata({ frozenControlRevision: "malformed" }), false);
    assert.equal(storage.isClasspilotPlainOpenTabTargetMetadata({ frozenControlRevision: 1 }), true);
    assert.equal(dispatcher.classpilotPlainOpenTabTargetsEligible([...resolved, resolved[0]!]), false);
    for (const key of ["scheduledAuthorityRevision", "durableAuthorityRevision"] as const)
      assert.equal(dispatcher.classpilotPlainOpenTabTargetsEligible(resolved.map(target => ({ ...target, [key]: 1 }))), false);
    assert.equal(dispatcher.classpilotPlainOpenTabTargetsEligible(Array.from({ length: 41 }, (_, index) => ({ ...resolved[0]!, studentId: String(index) }))), false);
    assert.equal(storage.isClasspilotPlainOpenTab("open-tab", { url: "https://example.invalid" }), true);
    for (const payload of [{ url: "https://example.invalid", focusAfterOpen: true }, { url: "https://example.invalid", afterRestrictionCommandId: "other" },
      { url: "https://example.invalid", currentPage: true }, { url: "https://example.invalid", classroomState: {} }, { url: "javascript:alert(1)" }])
      assert.equal(storage.isClasspilotPlainOpenTab("open-tab", payload), false);
    assert.equal(storage.isClasspilotPlainOpenTab("close-tabs", { url: "https://example.invalid" }), false);
    await admin.query("UPDATE classpilot_command_targets SET result='{}'::jsonb WHERE command_id=$1", [fixture.commandId]);
    const reference = await inSchool(() => storage.withClasspilotStudentControlDeliveryBatch(schoolId, fixture.chosen, binding => binding.studentId,
      binding => storage.withClasspilotStudentControlDeliveryAuthority(binding,
        database => storage.classpilotStudentRelayMessageAllowed(binding, { commandId: fixture.commandId, authority: fixture.authority }, database),
        (_claimed, allowed) => allowed)));
    assert.ok(reference.every(outcome => outcome.authorized && outcome.value), "authorized legacy targets lacking frozen revisions retain the reference path");
    const compatible = await inSchool(() => storage.withClasspilotPlainOpenTabDeliveryBatch({ schoolId, commandId: fixture.commandId, targets: fixture.chosen }, binding => binding.studentId));
    assert.ok(compatible.every(outcome => outcome.authorized), "the bulk path retains the same current authority when no frozen revision exists");
    await admin.query("UPDATE classpilot_commands SET command_payload=$2::jsonb WHERE id=$1", [fixture.commandId, JSON.stringify({ url: "https://example.invalid", focusAfterOpen: true })]);
    const sent: string[] = [];
    const rejected = await inSchool(() => storage.withClasspilotPlainOpenTabDeliveryBatch({ schoolId, commandId: fixture.commandId, targets: fixture.chosen },
      binding => { sent.push(binding.studentId); return binding.studentId; }));
    assert.ok(rejected.every(outcome => !outcome.authorized)); assert.deepEqual(sent, []);
  } finally { await fixture.dispose(); }
});

test("plain final database clock rejects a lease or command that expires during final read", async () => {
  const fixture = await plainOpenFixture([bindings[0]!, bindings[2]!]);
  try {
    await admin.query("UPDATE student_sessions SET manual_lease_expires_at=clock_timestamp()+interval '1 second' WHERE id=$1", [bindings[0]!.studentSessionId]);
    const sent: string[] = [];
    const outcomes = await inSchool(async () => {
      const store = tenant.getOwnedTenantStore(); assert.ok(store); const original = store.client.query;
      store.client.query = async function (this: pg.PoolClient, ...args: unknown[]) {
        const query = args[0] as string | { text?: string }; const text = typeof query === "string" ? query : query.text || "";
        if (text.includes("classpilot_plain_open_tab_final")) await Reflect.apply(original, this, ["SELECT pg_sleep(1.1)"]);
        return Reflect.apply(original, this, args);
      } as typeof original;
      try { return await storage.withClasspilotPlainOpenTabDeliveryBatch({ schoolId, commandId: fixture.commandId, targets: fixture.chosen },
        binding => { sent.push(binding.studentId); return binding.studentId; }); }
      finally { store.client.query = original; }
    });
    assert.deepEqual(outcomes.map(outcome => outcome.authorized), [false, true]);
    assert.deepEqual(sent, [bindings[2]!.studentId]);
    await admin.query("UPDATE classpilot_commands SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [fixture.commandId]);
    const expired = await inSchool(() => storage.withClasspilotPlainOpenTabDeliveryBatch({ schoolId, commandId: fixture.commandId, targets: fixture.chosen }, () => assert.fail("expired command sent")));
    assert.ok(expired.every(outcome => !outcome.authorized));
  } finally {
    await admin.query("UPDATE student_sessions SET manual_lease_expires_at=clock_timestamp()+interval '5 minutes' WHERE id=$1", [bindings[0]!.studentSessionId]);
    await fixture.dispose();
  }
});

test("plain synchronous frame loop rechecks the minimum control deadline without replaying earlier sends", async () => {
  const fixture = await plainOpenFixture(bindings.slice(2, 4));
  try {
    await admin.query("UPDATE classpilot_student_control_states SET hard_expires_at=clock_timestamp()+interval '1 second',scheduled_end_at=NULL WHERE school_id=$1 AND student_id=$2", [schoolId, fixture.chosen[1]!.studentId]);
    const sent: string[] = [];
    const outcomes = await inSchool(() => storage.withClasspilotPlainOpenTabDeliveryBatch({ schoolId, commandId: fixture.commandId, targets: fixture.chosen }, (binding, authority) => {
      assert.ok(authority.isCurrent()); sent.push(binding.studentId);
      if (binding === fixture.chosen[0]) { const until = performance.now() + 1100; while (performance.now() < until) { /* synchronous side effect window */ } }
      return binding.studentId;
    }));
    assert.deepEqual(outcomes.map(outcome => outcome.authorized), [true, false]);
    assert.deepEqual(sent, [fixture.chosen[0]!.studentId]);
  } finally { await fixture.dispose(); }
});

for (const cutoff of ["school", "license", "context", "command"] as const) test(`plain delayed final reply cannot outlive its ${cutoff} authority cutoff`, async () => {
  const fixture = await plainOpenFixture(bindings.slice(2, 4), cutoff === "context");
  try {
    if (cutoff === "school") await admin.query("UPDATE schools SET active_until=clock_timestamp()+interval '1 second' WHERE id=$1", [schoolId]);
    if (cutoff === "license") await admin.query("UPDATE product_licenses SET expires_at=clock_timestamp()+interval '1 second' WHERE school_id=$1 AND product='CLASSPILOT'", [schoolId]);
    if (cutoff === "context") await admin.query("UPDATE classpilot_supervision_contexts SET ends_at=clock_timestamp()+interval '1 second' WHERE id=$1", [fixture.authorityId]);
    if (cutoff === "command") await admin.query("UPDATE classpilot_commands SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1", [fixture.commandId]);
    let finalRowsBeforeReplyDelay = 0;
    const sent: string[] = [];
    const outcomes = await inSchool(async () => {
      const store = tenant.getOwnedTenantStore(); assert.ok(store); const original = store.client.query;
      store.client.query = async function (this: pg.PoolClient, ...args: unknown[]) {
        const query = args[0] as string | { text?: string }; const text = typeof query === "string" ? query : query.text || "";
        const result = await Reflect.apply(original, this, args);
        if (text.includes("classpilot_plain_open_tab_final")) {
          finalRowsBeforeReplyDelay = (result as pg.QueryResult).rows.length;
          await Reflect.apply(original, this, ["SELECT pg_sleep(1.1)"]);
        }
        return result;
      } as typeof original;
      try { return await storage.withClasspilotPlainOpenTabDeliveryBatch({ schoolId, commandId: fixture.commandId, targets: fixture.chosen },
        binding => { sent.push(binding.studentId); return binding.studentId; }); }
      finally { store.client.query = original; }
    });
    assert.ok(finalRowsBeforeReplyDelay >= fixture.chosen.length, "authority was valid in the DB projection before its response was delayed");
    assert.ok(outcomes.every(outcome => !outcome.authorized));
    assert.deepEqual(sent, []);
  } finally {
    if (cutoff === "school") await admin.query("UPDATE schools SET active_until=NULL WHERE id=$1", [schoolId]);
    if (cutoff === "license") await admin.query("UPDATE product_licenses SET expires_at=NULL WHERE school_id=$1 AND product='CLASSPILOT'", [schoolId]);
    await fixture.dispose();
  }
});

for (const mutation of ["binding", "membership", "session-staff", "context", "school", "license"] as const) test(`plain native ${mutation} retirement waits through the cohort's final synchronous send`, { timeout: 10_000 }, async () => {
  const fixture = await plainOpenFixture(bindings.slice(2, 4), mutation === "context");
  const competitor = await admin.connect(); await competitor.query("BEGIN");
  const pid = (await competitor.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
  let change: Promise<pg.QueryResult> | undefined;
  try {
    const sent: string[] = [];
    const outcomes = await inSchool(async () => {
      const store = tenant.getOwnedTenantStore(); assert.ok(store); const original = store.client.query;
      store.client.query = async function (this: pg.PoolClient, ...args: unknown[]) {
        const query = args[0] as string | { text?: string }; const text = typeof query === "string" ? query : query.text || "";
        if (text.includes("classpilot_plain_open_tab_final")) {
          change = mutation === "binding" ? competitor.query("UPDATE student_sessions SET is_active=false WHERE id=$1", [fixture.chosen[1]!.studentSessionId])
            : mutation === "membership" ? competitor.query("UPDATE school_memberships SET status='inactive' WHERE school_id=$1 AND user_id=$2", [schoolId, fixture.actorId])
            : mutation === "session-staff" ? competitor.query("DELETE FROM classpilot_session_staff WHERE teaching_session_id=$1 AND staff_id=$2", [fixture.authorityId, fixture.actorId])
            : mutation === "context" ? competitor.query("UPDATE classpilot_supervision_contexts SET status='ended' WHERE id=$1", [fixture.authorityId])
            : mutation === "school" ? competitor.query("UPDATE schools SET is_active=false WHERE id=$1", [schoolId])
            : competitor.query("UPDATE product_licenses SET status='inactive' WHERE school_id=$1 AND product='CLASSPILOT'", [schoolId]);
          change.catch(() => {});
          const deadline = performance.now() + 2000; let blocked = false;
          while (!blocked && performance.now() < deadline) {
            blocked = (await admin.query<{ blocked: boolean }>("SELECT cardinality(pg_blocking_pids($1))>0 AS blocked", [pid])).rows[0]!.blocked;
            if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
          }
          assert.equal(blocked, true, "mutable authority is locked before the final projection starts");
        }
        return Reflect.apply(original, this, args);
      } as typeof original;
      try { return await storage.withClasspilotPlainOpenTabDeliveryBatch({ schoolId, commandId: fixture.commandId, targets: fixture.chosen },
        binding => { sent.push(binding.studentId); return binding.studentId; }); }
      finally { store.client.query = original; }
    });
    assert.ok(outcomes.every(outcome => outcome.authorized));
    assert.deepEqual(sent, fixture.chosen.map(binding => binding.studentId));
    assert.ok(change); await change;
  } finally { await competitor.query("ROLLBACK"); competitor.release(); await fixture.dispose(); }
});

test("plain session co-teacher membership and retirement retain the exact staff contract", async () => {
  const fixture = await plainOpenFixture(bindings.slice(2, 4)); const coTeacher = randomUUID();
  try {
    await admin.query("INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'Synthetic','Co-teacher')", [coTeacher, `${coTeacher}@${schoolId}.example.edu`]);
    await admin.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,'teacher','active')", [schoolId, coTeacher]);
    await admin.query("INSERT INTO classpilot_session_staff(school_id,teaching_session_id,staff_id,role) VALUES($1,$2,$3,'co_teacher')", [schoolId, fixture.authorityId, coTeacher]);
    await admin.query("UPDATE classpilot_commands SET teacher_id=$2 WHERE id=$1", [fixture.commandId, coTeacher]);
    const deliver = () => inSchool(() => storage.withClasspilotPlainOpenTabDeliveryBatch({ schoolId, commandId: fixture.commandId, targets: fixture.chosen }, binding => binding.studentId));
    assert.ok((await deliver()).every(outcome => outcome.authorized));
    await admin.query("DELETE FROM classpilot_session_staff WHERE teaching_session_id=$1 AND staff_id=$2", [fixture.authorityId, coTeacher]);
    assert.ok((await deliver()).every(outcome => !outcome.authorized), "retired staff cannot retain a class command grant");
    await admin.query("UPDATE school_memberships SET status='inactive' WHERE school_id=$1 AND user_id=$2", [schoolId, coTeacher]);
    assert.ok((await deliver()).every(outcome => !outcome.authorized), "a teacher identity without active membership cannot use the live class");
    await admin.query("UPDATE school_memberships SET status='active' WHERE school_id=$1 AND user_id=$2", [schoolId, coTeacher]);
    assert.ok((await deliver()).every(outcome => !outcome.authorized));
    assert.equal((await admin.query("SELECT 1 FROM teaching_sessions WHERE id=$1 AND end_time IS NULL", [fixture.authorityId])).rowCount, 1);
    assert.equal((await admin.query("SELECT 1 FROM classpilot_session_staff WHERE teaching_session_id=$1 AND staff_id=$2", [fixture.authorityId, fixture.actorId])).rowCount, 1);
  } finally {
    await admin.query("DELETE FROM classpilot_session_staff WHERE teaching_session_id=$1 AND staff_id=$2", [fixture.authorityId, coTeacher]);
    await admin.query("DELETE FROM school_memberships WHERE school_id=$1 AND user_id=$2", [schoolId, coTeacher]);
    await fixture.dispose();
  }
});

test("plain supervision preserves assigned office staff and the narrow administrator exception", async () => {
  const fixture = await plainOpenFixture(bindings.slice(2, 4), true); const extraActors: string[] = [];
  try {
    await admin.query("UPDATE school_memberships SET role='office_staff' WHERE school_id=$1 AND user_id=$2", [schoolId, fixture.actorId]);
    const deliver = () => inSchool(() => storage.withClasspilotPlainOpenTabDeliveryBatch({ schoolId, commandId: fixture.commandId, targets: fixture.chosen }, binding => binding.studentId));
    assert.ok((await deliver()).every(outcome => outcome.authorized));
    for (const role of ["teacher", "admin", "school_admin", "superadmin"] as const) {
      const actorId = randomUUID(); extraActors.push(actorId);
      await admin.query("INSERT INTO users(id,email,first_name,last_name,is_super_admin) VALUES($1,$2,'Synthetic','Authority',$3)", [actorId, `${actorId}@${schoolId}.example.edu`, role === "superadmin"]);
      if (role !== "superadmin") await admin.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,$3,'active')", [schoolId, actorId, role]);
      await admin.query("UPDATE classpilot_commands SET teacher_id=$2 WHERE id=$1", [fixture.commandId, actorId]);
      assert.ok((await deliver()).every(outcome => outcome.authorized === (role !== "teacher")), "an unrelated teacher cannot borrow the assigned staff or admin exception");
    }
  } finally {
    for (const actorId of extraActors) await admin.query("DELETE FROM school_memberships WHERE school_id=$1 AND user_id=$2", [schoolId, actorId]);
    await fixture.dispose();
  }
});

for (const legacy of [false, true]) test(`plain owner projection retains ${legacy ? "legacy roster" : "frozen roster"} override ranking`, async () => {
  const fixture = await plainOpenFixture(bindings.slice(2, 4)); const newer = randomUUID();
  try {
    await admin.query("INSERT INTO teaching_sessions(id,school_id,group_id,teacher_id,session_mode,start_time,control_updated_at,roster_snapshot_completed_at) VALUES($1,$2,$3,$4,'live',clock_timestamp(),clock_timestamp()+interval '1 minute',$5)", [newer, schoolId, fixture.groupId, fixture.actorId, legacy ? null : new Date()]);
    if (legacy) await admin.query("INSERT INTO group_students(group_id,student_id) SELECT $1,student FROM unnest($2::text[]) student", [fixture.groupId, fixture.chosen.map(binding => binding.studentId)]);
    else await admin.query("INSERT INTO classpilot_session_students(school_id,teaching_session_id,group_id,student_id) SELECT $1,$2,$3,student FROM unnest($4::text[]) student", [schoolId, newer, fixture.groupId, fixture.chosen.map(binding => binding.studentId)]);
    const expectedOwner = await inSchool(() => storage.getActiveClassOwnersForStudents(schoolId, fixture.chosen.map(binding => binding.studentId)));
    assert.ok(expectedOwner.every(owner => owner.session.id === newer));
    const outcomes = await inSchool(() => storage.withClasspilotPlainOpenTabDeliveryBatch({ schoolId, commandId: fixture.commandId, targets: fixture.chosen }, () => assert.fail("overridden owner sent")));
    assert.ok(outcomes.every(outcome => !outcome.authorized));
  } finally {
    await admin.query("DELETE FROM classpilot_session_students WHERE teaching_session_id=$1", [newer]);
    await admin.query("DELETE FROM group_students WHERE group_id=$1", [fixture.groupId]);
    await admin.query("DELETE FROM teaching_sessions WHERE id=$1", [newer]);
    await fixture.dispose();
  }
});

test("plain delayed final reply stops class delivery when pre-existing future supervision begins", async () => {
  const fixture = await plainOpenFixture(bindings.slice(2, 4)); const future = randomUUID();
  try {
    await admin.query("INSERT INTO classpilot_supervision_contexts(id,school_id,context_type,name,assigned_staff_id,created_by,starts_at,ends_at) VALUES($1,$2,'other','Synthetic future coverage',$3,$3,clock_timestamp()+interval '1 second',clock_timestamp()+interval '1 hour')", [future, schoolId, fixture.actorId]);
    await admin.query("INSERT INTO classpilot_supervision_students(school_id,context_id,student_id,assigned_by) VALUES($1,$2,$3,$4)", [schoolId, future, fixture.chosen[1]!.studentId, fixture.actorId]);
    const sent: string[] = []; let projectedBeforeStart = false;
    const outcomes = await inSchool(async () => {
      const store = tenant.getOwnedTenantStore(); assert.ok(store); const original = store.client.query;
      store.client.query = async function (this: pg.PoolClient, ...args: unknown[]) {
        const query = args[0] as string | { text?: string }; const text = typeof query === "string" ? query : query.text || "";
        const result = await Reflect.apply(original, this, args);
        if (text.includes("classpilot_plain_open_tab_final")) {
          projectedBeforeStart = (result as pg.QueryResult).rows.every(row => row.hasActiveSupervision === false);
          await Reflect.apply(original, this, ["SELECT pg_sleep(1.1)"]);
        }
        return result;
      } as typeof original;
      try { return await storage.withClasspilotPlainOpenTabDeliveryBatch({ schoolId, commandId: fixture.commandId, targets: fixture.chosen },
        binding => { sent.push(binding.studentId); return binding.studentId; }); }
      finally { store.client.query = original; }
    });
    assert.equal(projectedBeforeStart, true);
    assert.deepEqual(outcomes.map(outcome => outcome.authorized), [true, false]);
    assert.deepEqual(sent, [fixture.chosen[0]!.studentId]);
  } finally {
    await admin.query("DELETE FROM classpilot_supervision_students WHERE context_id=$1", [future]);
    await admin.query("DELETE FROM classpilot_supervision_contexts WHERE id=$1", [future]);
    await fixture.dispose();
  }
});

test("plain partial synchronous side effects never fall back or replay after a delivery exception", async () => {
  const fixture = await plainOpenFixture(bindings.slice(2, 4)); const attempted: string[] = [];
  try {
    await assert.rejects(inSchool(() => storage.withClasspilotPlainOpenTabDeliveryBatch({ schoolId, commandId: fixture.commandId, targets: fixture.chosen }, binding => {
      attempted.push(binding.studentId); throw new Error("Synthetic one-shot transport uncertainty");
    })), /Synthetic one-shot transport uncertainty/);
    assert.deepEqual(attempted, [fixture.chosen[0]!.studentId]);
    const command = await inSchool(() => storage.getClasspilotCommandByIdAndSchool(fixture.commandId, schoolId));
    assert.ok(command?.targets.every(target => target.status === "requested"));
  } finally { await fixture.dispose(); }
});

test("plain execute-command keeps authority-unavailable and binding-retirement outcomes in a mixed forty-student teacher response", { timeout: 20_000 }, async () => {
  const fixture = await plainOpenFixture(); const dispatcher = await import("../src/services/classpilotCommandDispatcher.js");
  let issuedCommandId: string | undefined, injected = false, transactionStatements = 0, deliveryStatements = 0, measuringDelivery = false;
  let cohortLockQueries = 0, creationCommitted = false;
  try {
    const result = await inSchool(async () => {
      const store = tenant.getOwnedTenantStore(); assert.ok(store); const original = store.client.query;
      store.client.query = async function (this: pg.PoolClient, ...args: unknown[]) {
        const query = args[0] as string | { text?: string }; const text = typeof query === "string" ? query : query.text || "";
        if (/^begin\b/i.test(text.trim())) transactionStatements = 0;
        transactionStatements++;
        if (text.includes("classpilot_plain_open_tab_locks")) cohortLockQueries++;
        if (!injected && cohortLockQueries === 2 && text.includes("classpilot_plain_open_tab_locks")) {
          assert.equal(creationCommitted, true, "delivery race begins only after the real creation transaction commits");
          injected = true; measuringDelivery = true;
          const writer = await admin.connect();
          try {
            await writer.query("BEGIN");
            for (const binding of fixture.chosen.slice(0, 2).sort((left, right) => left.studentId.localeCompare(right.studentId)))
              await writer.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0::bigint))", [lockKey(binding.studentId)]);
            await writer.query("UPDATE classpilot_student_control_states SET teaching_session_id=NULL,supervision_context_id=NULL,hard_expires_at=NULL,scheduled_end_at=NULL,revision=revision+1 WHERE school_id=$1 AND student_id=$2", [schoolId, fixture.chosen[0]!.studentId]);
            await writer.query("UPDATE student_sessions SET is_active=false WHERE id=$1", [fixture.chosen[1]!.studentSessionId]);
            await writer.query("COMMIT");
          } finally { writer.release(); }
        }
        const result = await Reflect.apply(original, this, args);
        if (cohortLockQueries === 1 && /^commit\b/i.test(text.trim())) creationCommitted = true;
        if (measuringDelivery && /^commit\b/i.test(text.trim())) { deliveryStatements = transactionStatements; measuringDelivery = false; }
        return result;
      } as typeof original;
      try { return await dispatcher.executeClasspilotCommand({ schoolId, actorId: fixture.actorId, teachingSessionId: fixture.authorityId,
        targetScope: "class", commandType: "open-tab", rawCommandPayload: { url: "https://example.invalid/mixed" },
        targets: fixture.chosen.map(binding => ({ ...binding, studentName: "Synthetic", available: true, stateAuthorized: true })) }); }
      finally { store.client.query = original; }
    });
    issuedCommandId = result.command.id;
    assert.equal(cohortLockQueries, 2, "creation and delivery each use their own bounded cohort transaction");
    assert.equal(injected, true, "race occurs after immutable command creation and before delivery authority acquisition");
    assert.equal(deliveryStatements, 13, "real revisionless execute-command uses the bounded cohort transaction");
    console.log(`Plain natural execute cohort SQL statements: ${deliveryStatements}`);
    assert.ok(result.command.targets.every(target => !(target.result && typeof target.result === "object" && "frozenControlRevision" in target.result)), "ordinary persisted open-tab intentionally remains revisionless");
    const first = result.command.targets.find(target => target.studentId === fixture.chosen[0]!.studentId)!;
    const second = result.command.targets.find(target => target.studentId === fixture.chosen[1]!.studentId)!;
    assert.equal(first.status, "unavailable");
    assert.equal(first.errorMessage, "Classroom command authority changed before delivery");
    assert.equal(second.status, "requested", "a retired exact binding stays unsent rather than being mislabeled an authority denial");
    assert.equal(second.sentAt, null);
    assert.ok(result.command.targets.filter(target => target !== first && target !== second).every(target => target.status === "sent"));
    assert.equal(result.summary.requested, 40); assert.equal(result.summary.unavailable, 1); assert.equal(result.summary.attempted, 38);
    const { publicClasspilotCommand } = await import("../src/services/classpilotCommandPublic.js");
    const publicCommand = publicClasspilotCommand(result.command);
    assert.doesNotMatch(JSON.stringify(publicCommand), /deviceId|studentSessionId|frozenControlRevision/);
    assert.match(result.message, /38 students.*1 student unavailable/);
  } finally {
    await admin.query("UPDATE student_sessions SET is_active=true WHERE id=$1", [fixture.chosen[1]!.studentSessionId]);
    if (issuedCommandId) {
      await admin.query("DELETE FROM classpilot_command_targets WHERE command_id=$1", [issuedCommandId]);
      await admin.query("DELETE FROM classpilot_commands WHERE id=$1", [issuedCommandId]);
    }
    await fixture.dispose();
  }
});

test("plain delivery cannot borrow a genuine foreign school's command or exact student binding", async () => {
  const fixture = await plainOpenFixture(bindings.slice(2, 4));
  const foreignSchool = randomUUID(), foreignActor = randomUUID(), foreignStudent = randomUUID(), foreignDevice = randomUUID(), foreignSession = randomUUID(), foreignContext = randomUUID(), foreignCommand = randomUUID();
  const foreignBinding = { schoolId: foreignSchool, studentId: foreignStudent, studentSessionId: foreignSession, deviceId: foreignDevice };
  try {
    await admin.query("INSERT INTO schools(id,name,domain,status,plan_status) VALUES($1,'Synthetic foreign cohort',$2,'active','active')", [foreignSchool, `${foreignSchool}.example.edu`]);
    await admin.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')", [foreignSchool]);
    await admin.query("INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'Synthetic','Foreign')", [foreignActor, `${foreignActor}@${foreignSchool}.example.edu`]);
    await admin.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,'teacher','active')", [foreignSchool, foreignActor]);
    await admin.query("INSERT INTO students(id,school_id,first_name,last_name,status) VALUES($1,$2,'Synthetic','Foreign','active')", [foreignStudent, foreignSchool]);
    await admin.query("INSERT INTO devices(device_id,school_id,class_id) VALUES($1,$2,'synthetic')", [foreignDevice, foreignSchool]);
    await admin.query("INSERT INTO student_sessions(id,student_id,device_id,auth_kind) VALUES($1,$2,$3,'managed_profile')", [foreignSession, foreignStudent, foreignDevice]);
    await admin.query("INSERT INTO classpilot_supervision_contexts(id,school_id,context_type,name,assigned_staff_id,created_by,starts_at,ends_at) VALUES($1,$2,'other','Synthetic foreign cohort',$3,$3,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour')", [foreignContext, foreignSchool, foreignActor]);
    await admin.query("INSERT INTO classpilot_supervision_students(school_id,context_id,student_id,assigned_by) VALUES($1,$2,$3,$4)", [foreignSchool, foreignContext, foreignStudent, foreignActor]);
    await tenant.runWithTenantContext({ schoolId: foreignSchool }, () => storage.initializeClasspilotSupervisionControlStates({ schoolId: foreignSchool, supervisionContextId: foreignContext, studentIds: [foreignStudent] }));
    await admin.query("INSERT INTO classpilot_commands(id,school_id,supervision_context_id,teacher_id,target_scope,command_type,command_payload,expires_at) VALUES($1,$2,$3,$4,'context','open-tab','{\"url\":\"https://example.invalid/foreign\"}'::jsonb,clock_timestamp()+interval '15 seconds')", [foreignCommand, foreignSchool, foreignContext, foreignActor]);
    await admin.query("INSERT INTO classpilot_command_targets(command_id,school_id,supervision_context_id,student_id,student_session_id,device_id) VALUES($1,$2,$3,$4,$5,$6)", [foreignCommand, foreignSchool, foreignContext, foreignStudent, foreignSession, foreignDevice]);
    const authorized = await tenant.runWithTenantContext({ schoolId: foreignSchool }, () => storage.withClasspilotPlainOpenTabDeliveryBatch({ schoolId: foreignSchool, commandId: foreignCommand, targets: [foreignBinding] }, () => true));
    assert.equal(authorized[0]!.authorized, true, "foreign authority and binding are independently valid in their own tenant");
    const borrowedCommand = await inSchool(() => storage.withClasspilotPlainOpenTabDeliveryBatch({ schoolId, commandId: foreignCommand, targets: fixture.chosen }, () => assert.fail("foreign command delivered")));
    assert.ok(borrowedCommand.every(outcome => !outcome.authorized));
    const borrowedBinding = await inSchool(() => storage.withClasspilotPlainOpenTabDeliveryBatch({ schoolId, commandId: fixture.commandId, targets: [{ ...foreignBinding, schoolId }] }, () => assert.fail("foreign binding delivered")));
    assert.ok(borrowedBinding.every(outcome => !outcome.authorized));
  } finally {
    await admin.query("DELETE FROM classpilot_command_targets WHERE command_id=$1", [foreignCommand]);
    await admin.query("DELETE FROM classpilot_commands WHERE id=$1", [foreignCommand]);
    await admin.query("DELETE FROM classpilot_student_control_states WHERE school_id=$1", [foreignSchool]);
    await admin.query("DELETE FROM classpilot_supervision_students WHERE context_id=$1", [foreignContext]);
    await admin.query("DELETE FROM classpilot_supervision_contexts WHERE id=$1", [foreignContext]);
    await admin.query("DELETE FROM student_sessions WHERE id=$1", [foreignSession]);
    await admin.query("DELETE FROM devices WHERE school_id=$1", [foreignSchool]);
    await admin.query("DELETE FROM students WHERE school_id=$1", [foreignSchool]);
    await admin.query("DELETE FROM product_licenses WHERE school_id=$1", [foreignSchool]);
    await admin.query("DELETE FROM school_memberships WHERE school_id=$1", [foreignSchool]);
    await fixture.dispose();
  }
});
