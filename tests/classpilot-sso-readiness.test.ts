import assert from "node:assert/strict";
import test from "node:test";

import { newestClasspilotSsoReadinessBindingsByDevice } from "../src/services/classpilotSsoReadiness.js";

const cutoff = Date.parse("2026-09-01T12:00:00.000Z");

function session(options: {
  id: string;
  studentId: string;
  deviceId: string;
  startedAt: string;
  lastSeenAt: string;
}) {
  return {
    ...options,
    startedAt: new Date(options.startedAt),
    lastSeenAt: new Date(options.lastSeenAt),
  };
}

test("SSO readiness deterministically selects the newest exact session after device reuse", () => {
  const oldBinding = session({
    id: "session-old",
    studentId: "student-old",
    deviceId: "device-shared",
    startedAt: "2026-09-01T12:00:01.000Z",
    lastSeenAt: "2026-09-01T12:00:10.000Z",
  });
  const transferredBinding = session({
    id: "session-new",
    studentId: "student-new",
    deviceId: "device-shared",
    startedAt: "2026-09-01T12:00:20.000Z",
    lastSeenAt: "2026-09-01T12:00:30.000Z",
  });

  const expected = [{
    studentId: "student-new",
    studentSessionId: "session-new",
    deviceId: "device-shared",
  }];
  assert.deepEqual(
    newestClasspilotSsoReadinessBindingsByDevice(
      [oldBinding, transferredBinding],
      cutoff
    ),
    expected
  );
  assert.deepEqual(
    newestClasspilotSsoReadinessBindingsByDevice(
      [transferredBinding, oldBinding],
      cutoff
    ),
    expected,
    "selection must not depend on getActiveSessions row order"
  );
});

test("SSO readiness breaks equal-heartbeat ties by session start and excludes stale bindings", () => {
  const bindings = newestClasspilotSsoReadinessBindingsByDevice([
    session({
      id: "session-stale",
      studentId: "student-stale",
      deviceId: "device-stale",
      startedAt: "2026-09-01T11:00:00.000Z",
      lastSeenAt: "2026-09-01T11:59:59.999Z",
    }),
    session({
      id: "session-first",
      studentId: "student-first",
      deviceId: "device-transfer",
      startedAt: "2026-09-01T12:00:05.000Z",
      lastSeenAt: "2026-09-01T12:00:40.000Z",
    }),
    session({
      id: "session-second",
      studentId: "student-second",
      deviceId: "device-transfer",
      startedAt: "2026-09-01T12:00:15.000Z",
      lastSeenAt: "2026-09-01T12:00:40.000Z",
    }),
  ], cutoff);

  assert.deepEqual(bindings, [{
    studentId: "student-second",
    studentSessionId: "session-second",
    deviceId: "device-transfer",
  }]);
});
