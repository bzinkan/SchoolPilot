import assert from "node:assert/strict";
import test from "node:test";
import { classpilotTeachingSessionDeadline, classpilotTeachingSessionIsCurrent } from "../src/services/classpilotTeachingSessionWindow.js";

test("manual class authority stops at its frozen school-day deadline before worker cleanup", () => {
  const session = { startTime: new Date("2026-10-30T23:00:00Z"), scheduledEndAt: null,
    manualExpiresAt: new Date("2026-10-31T04:00:00Z"), sessionMode: "live", endTime: null };
  assert.equal(classpilotTeachingSessionDeadline(session).toISOString(), "2026-10-31T04:00:00.000Z");
  assert.equal(classpilotTeachingSessionIsCurrent(session, new Date("2026-10-31T03:59:59.999Z")), true);
  assert.equal(classpilotTeachingSessionIsCurrent(session, session.manualExpiresAt), false);
});

test("scheduled and twelve-hour safety deadlines can end authority before a later manual deadline", () => {
  const startTime = new Date("2026-10-30T11:00:00Z");
  const manualExpiresAt = new Date("2026-10-31T04:00:00Z");
  assert.equal(classpilotTeachingSessionDeadline({ startTime, scheduledEndAt: null, manualExpiresAt }).toISOString(), "2026-10-30T23:00:00.000Z");
  const scheduledEndAt = new Date("2026-10-30T12:00:00Z");
  assert.equal(classpilotTeachingSessionDeadline({ startTime, scheduledEndAt, manualExpiresAt }).toISOString(), scheduledEndAt.toISOString());
  assert.equal(classpilotTeachingSessionDeadline({ startTime, scheduledEndAt: null }).toISOString(), "2026-10-30T23:00:00.000Z");
});
