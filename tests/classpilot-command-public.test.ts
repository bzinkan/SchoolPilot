import assert from "node:assert/strict";
import test from "node:test";
import { publicClasspilotCommand } from "../src/services/classpilotCommandPublic.js";
import {
  CLASSPILOT_TRANSIENT_COMMAND_TTL_MS,
  classpilotCommandDeliveryPolicy,
  classpilotCommandExpiresAt,
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

test("command delivery policies are fixed and transient actions expire after 15 seconds", () => {
  assert.equal(classpilotCommandDeliveryPolicy("lock-screen"), "persistent_control");
  assert.equal(classpilotCommandDeliveryPolicy("temp-unblock"), "persistent_control");
  assert.equal(classpilotCommandDeliveryPolicy("open-tab"), "transient_action");
  assert.equal(classpilotCommandDeliveryPolicy("close-tabs"), "transient_action");
  assert.equal(classpilotCommandDeliveryPolicy("teacher-message"), "durable_message");
  assert.equal(classpilotCommandDeliveryPolicy("student-sign-out"), "server_authoritative");

  const issuedAt = new Date("2026-08-13T12:00:00.000Z");
  assert.equal(
    classpilotCommandExpiresAt("open-tab", issuedAt)?.getTime(),
    issuedAt.getTime() + CLASSPILOT_TRANSIENT_COMMAND_TTL_MS
  );
  assert.equal(classpilotCommandExpiresAt("lock-screen", issuedAt), null);
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
