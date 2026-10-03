import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as focus from "../src/services/classpilotFocus.js";
import { classpilotControlStateAckRequired } from "../src/services/classpilotControlStateAckGate.js";

const fixture: { heartbeatAckProperties: string; sendClassroomStateAck: string } = JSON.parse(
  readFileSync(new URL("./fixtures/classpilot-focus-wire-297.json", import.meta.url), "utf8"),
);
const binding = { schoolId: "school-a", studentId: "student-a", studentSessionId: "session-a", deviceId: "device-a" };
type Surface = "heartbeat" | "websocket";
type Packet = Record<string, unknown>;

function actualAckCode(surface: Surface): string {
  const file = surface === "heartbeat" ? "../src/routes/classpilot/devices.ts" : "../src/realtime/websocket.ts";
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const matches: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isIfStatement(node)) {
      const condition = node.expression.getText(tree);
      if (surface === "heartbeat"
        ? condition.includes("Number(appliedClassroomStateRevision) === controlState.revision")
        : condition.includes('message.type === "classroom-state-ack"')) matches.push(node.getText(tree));
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.equal(matches.length, 1);
  return ts.transpileModule(`(async () => { ${matches[0]} })`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
}
const code = { heartbeat: actualAckCode("heartbeat"), websocket: actualAckCode("websocket") };

function packagedPacket(surface: Surface, status: unknown): Packet {
  const currentClassroomState = { revision: 7, teachingSessionId: "class-a" };
  const common = { currentClassroomState, publicFocusStatus: () => status,
    appliedRestrictionAuthPolicyRevision: () => 12, Date, Number };
  if (surface === "heartbeat") {
    return JSON.parse(JSON.stringify(runInNewContext(`({${fixture.heartbeatAckProperties}})`, {
      ...common, heartbeatClassroomAckIsCurrent: true,
      lastClassroomStateAckRevision: 7, lastClassroomStateOutcome: "applied",
    })));
  }
  let packet: Packet | undefined;
  runInNewContext(`${fixture.sendClassroomStateAck}; sendClassroomStateAck(currentClassroomState, 'applied');`, {
    ...common, wsConnected: true, wsSend: (value: Packet) => { packet = value; },
    chrome: { runtime: { getManifest: () => ({ version: "2.9.7" }) } },
  });
  assert.ok(packet);
  return JSON.parse(JSON.stringify(packet));
}

async function consume(surface: Surface, packet: Packet, options: { pending?: boolean; stored?: unknown } = {}) {
  const calls: Packet[] = [];
  const controlState = { revision: 7, appliedRevision: options.pending ? null : 7,
    enforcementHealth: options.pending ? "pending" : "synced",
    desiredState: { focusStatusV1: options.stored } };
  const invoke: () => Promise<void> = runInNewContext(code[surface], {
    ...focus, ...binding, classpilotControlStateAckRequired, Number, String,
    req: { body: packet }, message: packet,
    client: { ...binding, role: "student", acceptedCapabilities: ["focusTabV1"] },
    controlState, appliedClassroomStateRevision: packet.appliedClassroomStateRevision,
    classroomStateOutcome: packet.classroomStateOutcome, appliedAuthPolicyRevision: 12,
    protocol: { acceptedCapabilities: ["focusTabV1"] }, ssoPolicy: { revision: 12 },
    classpilotLateSignInRevisionAppliedToBinding: () => true,
    classpilotControlStateHasLateSignInOrigin: () => false,
    classpilotControlStateHasAuthRelevantRestriction: () => false,
    isClasspilotCapabilityActive: () => false,
    getClasspilotStudentControlState: async () => controlState,
    runWithTenantContext: async (context: { schoolId: string }, action: () => Promise<unknown>) => {
      assert.equal(context.schoolId, binding.schoolId); return action();
    },
    acknowledgeClasspilotStudentControlState: async (value: Packet) => { calls.push(value); return undefined; },
  });
  await invoke();
  return calls;
}

const states = [
  { state: "inactive" }, { state: "active", assignmentId: "assignment-a" },
  ...["attention", "authentication", "browser_operation_pending"].map(reason =>
    ({ state: "suspended", assignmentId: "assignment-a", reason })),
  ...["focus_tab_closed", "focus_tab_missing", "focus_tab_off_policy"].map(reason =>
    ({ state: "invalidated", assignmentId: "assignment-a", reason })),
];

describe("Focus status semantic equality", () => {
  it("ignores JSONB key order while detecting assignment/reason changes and invalid stored status", () => {
    for (const state of states) {
      const reversed = Object.fromEntries(Object.entries(state).reverse());
      assert.equal(focus.focusStatusChanged({ focusStatusV1: reversed }, state), false);
      assert.equal(focus.focusStatusChanged({ focusStatusV1: { state: "invalid" } }, state), true);
      if ("assignmentId" in state) assert.equal(focus.focusStatusChanged({ focusStatusV1: state },
        { ...state, assignmentId: "replacement" }), true);
    }
    assert.equal(focus.focusStatusChanged({ focusStatusV1: states[2] },
      { assignmentId: "assignment-a", state: "suspended", reason: "authentication" }), true);
    assert.equal(focus.focusStatusChanged({ focusStatusV1: states[0] }, { state: "active" }), false);
  });
});

for (const surface of ["heartbeat", "websocket"] as const) describe(`${surface} packaged 2.9.7 Focus status`, () => {
  for (const status of states) it(`passes ${status.state}${"reason" in status ? `/${status.reason}` : ""} through the real ACK gate`, async () => {
    const packet = packagedPacket(surface, status);
    assert.deepEqual(packet.focusStatus, status);
    assert.equal(Object.hasOwn(packet, "focus"), false);
    const calls = await consume(surface, packet);
    assert.equal(calls.length, 1, "a changed status on an already applied revision must reach locked storage");
    assert.deepEqual(calls[0]?.focusStatus, status);
    for (const [key, value] of Object.entries(binding)) assert.equal(calls[0]?.[key], value);
    assert.equal(calls[0]?.appliedRevision, 7);
    assert.equal(calls[0]?.appliedAuthPolicyRevision, 12);
    assert.deepEqual(await consume(surface, packet, { stored: status }), [], "unchanged status stays a no-op");
  });

  it("retains the provisional alias and equal dual fields regardless of key order", async () => {
    const status = { state: "active", assignmentId: "assignment-a" };
    const packet = packagedPacket(surface, status);
    delete packet.focusStatus; packet.focus = status;
    assert.deepEqual((await consume(surface, packet))[0]?.focusStatus, status);
    packet.focusStatus = { assignmentId: "assignment-a", state: "active" };
    assert.deepEqual((await consume(surface, packet))[0]?.focusStatus, status);
  });

  it("ignores malformed or ambiguous status without falling back to a valid alias", async () => {
    const status = { state: "active", assignmentId: "assignment-a" };
    const base = packagedPacket(surface, status);
    for (const extra of [
      { focusStatus: null, focus: status }, { focusStatus: { state: "active" }, focus: status },
      { focusStatus: { ...status, deviceId: "forbidden" }, focus: status },
      { focusStatus: status, focus: { ...status, assignmentId: "other-assignment" } },
      { focusStatus: status, focus: null }, { focusStatus: null },
    ]) assert.deepEqual(await consume(surface, { ...base, ...extra }), []);
  });

  it("preserves a normal legacy ACK with no Focus fields", async () => {
    const packet = packagedPacket(surface, undefined);
    const calls = await consume(surface, packet, { pending: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.focusStatus, undefined);
  });

  it("does not replace the authenticated binding or the reported revision from status fields", async () => {
    const packet = packagedPacket(surface, { state: "invalidated", assignmentId: "old-assignment", reason: "focus_tab_closed" });
    packet.deviceId = "untrusted-device"; packet.studentSessionId = "untrusted-session";
    packet.appliedRevision = 6; packet.appliedClassroomStateRevision = 6;
    const calls = await consume(surface, packet);
    if (surface === "heartbeat") assert.deepEqual(calls, []);
    else {
      assert.equal(calls.length, 1, "the locked storage API remains responsible for rejecting a stale WS revision");
      assert.equal(calls[0]?.appliedRevision, 6);
      for (const [key, value] of Object.entries(binding)) assert.equal(calls[0]?.[key], value);
    }
  });
});
