import assert from "node:assert/strict";
import test from "node:test";
import { publicClasspilotCommand } from "../src/services/classpilotCommandPublic.js";
import {
  CLASSPILOT_TRANSIENT_COMMAND_TTL_MS,
  classpilotCommandDeliveryPolicy,
  classpilotCommandExpiresAt,
  classpilotTimerPollCommandTtlMs,
  classpilotTransientCommandTtlMs,
  classpilotTransientReplayOnAuthEnabled,
  summarizeClasspilotCommandTargets,
} from "../src/services/classpilotCommandDelivery.js";
import { classpilotTransientCurrentPageCommandEnvelope } from "../src/services/classpilotTransientCurrentPage.js";

test("staff command DTO recursively removes internal routing identifiers", () => {
  const command = {
    id: "command-1",
    teachingSessionId: "teaching-session-1",
    teacherId: "teacher-1",
    commandPayload: {
      targetDeviceIds: ["device-hidden"],
      nested: {
        student_session_id: "student-session-hidden",
        activeDeviceIdentifier: "device-hidden-by-prefix",
        keep: "visible",
      },
    },
    targets: [{
      studentId: "student-visible",
      studentSessionId: "student-session-hidden",
      deviceId: "device-hidden",
      status: "completed",
      result: { target_device_id: "device-hidden-again", outcome: "applied" },
    }],
  };

  const safe = publicClasspilotCommand(command);

  assert.equal(safe.targets[0].studentId, "student-visible");
  assert.equal(safe.targets[0].status, "completed");
  assert.equal(safe.targets[0].result.outcome, "applied");
  assert.equal(safe.commandPayload.nested.keep, "visible");
  assert.equal(JSON.stringify(safe).includes("device-hidden"), false);
  assert.equal(JSON.stringify(safe).includes("student-session-hidden"), false);
  assert.equal(command.targets[0].deviceId, "device-hidden", "serializer must not mutate storage rows");
});

const pilotSchool = "10000000-0000-4000-8000-000000000001";
const otherSchool = "10000000-0000-4000-8000-000000000002";
const timerPilot = { CLASSPILOT_TRANSIENT_REPLAY_ON_AUTH: "true", CLASSPILOT_TRANSIENT_REPLAY_SCHOOL_IDS: pilotSchool };
const pollPilot = { ...timerPilot, CLASSPILOT_PROTOCOL_V3_ENABLED: "true", CLASSPILOT_CAP_SCOPED_AUTHORITY_CHECKS_V1: "true", CLASSPILOT_CAP_POLL_REPLAY_SAFE_V1: "true" };

test("delivery deadlines follow the specific replay gate and retain the 15 s rollback", () => {
  assert.equal(classpilotCommandDeliveryPolicy("lock-screen"), "persistent_control");
  assert.equal(classpilotCommandDeliveryPolicy("teacher-message"), "durable_message");
  assert.equal(classpilotCommandDeliveryPolicy("student-sign-out"), "server_authoritative");
  assert.equal(CLASSPILOT_TRANSIENT_COMMAND_TTL_MS, 15_000);
  assert.equal(classpilotTimerPollCommandTtlMs({}), 15_000);
  for (const type of ["open-tab", "close-tab", "close-tabs", "activate-tab", "timer", "poll"]) {
    assert.equal(classpilotTransientCommandTtlMs(type, {}, pilotSchool), 15_000);
    assert.equal(classpilotTransientCommandTtlMs(type, pollPilot, otherSchool), 15_000);
    assert.equal(classpilotTransientCommandTtlMs(type, pollPilot), 15_000);
  }
  assert.equal(classpilotTransientCommandTtlMs("timer", timerPilot, pilotSchool), 60_000);
  assert.equal(classpilotTransientCommandTtlMs("poll", timerPilot, pilotSchool), 15_000);
  assert.equal(classpilotTransientCommandTtlMs("poll", pollPilot, pilotSchool), 60_000);
  assert.equal(classpilotTransientCommandTtlMs("open-tab", pollPilot, pilotSchool), 15_000);
  assert.equal(classpilotTransientCommandTtlMs("poll", { ...pollPilot, CLASSPILOT_CAP_SCOPED_AUTHORITY_CHECKS_V1: "false" }, pilotSchool), 15_000);
  assert.equal(classpilotTransientCommandTtlMs("poll", { ...pollPilot, CLASSPILOT_CAPABILITY_ROLLOUTS_JSON: JSON.stringify({ scopedAuthorityChecksV1:{mode:"on"},pollReplaySafeV1:{mode:"on",schoolIds:[otherSchool]} }) }, pilotSchool), 15_000);
  const issuedAt = new Date("2026-08-13T12:00:00.000Z");
  const names = Object.keys(pollPilot);
  const saved = names.map(name => process.env[name]);
  try {
    Object.assign(process.env, pollPilot);
    assert.equal(classpilotCommandExpiresAt("timer", issuedAt, pilotSchool)?.getTime(), issuedAt.getTime()+60_000);
    assert.equal(classpilotCommandExpiresAt("poll", issuedAt, pilotSchool)?.getTime(), issuedAt.getTime()+60_000);
    process.env.CLASSPILOT_TRANSIENT_REPLAY_ON_AUTH = "false";
    assert.equal(classpilotCommandExpiresAt("poll", issuedAt, pilotSchool)?.getTime(), issuedAt.getTime()+15_000);
    assert.equal(classpilotCommandExpiresAt("lock-screen", issuedAt, pilotSchool), null);
  } finally { names.forEach((name,index) => { if(saved[index]===undefined) delete process.env[name]; else process.env[name]=saved[index]; }); }
});

test("deadline override is bounded, integral and cannot enable a replay lane", () => {
  for (const value of ["", " ", "abc", "0", "14999", "60001", "90000", "45000.5", "4.5e4", "NaN", "Infinity"]) {
    const override = { CLASSPILOT_TIMER_POLL_COMMAND_TTL_MS: value };
    assert.equal(classpilotTransientCommandTtlMs("timer", override, pilotSchool), 15_000);
    assert.equal(classpilotTransientCommandTtlMs("timer", { ...timerPilot,...override }, pilotSchool), 60_000, value);
    assert.equal(classpilotTransientCommandTtlMs("poll", { ...timerPilot,...override }, pilotSchool), 15_000, value);
  }
  for (const value of ["15000", "45000", "60000"]) {
    const env = { ...pollPilot, CLASSPILOT_TIMER_POLL_COMMAND_TTL_MS: value };
    assert.equal(classpilotTransientCommandTtlMs("timer", env, pilotSchool), Number(value));
    assert.equal(classpilotTransientCommandTtlMs("poll", env, pilotSchool), Number(value));
    assert.equal(classpilotTransientCommandTtlMs("open-tab", env, pilotSchool), 15_000);
  }
});

test("transient replay requires the explicit flag and one canonical pilot UUID", () => {
  assert.equal(classpilotTransientReplayOnAuthEnabled(pilotSchool, timerPilot), true);
  assert.equal(classpilotTransientReplayOnAuthEnabled(otherSchool, timerPilot), false);
  for (const allowlist of [undefined,"", " ","school-a",pilotSchool+","+otherSchool," "+pilotSchool, pilotSchool+","]) {
    assert.equal(classpilotTransientReplayOnAuthEnabled(pilotSchool, { CLASSPILOT_TRANSIENT_REPLAY_ON_AUTH:"true",CLASSPILOT_TRANSIENT_REPLAY_SCHOOL_IDS:allowlist }), false);
  }
  for (const flag of [undefined,"1","TRUE","false"]) assert.equal(classpilotTransientReplayOnAuthEnabled(pilotSchool,{...timerPilot,CLASSPILOT_TRANSIENT_REPLAY_ON_AUTH:flag}),false);
});

test("public command DTO adds policy and reports truthful cumulative and outcome counts", () => {
  const command = {
    commandType: "open-tab",
    expiresAt: new Date("2026-08-13T12:00:15.000Z"),
    targets: [
      { status: "completed", sentAt: new Date(), receivedAt: new Date(), ackState: "completed" },
      { status: "received", sentAt: new Date(), receivedAt: new Date(), ackState: "received" },
      { status: "expired", sentAt: new Date(), receivedAt: null, ackState: "expired" },
      { status: "failed", sentAt: new Date(), receivedAt: null, ackState: "failed" },
      { status: "unavailable", sentAt: null, receivedAt: null, ackState: null },
    ],
  };

  assert.equal(publicClasspilotCommand(command).deliveryPolicy, "transient_action");
  assert.deepEqual(summarizeClasspilotCommandTargets(command), {
    requested: 5,
    attempted: 4,
    acknowledged: 3,
    completed: 1,
    pending: 1,
    expired: 1,
    failed: 1,
    unavailable: 1,
    sent: 4,
    received: 2,
    awaitingAck: 0,
  });
});

test("a current-page Waypoint is reported as transient and stores no observed URL", () => {
  const safe = publicClasspilotCommand({
    commandType: "lock-screen",
    commandPayload: { currentPage: true },
    targets: [],
  });
  assert.equal(safe.deliveryPolicy, "transient_action");
  assert.deepEqual(safe.commandPayload, { currentPage: true });
  assert.equal(JSON.stringify(safe).includes("CURRENT_URL"), false);
});

test("a transient current-page envelope carries only ephemeral auth authority", () => {
  const restrictionExpiresAt = new Date("2026-09-01T13:00:00.000Z");
  const authPassThrough = {
    schemaVersion: 1 as const,
    policyRevision: 7,
    defaultProfileId: "clever",
    attemptTtlSeconds: 300,
    profiles: [{
      id: "clever",
      name: "Clever",
      startUrl: "https://clever.com/in/district?source=schoolpilot",
      hostRules: [
        { hostname: "clever.com", includeSubdomains: true },
        { hostname: "accounts.google.com", includeSubdomains: false },
      ],
    }],
  };
  assert.deepEqual(classpilotTransientCurrentPageCommandEnvelope({
    currentPage: true,
    restrictionExpiresAt,
    authPassThrough,
  }), {
    currentPage: true,
    restrictionExpiresAt: restrictionExpiresAt.toISOString(),
    authPassThrough,
  });
  assert.deepEqual(classpilotTransientCurrentPageCommandEnvelope({}), {});
});
