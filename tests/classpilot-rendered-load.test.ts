import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
const { renderedAgeHistogram, renderedCommandMatches, validateRenderedDashboardInputs, observeRenderedCommandUpdate, renderedDeadline, validateRenderedManifest, renderedCommandRequestPath } = await import(
  new URL("../scripts/load/run-classpilot-rendered-dashboards.mjs", import.meta.url).href,
);

function authFixture(count: number) {
  const classrooms = count === 40 ? 1 : 20, size = count / classrooms;
  const expiresAt = new Date(Date.now() + 48 * 3600_000).toISOString();
  return { schemaVersion: 2, baseUrl: "https://staging.school-pilot.net", schoolId: "primary", expiresAt,
    deviceManifestExpiresAt: expiresAt,
    teacherAuth: Array.from({ length: classrooms }, (_, index) => ({ teacherId: `teacher-${index}`, schoolId: "primary", role: "teacher",
      teachingSessionId: `session-${index}`, teacherCookie: `schoolpilot.staging.sid=synthetic-${index}`,
      teacherToken: `synthetic-token-${index}`, csrfToken: `synthetic-csrf-${index}`, expiresAt,
      studentIds: Array.from({ length: size }, (_, student) => `student-${index}-${student}`) })) };
}
const env = { LOAD_RELIABILITY_STAGING_ORIGIN: "https://staging.school-pilot.net", LOAD_SESSION_COOKIE_NAME: "schoolpilot.staging.sid" };

test("rendered campaign enforces exact1/20 independent teacher cohorts, staging cookie and full-duration credential validity", () => {
  for (const count of [40, 500, 800]) assert.equal(validateRenderedDashboardInputs(authFixture(count), count, env).primaryDevices, count);
  assert.throws(() => validateRenderedDashboardInputs(authFixture(800), 800, { ...env, LOAD_SESSION_COOKIE_NAME: "schoolpilot.sid" }));
  assert.throws(() => validateRenderedDashboardInputs({ ...authFixture(800), baseUrl: "https://school-pilot.net" }, 800, env));
  const duplicate = authFixture(800); duplicate.teacherAuth[1]!.studentIds = duplicate.teacherAuth[0]!.studentIds;
  assert.throws(() => validateRenderedDashboardInputs(duplicate, 800, env));
  const retired = authFixture(800); retired.teacherAuth[0]!.expiresAt = new Date(Date.now() + 30_000).toISOString();
  assert.throws(() => validateRenderedDashboardInputs(retired, 800, env));
});

test("rendered credentials must outlive the shared start plus the entire profile, not merely process launch", () => {
  const auth = authFixture(800), planned = Date.now() + 120_000;
  const expiry = new Date(Date.now() + 5400_000 + 90_000).toISOString();
  auth.expiresAt = expiry; auth.deviceManifestExpiresAt = expiry;
  auth.teacherAuth.forEach(actor => { actor.expiresAt = expiry; });
  assert.equal(validateRenderedDashboardInputs(auth, 800, env).primaryDevices, 800);
  assert.throws(() => validateRenderedDashboardInputs(auth, 800, env, planned));
});

test("rendered actors bind exact private auth bytes and the same fresh staged fleet run/start identity", () => {
  const now = Date.now(), auth = Buffer.from(JSON.stringify(authFixture(40)));
  const manifest = { version: 1, campaign: "classpilot-staging-20261013-abcdef123456", runId: "40-abcdef123456",
    primaryDevices: 40, candidateApiImage: "135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-staging-api@sha256:" + "a".repeat(64),
    scriptBundleSha256: "b".repeat(64), createdAt: new Date(now).toISOString(), startAt: new Date(now + 120_000).toISOString(),
    files: { auth: { bytes: auth.length, sha256: createHash("sha256").update(auth).digest("hex") },
      commands: { bytes: 1, sha256: "c".repeat(64) }, devices: { bytes: 1, sha256: "d".repeat(64) } } };
  assert.equal(validateRenderedManifest(auth, manifest, 40, manifest.startAt, now), manifest);
  assert.throws(() => validateRenderedManifest(Buffer.concat([auth, Buffer.from(" ")]), manifest, 40, manifest.startAt, now));
  assert.throws(() => validateRenderedManifest(Buffer.from(auth.toString().replace("teacher-0", "teacher-9")), manifest, 40, manifest.startAt, now));
  assert.throws(() => validateRenderedManifest(auth, manifest, 40, new Date(now + 121_000).toISOString(), now));
  assert.throws(() => validateRenderedManifest(auth, manifest, 40, "", now));
  assert.throws(() => validateRenderedManifest(auth, manifest, 500, manifest.startAt, now));
  assert.throws(() => validateRenderedManifest(auth, { ...manifest, createdAt: new Date(now - 900_001).toISOString() }, 40, manifest.startAt, now));
});

test("actual UI may freeze all exact students while Node class burst retains canonical class scope", () => {
  assert.equal(renderedCommandRequestPath('/api/commands'), true);
  assert.equal(renderedCommandRequestPath('/api/classpilot/commands'), true);
  assert.equal(renderedCommandRequestPath('/api/commands/private/status'), false);
  const actor = authFixture(40).teacherAuth[0]!;
  const body = { teachingSessionId: actor.teachingSessionId, targetScope: "class", commandType: "open-tab", commandPayload: { url: "https://example.edu/fixture" } };
  assert.equal(renderedCommandMatches(body, actor, body.commandPayload.url), true);
  const exactStudents = { ...body, targetScope: "students", targetStudentIds: actor.studentIds };
  assert.equal(renderedCommandMatches(exactStudents, actor, body.commandPayload.url), true);
  assert.equal(renderedCommandMatches({ ...exactStudents, targetStudentIds: [...actor.studentIds.slice(0, -1), "foreign"] }, actor, body.commandPayload.url), false);
  assert.equal(renderedCommandMatches({ ...body, deviceId: "internal" }, actor, body.commandPayload.url), false);
  assert.equal(renderedCommandMatches({ ...body, teachingSessionId: "other" }, actor, body.commandPayload.url), false);
  assert.equal(renderedCommandMatches({ ...body, targetScope: "school" }, actor, body.commandPayload.url), false);
});

test("rendered freshness uses bounded monotonic buckets instead of repeated full-campaign sorts", () => {
  const histogram = renderedAgeHistogram();
  for (let index = 0; index < 100_000; index += 1) histogram.observe(index % 10 === 0 ? 11000 : 6000);
  assert.equal(histogram.percentile(95), 15000);
  assert.equal(histogram.percentile(50), 10000);
  assert.equal(histogram.summary().count, 100000);
  assert.equal(histogram.summary().counts.length, 5);
});

test("rendered command timing uses the first issuing teacher socket observation and rejects foreign targets", () => {
  const actor = authFixture(40).teacherAuth[0]!;
  const runtime = { actor, allowed: new Set(actor.studentIds), commands: new Map() };
  const command = { id: "command-1", teacherId: actor.teacherId, teachingSessionId: actor.teachingSessionId,
    targets: [{ studentId: actor.studentIds[0], status: "received" }] };
  assert.equal(observeRenderedCommandUpdate(runtime, { type: "classpilot-command-update", command }, 1234), false);
  command.targets[0]!.status = "completed";
  observeRenderedCommandUpdate(runtime, { type: "classpilot-command-update", command }, 2345);
  observeRenderedCommandUpdate(runtime, { type: "classpilot-command-update", command }, 3456);
  assert.deepEqual(runtime.commands.get(command.id).get(actor.studentIds[0]), { receivedAt: 1234, completedAt: 2345 });
  assert.equal(observeRenderedCommandUpdate(runtime, { type: "classpilot-command-update",
    command: { ...command, teacherId: "other", targets: [{ studentId: "foreign", status: "completed" }] } }, 4567), false);
  assert.equal(observeRenderedCommandUpdate(runtime, { type: "classpilot-command-update",
    command: { ...command, targets: [{ studentId: "foreign", status: "completed" }] } }, 4567), true);
  assert.equal(runtime.commands.get(command.id).has("foreign"), false);
});

test("a stalled renderer or response body cannot wedge the campaign instrumentation", async () => {
  assert.equal(await renderedDeadline(Promise.resolve("complete"), 20), "complete");
  // The test keeps its own ordinary timer alive; the helper's watchdog is
  // unreferenced so a completed browser campaign never lingers for it.
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(renderedDeadline(new Promise(() => {}), 20), /deadline exceeded/); }
  finally { clearTimeout(keepAlive); }
});
