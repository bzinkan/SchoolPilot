import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { gzipSync, gunzipSync } from "node:zlib";
import express from "express";
import ts from "typescript";
import { createScreenshotResponseEncoder } from "../src/services/classpilotScreenshotResponseEncoding.js";
import { parseKnownScreenshotImages, knownScreenshotImageForBinding, publicScreenshotImageData } from "../src/services/classpilotScreenshotReferences.js";

function source(path: string) { return readFileSync(new URL(`../${path}`, import.meta.url), "utf8"); }
function declarations(path: string, names: string[]) {
  const file = ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return names.map(name => {
    const statement = file.statements.find(item => (ts.isFunctionDeclaration(item) && item.name?.text === name)
      || (ts.isVariableStatement(item) && item.declarationList.declarations.some(declaration => declaration.name.getText(file) === name)));
    assert.ok(statement, `Unique production declaration required: ${name}`);
    return statement.getText(file).replace(/^export /, "");
  }).join("\n");
}
function javascript(text: string) { return ts.transpileModule(text, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None,
} }).outputText; }
const bindingSource = declarations("src/realtime/ws-redis.ts", ["screenshotBindingDigest", "screenshotBindingVersion",
  "classBoundScreenshotBindingDigest", "classBoundScreenshotBindingVersion", "SUPERVISION_BOUND_SCREENSHOT_DOMAIN",
  "supervisionBoundScreenshotBindingDigest", "supervisionBoundScreenshotBindingVersion", "screenshotMatchesBinding",
  "classBoundScreenshotMatchesBinding", "supervisionBoundScreenshotMatchesBinding"]);
const bindingHelpers = runInNewContext(javascript(`${bindingSource}\n({classBoundScreenshotBindingVersion, supervisionBoundScreenshotBindingVersion});`), { createHash });
const routeFile = ts.createSourceFile("devices.ts", source("src/routes/classpilot/devices.ts"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const route = routeFile.statements.flatMap(statement => {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return [];
  const call = statement.expression;
  if (!ts.isPropertyAccessExpression(call.expression) || call.expression.expression.getText(routeFile) !== "router"
    || call.expression.name.text !== "post" || !ts.isStringLiteral(call.arguments[0]!)
    || call.arguments[0].text !== "/tiles/screenshots") return [];
  return call.arguments.filter(ts.isArrowFunction);
});
assert.equal(route.length, 1, "Extract the actual unique screenshot route, not a rewritten test handler");
const routeProgram = javascript(`${bindingSource}\n${declarations("src/routes/classpilot/devices.ts", [
  "parseTileStudentIds", "parseTileTeachingSessionId", "tileStaffScope", "revisionedTileAccess", "publicScreenshotData",
  "classpilotScreenshotStoreRequired", "screenshotForAuthorizedStudent", "classBoundScreenshotForAuthorizedStudent",
])}\n(${route[0]!.getText(routeFile)});`);

async function fixture(reporting = false, metadataOnly = false, options: { delta?: boolean; deltaEnabled?: boolean } = {}) {
  const initial: { schoolId: string; staffId: string; studentId: string; deviceId: string; studentSessionId: string;
    controlRevision: number; teachingSessionId?: string; supervisionContextId?: string; reportingObservation?: boolean } = {
    schoolId: "synthetic-school", staffId: "synthetic-teacher", studentId: "synthetic-student",
    deviceId: "synthetic-device", studentSessionId: "synthetic-login", controlRevision: 1,
    ...(reporting ? { teachingSessionId: "synthetic-class", reportingObservation: true } : { supervisionContextId: "synthetic-room" }) };
  let current = new Map([[initial.studentId, { ...initial }]]);
  let calls = 0;
  let started!: () => void;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const order: string[] = [];
  const encoder = createScreenshotResponseEncoder({ timeoutMs: 1000, minBytes: 1, compress: async input => {
    order.push("compress"); started(); await gate; order.push("compressed"); return gzipSync(input);
  } });
  const version = reporting ? bindingHelpers.classBoundScreenshotBindingVersion(initial) : bindingHelpers.supervisionBoundScreenshotBindingVersion(initial);
  const delta = { codec: "cp-bit-copy-v1", baseImageId: "12345678-1234-4234-8234-123456789abc",
    data: Buffer.alloc(21).toString("base64"), targetBytes: 1024, integrityTag: "a".repeat(64) };
  const pixels = `data:image/jpeg;base64,${"synthetic-private-pixels".repeat(400)}`;
  const image = { ...initial, timestamp: 1794290000000, capturedAt: new Date(1794290000000).toISOString(),
    bindingVersion: version, imageId: "00000000-0000-4000-8000-000000000001",
    ...(options.delta ? { delta } : metadataOnly ? { unchanged: true } : { screenshot: pixels }),
    tabTitle: "Synthetic lesson", tabUrl: "https://example.invalid/lesson", contentHash: "private-content-hash" };
  const reads: { knownImageIds?: readonly (string | undefined)[]; allowDeltas?: readonly boolean[] }[] = [];
  function readImage(readOptions: (typeof reads)[number]) {
    reads.push(readOptions);
    return options.delta && (!readOptions.allowDeltas?.[0] || readOptions.knownImageIds?.[0] !== delta.baseImageId)
      ? { ...image, delta: undefined, screenshot: pixels } : image;
  }
  const globals = {
    createHash, process: { env: { NODE_ENV: "production" } },
    screenshotResponseEncoder: encoder, parseKnownScreenshotImages, knownScreenshotImageForBinding, publicScreenshotImageData,
    setClassPilotNoStore(res: express.Response) { res.set("Cache-Control", "no-store"); },
    selectRequestSchoolRole() { return "teacher"; },
    requireScheduledClassroomRequestRevision(value: string) { return value; },
    async requireScheduledClassroomContext() { return { classroomAuthorityRevision: "1" }; },
    async getBatchTileAccessForStaff() { calls++; order.push("authority"); return current; },
    async runWithTenantContext(_scope: unknown, operation: () => Promise<unknown>) { return operation(); },
    releaseClassPilotTileAdmission() {}, recordHeartbeatHotPathCounter() {}, recordHeartbeatHotPathTiming() {},
    async readClasspilotRealtimeStatusBatch() { return new Map(); },
    classpilotRealtimeFresh() { return false; },
    isClasspilotCapabilityActive(capability: string) { return capability !== "scopedScreenshotDeltasV1" || options.deltaEnabled !== false; },
    async getClassBoundScreenshotImages(_bindings: unknown, readOptions: (typeof reads)[number]) {
      order.push("redis"); return { status: "ok", screenshots: reporting ? [readImage(readOptions)] : [] };
    },
    async getSupervisionBoundScreenshotImages(_bindings: unknown, readOptions: (typeof reads)[number]) {
      order.push("redis"); return { status: "ok", screenshots: reporting ? [] : [readImage(readOptions)] };
    },
    async getScreenshots() { return { status: "ok", screenshots: [] }; },
    classpilotScreenshotFallback: { getClassBound() { throw new Error("No local pixels may replace a required store read"); },
      getSupervisionBound() { throw new Error("No local pixels may replace a required store read"); }, get() { throw new Error("Unexpected legacy fallback"); } },
  };
  const handler = runInNewContext(routeProgram, globals);
  const app = express(); app.use(express.json());
  app.post("/tiles/screenshots", (req, res, next) => {
    res.locals.schoolId = initial.schoolId;
    Object.assign(req, { authUser: { id: initial.staffId, isSuperAdmin: false } });
    return handler(req, res, next);
  });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, ready, release, initial, image, order, reads, calls: () => calls,
    replace(value: typeof initial | undefined) { current = value ? new Map([[initial.studentId, value]]) : new Map(); },
    requestBody: { studentIds: [initial.studentId], ...(reporting ? { teachingSessionId: initial.teachingSessionId } : { supervisionContextId: initial.supervisionContextId }),
      ...(options.delta ? { imageDeltaProtocolVersion: 1, knownImageIds: {
        [initial.studentId]: { imageId: delta.baseImageId, bindingVersion: version } } }
        : metadataOnly ? { knownImageIds: { [initial.studentId]: { imageId: image.imageId, bindingVersion: version } } } : {}) } };
}
async function raw(server: Server, body: object) {
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: address.port, method: "POST", path: "/tiles/screenshots",
      headers: { "Accept-Encoding": "gzip", "Content-Type": "application/json" } }, response => {
      const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on("error", reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error("Local screenshot authority response deadline exceeded")));
    req.on("error", reject); req.end(JSON.stringify(body));
  });
}
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }

for (const reporting of [false, true]) {
  test(`actual ${reporting ? "reporting Observe" : "supervision"} route filters pixels changed while gzip is pending`, async () => {
    const f = await fixture(reporting);
    try {
      const pending = raw(f.server, f.requestBody);
      const began = await Promise.race([f.ready.then(() => true), pending.then(() => false)]);
      assert.equal(began, true, "The real route must encode before its final authority read");
      assert.equal(f.calls(), 1, "no final database fence may run before encoding finishes");
      f.replace({ ...f.initial, controlRevision: 2 }); f.release();
      const response = await pending;
      assert.equal(response.status, 200);
      assert.equal(response.headers["content-encoding"], undefined);
      assert.deepEqual(JSON.parse(response.body.toString()), { tiles: [{ studentId: f.initial.studentId, screenshot: null }] });
      assert.equal(f.calls(), 2, "retain the existing two database authority reads, not an extra one");
      assert.ok(f.order.lastIndexOf("authority") > f.order.indexOf("compressed"));
    } finally { f.release(); await close(f.server); }
  });
}

test("actual route discards prepared gzip and returns no pixels after complete authority revocation", async () => {
  const f = await fixture();
  try {
    const pending = raw(f.server, f.requestBody);
    assert.equal(await Promise.race([f.ready.then(() => true), pending.then(() => false)]), true);
    f.replace(undefined); f.release();
    const response = await pending;
    assert.equal(response.status, 404);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["content-encoding"], undefined);
    assert.deepEqual(JSON.parse(response.body.toString()), { error: "No accessible tiles", code: "CLASSPILOT_NO_ACCESSIBLE_TILES" });
  } finally { f.release(); await close(f.server); }
});

test("actual known-image metadata response is compressed after unchanged authority without introducing pixels or private fields", async () => {
  const f = await fixture(false, true);
  try {
    const pending = raw(f.server, f.requestBody);
    assert.equal(await Promise.race([f.ready.then(() => true), pending.then(() => false)]), true);
    f.release(); const response = await pending;
    assert.equal(response.headers["content-encoding"], "gzip");
    const json = gunzipSync(response.body).toString();
    const parsed = JSON.parse(json);
    assert.equal(parsed.tiles[0].screenshot.unchanged, true);
    assert.equal(parsed.tiles[0].screenshot.timestamp, 1794290000000);
    assert.equal(parsed.tiles[0].screenshot.imageId, "00000000-0000-4000-8000-000000000001");
    assert.ok(!json.includes("data:image"));
    assert.ok(!json.includes("private-content-hash"));
    assert.ok(!json.includes("synthetic-login"));
    assert.ok(!json.includes("synthetic-device"));
    assert.equal(f.calls(), 2);
  } finally { f.release(); await close(f.server); }
});

test("actual unchanged screenshot authority publishes the exact original public pixels after encoding", async () => {
  const f = await fixture();
  try {
    const pending = raw(f.server, f.requestBody);
    assert.equal(await Promise.race([f.ready.then(() => true), pending.then(() => false)]), true);
    f.release(); const response = await pending;
    assert.equal(response.headers["content-encoding"], "gzip");
    const json = gunzipSync(response.body).toString();
    const parsed = JSON.parse(json);
    assert.equal(parsed.tiles[0].screenshot.screenshot, `data:image/jpeg;base64,${"synthetic-private-pixels".repeat(400)}`);
    assert.equal(parsed.tiles[0].screenshot.tabTitle, "Synthetic lesson");
    assert.equal(parsed.tiles[0].screenshot.tabUrl, "https://example.invalid/lesson");
    assert.equal(parsed.tiles[0].screenshot.bindingVersion, f.image.bindingVersion);
    assert.ok(!json.includes("private-content-hash"));
    assert.ok(!json.includes("synthetic-login"));
    assert.ok(!json.includes("synthetic-device"));
    assert.equal(f.calls(), 2);
    assert.ok(f.order.lastIndexOf("authority") > f.order.indexOf("compressed"));
  } finally { f.release(); await close(f.server); }
});

for (const reporting of [false, true]) {
  test(`actual ${reporting ? "reporting Observe" : "supervision"} route serves deltas only with body opt-in, known base and live rollout`, async () => {
    for (const scenario of ["delta", "old-reader", "disabled", "foreign-base"] as const) {
      const f = await fixture(reporting, false, { delta: true, deltaEnabled: scenario !== "disabled" });
      try {
        const body = { ...f.requestBody, ...(scenario === "old-reader" ? { imageDeltaProtocolVersion: undefined } : {}),
          ...(scenario === "foreign-base" ? { knownImageIds: {} } : {}) };
        const pending = raw(f.server, body);
        assert.equal(await Promise.race([f.ready.then(() => true), pending.then(() => false)]), true);
        f.release(); const response = await pending;
        assert.equal(response.status, 200);
        const json = (response.headers["content-encoding"] === "gzip" ? gunzipSync(response.body) : response.body).toString();
        const dto = JSON.parse(json).tiles[0].screenshot;
        assert.equal(f.reads[0]?.allowDeltas?.[0], scenario !== "old-reader" && scenario !== "disabled");
        if (scenario === "delta") {
          assert.equal(dto.delta.baseImageId, "12345678-1234-4234-8234-123456789abc");
          assert.equal(dto.screenshot, undefined); assert.equal(dto.unchanged, undefined);
          assert.equal(dto.delta.integrityTag, "a".repeat(64));
        } else { assert.equal(dto.delta, undefined); assert.ok(dto.screenshot.startsWith("data:image/jpeg;base64,")); }
        assert.ok(!json.includes("private-content-hash")); assert.ok(!json.includes("synthetic-device"));
        assert.ok(!json.includes("synthetic-login")); assert.equal(f.calls(), 2);
      } finally { f.release(); await close(f.server); }
    }
  });

  test(`actual ${reporting ? "reporting Observe" : "supervision"} route discards a delta prepared before an authority change`, async () => {
    const f = await fixture(reporting, false, { delta: true });
    try {
      const pending = raw(f.server, f.requestBody);
      assert.equal(await Promise.race([f.ready.then(() => true), pending.then(() => false)]), true);
      f.replace({ ...f.initial, controlRevision: 2 }); f.release(); const response = await pending;
      assert.equal(response.status, 200); assert.equal(response.headers["content-encoding"], undefined);
      assert.deepEqual(JSON.parse(response.body.toString()), { tiles: [{ studentId: f.initial.studentId, screenshot: null }] });
      assert.equal(f.calls(), 2);
    } finally { f.release(); await close(f.server); }
  });
}
