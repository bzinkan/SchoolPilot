import assert from "node:assert/strict";
import { after, test } from "node:test";
import { z } from "zod";
import { validateClasspilotCommandPayload } from "../src/services/classpilotCommandValidation.js";
import { classpilotCommandFrameForTarget } from "../src/services/classpilotCommandDispatcher.js";
import { publicClasspilotCommand } from "../src/services/classpilotCommandPublic.js";
import { classpilotCommandAuthorityEnvelope } from "../src/services/classpilotCommandAuthority.js";

const now = new Date("2026-09-30T10:00:00.123Z");
const target = { studentId: "student", studentSessionId: "login", deviceId: "device", status: "requested" as const };
const source = { id: "source", schoolId: "school", teacherId: "actor", teachingSessionId: null, supervisionContextId: "context", commandType: "apply-flight-path" };
const sourceTarget = { ...target, schoolId: "school", commandId: "source", status: "completed" as const, result: { outcome: "applied", appliedRevision: 7 } };
after(async () => {
  await (await import("../src/services/errorMonitor.js")).default.disposeAndWait();
  const pools = await import("../src/db.js");
  const scheduler = await import("../src/services/schedulerDb.js");
  await Promise.all([pools.pool.end(), pools.sessionPool.end(), scheduler.schedulerPool.end(), scheduler.schedulerLockPool.end()]);
});
test("dependent open wire contains only URL with exact freeze and protected teacher projection", () => {
  const payload = validateClasspilotCommandPayload("open-tab", { url: "https://example.org/lesson", afterRestrictionCommandId: "source" });
  const frame = classpilotCommandFrameForTarget("school", "open-tab", "open-tab", { ...payload, commandId: "open" },
    { ...target, available: true, studentName: "Student", controlRevision: 7 }, { policy: "transient_action", expiresAt: now }, undefined,
    classpilotCommandAuthorityEnvelope({ teachingSessionId: "class", supervisionContextId: null }));
  const framed = z.object({ command: z.object({ data: z.object({ url: z.literal("https://example.org/lesson") }).strict() }),
    exactBinding: z.object({ controlRevision: z.literal(7) }) }).parse(frame);
  assert.deepEqual(framed.command.data, { url: "https://example.org/lesson" });
  assert.equal(framed.exactBinding.controlRevision, 7);
  const projected = JSON.stringify(publicClasspilotCommand({ ...source, targets: [{ ...sourceTarget, result: {
    ...sourceTarget.result, frozenControlRevision: 7, deviceId: "hidden-device", studentSessionId: "hidden-login" } }] }));
  assert.ok(!projected.includes("hidden-device") && !projected.includes("hidden-login") && !projected.includes("frozenControlRevision"));
  assert.throws(() => validateClasspilotCommandPayload("open-tab", { url: "example.org", afterRestrictionCommandId: "x".repeat(129) }));
});
