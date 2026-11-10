import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { isClasspilotCapabilityActive, negotiateClasspilotProtocol } from "../src/services/classpilotProtocol.js";

const delta = "scopedScreenshotDeltasV1";
const parents = ["scopedAuthorityChecksV1", "screenshotTrackingWindowLeaseV1", "deviceTelemetryTransportV1", "scopedScreenshotReferencesV1"];
const flags = ["CLASSPILOT_CAP_SCOPED_AUTHORITY_CHECKS_V1", "CLASSPILOT_CAP_SCREENSHOT_TRACKING_WINDOW_LEASE_V1",
  "CLASSPILOT_CAP_DEVICE_TELEMETRY_TRANSPORT_V1", "CLASSPILOT_CAP_SCOPED_SCREENSHOT_REFERENCES_V1"];
const schoolA = "11111111-1111-4111-8111-111111111111";
const schoolB = "22222222-2222-4222-8222-222222222222";
const enabled: NodeJS.ProcessEnv = { CLASSPILOT_PROTOCOL_V3_ENABLED: "true", CLASSPILOT_CAP_SCOPED_SCREENSHOT_DELTAS_V1: "true",
  ...Object.fromEntries(flags.map(flag => [flag, "true"])) };
const accepted = (env: NodeJS.ProcessEnv, advertised = [...parents, delta], schoolId = schoolA) => negotiateClasspilotProtocol({
  clientProtocolVersion: 3, advertisedCapabilities: advertised, env, scope: { schoolId },
}).acceptedCapabilities;

test("lossless screenshot deltas default off and require every negotiated parent", () => {
  assert.ok(!accepted({}).includes(delta));
  assert.ok(accepted(enabled).includes(delta));
  for (const parent of parents) assert.ok(!accepted(enabled, [...parents, delta].filter(value => value !== parent)).includes(delta), parent);
  assert.ok(!accepted({ ...enabled, CLASSPILOT_CAP_SCOPED_SCREENSHOT_DELTAS_V1: "false" }).includes(delta));
});

test("direct school delta checks retain all live parent kill switches", () => {
  assert.equal(isClasspilotCapabilityActive(delta, { schoolId: schoolA }, enabled), true);
  for (const flag of flags) assert.equal(isClasspilotCapabilityActive(delta, { schoolId: schoolA }, { ...enabled, [flag]: "false" }), false, flag);
  const changing = { ...enabled };
  assert.equal(isClasspilotCapabilityActive(delta, { schoolId: schoolA }, changing), true);
  changing.CLASSPILOT_CAP_SCOPED_SCREENSHOT_REFERENCES_V1 = "false";
  assert.equal(isClasspilotCapabilityActive(delta, { schoolId: schoolA }, changing), false);
});

test("delta school scopes cannot bypass a different parent pilot or an invalid registry", () => {
  const scoped = { ...enabled, CLASSPILOT_CAPABILITY_ROLLOUTS_JSON: JSON.stringify(Object.fromEntries([
    ...parents.map(parent => [parent, { mode: "on", schoolIds: [schoolA] }]), [delta, { mode: "on", schoolIds: [schoolA] }],
  ])) };
  assert.ok(accepted(scoped).includes(delta));
  assert.ok(!accepted(scoped, [...parents, delta], schoolB).includes(delta));
  const crossScope = { ...scoped, CLASSPILOT_CAPABILITY_ROLLOUTS_JSON: JSON.stringify({
    ...JSON.parse(scoped.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON), deviceTelemetryTransportV1: { mode: "on", schoolIds: [schoolB] },
  }) };
  assert.equal(isClasspilotCapabilityActive(delta, { schoolId: schoolA }, crossScope), false);
  assert.equal(isClasspilotCapabilityActive(delta, { schoolId: schoolA }, { ...enabled, CLASSPILOT_CAPABILITY_ROLLOUTS_JSON: "bad-json" }), false);
});

test("Windows browser authority filters the unsupported delta marker before negotiation", () => {
  const source = readFileSync(new URL("../src/services/classpilotWindows.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("windows.ts", source, ts.ScriptTarget.ES2022, true);
  const declaration = ast.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(value => value.name.getText(ast) === "unsupportedWindowsCapabilities"));
  const operation = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "currentWindowsCapabilities");
  assert.ok(declaration && operation);
  const code = ts.transpileModule(`${declaration.getText(ast)}\n${operation.getText(ast)}\ncurrentWindowsCapabilities;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const current: (browser: { schoolId: string; acceptedCapabilities: string[] }) => string[] = runInNewContext(code, {
    negotiateClasspilotProtocol: (options: Parameters<typeof negotiateClasspilotProtocol>[0]) => negotiateClasspilotProtocol({ ...options, env: enabled }),
  });
  assert.equal(runInNewContext(`${declaration.getText(ast)}\nunsupportedWindowsCapabilities.has('scopedScreenshotDeltasV1');`), true);
  assert.ok(!current({ schoolId: schoolA, acceptedCapabilities: [...parents, delta] }).includes(delta));
});
