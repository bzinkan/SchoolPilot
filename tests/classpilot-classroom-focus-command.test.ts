import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const scope = JSON.parse(readFileSync(new URL("./fixtures/classroom-focus-scope-cases.json", import.meta.url), "utf8")).scope;
const context = { schoolId: "school-a", actorId: "teacher-a", teachingSessionId: "class-a",
  targetScope: "students", targetStudentIds: ["student-a", "student-b"] };
const payload = { url: "https://classroom.google.com/", classroomFocus: { courseId: "course-a", reviewToken: "review-secret" } };

test("canonical Classroom Focus prepares only a verified server scope and discards its review token", async () => {
  const modulePath = "../src/services/classpilotClassroomFocusCommand.js";
  const implementation = await import(modulePath).catch(() => ({}));
  assert.equal(typeof implementation.prepareClassroomFocusCommand, "function", "canonical command review verifier must exist");
  let verified: unknown;
  const result = await implementation.prepareClassroomFocusCommand(context, payload, {
    enabled: true, confirm: async (request: unknown) => { verified = request; return scope; },
  });
  assert.deepEqual(result, { url: payload.url, classroomScope: scope });
  assert.deepEqual(verified, { schoolId: "school-a", actorId: "teacher-a", authority: { teachingSessionId: "class-a" },
    targetStudentIds: context.targetStudentIds, courseId: "course-a", reviewToken: "review-secret" });
  assert.equal(JSON.stringify(result).includes("review-secret"), false);
  for (const url of ["http://classroom.google.com/c/course", "https://www.classroom.google.com/?authuser=1#course"])
    assert.equal((await implementation.prepareClassroomFocusCommand(context, { ...payload, url }, {
      enabled: true, confirm: async () => scope,
    })).url, "https://classroom.google.com/", "the reviewed scope uses the client's canonical HTTPS Classroom destination");
  let sourceCalls = 0;
  const deps = { enabled: true, confirm: async () => { sourceCalls++; return scope; } };
  for (const invalid of [{ ...context, targetScope: "class" }, { ...context, targetStudentIds: [] },
    { ...context, supervisionContextId: "other-context" }, { ...context, targetStudentIds: ["student-a", "student-a"] }]) {
    await assert.rejects(implementation.prepareClassroomFocusCommand(invalid, payload, deps));
  }
  await assert.rejects(implementation.prepareClassroomFocusCommand(context, payload, { ...deps, enabled: false }));
  assert.equal(sourceCalls, 0, "invalid authority, recipients and disabled rollout must fail before provider work");
});
