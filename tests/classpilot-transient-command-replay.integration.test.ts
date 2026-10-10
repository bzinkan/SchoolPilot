import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { sql } from "drizzle-orm";
import pg from "pg";
import { WebSocket, type WebSocketServer } from "ws";
import { CLASSPILOT_SCHEDULED_CLASSROOM_SQL } from "../src/db/classpilotScheduledClassroomMigration.js";
import { CLASSPILOT_TOOLS_SQL } from "../src/db/classpilotToolsMigration.js";

// Mirrors production: no Redis in this lane, Class Tools at phase 0 (legacy
// timer payloads carry no timerId and no deadline), replay lane and deadline
// override unset.
process.env.REDIS_URL = "";
delete process.env.CLASSPILOT_TRANSIENT_REPLAY_ON_AUTH;
delete process.env.CLASSPILOT_TRANSIENT_REPLAY_SCHOOL_IDS;
delete process.env.CLASSPILOT_TIMER_POLL_COMMAND_TTL_MS;
delete process.env.CLASSPILOT_CLASS_TOOLS_SCHOOLS_JSON;

type Frame = Record<string, any>;
type Student = { studentId: string; deviceId: string; studentSessionId: string };
type TargetRow = { student_id: string; status: string; error_message: string | null; received_at: Date | null };
type Connection = { client: WebSocket; frames: Frame[] };

const tag = `transient_replay_${randomUUID().replaceAll("-", "")}`;
let admin: pg.Pool;
let db: typeof import("../src/db.js").default;
let pool: pg.Pool;
let storage: typeof import("../src/services/storage.js");
let dispatcher: typeof import("../src/services/classpilotCommandDispatcher.js");
let replay: typeof import("../src/services/classpilotTransientCommandReplay.js");
let websocket: typeof import("../src/realtime/websocket.js");
let runtime: typeof import("../src/services/runtimePerformanceMetrics.js");
let lifecycle: typeof import("../src/services/classpilotSessionLifecycle.js");
let pushes: typeof import("../src/services/classpilotLifecyclePushes.js");
let createStudentToken: typeof import("../src/services/deviceJwt.js").createStudentToken;
let runWithTenantContext: typeof import("../src/middleware/tenantContext.js").runWithTenantContext;
type Dispatched = Awaited<ReturnType<typeof dispatcher.executeClasspilotCommand>>;
type ReplayAuthority = import("../src/services/classpilotTransientCommandReplay.js").ClasspilotTransientReplayAuthority;
type ReplayEntry = import("../src/services/storage.js").ClasspilotReplayableTransientCommandTarget;

let schoolId = "";
let teacherId = "";
let teachingSessionId = "";
let classEnded = false;
const students: Student[] = [];
let httpServer: Server | undefined;
let wss: WebSocketServer | undefined;
let wsUrl = "";
const clients: WebSocket[] = [];

const inSchool = <T>(fn: () => Promise<T>) => runWithTenantContext({ schoolId }, fn);

before(async () => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.DATABASE_URL || "").hostname),
    "transient replay tests require the local fixture");
  // Fixture rows and assertions use an independent bootstrap connection, so
  // every statement issued by the code under test runs as the application
  // role inside tenant context. The ordinary lane and the restricted-role RLS
  // lane (the production posture) therefore exercise identical paths.
  admin = new pg.Pool({ connectionString: process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL, max: 2 });
  ({ default: db, pool } = await import("../src/db.js"));
  if (process.env.RLS_GUC_ENABLED === "true") {
    // In the RLS lane this suite is the evidence that the replay read and the
    // supersede update work in the production posture, so prove the posture:
    // a restricted, non-owner application role with row security on both
    // command tables. Both lanes swallow failures by design (best-effort
    // supersede, fail-safe replay), so a silent bypass must be impossible.
    const role = await pool.query(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    assert.equal(role.rows[0]?.rolsuper, false, "the application role must not be a superuser");
    assert.equal(role.rows[0]?.rolbypassrls, false, "the application role must not bypass row security");
    const secured = await admin.query(
      "SELECT relname, relrowsecurity, pg_get_userbyid(relowner) = $1 AS owned FROM pg_class WHERE oid IN ('classpilot_commands'::regclass, 'classpilot_command_targets'::regclass) ORDER BY relname",
      [new URL(process.env.DATABASE_URL || "").username],
    );
    assert.equal(secured.rows.length, 2);
    for (const table of secured.rows) {
      assert.equal(table.relrowsecurity, true, `${table.relname} must have row security enabled`);
      assert.equal(table.owned, false, `${table.relname} must not be owned by the application role`);
    }
  }
  storage = await import("../src/services/storage.js");
  dispatcher = await import("../src/services/classpilotCommandDispatcher.js");
  replay = await import("../src/services/classpilotTransientCommandReplay.js");
  websocket = await import("../src/realtime/websocket.js");
  runtime = await import("../src/services/runtimePerformanceMetrics.js");
  lifecycle = await import("../src/services/classpilotSessionLifecycle.js");
  pushes = await import("../src/services/classpilotLifecyclePushes.js");
  ({ createStudentToken } = await import("../src/services/deviceJwt.js"));
  ({ runWithTenantContext } = await import("../src/middleware/tenantContext.js"));
  // classpilot_timers is migration-owned (not in the drizzle push); a legacy
  // timer stop tombstones it. Where the lane has not installed it, install it
  // exactly as the class-tools lane does: the scheduled classroom SQL first,
  // which defines the parent guard the tools SQL references.
  const installed = await admin.query("SELECT to_regclass('public.classpilot_timers') AS timers");
  if (!installed.rows[0]?.timers) {
    await admin.query(CLASSPILOT_SCHEDULED_CLASSROOM_SQL);
    await admin.query(CLASSPILOT_TOOLS_SQL);
  }

  schoolId = randomUUID();
  teacherId = randomUUID();
  await admin.query(
    "INSERT INTO schools(id,name,domain,status,plan_status) VALUES($1,$2,$3,'active','active')",
    [schoolId, tag, `${tag}.example.edu`],
  );
  await admin.query(
    "INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'Replay','Teacher')",
    [teacherId, `teacher@${tag}.example.edu`],
  );
  await admin.query(
    "INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,'teacher','active')",
    [schoolId, teacherId],
  );
  await admin.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')", [schoolId]);
  // Student WebSocket auth requires a monitoring policy of "full": a settings
  // row without tracking hours is always inside the instructional window.
  await admin.query(
    "INSERT INTO settings (school_id, school_name, ws_shared_key, enable_tracking_hours, after_hours_mode, pause_chat_during_testing) VALUES ($1, $2, 'test-only', false, 'off', false)",
    [schoolId, tag],
  );
  await inSchool(async () => {
    const group = await storage.createGroup({ schoolId, teacherId, name: tag, groupType: "teacher_created" });
    for (let index = 0; index < 2; index += 1) {
      const student = await storage.createStudent({ schoolId, firstName: "Replay", lastName: `Student${index}`, status: "active" });
      await db.execute(sql`INSERT INTO group_students (group_id, student_id) VALUES (${group.id}, ${student.id})`);
      const deviceId = `${tag}_${index}`;
      await storage.createDevice({ deviceId, schoolId, classId: "default" });
      await storage.linkStudentDevice({ studentId: student.id, deviceId });
      const active = await storage.setActiveStudentForDevice(deviceId, student.id);
      students.push({ studentId: student.id, deviceId, studentSessionId: active.id });
    }
    const session = await storage.createTeachingSession({ groupId: group.id, teacherId, startTime: new Date(Date.now() - 60_000) });
    teachingSessionId = session.id;
  });

  // The real student WebSocket path: setupWebSocket on an in-process HTTP server.
  httpServer = createServer();
  wss = websocket.setupWebSocket(httpServer);
  await new Promise<void>((resolve) => httpServer!.listen(0, "127.0.0.1", resolve));
  wsUrl = `ws://127.0.0.1:${(httpServer.address() as AddressInfo).port}/ws`;
});

after(async () => {
  delete process.env.CLASSPILOT_TRANSIENT_REPLAY_ON_AUTH;
  delete process.env.CLASSPILOT_TRANSIENT_REPLAY_SCHOOL_IDS;
  delete process.env.CLASSPILOT_TIMER_POLL_COMMAND_TTL_MS;
  await closeClients();
  if (wss) await new Promise<void>((resolve) => wss!.close(() => resolve()));
  if (httpServer) await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
  if (teachingSessionId && !classEnded) await endClass().catch(() => undefined);
  await pushes.flushClasspilotLifecyclePushes().catch(() => undefined);
  await admin.query("DELETE FROM schools WHERE id = $1", [schoolId]).catch(() => undefined);
  await admin.query("DELETE FROM users WHERE id = $1", [teacherId]).catch(() => undefined);
  const { sessionPool } = await import("../src/db.js");
  await Promise.all([pool.end(), sessionPool.end(), admin.end()]);
});

function endClass() {
  return inSchool(() => lifecycle.finalizeClasspilotSession({ schoolId, sessionId: teachingSessionId, reason: "manual_end" }));
}

const bindingOf = (student: Student) => ({
  schoolId,
  studentId: student.studentId,
  studentSessionId: student.studentSessionId,
  deviceId: student.deviceId,
});

function targetsFor(recipients: Student[]) {
  return recipients.map((student) => ({
    studentId: student.studentId,
    studentName: "Student",
    studentSessionId: student.studentSessionId,
    deviceId: student.deviceId,
    available: true,
    stateAuthorized: true,
  }));
}

/** Dispatch through the real dispatcher; whole class unless recipients are given. */
function dispatch(
  commandType: string,
  rawCommandPayload: Record<string, unknown>,
  recipients?: Student[],
): Promise<Dispatched> {
  return inSchool(() => dispatcher.executeClasspilotCommand({
    schoolId,
    actorId: teacherId,
    teachingSessionId,
    targetScope: recipients ? "students" : "class",
    commandType,
    rawCommandPayload,
    targets: targetsFor(recipients ?? students),
    persistClassroomState: true,
  }));
}

/** Dispatch and prove the deadline on the application clock that wrote it. */
async function dispatchWithDeadline(
  ttlMs: number,
  commandType: string,
  rawCommandPayload: Record<string, unknown>,
): Promise<Dispatched> {
  const before = Date.now();
  const dispatched = await dispatch(commandType, rawCommandPayload);
  const after = Date.now();
  const expiresAt = dispatched.command.expiresAt!.getTime();
  assert.ok(
    expiresAt >= before + ttlMs && expiresAt <= after + ttlMs,
    `${commandType} deadline ${expiresAt - before} ms after dispatch began, expected ${ttlMs} ms`,
  );
  return dispatched;
}

async function waitForFrame(frames: Frame[], predicate: () => Frame | undefined, label: string): Promise<Frame> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const found = predicate();
    if (found) return found;
    assert.ok(Date.now() < deadline, `timed out waiting for ${label}: ${JSON.stringify(frames.map((frame) => frame.type))}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Frames on one socket are ordered, so once the reply to a ping sent now has
 * arrived, everything the server queued before it has arrived too.
 */
async function settle(connection: Connection): Promise<void> {
  const seen = connection.frames.filter((frame) => frame.type === "pong").length;
  connection.client.send(JSON.stringify({ type: "ping" }));
  await waitForFrame(
    connection.frames,
    () => connection.frames.filter((frame) => frame.type === "pong")[seen],
    "pong",
  );
}

/** Authenticate one exact binding over the real socket path and collect every frame. */
async function connect(student: Student): Promise<Connection> {
  const client = new WebSocket(wsUrl);
  const connection: Connection = { client, frames: [] };
  clients.push(client);
  client.on("message", (data) => connection.frames.push(JSON.parse(data.toString()) as Frame));
  await once(client, "open");
  client.send(JSON.stringify({
    type: "auth",
    role: "student",
    deviceId: student.deviceId,
    studentToken: createStudentToken({
      schoolId,
      studentId: student.studentId,
      deviceId: student.deviceId,
      sessionId: student.studentSessionId,
    }),
  }));
  const outcome = await waitForFrame(
    connection.frames,
    () => connection.frames.find((frame) => frame.type === "auth-success" || frame.type === "auth-error"),
    `authentication of ${student.deviceId}`,
  );
  assert.equal(outcome.type, "auth-success", `student auth failed: ${outcome.message}`);
  // Replayed frames are queued synchronously after auth-success inside the
  // same delivery callback, so they precede the reply to this ping.
  await settle(connection);
  return connection;
}

async function closeClients(): Promise<void> {
  await Promise.all(clients.splice(0).map((client) => new Promise<void>((resolve) => {
    if (client.readyState === WebSocket.CLOSED) return resolve();
    const timer = setTimeout(() => { client.terminate(); resolve(); }, 500);
    timer.unref();
    client.once("close", () => { clearTimeout(timer); resolve(); });
    client.close();
  })));
  // Let the server observe the closes and unregister the bindings before the
  // next dispatch, so "no socket" is true at dispatch time.
  await new Promise((resolve) => setTimeout(resolve, 50));
}

const remoteControl = (connection: Connection) => connection.frames.filter((frame) => frame.type === "remote-control");
const withoutMessageId = ({ _msgId: _ignored, ...frame }: Frame) => frame;
const payloadOf = (dispatched: Dispatched) => dispatched.command.commandPayload as Record<string, any>;
const counters = () => runtime.snapshotRuntimePerformanceMetrics().counters as Record<string, number | undefined>;
const resetCounters = () => { runtime.snapshotRuntimePerformanceMetrics({ reset: true }); };

async function targetRows(commandId: string): Promise<TargetRow[]> {
  const result = await admin.query(
    "SELECT student_id, status, error_message, received_at FROM classpilot_command_targets WHERE command_id = $1 ORDER BY student_id",
    [commandId],
  );
  return result.rows as TargetRow[];
}

async function targetRow(commandId: string, student: Student): Promise<TargetRow> {
  const row = (await targetRows(commandId)).find((candidate) => candidate.student_id === student.studentId);
  assert.ok(row, `no target for ${student.deviceId}`);
  return row;
}

/** Stand in for the device's `received` ACK so later cases start clean. */
async function markReceived(commandId: string): Promise<void> {
  await admin.query(
    "UPDATE classpilot_command_targets SET status = 'received', ack_state = 'received', received_at = now(), updated_at = now() WHERE command_id = $1 AND status = 'sent'",
    [commandId],
  );
}

function capture(method: "info" | "warn"): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console[method];
  console[method] = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  return { lines, restore: () => { console[method] = original; } };
}

/** What a device in this class holds after auth-success at phase 0. */
const classAuthority = (overrides: Partial<ReplayAuthority> = {}): ReplayAuthority => ({
  activeContexts: [{ teachingSessionId }],
  contextAuthorityRevision: null,
  controlState: null,
  acceptedCapabilities: [],
  ...overrides,
});

/** The pure frame builder, viewed as the loose wire shape these assertions read. */
function frameFor(entry: ReplayEntry, authority: ReplayAuthority, now?: Date): Frame | null {
  return replay.classpilotTransientReplayFrameFor(entry, authority, now) as Frame | null;
}

function pendingFor(student: Student, now?: Date): Promise<ReplayEntry[]> {
  return inSchool(() => storage.listClasspilotReplayableTransientCommandTargets(bindingOf(student), db, { now }));
}

describe("transient command replay on student WebSocket auth-success", () => {
  let pendingPoll: Dispatched;
  let openTab: Dispatched;
  let liveFrame: Frame;

  // Every case starts with the replay on for every school. A case that needs
  // another posture sets it itself, so one failing case cannot leave the next
  // ones running under the wrong switch.
  beforeEach(() => {
    process.env.CLASSPILOT_TRANSIENT_REPLAY_ON_AUTH = "true";
    delete process.env.CLASSPILOT_TRANSIENT_REPLAY_SCHOOL_IDS;
    delete process.env.CLASSPILOT_TIMER_POLL_COMMAND_TTL_MS;
  });

  it("gives timer/poll a 60 s deadline where the replay is enabled, keeps 15 s for open-tab, and replays nothing while the flag is off", async () => {
    // This case owns its posture: the replay is off, except around the one
    // dispatch that must be granted the longer deadline.
    delete process.env.CLASSPILOT_TRANSIENT_REPLAY_ON_AUTH;
    // One student is connected, so the dispatcher's own live frame is on record.
    const live = await connect(students[1]!);
    // The longer deadline exists to give the replay a window, so the dispatcher
    // grants it only while the replay is enabled for this school.
    process.env.CLASSPILOT_TRANSIENT_REPLAY_ON_AUTH = "true";
    process.env.CLASSPILOT_TRANSIENT_REPLAY_SCHOOL_IDS = schoolId;
    try {
      pendingPoll = await dispatchWithDeadline(60_000, "poll", {
        action: "start", question: "Ready to move on?", options: ["Yes", "No"],
      });
    } finally {
      delete process.env.CLASSPILOT_TRANSIENT_REPLAY_ON_AUTH;
      delete process.env.CLASSPILOT_TRANSIENT_REPLAY_SCHOOL_IDS;
    }
    assert.equal(pendingPoll.deliveryPolicy, "transient_action");
    await settle(live);
    const delivered = remoteControl(live);
    assert.equal(delivered.length, 1, JSON.stringify(delivered));
    liveFrame = delivered[0]!;
    assert.equal(liveFrame.commandId, pendingPoll.command.id);

    const pollRows = await targetRows(pendingPoll.command.id);
    assert.equal(pollRows.length, students.length);
    for (const row of pollRows) {
      // Pinned contract: the dispatcher marks every delivery candidate sent
      // whether or not a socket was present. This is the frame the lane recovers.
      assert.equal(row.status, "sent");
      assert.equal(row.received_at, null);
    }

    openTab = await dispatchWithDeadline(15_000, "open-tab", { url: "https://example.edu/reading" });
    for (const row of await targetRows(openTab.command.id)) assert.equal(row.status, "sent");
    await closeClients();

    resetCounters();
    const offline = await connect(students[0]!);
    assert.deepEqual(remoteControl(offline), [], "flag off: nothing is replayed");
    assert.equal(counters().transientCommandReplayedOnAuth, undefined);
    await closeClients();
  });

  it("replays the un-received poll frame to its exact binding after auth-success, honours the school allowlist, and never replays open-tab", async () => {
    process.env.CLASSPILOT_TRANSIENT_REPLAY_ON_AUTH = "true";
    process.env.CLASSPILOT_TRANSIENT_REPLAY_SCHOOL_IDS = randomUUID();
    resetCounters();
    assert.deepEqual(remoteControl(await connect(students[0]!)), [], "another school's canary: no replay here");
    assert.equal(counters().transientCommandReplayedOnAuth, undefined);
    await closeClients();

    process.env.CLASSPILOT_TRANSIENT_REPLAY_SCHOOL_IDS = ` ${schoolId} , ${randomUUID()}`;
    const first = await connect(students[0]!);
    const replayed = remoteControl(first);
    assert.equal(replayed.length, 1, JSON.stringify(replayed));
    const frame = replayed[0]!;
    assert.ok(
      first.frames.indexOf(frame) > first.frames.findIndex((candidate) => candidate.type === "auth-success"),
      "the replayed frame follows auth-success",
    );
    assert.equal(frame.commandId, pendingPoll.command.id);
    assert.equal(frame.command.type, "poll");
    assert.equal(frame.command.commandId, pendingPoll.command.id);
    assert.equal(frame.command.data.action, "start");
    assert.equal(frame.command.data.pollId, payloadOf(pendingPoll).pollId);
    assert.deepEqual(frame.command.data.options, ["Yes", "No"]);
    assert.equal(frame.studentId, students[0]!.studentId);
    assert.equal(frame.studentSessionId, students[0]!.studentSessionId);
    assert.equal(frame.command.teachingSessionId, teachingSessionId);
    assert.equal(frame.command.authority.teachingSessionId, teachingSessionId);
    assert.equal(frame.deliveryPolicy, "transient_action");
    assert.equal(frame.expiresAt, pendingPoll.command.expiresAt!.toISOString());
    assert.ok(!JSON.stringify(frame).includes(students[0]!.deviceId), "device ids stay transport-only");
    assert.equal(counters().transientCommandReplayedOnAuth, 1);
    // Replay is not receipt: only the device's ACK moves a target.
    for (const row of await targetRows(pendingPoll.command.id)) {
      assert.equal(row.status, "sent");
      assert.equal(row.received_at, null);
    }
    await closeClients();

    // The connected student never acknowledged, so its own target is still
    // pending and replays to that binding. The rebuilt frame is the
    // dispatcher's live frame for the same binding, with only a new message id.
    const second = remoteControl(await connect(students[1]!));
    assert.equal(second.length, 1, JSON.stringify(second));
    assert.equal(second[0]!.studentId, students[1]!.studentId);
    assert.notEqual(second[0]!._msgId, liveFrame._msgId);
    assert.deepEqual(withoutMessageId(second[0]!), withoutMessageId(liveFrame));
    assert.equal(counters().transientCommandReplayedOnAuth, 2);
    await closeClients();

    delete process.env.CLASSPILOT_TRANSIENT_REPLAY_SCHOOL_IDS;
    await markReceived(pendingPoll.command.id);
    await markReceived(openTab.command.id);
    // One active poll per class: close it before the next case. Its targets
    // are already received, so the close supersedes nothing.
    resetCounters();
    const closed = await dispatch("poll", { action: "close", pollId: payloadOf(pendingPoll).pollId });
    for (const row of await targetRows(pendingPoll.command.id)) {
      assert.equal(row.status, "received", "received targets are never superseded");
    }
    assert.equal(counters().transientCommandTargetSuperseded, undefined);
    await markReceived(closed.command.id);
  });

  it("a poll close supersedes the undelivered start at dispatch: start targets expire and only the close is replayed", async () => {
    const start = await dispatch("poll", { action: "start", question: "Second poll", options: ["A", "B"] });
    const pollId = payloadOf(start).pollId as string;
    for (const row of await targetRows(start.command.id)) assert.equal(row.status, "sent");

    resetCounters();
    const close = await dispatch("poll", { action: "close", pollId });
    const startRows = await targetRows(start.command.id);
    assert.equal(startRows.length, students.length);
    for (const row of startRows) {
      assert.equal(row.status, "expired");
      assert.equal(row.error_message, storage.CLASSPILOT_SUPERSEDED_TARGET_MESSAGE);
      assert.equal(row.received_at, null);
    }
    for (const row of await targetRows(close.command.id)) assert.equal(row.status, "sent");
    assert.equal(counters().transientCommandTargetSuperseded, students.length);
    assert.equal(counters().transientCommandTargetExpired, undefined, "supersede is accounted apart from deadline expiry");

    const replayed = remoteControl(await connect(students[0]!));
    assert.equal(replayed.length, 1, JSON.stringify(replayed));
    assert.equal(replayed[0]!.commandId, close.command.id);
    assert.equal(replayed[0]!.command.type, "poll");
    assert.equal(replayed[0]!.command.data.action, "close");
    assert.equal(replayed[0]!.command.data.pollId, pollId);
    await closeClients();
    await markReceived(close.command.id);
  });

  it("a legacy timer start is replayed with the seconds remaining, and the latest timer command supersedes earlier undelivered ones", async () => {
    const first = await dispatchWithDeadline(60_000, "timer", { action: "start", seconds: 300, message: "Independent reading" });
    const stored = payloadOf(first);
    assert.equal(stored.timerId, undefined, "phase 0 timers carry no server identity");
    assert.equal(stored.deadline, undefined, "phase 0 timers carry only a duration");
    assert.equal(stored.seconds, 300);
    const createdAt = first.command.createdAt.getTime();

    // Deterministic clock: the dashboard ends a legacy timer at createdAt +
    // seconds, and the extension counts from receipt.
    const later = new Date(createdAt + 20_000);
    const [entry] = await pendingFor(students[0]!, later);
    assert.ok(entry, "the timer start is pending for the offline binding");
    assert.equal(entry.command.id, first.command.id);
    const lateFrame = frameFor(entry, classAuthority(), later);
    assert.equal(lateFrame?.command.data.seconds, 280);
    assert.equal(lateFrame?.command.data.message, "Independent reading");
    assert.equal(payloadOf(first).seconds, 300, "the stored command is not rewritten");
    const shortTimer = { ...entry, command: { ...entry.command, commandPayload: { ...stored, seconds: 15 } } };
    assert.equal(frameFor(shortTimer, classAuthority(), later), null,
      "a timer that already ended is not replayed");
    // A database clock ahead of the application clock can never lengthen a timer.
    assert.equal(
      frameFor(entry, classAuthority(), new Date(createdAt - 5_000))?.command.data.seconds,
      300,
    );

    // The real path: the frame arrives with (about) the full time, never more.
    const offline = remoteControl(await connect(students[0]!));
    assert.equal(offline.length, 1, JSON.stringify(offline));
    assert.equal(offline[0]!.commandId, first.command.id);
    assert.equal(offline[0]!.command.data.action, "start");
    const expected = Math.min(300, Math.round(300 - (Date.now() - createdAt) / 1000));
    assert.ok(Math.abs(offline[0]!.command.data.seconds - expected) <= 1, `replayed ${offline[0]!.command.data.seconds} s, expected about ${expected} s`);
    assert.ok(offline[0]!.command.data.seconds <= 300);
    await closeClients();

    // A second start replaces the first for every student it addresses.
    resetCounters();
    const second = await dispatch("timer", { action: "start", seconds: 120, message: "Clean up" });
    for (const row of await targetRows(first.command.id)) {
      assert.equal(row.status, "expired");
      assert.equal(row.error_message, storage.CLASSPILOT_SUPERSEDED_TARGET_MESSAGE);
    }
    assert.equal(counters().transientCommandTargetSuperseded, students.length);
    const afterSecond = remoteControl(await connect(students[1]!));
    assert.equal(afterSecond.length, 1, JSON.stringify(afterSecond));
    assert.equal(afterSecond[0]!.commandId, second.command.id, "only the latest timer is replayed");
    assert.equal(afterSecond[0]!.command.data.message, "Clean up");
    await closeClients();

    // A legacy stop withdraws the undelivered start; only the stop is replayed.
    resetCounters();
    const stop = await dispatch("timer", { action: "stop" });
    for (const row of await targetRows(second.command.id)) {
      assert.equal(row.status, "expired");
      assert.equal(row.error_message, storage.CLASSPILOT_SUPERSEDED_TARGET_MESSAGE);
    }
    for (const row of await targetRows(stop.command.id)) assert.equal(row.status, "sent");
    assert.equal(counters().transientCommandTargetSuperseded, students.length);
    const afterStop = remoteControl(await connect(students[0]!));
    assert.equal(afterStop.length, 1, JSON.stringify(afterStop));
    assert.equal(afterStop[0]!.commandId, stop.command.id);
    assert.equal(afterStop[0]!.command.data.action, "stop");
    await closeClients();
    await markReceived(stop.command.id);
  });

  it("a timer for other students does not supersede a pending timer, and nothing is superseded while the replay is off", async () => {
    const forFirst = await dispatch("timer", { action: "start", seconds: 90 }, [students[0]!]);
    resetCounters();
    const forSecond = await dispatch("timer", { action: "start", seconds: 45 }, [students[1]!]);
    assert.equal((await targetRow(forFirst.command.id, students[0]!)).status, "sent",
      "a command that does not address the student leaves that student's pending timer alone");
    assert.equal(counters().transientCommandTargetSuperseded, undefined);
    const replayed = remoteControl(await connect(students[0]!));
    assert.equal(replayed.length, 1, JSON.stringify(replayed));
    assert.equal(replayed[0]!.commandId, forFirst.command.id);
    await closeClients();
    await markReceived(forFirst.command.id);
    await markReceived(forSecond.command.id);

    // With the replay off there is no re-send to protect, so a later timer
    // leaves earlier targets on their ordinary deadline. A device receipt that
    // is still in flight is then accepted, as before this lane existed.
    delete process.env.CLASSPILOT_TRANSIENT_REPLAY_ON_AUTH;
    try {
      const earlier = await dispatch("timer", { action: "start", seconds: 60 });
      resetCounters();
      const stop = await dispatch("timer", { action: "stop" });
      const earlierRows = await targetRows(earlier.command.id);
      assert.equal(earlierRows.length, students.length);
      for (const row of earlierRows) {
        assert.equal(row.status, "sent", "the earlier timer keeps its ordinary deadline");
        assert.equal(row.error_message, null);
      }
      assert.equal(counters().transientCommandTargetSuperseded, undefined);
      await markReceived(earlier.command.id);
      await markReceived(stop.command.id);
    } finally {
      process.env.CLASSPILOT_TRANSIENT_REPLAY_ON_AUTH = "true";
    }
  });

  it("replays only frames the device will accept: current class, current scheduled control revision, accepted capability, unexpired", async () => {
    const start = await dispatch("poll", { action: "start", question: "Fence", options: ["A", "B"] });
    const [entry] = await pendingFor(students[0]!);
    assert.ok(entry);
    assert.equal(entry.command.id, start.command.id);
    const build = frameFor;

    assert.equal(build(entry, classAuthority())?.commandId, start.command.id);
    assert.equal(build(entry, classAuthority({ activeContexts: [] })), null, "the class is no longer active for this student");
    assert.equal(build(entry, classAuthority({ activeContexts: [{ teachingSessionId: randomUUID() }] })), null,
      "the student is in a different class now");
    assert.equal(build(entry, classAuthority({ activeContexts: [{ supervisionContextId: randomUUID() }] })), null);
    assert.equal(build(entry, classAuthority(), new Date(start.command.expiresAt!.getTime() + 1)), null, "past the deadline");
    assert.equal(build({ ...entry, target: { ...entry.target, status: "received", receivedAt: new Date() } }, classAuthority()), null);
    assert.equal(build({ ...entry, command: { ...entry.command, commandType: "open-tab" } }, classAuthority()), null,
      "one-shot tab actions are never replayed");

    // Capability-gated frames go only to a socket that accepted the capability.
    const shortText = { ...entry, command: { ...entry.command, commandPayload: { ...payloadOf(start), responseType: "short_text" } } };
    assert.equal(build(shortText, classAuthority()), null);
    assert.equal(build(shortText, classAuthority({ acceptedCapabilities: ["exitTicketsV1"] }))?.commandId, start.command.id);
    const pause = { ...entry, command: { ...entry.command, commandType: "timer",
      commandPayload: { action: "pause", timerId: randomUUID(), revision: 2, deadline: null, pausedRemainingMs: 90_000 } } };
    assert.equal(build(pause, classAuthority()), null);
    assert.equal(build(pause, classAuthority({ acceptedCapabilities: ["timerControlsV1"] }))?.command.data.action, "pause");

    // A revisioned timer start carries its own deadline: sent unchanged while
    // it is still running, dropped once it is over.
    const deadline = new Date(Date.now() + 120_000).toISOString();
    const revisioned = { ...entry, command: { ...entry.command, commandType: "timer",
      commandPayload: { action: "start", seconds: 300, timerId: randomUUID(), revision: 1, deadline, pausedRemainingMs: null } } };
    const revisionedFrame = build(revisioned, classAuthority());
    assert.equal(revisionedFrame?.command.data.seconds, 300);
    assert.equal(revisionedFrame?.command.data.deadline, deadline);
    const over = { ...revisioned, command: { ...revisioned.command,
      commandPayload: { ...revisioned.command.commandPayload, deadline: new Date(Date.now() - 1_000).toISOString() } } };
    assert.equal(build(over, classAuthority()), null);

    // Scheduled classroom frames are bound to the control revision frozen at
    // dispatch; the extension rejects any other revision.
    const supervisionContextId = randomUUID();
    const scheduled = {
      command: { ...entry.command, teachingSessionId: null, supervisionContextId },
      target: { ...entry.target, teachingSessionId: null, supervisionContextId,
        result: { scheduledAuthorityRevision: 7, scheduledContextAuthorityRevision: "3" } },
    };
    const scheduledAuthority = (overrides: Partial<ReplayAuthority> = {}) => classAuthority({
      activeContexts: [{ supervisionContextId }],
      contextAuthorityRevision: "3",
      controlState: { supervisionContextId, revision: 7 },
      acceptedCapabilities: ["scheduledClassroomV1"],
      ...overrides,
    });
    const scheduledFrame = build(scheduled, scheduledAuthority());
    assert.equal(scheduledFrame?.studentControlRevision, 7);
    assert.equal(scheduledFrame?.contextAuthorityRevision, "3");
    assert.equal(scheduledFrame?.command.supervisionContextId, supervisionContextId);
    assert.equal(scheduledFrame?.command.teachingSessionId, null);
    assert.equal(build(scheduled, scheduledAuthority({ controlState: { supervisionContextId, revision: 8 } })), null,
      "a retired control revision is never replayed");
    assert.equal(build(scheduled, scheduledAuthority({ controlState: null })), null, "no delivered control state");
    assert.equal(build(scheduled, scheduledAuthority({ controlState: { supervisionContextId: randomUUID(), revision: 7 } })), null);
    assert.equal(build(scheduled, scheduledAuthority({ contextAuthorityRevision: "4" })), null);
    assert.equal(build(scheduled, scheduledAuthority({ activeContexts: [{ teachingSessionId }] })), null);
    assert.equal(build({ ...scheduled, target: { ...scheduled.target, result: null } }, scheduledAuthority()), null,
      "a scheduled frame without its frozen revision is never replayed");

    const closed = await dispatch("poll", { action: "close", pollId: payloadOf(start).pollId });
    await markReceived(closed.command.id);
  });

  it("a failing replay read degrades to no replay without poisoning the authentication transaction", async () => {
    resetCounters();
    const warnings = capture("warn");
    let preparedFrames: unknown[] = [{ sentinel: true }];
    let outcome: { authorized: true; value: number } | { authorized: false };
    try {
      // The real bootstrap authority: its own mandatory exact-binding check
      // runs after the prepare step, in the same transaction, and would fail
      // with "current transaction is aborted" if the replay read had left the
      // transaction poisoned.
      outcome = await inSchool(() => storage.withClasspilotStudentWebSocketBootstrapAuthority(
        { ...bindingOf(students[0]!), freezeSsoPolicy: true },
        async (transactionDb) => {
          preparedFrames = await replay.prepareClasspilotTransientCommandReplay(
            bindingOf(students[0]!),
            transactionDb,
            classAuthority(),
            { list: async () => { await transactionDb.execute(sql`SELECT 1 / 0`); return []; } },
          );
          return preparedFrames.length;
        },
        (_teacherReplies, replayed) => replayed,
      ));
    } finally {
      warnings.restore();
    }
    assert.deepEqual(preparedFrames, []);
    assert.deepEqual(outcome, { authorized: true, value: 0 }, "authentication completes with nothing replayed");
    assert.equal(counters().transientCommandReplayFailed, 1);
    const line = warnings.lines.find((entry) => entry.includes("Transient command replay skipped"));
    assert.ok(line, JSON.stringify(warnings.lines));
    assert.ok(!line.includes(schoolId) && !line.includes(students[0]!.studentId), "no identifiers in the warning");
  });

  it("a timer/poll frame past its (env-overridable) deadline is not replayed, and the sweep accounts the expiry by command type", async () => {
    process.env.CLASSPILOT_TIMER_POLL_COMMAND_TTL_MS = "1000";
    let shortLived: Dispatched;
    try {
      shortLived = await dispatchWithDeadline(1_000, "poll", { action: "start", question: "Quick check", options: ["Done", "Not yet"] });
    } finally {
      delete process.env.CLASSPILOT_TIMER_POLL_COMMAND_TTL_MS;
    }
    for (const row of await targetRows(shortLived.command.id)) assert.equal(row.status, "sent");
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    resetCounters();
    assert.deepEqual(remoteControl(await connect(students[0]!)), [], "an expired frame is never replayed");
    assert.equal(counters().transientCommandReplayedOnAuth, undefined);
    await closeClients();

    const logs = capture("info");
    let expiredCommandIds: string[];
    try {
      expiredCommandIds = await inSchool(() => storage.expireClasspilotTransientCommandTargets({ schoolId }));
    } finally {
      logs.restore();
    }
    assert.deepEqual(expiredCommandIds, [shortLived.command.id]);
    for (const row of await targetRows(shortLived.command.id)) {
      assert.equal(row.status, "expired");
      assert.equal(row.error_message, "Not delivered before command expired");
    }
    assert.equal(counters().transientCommandTargetExpired, students.length);
    const line = logs.lines
      .map((entry) => { try { return JSON.parse(entry) as Record<string, any>; } catch { return null; } })
      .find((entry) => entry?.event === "classpilot_transient_command_targets_expired");
    assert.ok(line, `expiry log line missing: ${JSON.stringify(logs.lines)}`);
    assert.deepEqual(line.byCommandType, { poll: students.length });
    assert.equal(line.targets, students.length);
    assert.equal(line.commands, 1);
    assert.equal(line.scope, "filtered");
    const serialized = JSON.stringify(line);
    assert.ok(!serialized.includes(schoolId) && !serialized.includes(shortLived.command.id), "aggregate only: no identifiers");

    const closed = await dispatch("poll", { action: "close", pollId: payloadOf(shortLived).pollId });
    await markReceived(closed.command.id);
  });

  it("with the replay off a poll keeps the 15 s deadline, and a pending frame is not replayed after its class has ended", async () => {
    // Production posture at deploy: the replay is off, so the dispatcher keeps
    // the one-shot deadline. Shipping this code alone changes no deadline.
    delete process.env.CLASSPILOT_TRANSIENT_REPLAY_ON_AUTH;
    let start: Dispatched;
    try {
      start = await dispatchWithDeadline(15_000, "poll", { action: "start", question: "Before the bell", options: ["A", "B"] });
    } finally {
      process.env.CLASSPILOT_TRANSIENT_REPLAY_ON_AUTH = "true";
    }
    const [pending] = await pendingFor(students[0]!);
    assert.equal(pending?.command.id, start.command.id, "pending and replayable while the class is running");

    await endClass();
    classEnded = true;
    await pushes.flushClasspilotLifecyclePushes().catch(() => undefined);

    resetCounters();
    const afterClass = await connect(students[0]!);
    assert.ok(afterClass.frames.some((frame) => frame.type === "auth-success"), "the student still authenticates");
    assert.deepEqual(remoteControl(afterClass), [], "the device would reject a frame for an ended class");
    assert.equal(counters().transientCommandReplayedOnAuth, undefined);
    assert.ok(Date.now() < start.command.expiresAt!.getTime(),
      "still inside the deadline: the class fence withheld the frame, not expiry");
    // The target was withheld by the authority fence, not consumed: it is
    // still an undelivered one-shot frame and expires on the normal sweep.
    assert.equal((await targetRow(start.command.id, students[0]!)).status, "sent");
    await closeClients();
  });
});
