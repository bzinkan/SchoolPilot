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
    tabSnapshotRevision: 7,
    observedAt: 1_000,
    activeTabUrl: unsafeSearchUrl,
    activeTabTitle: "Google Search",
    activeTabRef: "opaque-active-tab",
    allOpenTabs: [{
      tabRef: "opaque-active-tab",
      url: unsafeSearchUrl,
      title: "Google Search",
    }],
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
    extensionCapabilities: ["exactTabCloseV1"],
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

  it("targets the exact opaque tab reference and snapshot revision", () => {
    const action = resolve();

    assert.ok(action);
    assert.deepEqual(action.closeTabData, {
      tabRefs: ["opaque-active-tab"],
      snapshotRevision: 7,
    });
    assert.deepEqual(action.evidenceTarget, {
      tabRef: "opaque-active-tab",
      snapshotRevision: 7,
    });
    assert.equal(action.teachingSessionId, "teaching-session-current");
    assert.equal(action.snapshot.heartbeatId, binding.heartbeatId);
  });

  it("allows a legacy URL only when the complete snapshot has one match", () => {
    const legacy = resolve({
      realtimeMutation: {
        status: "stored",
        snapshot: snapshot({ activeTabRef: undefined, extensionCapabilities: [] }),
      },
    });
    assert.deepEqual(legacy?.closeTabData, { specificUrls: [unsafeSearchUrl] });

    const ambiguous = resolve({
      realtimeMutation: {
        status: "stored",
        snapshot: snapshot({
          activeTabRef: undefined,
          extensionCapabilities: [],
          allOpenTabs: [
            { url: unsafeSearchUrl, title: "one" },
            { url: `${unsafeSearchUrl}#duplicate`, title: "two" },
          ],
          openTabCount: 2,
        }),
      },
    });
    assert.equal(ambiguous?.closeTabData, null);
  });

  it("never infers a broad close from missing or truncated tab data", () => {
    const missing = resolve({
      realtimeMutation: {
        status: "stored",
        snapshot: snapshot({
          activeTabRef: undefined,
          extensionCapabilities: [],
          allOpenTabs: [],
          openTabCount: 0,
        }),
      },
    });
    assert.equal(missing?.closeTabData, null);

    const truncated = resolve({
      realtimeMutation: {
        status: "stored",
        snapshot: snapshot({ activeTabRef: undefined, extensionCapabilities: [], tabsTruncated: true }),
      },
    });
    assert.equal(truncated?.closeTabData, null);
  });

  it("keeps non-safety classifications outside the live safety path", () => {
    assert.equal(resolve({
      classification: classification({ safetyAlert: null }),
    }), null);
  });

});
