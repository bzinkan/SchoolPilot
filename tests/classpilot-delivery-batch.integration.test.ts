import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { before, after, test } from "node:test";
import { sql } from "drizzle-orm";
import pg from "pg";

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
