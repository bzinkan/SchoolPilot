import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { classpilotLiveViewSignalingEnabled } from "../src/config/runtime.js";
import { normalizeClasspilotSignalingIdentifier } from "../src/services/classpilotSignaling.js";

// Execute the production gate with controlled I/O (the harness pattern from
// classpilot-live-view-receipt.test.ts), so each assertion is about the frames
// the real branch emits rather than a fixture copy of its contract.
const GATE_MARKER = "// --- Legacy Live View signaling gate (default off) ---";
const RESOLVER_MARKER = "const resolveLiveTarget = async";
const FELL_THROUGH = "fell-through";
const FLAG = "CLASSPILOT_LIVE_VIEW_SIGNALING_ENABLED";
const STAFF_ROLES = ["teacher", "school_admin", "super_admin"] as const;
const NEGOTIATION_TYPES = ["offer", "answer", "ice"] as const;

const source = readFileSync(new URL("../src/realtime/websocket.ts", import.meta.url), "utf8");
const gateStart = source.indexOf(GATE_MARKER);
const gateEnd = source.indexOf(RESOLVER_MARKER, gateStart);
assert.ok(gateStart > 0 && gateEnd > gateStart, "the gate must sit immediately before the Live View target resolver");
const gate = source.slice(gateStart, gateEnd);
const executable = ts.transpileModule(
  `async function gate() { ${gate} return ${JSON.stringify(FELL_THROUGH)}; }; gate;`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
).outputText;

type Frame = Record<string, unknown>;

async function runGate(options: {
  message: Record<string, unknown>;
  role: string;
  env?: NodeJS.ProcessEnv;
  readyState?: number;
}) {
  const frames: Frame[] = [];
  // Only the identifiers the gate is allowed to touch exist in this context. A
  // forward (sendToDeviceLocal, publishWS, resolveLiveTarget, ...) on an
  // executed path would throw a ReferenceError instead of passing silently.
  const context = {
    message: options.message,
    client: { role: options.role, authenticated: true, schoolId: "school-1", userId: "user-1" },
    ws: {
      readyState: options.readyState ?? 1,
      send: (frame: string) => { frames.push(JSON.parse(frame) as Frame); },
    },
    WebSocket: { OPEN: 1 },
    classpilotLiveViewSignalingEnabled: () => classpilotLiveViewSignalingEnabled(options.env ?? {}),
    normalizeClasspilotSignalingIdentifier,
  };
  const outcome = await runInNewContext(executable, context)();
  return { frames, fellThrough: outcome === FELL_THROUGH };
}

describe("legacy Live View signaling gate with the flag unset", () => {
  it("answers a staff request-stream with exactly one LIVE_VIEW_RETIRED frame and stops", async () => {
    for (const role of STAFF_ROLES) {
      const { frames, fellThrough } = await runGate({
        role,
        message: { type: "request-stream", studentId: "student-1", teachingSessionId: "session-1" },
      });
      assert.equal(fellThrough, false, `${role} request-stream must not reach target resolution`);
      assert.deepEqual(frames, [{ type: "live-view-unavailable", code: "LIVE_VIEW_RETIRED", studentId: "student-1" }]);
    }
  });

  it("echoes only a normalized student identifier, never raw client input", async () => {
    const fallback = await runGate({ role: "teacher", message: { type: "request-stream", toStudentId: "student-2" } });
    assert.deepEqual(fallback.frames, [{ type: "live-view-unavailable", code: "LIVE_VIEW_RETIRED", studentId: "student-2" }]);
    for (const studentId of [" student-1 ", "student 1", { id: "student-1" }, "", undefined]) {
      const { frames, fellThrough } = await runGate({ role: "teacher", message: { type: "request-stream", studentId } });
      assert.equal(fellThrough, false);
      assert.deepEqual(frames, [{ type: "live-view-unavailable", code: "LIVE_VIEW_RETIRED", studentId: null }]);
    }
  });

  it("drops a request-stream from any other role silently", async () => {
    for (const role of ["student", "office_staff"]) {
      const { frames, fellThrough } = await runGate({ role, message: { type: "request-stream", studentId: "student-1" } });
      assert.equal(fellThrough, false, `${role} request-stream must stop at the gate`);
      assert.deepEqual(frames, [], `${role} request-stream must receive no frame`);
    }
  });

  it("drops offer, answer and ice from staff and students silently", async () => {
    for (const role of [...STAFF_ROLES, "student"]) {
      for (const type of NEGOTIATION_TYPES) {
        const { frames, fellThrough } = await runGate({
          role,
          message: { type, to: "teacher", negotiationId: "signed-negotiation", studentId: "student-1" },
        });
        assert.equal(fellThrough, false, `${role} ${type} must stop at the gate`);
        assert.deepEqual(frames, [], `${role} ${type} must receive no frame`);
      }
    }
  });

  it("never gates stop-share, so capture can always be ended", async () => {
    for (const role of [...STAFF_ROLES, "student"]) {
      const { frames, fellThrough } = await runGate({
        role,
        message: { type: "stop-share", to: "teacher", negotiationId: "signed-negotiation", studentId: "student-1" },
      });
      assert.equal(fellThrough, true, `${role} stop-share must reach its authorized branch`);
      assert.deepEqual(frames, []);
    }
  });

  it("stops a staff request-stream without sending when the socket is no longer open", async () => {
    const { frames, fellThrough } = await runGate({
      role: "teacher",
      readyState: 3,
      message: { type: "request-stream", studentId: "student-1" },
    });
    assert.equal(fellThrough, false);
    assert.deepEqual(frames, []);
  });

  it("leaves every other frame type untouched", async () => {
    for (const type of ["command-ack", "classroom-state-request", "chat-ack", "subscribe-session", "", undefined]) {
      const { frames, fellThrough } = await runGate({ role: "teacher", message: { type } });
      assert.equal(fellThrough, true, `${String(type)} must fall through`);
      assert.deepEqual(frames, []);
    }
  });

  it("treats empty and malformed flag values as off", async () => {
    for (const value of ["", "0", "false", "off", "no", "enabled", "maybe"]) {
      const { frames, fellThrough } = await runGate({
        role: "teacher",
        env: { [FLAG]: value },
        message: { type: "request-stream", studentId: "student-1" },
      });
      assert.equal(fellThrough, false, `${FLAG}=${JSON.stringify(value)} must keep the gate closed`);
      assert.equal(frames.length, 1);
    }
  });
});

describe("legacy Live View signaling gate with the local/test flag set", () => {
  it("lets every signaling frame through to the existing authorized handlers unchanged", async () => {
    for (const value of ["true", "1", "yes", "on"]) {
      for (const role of [...STAFF_ROLES, "student"]) {
        for (const type of ["request-stream", ...NEGOTIATION_TYPES, "stop-share"]) {
          const { frames, fellThrough } = await runGate({
            role,
            env: { [FLAG]: value },
            message: { type, studentId: "student-1", negotiationId: "signed-negotiation" },
          });
          assert.equal(fellThrough, true, `${role} ${type} must fall through when ${FLAG}=${value}`);
          assert.deepEqual(frames, []);
        }
      }
    }
  });
});

describe("legacy Live View signaling gate source contract", () => {
  const handlerStart = source.indexOf("const handleMessage = async");
  const handlerEnd = source.indexOf('console.error("[WebSocket] Message error:"', gateEnd);

  it("is a single gate that runs after per-frame revalidation and before every Live View handler", () => {
    assert.ok(handlerStart > 0 && handlerStart < gateStart && gateEnd < handlerEnd);
    assert.equal(source.indexOf(GATE_MARKER, gateStart + GATE_MARKER.length), -1, "exactly one gate");
    assert.ok(gateStart > source.indexOf("job: \"staffWebSocketMessageRevalidation\""),
      "staff frames are revalidated before the gate");
    assert.ok(gateStart > source.indexOf("Authentication is not a one-time authorization grant"),
      "student frames are revalidated before the gate");

    // No Live View negotiation type is examined anywhere in the frame handler
    // before the gate; every such branch (and the resolver) comes after it.
    const handler = source.slice(handlerStart, handlerEnd);
    const relativeGateStart = gateStart - handlerStart;
    const relativeGateEnd = gateEnd - handlerStart;
    const typeChecks = [...handler.matchAll(/message\.type === "(?:request-stream|offer|answer|ice)"/g)]
      .map((match) => ({ text: match[0], index: match.index ?? -1 }));
    assert.ok(typeChecks.length > 0);
    for (const check of typeChecks) {
      assert.ok(
        check.index >= relativeGateStart,
        `${check.text} is examined before the Live View signaling gate`,
      );
    }
    const afterGate = typeChecks.filter((check) => check.index >= relativeGateEnd).map((check) => check.text);
    for (const type of ["request-stream", ...NEGOTIATION_TYPES]) {
      assert.ok(afterGate.includes(`message.type === "${type}"`), `${type} branch must follow the gate`);
    }

    // Every device forward in the frame handler follows the gate.
    const deviceForwards = [...handler.matchAll(/sendToDeviceLocal\(|kind: "device"/g)]
      .map((match) => ({ text: match[0], index: match.index ?? -1 }));
    assert.ok(deviceForwards.length >= 6, "request-stream, negotiation and stop-share forwards are all present");
    for (const forward of deviceForwards) {
      assert.ok(forward.index >= relativeGateEnd, `${forward.text} precedes the Live View signaling gate`);
    }

    // stop-share is never gated, and both stop branches still follow the gate.
    assert.doesNotMatch(gate, /message\.type === "stop-share"/);
    assert.ok(source.indexOf('if (message.type === "stop-share" && client.role === "student")') > gateEnd);
    assert.ok(source.indexOf("// --- Remote control: stop-share ---") > gateEnd);
  });

  it("cannot forward anything and replies only through the requesting socket", () => {
    assert.doesNotMatch(gate, /sendToDeviceLocal|sendToStaffUserLocal|sendToStudentBindingLocal|publishWS|broadcast|resolveLiveTarget/);
    assert.equal(gate.match(/ws\.send\(/g)?.length, 1);
    assert.match(gate, /code: "LIVE_VIEW_RETIRED"/);
    assert.match(gate, /client\.role === "teacher" \|\| client\.role === "school_admin" \|\| client\.role === "super_admin"/);
    assert.match(gate, /ws\.readyState === WebSocket\.OPEN/);
  });

  it("keeps the flag out of every region other tests execute or slice", () => {
    // classpilot-live-view-receipt.test.ts runs the request-stream branch in a
    // VM whose context has no flag; the security contract slices the resolver
    // and relay regions. The identifier may appear only in the import and gate.
    const occurrences = [...source.matchAll(/classpilotLiveViewSignalingEnabled/g)].map((match) => match.index ?? -1);
    assert.equal(occurrences.length, 2);
    assert.match(source, /import \{ classpilotLiveViewSignalingEnabled \} from "\.\.\/config\/runtime\.js";/);
    const [importIndex = -1, gateIndex = -1] = occurrences;
    assert.ok(importIndex >= 0 && importIndex < handlerStart, "the import is the only use outside the gate");
    assert.ok(gateIndex > gateStart && gateIndex < gateEnd, "the gate is the only runtime reader");
  });
});

describe("classroom activity Live View capability", () => {
  const activity = readFileSync(new URL("../src/services/classpilotDashboardActivity.ts", import.meta.url), "utf8");
  const functionStart = activity.indexOf("function classroomActivityCapabilities(");
  const functionEnd = activity.indexOf("/** Personal assignment only.", functionStart);
  assert.ok(functionStart > 0 && functionEnd > functionStart);
  const capabilities = ts.transpileModule(
    `${activity.slice(functionStart, functionEnd)}; classroomActivityCapabilities;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
  ).outputText;

  function evaluate(processEnv: NodeJS.ProcessEnv, explicitEnv?: NodeJS.ProcessEnv) {
    const factory = runInNewContext(capabilities, {
      SCHEDULED_CLASSROOM_COMMANDS: ["open-tab", "timer"],
      classpilotLiveViewSignalingEnabled,
      process: { env: processEnv },
    });
    return JSON.parse(JSON.stringify(explicitEnv ? factory(explicitEnv) : factory())) as Record<string, unknown>;
  }

  it("stops advertising Live View while the server refuses its signaling", () => {
    const expected = { commands: ["open-tab", "timer"], fab: true, chat: true, raiseHand: true, polls: true,
      timers: true, liveView: false, screenshots: true, settings: true };
    assert.deepEqual(evaluate({}), expected);
    assert.deepEqual(evaluate({ [FLAG]: "maybe" }), expected);
    assert.deepEqual(evaluate({ [FLAG]: "true" }), { ...expected, liveView: true });
    assert.deepEqual(evaluate({}, { [FLAG]: "true" }), { ...expected, liveView: true });
    // Every activity the feed builds takes its capabilities from this function.
    assert.equal(activity.match(/capabilities: classroomActivityCapabilities\(\)/g)?.length, 2);
    assert.doesNotMatch(activity, /liveView: true/);
  });
});
