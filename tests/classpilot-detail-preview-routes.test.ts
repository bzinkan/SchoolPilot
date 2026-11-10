import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import ts from "typescript";
import * as D from "../src/services/classpilotDetailPreview.js";
import { parseScreenshotImageRequest } from "../src/services/classpilotScreenshotImageRequest.js";
import { parseClasspilotScreenshotAuthority, validateClasspilotScreenshotCapturedAt } from "../src/services/classpilotScreenshotPolicy.js";

const source = readFileSync(new URL("../src/routes/classpilot/devices.ts", import.meta.url), "utf8");
const file = ts.createSourceFile("devices.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function js(source: string) { return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText; }
function declaration(name: string) {
  const found = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(found, `Actual production function ${name} exists`); return found.getText(file).replace(/^export /, "");
}
function route(path: string, globals: object) {
  const handlers = file.statements.flatMap(node => {
    if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) return [];
    const call = node.expression;
    if (call.expression.getText(file) !== "router.post" || !ts.isStringLiteral(call.arguments[0]!) || call.arguments[0].text !== path) return [];
    return call.arguments.filter(ts.isArrowFunction);
  });
  assert.equal(handlers.length, 1);
  return runInNewContext(js(`${declaration("parseTileTeachingSessionId")}\n(${handlers[0]!.getText(file)});`), globals);
}
const at = Date.now();
const exact = { schoolId: "detail-route-school", studentId: "student", studentSessionId: "login", deviceId: "PRIVATE-device", teachingSessionId: "class", controlRevision: 1 };
const pixel = { screenshot: "data:image/jpeg;base64,/9j/2Q==", timestamp: at + 100, capturedAt: new Date(at + 100).toISOString(),
  bindingVersion: D.detailPreviewBindingVersion(exact), resolution: "detail" as const, captureCadenceMode: "active_view" as const };
const capabilities = ["scopedAuthorityChecksV1", "screenshotTrackingWindowLeaseV1", "screenshotActiveObservationCadenceV1"];
function response() {
  return { locals: { schoolId: exact.schoolId }, statusCode: 200, body: undefined as unknown, set() {},
    status(code: number) { this.statusCode = code; return this; }, json(body: unknown) { this.body = body; return this; } };
}
function fixture(reportingObservation = false, supported = true, observed = true) {
  let current = new Map([[exact.studentId, { ...exact, reportingObservation }]]);
  let authorityReads = 0;
  let afterRead: (() => void) | undefined;
  let entitled = true;
  let staff = true;
  const globals = { ...D,
    Date, Object, Number, Error,
    setClassPilotNoStore() {}, releaseClassPilotTileAdmission() {},
    tileStaffScope() { return { schoolId: exact.schoolId, staffId: "teacher", role: "teacher", teachingSessionId: exact.teachingSessionId }; },
    async revisionedTileAccess() { authorityReads++; return current; },
    async resolveClasspilotEntitlement() { return { entitled }; },
    async loadVerifiedSchoolIdentities() { return staff ? [{ roles: ["teacher"] }] : []; },
    async runWithTenantContext(_scope: unknown, op: () => Promise<unknown>) { return op(); },
    async readClasspilotRealtimeStatusBatch() { return new Map([[exact.studentId, { status: "hit", snapshot: { acceptedCapabilities: supported ? capabilities : [] } }]]); },
    classpilotRealtimeFresh() { return true; }, isClasspilotCapabilityActive() { return true; },
    async classpilotObservationStatus() { return { status: observed ? "observed" : "unobserved", expiresInSeconds: observed ? 84 : 0 }; },
    async classpilotSupervisionObservationStatus() { return { status: observed ? "observed" : "unobserved", expiresInSeconds: observed ? 84 : 0 }; },
    async readDetailPreview(options: Parameters<typeof D.readDetailPreview>[0]) { const image = await D.readDetailPreview(options); afterRead?.(); return image; },
    async nudgeClasspilotScreenshotPolicyRefresh() { return 0; },
  };
  const read = route("/tiles/detail-preview", globals);
  return { async call(body: object) { const res = response(); let error: unknown;
    await read({ body, authUser: { id: "teacher" } }, res, (err: unknown) => { error = err; });
    assert.equal(error, undefined); return res; },
    mutate(callback: () => void) { afterRead = callback; }, replace() { current = new Map([[exact.studentId, { ...exact, reportingObservation, controlRevision: 2 }]]); },
    revokeEntitlement() { entitled = false; }, revokeStaff() { staff = false; },
    authorityReads: () => authorityReads };
}
test("detail route rejects missing, multiple, foreign-device and mixed-context targets before authorizing", async () => {
  const f = fixture();
  for (const body of [{}, { studentId: ["student", "other"], viewerInstanceId: "viewer", teachingSessionId: "class" },
    { studentId: "student", deviceId: "PRIVATE-device", viewerInstanceId: "viewer", teachingSessionId: "class" },
    { studentId: "student", viewerInstanceId: "viewer", teachingSessionId: "class", supervisionContextId: "claim" }]) {
    assert.equal((await f.call(body)).statusCode, 400);
  }
  assert.equal(f.authorityReads(), 0);
});
test("reporting-only Observe and old clients receive an explicit unsupported result without creating detail demand", async () => {
  for (const f of [fixture(true), fixture(false, false)]) {
    const result = await f.call({ studentId: exact.studentId, viewerInstanceId: "unsupported", teachingSessionId: exact.teachingSessionId });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(JSON.parse(JSON.stringify(result.body)), { studentId: exact.studentId,
      bindingVersion: D.detailPreviewBindingVersion(exact), detailPreview: null, screenshot: null, detailPreviewStatus: "unsupported" });
    assert.equal(f.authorityReads(), 1);
  }
});
test("an observation not yet active is transient and can be polled again", async () => {
  const f = fixture(false, true, false);
  const result = await f.call({ studentId: exact.studentId, viewerInstanceId: "not-observed-yet", teachingSessionId: exact.teachingSessionId });
  assert.deepEqual(JSON.parse(JSON.stringify(result.body)), { studentId: exact.studentId,
    bindingVersion: D.detailPreviewBindingVersion(exact), detailPreview: null, screenshot: null, detailPreviewStatus: "unavailable" });
});
test("actual detail route serves separately stamped pixels and filters a binding replaced during Redis read", async () => {
  const f = fixture();
  const body = { studentId: exact.studentId, viewerInstanceId: "route-visible", teachingSessionId: exact.teachingSessionId };
  const opened = await f.call(body);
  assert.equal(opened.statusCode, 200);
  const lease = await D.detailPreviewStatus({ binding: exact }); assert.ok(lease);
  const captured = Date.now();
  assert.equal(await D.writeDetailPreview({ binding: exact, leaseId: lease.leaseId, image: { ...pixel, timestamp: captured,
    capturedAt: new Date(captured).toISOString() } }), "stored");
  const ready = await f.call(body);
  const serialized = JSON.stringify(ready.body);
  assert.match(serialized, /"resolution":"detail"/); assert.doesNotMatch(serialized, /PRIVATE-device|studentSessionId|deviceId/);
  f.mutate(() => f.replace());
  const replaced = await f.call(body);
  assert.equal(replaced.statusCode, 404);
  assert.doesNotMatch(JSON.stringify(replaced.body), /data:image/);
});
test("detail pixels are withheld when school entitlement or the viewer's current role is revoked while Redis is pending", async () => {
  for (const kind of ["entitlement", "staff"]) {
    const f = fixture();
    f.mutate(() => kind === "entitlement" ? f.revokeEntitlement() : f.revokeStaff());
    const result = await f.call({ studentId: exact.studentId, viewerInstanceId: `revocation-${kind}`, teachingSessionId: exact.teachingSessionId });
    assert.equal(result.statusCode, 404);
    assert.doesNotMatch(JSON.stringify(result.body), /data:image/);
  }
});

test("canonical detail upload stores only separate bytes and rejects stale leases before ordinary screenshot publication", async () => {
  const viewer = { schoolId: exact.schoolId, viewerUserId: "teacher", viewerInstanceId: "canonical-upload" };
  const lease = await D.renewDetailPreview({ ...viewer, binding: exact });
  const authority = { kind: "teaching_session" as const, teachingSessionId: exact.teachingSessionId, controlRevision: 1 };
  const projection = { authority, authorityStartedAt: new Date(at - 60_000), authorityExpiresAt: null };
  const trackingSettings = { enableTrackingHours: false, trackingStartTime: "08:00", trackingEndTime: "15:00", trackingDays: ["Tuesday"], schoolTimezone: "UTC", afterHoursMode: "off" };
  const globals = { ...D, Date, Number, Set, Error,
    parseScreenshotImageRequest, parseClasspilotScreenshotAuthority, validateClasspilotScreenshotCapturedAt,
    isClasspilotCapabilityActive() { return true; }, classpilotRealtimeFresh() { return true; },
    async readClasspilotRealtimeStatusBatch() { return new Map([[exact.studentId, { status: "hit", snapshot: { acceptedCapabilities: capabilities,
      classroomState: { teachingSessionId: exact.teachingSessionId } } }]]); },
    async classpilotObservationStatus() { return { status: "observed", expiresInSeconds: 84 }; },
    recordHeartbeatHotPathCounter() {}, recordHeartbeatHotPathTiming() {},
    async runWithTenantContext(_scope: unknown, op: () => Promise<unknown>) { return op(); },
    async withClasspilotScreenshotUploadAuthority(_options: unknown, op: (context: unknown) => Promise<unknown>) {
      return { status: "accepted", current: projection, value: await op({ current: projection, trackingSettings }) };
    },
    async resolveClasspilotScreenshotPolicy() { return { mode: "tracking_window_lease", captureAllowed: true,
      captureCadence: { mode: "active_view", intervalSeconds: 5, expiresInSeconds: 84 }, detailPreview: { leaseId: lease.leaseId } }; },
    screenshotDeltaTargetByteLimit() { throw new Error("Detail cannot use delta metadata"); },
    setClassBoundScreenshot() { throw new Error("Detail cannot enter the ordinary tile store"); },
    setSupervisionBoundScreenshot() { throw new Error("Detail cannot enter the ordinary supervision store"); },
    publishLockedScreenshotAvailable() { throw new Error("Detail cannot publish ordinary tile notifications"); },
  };
  const upload = runInNewContext(js(`${declaration("executeCanonicalScreenshot")}\nexecuteCanonicalScreenshot;`), globals);
  const capture = Date.now();
  const payload = { screenshot: pixel.screenshot, captureKind: "detail_preview", detailPreviewLeaseId: lease.leaseId,
    screenshotAuthority: authority, capturedAt: new Date(capture).toISOString() };
  const context = { binding: exact, payload, reply: (status: number, body: unknown) => ({ status, body }) };
  assert.equal((await upload(context)).status, 200);
  assert.equal((await D.readDetailPreview({ ...viewer, binding: exact }))?.screenshot, pixel.screenshot);
  await D.releaseDetailPreview({ ...viewer, leaseId: lease.leaseId });
  assert.equal((await upload({ ...context, payload: { ...payload, capturedAt: new Date(capture + 5000).toISOString() } })).status, 409);
  assert.equal((await upload({ ...context, payload: { ...payload, screenshot: "x".repeat(800_001) } })).status, 400);
});
