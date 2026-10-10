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

/** Run with the timer/poll deadline override set (or unset), whatever the local .env holds. */
function withTimerPollTtlEnv<T>(value: string | undefined, run: () => T): T {
  const previous = process.env.CLASSPILOT_TIMER_POLL_COMMAND_TTL_MS;
  if (value === undefined) delete process.env.CLASSPILOT_TIMER_POLL_COMMAND_TTL_MS;
  else process.env.CLASSPILOT_TIMER_POLL_COMMAND_TTL_MS = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.CLASSPILOT_TIMER_POLL_COMMAND_TTL_MS;
    else process.env.CLASSPILOT_TIMER_POLL_COMMAND_TTL_MS = previous;
  }
}

/** Run with exact replay-lane and deadline variables, whatever the local .env holds. */
function withTransientLaneEnv<T>(values: Record<string, string | undefined>, run: () => T): T {
  const names = [
    "CLASSPILOT_TIMER_POLL_COMMAND_TTL_MS",
    "CLASSPILOT_TRANSIENT_REPLAY_ON_AUTH",
    "CLASSPILOT_TRANSIENT_REPLAY_SCHOOL_IDS",
  ];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) {
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("command delivery policies are fixed; one-shot actions expire after 15 s and timer/poll get 60 s only where the replay is enabled", () => {
  assert.equal(classpilotCommandDeliveryPolicy("lock-screen"), "persistent_control");
  assert.equal(classpilotCommandDeliveryPolicy("temp-unblock"), "persistent_control");
  assert.equal(classpilotCommandDeliveryPolicy("open-tab"), "transient_action");
  assert.equal(classpilotCommandDeliveryPolicy("close-tabs"), "transient_action");
  assert.equal(classpilotCommandDeliveryPolicy("timer"), "transient_action");
  assert.equal(classpilotCommandDeliveryPolicy("poll"), "transient_action");
  assert.equal(classpilotCommandDeliveryPolicy("teacher-message"), "durable_message");
  assert.equal(classpilotCommandDeliveryPolicy("student-sign-out"), "server_authoritative");

  // Defaults, pinned against an explicit environment without the override.
  // Replay off: every one-shot action, timer and poll included, keeps 15 s, so
  // a deploy with the replay off changes no deadline.
  const defaults = {};
  assert.equal(CLASSPILOT_TRANSIENT_COMMAND_TTL_MS, 15_000);
  assert.equal(classpilotTimerPollCommandTtlMs(defaults), 15_000);
  assert.equal(classpilotTimerPollCommandTtlMs(defaults, "school-a"), 15_000);
  for (const commandType of ["open-tab", "close-tab", "close-tabs", "activate-tab", "not-a-command", "timer", "poll"]) {
    assert.equal(classpilotTransientCommandTtlMs(commandType, defaults), 15_000, commandType);
    assert.equal(classpilotTransientCommandTtlMs(commandType, defaults, "school-a"), 15_000, commandType);
  }

  // Replay on for the school: the longer window exists to give the replay time.
  const replayOn = { CLASSPILOT_TRANSIENT_REPLAY_ON_AUTH: "true" };
  const replayCanary = {
    CLASSPILOT_TRANSIENT_REPLAY_ON_AUTH: "true",
    CLASSPILOT_TRANSIENT_REPLAY_SCHOOL_IDS: "school-a",
  };
  for (const commandType of ["timer", "poll"]) {
    assert.equal(classpilotTransientCommandTtlMs(commandType, replayOn, "school-a"), 60_000, commandType);
    assert.equal(classpilotTransientCommandTtlMs(commandType, replayCanary, "school-a"), 60_000, commandType);
    assert.equal(classpilotTransientCommandTtlMs(commandType, replayCanary, "school-b"), 15_000, `${commandType} outside the canary`);
    // Without a school there is no replay decision to follow.
    assert.equal(classpilotTransientCommandTtlMs(commandType, replayOn), 15_000, `${commandType} without a school`);
  }
  for (const commandType of ["open-tab", "close-tab", "close-tabs", "activate-tab", "not-a-command"]) {
    assert.equal(classpilotTransientCommandTtlMs(commandType, replayOn, "school-a"), 15_000, commandType);
  }

  const issuedAt = new Date("2026-08-13T12:00:00.000Z");
  withTransientLaneEnv({}, () => {
    assert.equal(
      classpilotCommandExpiresAt("open-tab", issuedAt)?.getTime(),
      issuedAt.getTime() + CLASSPILOT_TRANSIENT_COMMAND_TTL_MS
    );
    assert.equal(classpilotCommandExpiresAt("close-tabs", issuedAt)?.getTime(), issuedAt.getTime() + 15_000);
    assert.equal(classpilotCommandExpiresAt("activate-tab", issuedAt)?.getTime(), issuedAt.getTime() + 15_000);
    assert.equal(classpilotCommandExpiresAt("timer", issuedAt)?.getTime(), issuedAt.getTime() + 15_000);
    assert.equal(classpilotCommandExpiresAt("poll", issuedAt, "school-a")?.getTime(), issuedAt.getTime() + 15_000);
    assert.equal(classpilotCommandExpiresAt("lock-screen", issuedAt), null);
    assert.equal(classpilotCommandExpiresAt("teacher-message", issuedAt), null);
  });
  withTransientLaneEnv({
    CLASSPILOT_TRANSIENT_REPLAY_ON_AUTH: "true",
    CLASSPILOT_TRANSIENT_REPLAY_SCHOOL_IDS: "school-a",
  }, () => {
    assert.equal(classpilotCommandExpiresAt("timer", issuedAt, "school-a")?.getTime(), issuedAt.getTime() + 60_000);
    assert.equal(classpilotCommandExpiresAt("poll", issuedAt, "school-a")?.getTime(), issuedAt.getTime() + 60_000);
    assert.equal(classpilotCommandExpiresAt("poll", issuedAt, "school-b")?.getTime(), issuedAt.getTime() + 15_000);
    assert.equal(classpilotCommandExpiresAt("poll", issuedAt)?.getTime(), issuedAt.getTime() + 15_000);
    assert.equal(classpilotCommandExpiresAt("open-tab", issuedAt, "school-a")?.getTime(), issuedAt.getTime() + 15_000);
    assert.equal(classpilotCommandExpiresAt("lock-screen", issuedAt, "school-a"), null);
  });
});

test("CLASSPILOT_TIMER_POLL_COMMAND_TTL_MS overrides only the timer/poll deadline and ignores invalid values", () => {
  // Each case uses a value no default produces, so a build that ignored the
  // override could not pass.
  const override = { CLASSPILOT_TIMER_POLL_COMMAND_TTL_MS: "45000" };
  assert.equal(classpilotTransientCommandTtlMs("timer", override), 45_000);
  assert.equal(classpilotTransientCommandTtlMs("poll", override), 45_000);
  assert.equal(classpilotTransientCommandTtlMs("open-tab", override), 15_000);
  // The accepted band is inclusive and tolerates surrounding whitespace.
  assert.equal(classpilotTransientCommandTtlMs("poll", { CLASSPILOT_TIMER_POLL_COMMAND_TTL_MS: "1000" }), 1_000);
  assert.equal(classpilotTransientCommandTtlMs("poll", { CLASSPILOT_TIMER_POLL_COMMAND_TTL_MS: "300000" }), 300_000);
  assert.equal(classpilotTransientCommandTtlMs("poll", { CLASSPILOT_TIMER_POLL_COMMAND_TTL_MS: " 45000 " }), 45_000);
  assert.equal(classpilotTransientCommandTtlMs("poll", { CLASSPILOT_TIMER_POLL_COMMAND_TTL_MS: "90000" }), 90_000);
  assert.equal(classpilotTransientCommandTtlMs("open-tab", { CLASSPILOT_TIMER_POLL_COMMAND_TTL_MS: "90000" }), 15_000);
  // An invalid value is ignored: the deadline falls back to what the replay
  // setting alone decides. That covers a fraction, a value typed in seconds,
  // a unit suffix, and anything outside 1 000 to 300 000 ms.
  for (const invalid of [
    "", "   ", "abc", "0", "-5", "NaN", "Infinity",
    "0.5", "60", "999", "45000.5", "300001", "1e16", "45000ms",
  ]) {
    assert.equal(
      classpilotTransientCommandTtlMs("timer", { CLASSPILOT_TIMER_POLL_COMMAND_TTL_MS: invalid }),
      15_000,
      JSON.stringify(invalid)
    );
    assert.equal(
      classpilotTransientCommandTtlMs("timer", {
        CLASSPILOT_TIMER_POLL_COMMAND_TTL_MS: invalid,
        CLASSPILOT_TRANSIENT_REPLAY_ON_AUTH: "true",
      }, "school-a"),
      60_000,
      `${JSON.stringify(invalid)} with the replay on`
    );
  }
  // A valid override wins in both directions, with or without the replay.
  assert.equal(classpilotTransientCommandTtlMs("poll", {
    CLASSPILOT_TIMER_POLL_COMMAND_TTL_MS: "15000",
    CLASSPILOT_TRANSIENT_REPLAY_ON_AUTH: "true",
  }, "school-a"), 15_000);
  assert.equal(classpilotTransientCommandTtlMs("poll", { CLASSPILOT_TIMER_POLL_COMMAND_TTL_MS: "90000" }, "school-a"), 90_000);

  // The dispatcher reads the deadline per command, so the override takes
  // effect with the environment variable alone, not a new build.
  const issuedAt = new Date("2026-08-13T12:00:00.000Z");
  withTimerPollTtlEnv("45000", () => {
    assert.equal(classpilotCommandExpiresAt("poll", issuedAt)?.getTime(), issuedAt.getTime() + 45_000);
    assert.equal(classpilotCommandExpiresAt("timer", issuedAt, "school-a")?.getTime(), issuedAt.getTime() + 45_000);
    assert.equal(classpilotCommandExpiresAt("open-tab", issuedAt)?.getTime(), issuedAt.getTime() + 15_000);
  });
  // It also shortens the deadline where the replay alone would grant 60 s.
  withTransientLaneEnv({
    CLASSPILOT_TIMER_POLL_COMMAND_TTL_MS: "15000",
    CLASSPILOT_TRANSIENT_REPLAY_ON_AUTH: "true",
  }, () => {
    assert.equal(classpilotCommandExpiresAt("poll", issuedAt, "school-a")?.getTime(), issuedAt.getTime() + 15_000);
  });
});

test("transient replay on auth-success is off by default and honours the school allowlist", () => {
  assert.equal(classpilotTransientReplayOnAuthEnabled("school-a", {}), false);
  assert.equal(classpilotTransientReplayOnAuthEnabled("school-a", { CLASSPILOT_TRANSIENT_REPLAY_ON_AUTH: "1" }), false);
  assert.equal(classpilotTransientReplayOnAuthEnabled("school-a", { CLASSPILOT_TRANSIENT_REPLAY_ON_AUTH: "TRUE" }), false);
  assert.equal(classpilotTransientReplayOnAuthEnabled("school-a", { CLASSPILOT_TRANSIENT_REPLAY_ON_AUTH: "true" }), true);
  assert.equal(classpilotTransientReplayOnAuthEnabled("school-a", {
    CLASSPILOT_TRANSIENT_REPLAY_ON_AUTH: "true",
    CLASSPILOT_TRANSIENT_REPLAY_SCHOOL_IDS: "",
  }), true, "an empty allowlist means every school");
  assert.equal(classpilotTransientReplayOnAuthEnabled("school-a", {
    CLASSPILOT_TRANSIENT_REPLAY_ON_AUTH: "true",
    CLASSPILOT_TRANSIENT_REPLAY_SCHOOL_IDS: " school-b , school-a ",
  }), true);
  assert.equal(classpilotTransientReplayOnAuthEnabled("school-c", {
    CLASSPILOT_TRANSIENT_REPLAY_ON_AUTH: "true",
    CLASSPILOT_TRANSIENT_REPLAY_SCHOOL_IDS: "school-b,school-a",
  }), false);
  assert.equal(classpilotTransientReplayOnAuthEnabled("school-a", {
    CLASSPILOT_TRANSIENT_REPLAY_SCHOOL_IDS: "school-a",
  }), false, "an allowlist never enables the lane on its own");
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
