import test from "node:test";
import assert from "node:assert/strict";
import {
  CLASSPILOT_STUDENT_AUTH_GATE_PRESENCE_TTL_SECONDS,
  classpilotStudentAuthGatePresenceKey,
  createClasspilotStudentAuthGatePresenceStore,
} from "../src/services/classpilotStudentAuthGatePresence.js";
import {
  classpilotStudentRosterTransferDecision,
  classpilotStudentSessionTransferDecision,
} from "../src/services/classpilotStudentSessionTransfer.js";

const binding = {
  schoolId: "school-sensitive-id",
  studentId: "student-sensitive-id",
  studentSessionId: "session-sensitive-id",
  deviceId: "device-sensitive-id",
};

test("auth-gate presence uses an opaque exact-binding key and bounded TTL", async () => {
  const previousRedis = process.env.REDIS_URL;
  process.env.REDIS_URL = "redis://configured.test";
  const calls: string[][] = [];
  const store = createClasspilotStudentAuthGatePresenceStore(async (args) => {
    calls.push(args);
    return "OK";
  });
  try {
    const now = 1_800_000_000_000;
    const renewed = await store.renew(binding, now);
    assert.deepEqual(renewed, {
      status: "present",
      presence: {
        observedAt: now,
        expiresAt: now + CLASSPILOT_STUDENT_AUTH_GATE_PRESENCE_TTL_SECONDS * 1_000,
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[0], "SET");
    assert.equal(calls[0]?.[3], "EX");
    assert.equal(calls[0]?.[4], String(CLASSPILOT_STUDENT_AUTH_GATE_PRESENCE_TTL_SECONDS));
    const key = classpilotStudentAuthGatePresenceKey(binding);
    for (const identifier of Object.values(binding)) {
      assert.equal(key.includes(identifier), false);
    }
  } finally {
    if (previousRedis === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previousRedis;
  }
});

test("auth-gate presence store fails closed when configured Redis is unavailable", async () => {
  const previousRedis = process.env.REDIS_URL;
  process.env.REDIS_URL = "redis://configured.test";
  const store = createClasspilotStudentAuthGatePresenceStore(async () => undefined);
  try {
    assert.deepEqual(await store.renew(binding, 1_800_000_000_000), {
      status: "unavailable",
    });
    assert.deepEqual(await store.read(binding, 1_800_000_000_000), {
      status: "unavailable",
    });
  } finally {
    if (previousRedis === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previousRedis;
  }
});

test("manual transfer policy has an inclusive 60-second PostgreSQL fallback", () => {
  const startedAt = new Date("2026-08-30T12:00:00.000Z");
  const absent = { status: "absent" } as const;
  assert.deepEqual(classpilotStudentSessionTransferDecision({
    authKind: "manual_shared",
    sessionStartedAt: startedAt,
    latestHeartbeatAt: startedAt,
    gatePresence: absent,
    now: startedAt.getTime() + 59_999,
  }), { status: "blocked" });
  assert.deepEqual(classpilotStudentSessionTransferDecision({
    authKind: "manual_shared",
    sessionStartedAt: startedAt,
    latestHeartbeatAt: startedAt,
    gatePresence: absent,
    now: startedAt.getTime() + 60_000,
  }), { status: "allowed", source: "stale_heartbeat" });
  assert.deepEqual(classpilotStudentSessionTransferDecision({
    authKind: "manual_shared",
    sessionStartedAt: startedAt,
    latestHeartbeatAt: startedAt,
    gatePresence: absent,
    now: startedAt.getTime() + 60_001,
  }), { status: "allowed", source: "stale_heartbeat" });
});

test("newer exact heartbeat supersedes gate presence and store outages preserve stale fallback", () => {
  const startedAt = new Date("2026-08-30T12:00:00.000Z");
  const gateObservedAt = startedAt.getTime() + 10_000;
  const present = {
    status: "present",
    presence: { observedAt: gateObservedAt, expiresAt: gateObservedAt + 30_000 },
  } as const;
  assert.deepEqual(classpilotStudentSessionTransferDecision({
    authKind: "manual_shared",
    sessionStartedAt: startedAt,
    latestHeartbeatAt: new Date(gateObservedAt - 1),
    gatePresence: present,
    now: gateObservedAt + 1,
  }), { status: "allowed", source: "gate_presence" });
  assert.deepEqual(classpilotStudentSessionTransferDecision({
    authKind: "manual_shared",
    sessionStartedAt: startedAt,
    latestHeartbeatAt: new Date(gateObservedAt + 1),
    gatePresence: present,
    now: gateObservedAt + 2,
  }), { status: "blocked" });
  assert.deepEqual(classpilotStudentSessionTransferDecision({
    authKind: "manual_shared",
    sessionStartedAt: startedAt,
    latestHeartbeatAt: startedAt,
    gatePresence: { status: "unavailable" },
    now: startedAt.getTime() + 59_999,
  }), { status: "unavailable" });
  assert.deepEqual(classpilotStudentSessionTransferDecision({
    authKind: "manual_shared",
    sessionStartedAt: startedAt,
    latestHeartbeatAt: startedAt,
    gatePresence: { status: "unavailable" },
    now: startedAt.getTime() + 60_000,
  }), { status: "allowed", source: "stale_heartbeat" });
  assert.deepEqual(classpilotStudentSessionTransferDecision({
    authKind: "managed_profile",
    sessionStartedAt: startedAt,
    latestHeartbeatAt: null,
    gatePresence: present,
    now: gateObservedAt + 1,
  }), { status: "blocked" });
  assert.deepEqual(classpilotStudentSessionTransferDecision({
    authKind: "legacy",
    sessionStartedAt: startedAt,
    latestHeartbeatAt: null,
    gatePresence: present,
    now: gateObservedAt + 1,
  }), { status: "blocked" });
});

test("roster visibility fails closed for multiple authorities", () => {
  const startedAt = new Date("2026-08-30T12:00:00.000Z");
  const now = startedAt.getTime() + 60_000;
  const authority = (id: string) => ({
    id,
    authKind: "manual_shared" as const,
    startedAt,
    latestHeartbeatAt: startedAt,
  });
  assert.deepEqual(classpilotStudentRosterTransferDecision({
    authorities: [authority("session-a"), authority("session-b")],
    gatePresenceBySession: new Map(),
    now,
  }), { status: "hidden" });
  assert.deepEqual(classpilotStudentRosterTransferDecision({
    authorities: [authority("session-a")],
    reclaimableSessionId: "session-a",
    gatePresenceBySession: new Map(),
    now,
  }), { status: "reclaimable" });
});
