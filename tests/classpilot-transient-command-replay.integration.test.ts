import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { sql } from "drizzle-orm";
import { WebSocket, type WebSocketServer } from "ws";
import { CLASSPILOT_SCHEDULED_CLASSROOM_SQL } from "../src/db/classpilotScheduledClassroomMigration.js";
import { CLASSPILOT_TOOLS_SQL } from "../src/db/classpilotToolsMigration.js";

// Mirrors production: no Redis in this lane, Class Tools at phase 0 (legacy
// timer payloads carry no timerId), replay lane and deadline override unset.
process.env.REDIS_URL = "";
delete process.env.CLASSPILOT_TRANSIENT_REPLAY_ON_AUTH;
delete process.env.CLASSPILOT_TRANSIENT_REPLAY_SCHOOL_IDS;
delete process.env.CLASSPILOT_TIMER_POLL_COMMAND_TTL_MS;
delete process.env.CLASSPILOT_CLASS_TOOLS_SCHOOLS_JSON;

type Frame = Record<string, any>;
type Student = { studentId: string; deviceId: string; studentSessionId: string };
type TargetRow = { student_id: string; status: string; error_message: string | null; received_at: Date | null };

const tag = `transient_replay_${randomUUID().replaceAll("-", "")}`;
let db: typeof import("../src/db.js").default;
let pool: import("pg").Pool;
let storage: typeof import("../src/services/storage.js");
let dispatcher: typeof import("../src/services/classpilotCommandDispatcher.js");
let websocket: typeof import("../src/realtime/websocket.js");
let runtime: typeof import("../src/services/runtimePerformanceMetrics.js");
let lifecycle: typeof import("../src/services/classpilotSessionLifecycle.js");
let createStudentToken: typeof import("../src/services/deviceJwt.js").createStudentToken;
let runWithTenantContext: typeof import("../src/middleware/tenantContext.js").runWithTenantContext;
type Dispatched = Awaited<ReturnType<typeof dispatcher.executeClasspilotCommand>>;

let schoolId = "";
let teacherId = "";
let teachingSessionId = "";
const students: Student[] = [];
let httpServer: Server | undefined;
let wss: WebSocketServer | undefined;
let wsUrl = "";
const clients: WebSocket[] = [];

const inSchool = <T>(fn: () => Promise<T>) => runWithTenantContext({ schoolId }, fn);

before(async () => {
  ({ default: db, pool } = await import("../src/db.js"));
  storage = await import("../src/services/storage.js");
  dispatcher = await import("../src/services/classpilotCommandDispatcher.js");
  websocket = await import("../src/realtime/websocket.js");
  runtime = await import("../src/services/runtimePerformanceMetrics.js");
  lifecycle = await import("../src/services/classpilotSessionLifecycle.js");
  ({ createStudentToken } = await import("../src/services/deviceJwt.js"));
  ({ runWithTenantContext } = await import("../src/middleware/tenantContext.js"));
  // classpilot_timers is migration-owned (not in the drizzle push); a legacy
  // timer stop tombstones it. Install it exactly as the class-tools lane does:
  // the scheduled classroom SQL first, which defines the parent guard the tools
  // SQL references.
  await pool.query(CLASSPILOT_SCHEDULED_CLASSROOM_SQL);
  await pool.query(CLASSPILOT_TOOLS_SQL);

  const school = await storage.createSchool({ name: tag, slug: tag, domain: `${tag}.example.edu` });
  schoolId = school.id;
  // Student WebSocket auth requires a monitoring policy of "full": a settings
  // row without tracking hours is always inside the instructional window.
  await pool.query(
    "INSERT INTO settings (school_id, school_name, ws_shared_key, enable_tracking_hours, after_hours_mode, pause_chat_during_testing) VALUES ($1, $2, 'test-only', false, 'off', false)",
    [schoolId, tag],
  );
  const teacher = await storage.createUser({ email: `teacher@${tag}.example.edu`, firstName: "Replay", lastName: "Teacher" });
  teacherId = teacher.id;
  await storage.createMembership({ schoolId, userId: teacherId, role: "teacher", status: "active" });
  await storage.createProductLicense({ schoolId, product: "CLASSPILOT", status: "active" });
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
  if (teachingSessionId) {
    await lifecycle.finalizeClasspilotSession({ schoolId, sessionId: teachingSessionId, reason: "manual_end" }).catch(() => undefined);
  }
  await pool.query("DELETE FROM schools WHERE id = $1", [schoolId]).catch(() => undefined);
  const { sessionPool } = await import("../src/db.js");
  await Promise.all([pool.end(), sessionPool.end()]);
});

function rosterTargets() {
  return students.map((student) => ({
    studentId: student.studentId,
    studentName: "Student",
    studentSessionId: student.studentSessionId,
    deviceId: student.deviceId,
    available: true,
    stateAuthorized: true,
  }));
}

/** Dispatch through the real dispatcher with no student socket open. */
function dispatch(commandType: string, rawCommandPayload: Record<string, unknown>): Promise<Dispatched> {
  return inSchool(() => dispatcher.executeClasspilotCommand({
    schoolId,
    actorId: teacherId,
    teachingSessionId,
    targetScope: "class",
    commandType,
    rawCommandPayload,
    targets: rosterTargets(),
    persistClassroomState: true,
  }));
}

/** Authenticate one exact binding over the real socket path and collect every frame. */
async function authenticate(student: Student): Promise<Frame[]> {
  const client = new WebSocket(wsUrl);
  clients.push(client);
  const frames: Frame[] = [];
  client.on("message", (data) => frames.push(JSON.parse(data.toString()) as Frame));
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
  const deadline = Date.now() + 10_000;
  while (!frames.some((frame) => frame.type === "auth-success" || frame.type === "auth-error")) {
    assert.ok(Date.now() < deadline, `timed out authenticating ${student.deviceId}: ${JSON.stringify(frames)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const failure = frames.find((frame) => frame.type === "auth-error");
  assert.equal(failure, undefined, `student auth failed: ${failure?.message}`);
  // Replayed frames are queued synchronously after auth-success inside the same
  // delivery callback; let the transport settle before asserting on them.
  await new Promise((resolve) => setTimeout(resolve, 200));
  return frames;
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

const remoteControl = (frames: Frame[]) => frames.filter((frame) => frame.type === "remote-control");
const counters = () => runtime.snapshotRuntimePerformanceMetrics().counters as Record<string, number | undefined>;

async function targetRows(commandId: string): Promise<TargetRow[]> {
  const result = await pool.query(
    "SELECT student_id, status, error_message, received_at FROM classpilot_command_targets WHERE command_id = $1 ORDER BY student_id",
    [commandId],
  );
  return result.rows as TargetRow[];
}

/** Stand in for the device's `received` ACK so later cases start clean. */
async function markReceived(commandId: string): Promise<void> {
  await pool.query(
    "UPDATE classpilot_command_targets SET status = 'received', ack_state = 'received', received_at = now(), updated_at = now() WHERE command_id = $1 AND status = 'sent'",
    [commandId],
  );
}

function captureInfo(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  return { lines, restore: () => { console.info = original; } };
}

function ttlMs(dispatched: Dispatched): number {
  return dispatched.command.expiresAt!.getTime() - dispatched.command.createdAt.getTime();
}

describe("transient command replay on student WebSocket auth-success", () => {
  let pendingPoll: Dispatched;
  let openTab: Dispatched;

  it("gives timer/poll a 60 s deadline, keeps 15 s for open-tab, and replays nothing while the flag is off", async () => {
    pendingPoll = await dispatch("poll", { action: "start", question: "Ready to move on?", options: ["Yes", "No"] });
    assert.equal(pendingPoll.deliveryPolicy, "transient_action");
    const pollTtl = ttlMs(pendingPoll);
    assert.ok(pollTtl >= 59_000 && pollTtl <= 61_000, `poll deadline ${pollTtl} ms`);
    const pollRows = await targetRows(pendingPoll.command.id);
    assert.equal(pollRows.length, students.length);
    for (const row of pollRows) {
      // Pinned contract: the dispatcher marks every delivery candidate sent
      // whether or not a socket was present. This is the frame the lane recovers.
      assert.equal(row.status, "sent");
      assert.equal(row.received_at, null);
    }

    openTab = await dispatch("open-tab", { url: "https://example.edu/reading" });
    const tabTtl = ttlMs(openTab);
    assert.ok(tabTtl >= 14_000 && tabTtl <= 16_000, `open-tab deadline ${tabTtl} ms`);
    for (const row of await targetRows(openTab.command.id)) assert.equal(row.status, "sent");

    runtime.snapshotRuntimePerformanceMetrics({ reset: true });
    const frames = await authenticate(students[0]!);
    assert.ok(frames.some((frame) => frame.type === "auth-success"));
    assert.deepEqual(remoteControl(frames), [], "flag off: nothing is replayed");
    assert.equal(counters().transientCommandReplayedOnAuth, undefined);
    await closeClients();
  });

  it("replays the un-received poll frame to its exact binding after auth-success, honours the school allowlist, and never replays open-tab", async () => {
    process.env.CLASSPILOT_TRANSIENT_REPLAY_ON_AUTH = "true";
    process.env.CLASSPILOT_TRANSIENT_REPLAY_SCHOOL_IDS = randomUUID();
    runtime.snapshotRuntimePerformanceMetrics({ reset: true });
    assert.deepEqual(remoteControl(await authenticate(students[0]!)), [], "another school's canary: no replay here");
    assert.equal(counters().transientCommandReplayedOnAuth, undefined);
    await closeClients();

    process.env.CLASSPILOT_TRANSIENT_REPLAY_SCHOOL_IDS = ` ${schoolId} , ${randomUUID()}`;
    const frames = await authenticate(students[0]!);
    const replayed = remoteControl(frames);
    assert.equal(replayed.length, 1, JSON.stringify(replayed));
    const frame = replayed[0]!;
    assert.ok(
      frames.indexOf(frame) > frames.findIndex((candidate) => candidate.type === "auth-success"),
      "the replayed frame follows auth-success",
    );
    assert.equal(frame.commandId, pendingPoll.command.id);
    assert.equal(frame.command.type, "poll");
    assert.equal(frame.command.commandId, pendingPoll.command.id);
    assert.equal(frame.command.data.action, "start");
    assert.equal(frame.command.data.pollId, (pendingPoll.command.commandPayload as Record<string, any>).pollId);
    assert.deepEqual(frame.command.data.options, ["Yes", "No"]);
    assert.equal(frame.studentId, students[0]!.studentId);
    assert.equal(frame.studentSessionId, students[0]!.studentSessionId);
    assert.equal(frame.command.teachingSessionId, teachingSessionId);
    assert.equal(frame.command.authority.teachingSessionId, teachingSessionId);
    assert.equal(frame.deliveryPolicy, "transient_action");
    assert.equal(frame.expiresAt, pendingPoll.command.expiresAt!.toISOString());
    assert.equal(typeof frame._msgId, "string");
    assert.ok(!JSON.stringify(frame).includes(students[0]!.deviceId), "device ids stay transport-only");
    assert.equal(counters().transientCommandReplayedOnAuth, 1);
    // Replay is not receipt: only the device's ACK moves a target.
    for (const row of await targetRows(pendingPoll.command.id)) {
      assert.equal(row.status, "sent");
      assert.equal(row.received_at, null);
    }
    await closeClients();

    // The other student's own target is still pending and replays to that binding only.
    const otherFrames = remoteControl(await authenticate(students[1]!));
    assert.equal(otherFrames.length, 1, JSON.stringify(otherFrames));
    assert.equal(otherFrames[0]!.commandId, pendingPoll.command.id);
    assert.equal(otherFrames[0]!.studentId, students[1]!.studentId);
    assert.equal(otherFrames[0]!.studentSessionId, students[1]!.studentSessionId);
    assert.equal(counters().transientCommandReplayedOnAuth, 2);
    await closeClients();

    delete process.env.CLASSPILOT_TRANSIENT_REPLAY_SCHOOL_IDS;
    await markReceived(pendingPoll.command.id);
    await markReceived(openTab.command.id);
    // One active poll per class: close it before the next case. Its targets
    // are already received, so the close supersedes nothing.
    const closed = await dispatch("poll", {
      action: "close",
      pollId: (pendingPoll.command.commandPayload as Record<string, any>).pollId,
    });
    for (const row of await targetRows(pendingPoll.command.id)) {
      assert.equal(row.status, "received", "received targets are never superseded");
    }
    assert.equal(counters().transientCommandTargetSuperseded, undefined);
    await markReceived(closed.command.id);
  });

  it("a poll close supersedes the undelivered start at dispatch: start targets expire and only the close is replayed", async () => {
    const start = await dispatch("poll", { action: "start", question: "Second poll", options: ["A", "B"] });
    const pollId = (start.command.commandPayload as Record<string, any>).pollId as string;
    for (const row of await targetRows(start.command.id)) assert.equal(row.status, "sent");

    runtime.snapshotRuntimePerformanceMetrics({ reset: true });
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

    const replayed = remoteControl(await authenticate(students[0]!));
    assert.equal(replayed.length, 1, JSON.stringify(replayed));
    assert.equal(replayed[0]!.commandId, close.command.id);
    assert.equal(replayed[0]!.command.type, "poll");
    assert.equal(replayed[0]!.command.data.action, "close");
    assert.equal(replayed[0]!.command.data.pollId, pollId);
    assert.ok(!replayed.some((frame) => frame.commandId === start.command.id), "a superseded start is never replayed");
    await closeClients();
    await markReceived(close.command.id);
  });

  it("a legacy (phase 0) timer stop supersedes the undelivered timer start for its class session", async () => {
    const start = await dispatch("timer", { action: "start", seconds: 300, message: "Independent reading" });
    assert.equal((start.command.commandPayload as Record<string, any>).timerId, undefined, "phase 0 timers carry no server identity");
    const startTtl = ttlMs(start);
    assert.ok(startTtl >= 59_000 && startTtl <= 61_000, `timer deadline ${startTtl} ms`);
    for (const row of await targetRows(start.command.id)) assert.equal(row.status, "sent");

    runtime.snapshotRuntimePerformanceMetrics({ reset: true });
    const stop = await dispatch("timer", { action: "stop" });
    for (const row of await targetRows(start.command.id)) {
      assert.equal(row.status, "expired");
      assert.equal(row.error_message, storage.CLASSPILOT_SUPERSEDED_TARGET_MESSAGE);
    }
    for (const row of await targetRows(stop.command.id)) assert.equal(row.status, "sent");
    assert.equal(counters().transientCommandTargetSuperseded, students.length);

    const replayed = remoteControl(await authenticate(students[1]!));
    assert.equal(replayed.length, 1, JSON.stringify(replayed));
    assert.equal(replayed[0]!.commandId, stop.command.id);
    assert.equal(replayed[0]!.command.type, "timer");
    assert.equal(replayed[0]!.command.data.action, "stop");
    await closeClients();
    await markReceived(stop.command.id);
  });

  it("a timer/poll frame past its (env-overridable) deadline is not replayed, and the sweep accounts the expiry by command type", async () => {
    process.env.CLASSPILOT_TIMER_POLL_COMMAND_TTL_MS = "1000";
    let shortLived: Dispatched;
    try {
      shortLived = await dispatch("poll", { action: "start", question: "Quick check", options: ["Done", "Not yet"] });
    } finally {
      delete process.env.CLASSPILOT_TIMER_POLL_COMMAND_TTL_MS;
    }
    const ttl = ttlMs(shortLived);
    assert.ok(ttl >= 900 && ttl <= 1_100, `overridden deadline ${ttl} ms`);
    for (const row of await targetRows(shortLived.command.id)) assert.equal(row.status, "sent");
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    runtime.snapshotRuntimePerformanceMetrics({ reset: true });
    assert.deepEqual(remoteControl(await authenticate(students[0]!)), [], "an expired frame is never replayed");
    assert.equal(counters().transientCommandReplayedOnAuth, undefined);
    await closeClients();

    const logs = captureInfo();
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
  });
});
