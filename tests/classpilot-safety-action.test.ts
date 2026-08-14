import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveCurrentClasspilotSafetyAction } from "../src/services/classpilotSafetyAction.js";
import type { AiClassification } from "../src/services/aiClassification.js";
import type { ClasspilotRealtimeStatus } from "../src/services/classpilotRealtimeStatus.js";

const binding = {
  schoolId: "school-a",
  studentId: "student-a",
  studentSessionId: "student-session-a",
  deviceId: "device-a",
  heartbeatId: "heartbeat-a",
};

const unsafeSearchUrl = "https://www.google.com/search?q=suicide%20method";

function classification(overrides: Partial<AiClassification> = {}): AiClassification {
  return {
    category: "non-educational",
    safetyAlert: "self-harm",
    domain: "search:suicide method",
    classifiedAt: 1_000,
    ...overrides,
  };
}

function snapshot(overrides: Partial<ClasspilotRealtimeStatus> = {}): ClasspilotRealtimeStatus {
  return {
    schemaVersion: 2,
    state: "active",
    ...binding,
    revision: 10,
    observedAt: 1_000,
    activeTabUrl: unsafeSearchUrl,
    activeTabTitle: "Google Search",
    allOpenTabs: [],
    openTabCount: 1,
    tabsTruncated: false,
    activityState: "active",
    classroomControls: {
      screenLocked: false,
      flightPathActive: false,
      isSharing: false,
      cameraActive: false,
    },
    classroomState: {
      schemaVersion: 1,
      revision: 4,
      teachingSessionId: "teaching-session-current",
      supervisionContextId: null,
      receivedAt: "2026-08-13T12:00:00.000Z",
      restrictions: {
        screenLock: { active: false },
        flightPath: { active: false, allowedDomains: [] },
        blockList: { active: false, blockedDomains: [] },
        attentionMode: { active: false },
        tabLimit: null,
        temporaryAllows: [],
      },
      scheduledEndAt: null,
      hardExpiresAt: "2026-08-14T00:00:00.000Z",
    },
    classificationPending: false,
    ...overrides,
  };
}

function resolve(overrides: Partial<Parameters<typeof resolveCurrentClasspilotSafetyAction>[0]> = {}) {
  return resolveCurrentClasspilotSafetyAction({
    classification: classification(),
    realtimeMutation: { status: "stored", snapshot: snapshot() },
    ...binding,
    activeTabUrl: unsafeSearchUrl,
    activeTabTitle: "Google Search",
    ...overrides,
  });
}

describe("ClassPilot current-heartbeat safety action boundary", () => {
  it("rejects a stale classification before any live safety context is created", () => {
    assert.equal(resolve({ realtimeMutation: { status: "stale" } }), null);
  });

  it("rejects a returned snapshot whose heartbeat or active binding differs", () => {
    assert.equal(resolve({
      realtimeMutation: {
        status: "stored",
        snapshot: snapshot({ heartbeatId: "heartbeat-newer" }),
      },
    }), null);
    assert.equal(resolve({
      realtimeMutation: {
        status: "stored",
        snapshot: snapshot({ studentSessionId: "replacement-session" }),
      },
    }), null);
  });

  it("targets the exact classified search URL and attributes from the returned snapshot", () => {
    const action = resolve();

    assert.ok(action);
    assert.deepEqual(action.closeTabData, { specificUrls: [unsafeSearchUrl] });
    assert.equal(action.teachingSessionId, "teaching-session-current");
    assert.equal(action.snapshot.heartbeatId, binding.heartbeatId);
    assert.notEqual(action.closeTabData.specificUrls[0], classification().domain);
  });

  it("keeps non-safety classifications outside the live safety path", () => {
    assert.equal(resolve({
      classification: classification({ safetyAlert: null }),
    }), null);
  });

  it("routes every live safety side effect through the guarded action context", () => {
    const source = readFileSync(
      new URL("../src/routes/classpilot/devices.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("const safetyAction = resolveCurrentClasspilotSafetyAction");
    const end = source.indexOf("// --- Deliver any missed messages", start);
    const safetyPath = source.slice(start, end);

    assert.ok(start >= 0 && end > start);
    assert.match(safetyPath, /if \(safetyAction\) \{/);
    assert.match(safetyPath, /data: safetyAction\.closeTabData/);
    assert.match(safetyPath, /deliveryPolicy: classpilotCommandDeliveryPolicy\("close-tab"\)/);
    assert.match(safetyPath, /expiresAt: safetyCommandExpiresAt\.toISOString\(\)/);
    assert.match(safetyPath, /const alertSessionId = safetyAction\.teachingSessionId/);
    assert.doesNotMatch(safetyPath, /pattern: classification\.domain/);
  });
});
