import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

process.env.NODE_ENV = "test";
process.env.REDIS_URL = "";
process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";

const realtime = await import("../src/services/classpilotRealtimeStatus.ts");
const { focusStatusSchema } = await import("../src/services/classpilotFocus.ts");

type PublicTabContract = {
  acceptedCapabilities: Record<string, boolean>;
  tabSnapshotRevision: number | null;
  tabSnapshot: { schemaVersion: number; revision: number } | null;
  focus?: { state: string; assignmentId?: string; reason?: string };
};

// Exercise the actual route serializers without starting their database-backed
// routers. This is the same source-function seam used by the optional Focus
// status regression: no test copy of the public projection is maintained.
function loadProjection(path: string, startMarker: string, endMarker: string, name: string):
  (snapshot: Record<string, unknown>) => PublicTabContract {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${name} source seam must exist`);
  const executable = ts.transpileModule(`${source.slice(start, end)}\n${name};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return runInNewContext(executable, { ...realtime, focusStatusSchema, Date });
}

const projections = [
  ["initial Dashboard read", loadProjection("../src/routes/compat.ts",
    "function publicClasspilotExtensionContract(", "async function loadAuthorizedRealtimeStatuses", "publicClasspilotExtensionContract")],
  ["heartbeat Dashboard update", loadProjection("../src/routes/classpilot/devices.ts",
    "function publicRealtimeFields(", "\ntype ClasspilotRealtimeControlAuthority", "publicRealtimeFields")],
] as const;

const now = Date.now();
const heartbeat = {
  schoolId: "focus-contract-school", studentId: "focus-contract-student",
  studentSessionId: "private-session-binding", deviceId: "private-device-binding",
  heartbeatId: "focus-contract-heartbeat", observedAt: now, trackingStatus: "ACTIVE",
  clientProtocolVersion: 3, extensionVersion: "2.9.7", tabSnapshotRevision: 7,
  allOpenTabs: [{ tabRef: "opaque-exact-tab", title: "Example", url: "https://example.test/", active: true }],
  extensionCapabilities: ["scopedAuthorityChecksV1", "focusTabV1"],
};

async function snapshot(acceptedCapabilities: string[]) {
  const cache = realtime.createClasspilotRealtimeStatusStore(async (args) => {
    if (args[0] === "EVAL") return args[5];
    throw new Error("Unexpected cache command");
  }, () => now);
  const written = await cache.write({ ...heartbeat, acceptedCapabilities });
  assert.ok(written.snapshot);
  return written.snapshot;
}

describe("public Focus and Bring Forward capability contract", () => {
  it("keeps negotiated support and the exact revision on initial read and every heartbeat update", async () => {
    const negotiated = await snapshot(["scopedAuthorityChecksV1", "focusTabV1"]);
    for (const [surface, project] of projections) {
      const contract = project({ ...negotiated });
      assert.equal(contract.acceptedCapabilities.focusTabV1, true, `${surface} must retain accepted Focus support`);
      assert.equal(contract.acceptedCapabilities.scopedAuthorityChecksV1, true);
      assert.equal(contract.tabSnapshotRevision, 7);
      assert.equal(contract.tabSnapshot?.revision, 7);
      const serialized = JSON.stringify(contract);
      assert.equal(serialized.includes("private-device-binding"), false);
      assert.equal(serialized.includes("private-session-binding"), false);
    }
  });

  it("never upgrades an extension advertisement to negotiated Focus support", async () => {
    const advertisedOnly = await snapshot(["scopedAuthorityChecksV1"]);
    for (const [surface, project] of projections) {
      const contract = project({ ...advertisedOnly });
      assert.equal(contract.acceptedCapabilities.focusTabV1, false, `${surface} must keep advertisement-only clients disabled`);
      assert.equal(contract.acceptedCapabilities.scopedAuthorityChecksV1, true);
    }
  });

  it("replaces previously accepted support with false after renegotiation revokes it", async () => {
    const enabled = await snapshot(["scopedAuthorityChecksV1", "focusTabV1"]);
    const revoked = await snapshot([]);
    for (const [surface, project] of projections) {
      let dashboard = { acceptedCapabilities: project({ ...enabled }).acceptedCapabilities };
      dashboard = { ...dashboard, acceptedCapabilities: project({ ...revoked }).acceptedCapabilities };
      assert.equal(dashboard.acceptedCapabilities.focusTabV1, false, `${surface} must revoke the cached capability`);
      assert.equal(dashboard.acceptedCapabilities.scopedAuthorityChecksV1, false);
    }
  });

  it("retains validated lifecycle confirmation but never exposes malformed or signed-out Focus", async () => {
    const negotiated = await snapshot(["scopedAuthorityChecksV1", "focusTabV1"]);
    const states = [
      { state: "inactive" }, { state: "active", assignmentId: "focus-a" },
      { state: "suspended", assignmentId: "focus-a", reason: "attention" },
      { state: "invalidated", assignmentId: "focus-a", reason: "focus_tab_closed" },
    ];
    for (const [surface, project] of projections) {
      for (const focus of states) {
        assert.equal(JSON.stringify(project({ ...negotiated, focus }).focus), JSON.stringify(focus), `${surface} must retain validated device confirmation`);
        assert.equal(project({ ...negotiated, state: "signed_out", focus }).focus, undefined, `${surface} must suppress signed-out confirmation`);
      }
      for (const focus of [null, false, {}, { state: "active" },
        { state: "active", assignmentId: "focus-a", deviceId: "must-not-leak" }]) {
        assert.equal(project({ ...negotiated, focus }).focus, undefined, `${surface} must reject malformed Focus status`);
      }
      assert.equal(project({ ...negotiated }).focus, undefined, `${surface} must not invent confirmation`);
    }
  });
});
