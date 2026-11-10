import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import express from "express";
import { rateLimit, MemoryStore } from "express-rate-limit";
import ts from "typescript";

const text = readFileSync(new URL("../src/routes/classpilot/devices.ts", import.meta.url), "utf8");
const source = ts.createSourceFile("devices.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function nodeFor(name: string) {
  return source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name
    || ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(source) === name))?.getText(source) ?? "";
}
const route = source.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(source) === "router.post" && ts.isStringLiteral(node.expression.arguments[0]!)
  && node.expression.arguments[0].text === "/device/screenshot");
assert.ok(route);

test("selected detail HTTP uploads have their own bounded allowance and cannot consume the ordinary sixty-frame budget", async () => {
  const app = express(); app.use(express.json());
  const pass = (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();
  const program = [nodeFor("authenticatedDeviceKey"), nodeFor("deviceScreenshotLimiter"), nodeFor("deviceDetailScreenshotLimiter"), route.getText(source)].join("\n");
  runInNewContext(ts.transpileModule(program, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, {
    rateLimit, MemoryStore, deviceScreenshotRateStore: new MemoryStore(),
    redisStore: () => undefined, router: app, recordHeartbeatHotPathCounter() {},
    requireDeviceAuthWithoutTenant(_req: express.Request, res: express.Response, next: express.NextFunction) {
      res.locals.schoolId = "synthetic-school"; res.locals.deviceId = "synthetic-device"; next();
    }, requireClasspilotEntitlement: pass, requireClasspilotFullMonitoring: pass, setClassPilotNoStore() {},
    deviceTelemetryHttpContext(req: express.Request, res: express.Response) { return { req, res }; },
    async executeCanonicalScreenshot(context: { res: express.Response }) { context.res.json({ ok: true }); },
  });
  const server = createServer(app); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const upload = async (detail = false) => (await fetch(`http://127.0.0.1:${address.port}/device/screenshot`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(detail ? { captureKind: "detail_preview" } : {}),
  })).status;
  try {
    for (let frame = 0; frame < 60; frame++) {
      assert.equal(await upload(), 200, `ordinary frame ${frame + 1} retains its existing allowance`);
      if (frame % 5 === 0) assert.equal(await upload(true), 200);
    }
    for (let frame = 12; frame < 15; frame++) assert.equal(await upload(true), 200);
    assert.equal(await upload(true), 429, "detail's sixteenth request stays bounded independently");
    assert.equal(await upload(), 429, "ordinary's sixty-first request remains bounded at sixty");
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("HTTP-only detail frames are refused by the canonical WebSocket adapter before consuming ordinary device or IP allowances", async () => {
  const deviceStore = new MemoryStore(); const ipStore = new MemoryStore();
  rateLimit({ windowMs: 60_000, max: 60, store: deviceStore });
  rateLimit({ windowMs: 60_000, max: 300_000, store: ipStore });
  const operation = runInNewContext(ts.transpileModule(`${nodeFor("runWebSocketDeviceOperation")}\nrunWebSocketDeviceOperation;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, { deviceScreenshotRateStore: deviceStore, deviceTelemetryIpRateStore: ipStore,
    ipKeyGenerator: (ip: string) => ip, deviceTelemetryIpRateExceeded: (hits: number) => hits > 300_000,
    async runWithTenantContext(_scope: unknown, op: () => Promise<unknown>) { return op(); },
    async resolveClasspilotEntitlement() { return { entitled: true }; },
    async resolveActiveStudentTokenSession() { return {}; },
    async getClasspilotMonitoringPolicy() { return { mode: "full" }; },
    async executeCanonicalScreenshot(context: { reply: (status: number, body: object) => unknown }) { return context.reply(200, { ok: true }); },
  });
  const context = { binding: { schoolId: "school", deviceId: "device" }, sourceIp: "127.0.0.1", delivery: { closed: false },
    reply: (status: number, body: unknown) => ({ status, body }) };
  assert.equal((await operation("screenshot", { ...context, payload: { captureKind: "detail_preview" } })).status, 400);
  assert.equal(await deviceStore.get("device:school:device"), undefined);
  assert.equal(await ipStore.get("127.0.0.1"), undefined);
  assert.equal((await operation("screenshot", { ...context, payload: {} })).status, 200);
  assert.equal((await deviceStore.get("device:school:device"))?.totalHits, 1);
  assert.equal((await ipStore.get("127.0.0.1"))?.totalHits, 1);
});
