import assert from "node:assert/strict";
import test from "node:test";
import { previewClassroomFocusReview, confirmClassroomFocusReview } from "../src/services/classpilotClassroomFocusReview.js";
import { buildClassroomFocusSource } from "../src/services/classpilotClassroomFocusSource.js";

const input = { schoolId: "school", actorId: "teacher", authority: { teachingSessionId: "session" }, targetStudentIds: ["one", "two"], courseId: "course" };
const source = () => buildClassroomFocusSource({ id: "course", name: "Synthetic coursework" }, [{ id: "work:1", state: "PUBLISHED", materials: [{ link: { url: "https://reading.example.org/unit?exercise=1" } }] }]);
const dependencies = { enabled: true, resolveSource: async () => source(), now: () => 1000, signingSecret: "fixture-only-secret" };

test("the off gate refuses a Classroom review before reading Google source", async () => {
  let calls = 0;
  await assert.rejects(previewClassroomFocusReview(input, { ...dependencies, enabled: false,
    resolveSource: async () => { calls++; return source(); } }), /not enabled/i);
  assert.equal(calls, 0);
});
test("server review binds the exact actor, school, classroom and students while showing broad external websites", async () => {
  const preview = await previewClassroomFocusReview(input, dependencies);
  assert.ok(preview.warnings.some(item => item.hostname === "reading.example.org"));
  assert.ok(preview.scopes.some(item => item.hostname === "reading.example.org" && item.type === "website"));
  assert.deepEqual(await confirmClassroomFocusReview({ ...input, targetStudentIds: ["two", "one"], reviewToken: preview.reviewToken }, dependencies), source().scope);
  for (const change of [{ actorId: "other" }, { schoolId: "other" }, { authority: { teachingSessionId: "replacement" } }, { targetStudentIds: ["one"] }, { courseId: "other" }])
    await assert.rejects(confirmClassroomFocusReview({ ...input, ...change, reviewToken: preview.reviewToken }, dependencies), /review/i);
  await assert.rejects(confirmClassroomFocusReview({ ...input, reviewToken: preview.reviewToken + "x" }, dependencies), /review/i);
  await assert.rejects(confirmClassroomFocusReview({ ...input, reviewToken: preview.reviewToken }, { ...dependencies, now: () => preview.expiresAt + 1 }), /review/i);
});
test("changed Google source requires another review and opaque context revisions stay exact", async () => {
  const request = { ...input, authority: { supervisionContextId: "context", contextAuthorityRevision: "opaque-revision" } };
  const preview = await previewClassroomFocusReview(request, dependencies);
  await assert.rejects(confirmClassroomFocusReview({ ...request, reviewToken: preview.reviewToken }, { ...dependencies, resolveSource: async () => ({ ...source(), scope: { ...source().scope, sourceRevision: "a".repeat(64) } }) }), /review/i);
  await assert.rejects(confirmClassroomFocusReview({ ...request, authority: { ...request.authority, contextAuthorityRevision: "replacement" }, reviewToken: preview.reviewToken }, dependencies), /review/i);
  await assert.rejects(previewClassroomFocusReview({ ...input, targetStudentIds: [] }, dependencies), /student|target/i);
});
test("a review that expires during the provider reread cannot authorize Focus", async () => {
  const preview = await previewClassroomFocusReview(input, dependencies);
  let now = 1000;
  await assert.rejects(confirmClassroomFocusReview({ ...input, reviewToken: preview.reviewToken }, {
    ...dependencies, now: () => now, resolveSource: async () => { now = preview.expiresAt + 1; return source(); },
  }), /review/i);
});

test("malformed non-ASCII review signatures produce a stale review instead of a server error", async () => {
  const preview = await previewClassroomFocusReview(input, dependencies);
  const payload = preview.reviewToken.split(".")[0];
  await assert.rejects(confirmClassroomFocusReview({ ...input, reviewToken: `${payload}.${"é".repeat(43)}` }, dependencies),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "CLASSROOM_FOCUS_REVIEW_STALE");
});
