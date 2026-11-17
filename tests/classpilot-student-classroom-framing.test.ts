import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { emptyClasspilotRestrictions } from "../src/services/classpilotClassroomState.js";
import { classpilotCommandAuthorityEnvelope } from "../src/services/classpilotCommandAuthority.js";
import { createStudentClassroomAccessEnvelope, createStudentClassroomFocusPayload, compileStudentClassroomFlightPath } from "../src/services/classpilotStudentClassroomAccess.js";

process.env.DATABASE_URL = "postgres://fixture:fixture@127.0.0.1:1/student_classroom_no_queries";
const scope = JSON.parse(readFileSync(new URL("./fixtures/classroom-focus-scope-cases.json", import.meta.url), "utf8")).scope;
after(async () => { const { pool, sessionPool } = await import("../src/db.js"); await Promise.all([pool.end(), sessionPool.end()]); });
test("relay source-generation metadata is bounded, server-only and student-binding specific", async () => {
  const { validStudentClassroomPublicationTarget } = await import("../src/realtime/ws-redis.js");
  const target = { kind: "student-binding", schoolId: "school-a", studentId: "student-a", studentSessionId: "session-a", deviceId: "device-a" };
  assert.equal(validStudentClassroomPublicationTarget(target), true);
  assert.equal(validStudentClassroomPublicationTarget({ ...target, requiredStudentClassroomApprovalKey: "a".repeat(64) }), true);
  for (const requiredStudentClassroomApprovalKey of [null, undefined, "a".repeat(63), "A".repeat(64), { key: "a".repeat(64) }]) {
    assert.equal(validStudentClassroomPublicationTarget({ ...target, requiredStudentClassroomApprovalKey }), false);
  }
  assert.equal(validStudentClassroomPublicationTarget({ kind: "staff-session", schoolId: "school-a", sessionId: "class-a",
    requiredStudentClassroomApprovalKey: "a".repeat(64) }), false);
});
test("canonical last-mile framing selects one student's own Classroom permissions and strips private maps", async () => {
  const { classpilotCommandFrameForTarget } = await import("../src/services/classpilotCommandDispatcher.js");
  const source = { studentId: "student-a", scope, courseCount: 2, itemCount: 3, linkCount: 4, approvalKey: "a".repeat(64) };
  const a = createStudentClassroomFocusPayload("school-a", source);
  const b = createStudentClassroomFocusPayload("school-a", { ...source, studentId: "student-b", scope: { ...scope, sourceRevision: "b".repeat(64),
    allowedDomains: [...scope.allowedDomains.filter((domain: string) => domain !== "assigned.example"), "student-b-work.example"] } });
  const payload = { url: a.url, commandId: "command-a", classroomAccessV1: createStudentClassroomAccessEnvelope({ mode: "focus", payloadByStudent: { "student-a": a, "student-b": b } }) };
  const snapshot = { schemaVersion: 1 as const, revision: 3, teachingSessionId: "class-a", supervisionContextId: null,
    receivedAt: "2026-11-16T20:00:00Z", scheduledEndAt: null, hardExpiresAt: "2026-11-17T03:00:00Z",
    restrictions: { ...emptyClasspilotRestrictions(), screenLock: { active: true, ...a,
      classroomScope: { resources: scope.resources, sourceRevision: scope.sourceRevision, schemaVersion: 1, allowedDomains: scope.allowedDomains } } } };
  const target = { schoolId: "school-a", studentId: "student-a", studentSessionId: "session-a", deviceId: "device-a", studentName: "Synthetic", available: true, controlRevision: 3 };
  const delivery = { policy: "persistent_control" as const, expiresAt: null,
    requiredCapabilities: ["preciseRestrictionResourcesV1" as const, "classroomFocusScopeV1" as const] };
  const frame = classpilotCommandFrameForTarget("school-a", "lock-screen", "lock-screen", payload, target, delivery, snapshot, classpilotCommandAuthorityEnvelope({ teachingSessionId: "class-a" }));
  assert.ok(frame, "equivalent JSONB key ordering must not invalidate the recipient policy");
  const bytes = JSON.stringify(frame);
  assert.equal(bytes.includes("student-b"), false);
  assert.equal(bytes.includes("student-b-work.example"), false);
  assert.equal(bytes.includes("classroomAccessV1"), false);
  assert.equal(bytes.includes("classroomMaterials"), false);
  assert.equal(classpilotCommandFrameForTarget("school-a", "lock-screen", "lock-screen", payload, { ...target, studentId: "unknown" }, delivery, snapshot, classpilotCommandAuthorityEnvelope({ teachingSessionId: "class-a" })), null);
  assert.equal(classpilotCommandFrameForTarget("school-a", "lock-screen", "lock-screen", payload, target, delivery,
    { ...snapshot, restrictions: { ...snapshot.restrictions, screenLock: { active: true, ...b } } }, classpilotCommandAuthorityEnvelope({ teachingSessionId: "class-a" })), null);
  const compiled = compileStudentClassroomFlightPath({ schoolId: "school-a", flightPath: { id: "path-a", flightPathName: "Work", allowedDomains: ["classroom.google.com"] }, source: { ...source, scope: { ...scope, resources: [] } } });
  const pathPayload = { flightPathId: "path-a", commandId: "path-command", classroomAccessV1: createStudentClassroomAccessEnvelope({ mode: "flight-path", payloadByStudent: { "student-a": compiled } }) };
  const pathSnapshot = { ...snapshot, restrictions: { ...emptyClasspilotRestrictions(), flightPath: { active: true, ...compiled } } };
  const pathFrame = classpilotCommandFrameForTarget("school-a", "apply-flight-path", "apply-flight-path", pathPayload, target, delivery, pathSnapshot, classpilotCommandAuthorityEnvelope({ teachingSessionId: "class-a" }));
  assert.ok(pathFrame, "domain-only compiled paths retain the Classroom cohort fence");
  assert.equal(JSON.stringify(pathFrame).includes("classroomMaterials"), false);
  assert.equal(classpilotCommandFrameForTarget("school-a", "apply-flight-path", "apply-flight-path", pathPayload, target,
    { ...delivery, requiredCapabilities: ["preciseRestrictionResourcesV1"] }, pathSnapshot, classpilotCommandAuthorityEnvelope({ teachingSessionId: "class-a" })), null);
});
