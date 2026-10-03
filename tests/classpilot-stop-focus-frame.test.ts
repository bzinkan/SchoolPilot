import assert from "node:assert/strict";
import { after, test } from "node:test";
import { z } from "zod";
import { classpilotCommandAuthorityEnvelope } from "../src/services/classpilotCommandAuthority.js";
import { classpilotCommandFrameForTarget } from "../src/services/classpilotCommandDispatcher.js";
import { emptyClasspilotRestrictions } from "../src/services/classpilotClassroomState.js";
import { publicClasspilotCommand } from "../src/services/classpilotCommandPublic.js";

const target = { studentId: "student", studentName: "Student", studentSessionId: "login", deviceId: "device", available: true, controlRevision: 6 };
const now = new Date("2026-10-02T12:00:00Z");
const snapshot = { schemaVersion: 1 as const, revision: 7, teachingSessionId: "class", receivedAt: now.toISOString(),
  scheduledEndAt: null, hardExpiresAt: new Date(now.getTime() + 60_000).toISOString(), restrictions: emptyClasspilotRestrictions() };
const expectedBinding = { bindingVersion: 2, schoolId: "school", studentId: "student", studentSessionId: "login", deviceId: "device", controlRevision: 7 };
const exact = z.object({ bindingVersion: z.literal(2), schoolId: z.string(), studentId: z.string(), studentSessionId: z.string(), deviceId: z.string(), controlRevision: z.number().int().nonnegative() }).strict();
const framed = z.object({ exactBinding: exact, command: z.object({ exactBinding: exact, type: z.literal("stop-focus") }) });
const make = (overrides: Partial<typeof target> = {}, state = snapshot, schoolId = "school") => classpilotCommandFrameForTarget(
  schoolId, "stop-focus", "stop-focus", { commandId: "stop" }, { ...target, ...overrides },
  { policy: "persistent_control", expiresAt: new Date(now.getTime() + 60_000) }, state,
  classpilotCommandAuthorityEnvelope({ teachingSessionId: "class" }));

after(async () => {
  await (await import("../src/services/errorMonitor.js")).default.disposeAndWait();
  const pools = await import("../src/db.js"), scheduler = await import("../src/services/schedulerDb.js");
  await Promise.all([pools.pool.end(), pools.sessionPool.end(), scheduler.schedulerPool.end(), scheduler.schedulerLockPool.end()]);
});

test("Stop Focus carries complete current V2 authority without requiring a remaining capability", () => {
  const frame = make();
  const parsed = framed.parse(frame);
  assert.deepEqual(parsed.exactBinding, expectedBinding);
  assert.deepEqual(parsed.command.exactBinding, expectedBinding);
  assert.ok(frame && "classroomState" in frame);
  assert.deepEqual(frame.classroomState, snapshot);
  assert.equal("requiredCapability" in frame, false);
  assert.equal("requiredCapabilities" in frame, false);
});

test("Stop Focus keeps unrelated restrictions and private transport bindings out of teacher DTOs", () => {
  const state = { ...snapshot, restrictions: { ...snapshot.restrictions,
    blockList: { active: true, blockedDomains: ["blocked.example"], name: "Existing school policy" }, tabLimit: 5 } };
  const frame = make({}, state);
  framed.parse(frame);
  assert.ok(frame && "classroomState" in frame);
  assert.deepEqual(frame.classroomState, state);
  const dto = publicClasspilotCommand({ id: "stop", commandType: "stop-focus", targets: [{ ...target, result: { frozenControlRevision: 7 } }] });
  const serialized = JSON.stringify(dto);
  assert.ok(!serialized.includes("deviceId") && !serialized.includes("studentSessionId") && !serialized.includes("frozenControlRevision"));
});

test("Stop Focus refuses an incomplete exact tuple or invalid authoritative revision", () => {
  for (const key of ["studentId", "studentSessionId", "deviceId"] as const) {
    for (const value of ["", " "]) assert.equal(make({ [key]: value }), null, key);
  }
  for (const schoolId of ["", " "]) assert.equal(make({}, snapshot, schoolId), null);
  for (const revision of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(make({}, { ...snapshot, revision }), null, String(revision));
  const withoutRevision = classpilotCommandFrameForTarget("school", "stop-focus", "stop-focus", { commandId: "stop" },
    { studentId: "student", studentName: "Student", studentSessionId: "login", deviceId: "device", available: true },
    { policy: "persistent_control", expiresAt: now }, undefined,
    classpilotCommandAuthorityEnvelope({ teachingSessionId: "class" }));
  assert.equal(withoutRevision, null);
});
