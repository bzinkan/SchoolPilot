import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  applyClasspilotControlCommand,
  classpilotPreciseRestrictionCapabilityRequired,
  classpilotPreciseRestrictionPayload,
  effectiveClasspilotControlEnforcementHealth,
  emptyClasspilotRestrictions,
  restrictionsFromClassroomStates,
  serializeClasspilotStudentControlStateForDelivery,
} from "../src/services/classpilotClassroomState.js";
import { negotiateClasspilotSurfaceProtocol } from "../src/services/classpilotProtocol.js";
import {
  MAX_RESTRICTION_RESOURCES,
  legacyHostProjection,
  normalizeAllowedResource,
  normalizeAllowedResourceList,
  preciseRestrictionResources,
  type AllowedResource,
} from "../src/services/restrictionResources.js";
import { classpilotFlightPathApplyPayload } from "../src/services/classpilotPreciseRestrictions.js";
import { snapshotHeartbeatHotPathMetrics } from "../src/services/heartbeatHotPathMetrics.js";
import { sanitizeExtensionMonitoringEvent } from "../src/services/classpilotMonitoringEventSanitizer.js";
import type { ClasspilotClassroomState, ClasspilotStudentControlState } from "../src/schema/classpilot.js";

// Roadmap PR 2 projection: precise Waypoints and Flight Paths reach only an
// exact binding that ACCEPTED preciseRestrictionResourcesV1, carry only
// re-validated canonical entries, never degrade to a host, and leave every
// website-only restriction byte-identical.

const NOW = new Date("2026-09-29T15:00:00.000Z");
const BINDING = {
  schoolId: "school-precise",
  studentId: "student-precise",
  studentSessionId: "session-precise",
  deviceId: "device-precise",
};
const PRECISE = "preciseRestrictionResourcesV1";

type ArchivedFixture = { requests: { heartbeat: { body: { capabilities: string[] } } } };
const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/classpilot-compatibility/classpilot-2.9.6.json", import.meta.url),
  "utf8"
)) as ArchivedFixture;
const legacyFrames = JSON.parse(readFileSync(
  new URL("./fixtures/classpilot-compatibility/schoolpilot-legacy-restriction-frames.json", import.meta.url),
  "utf8"
)) as { classroomState: { restrictions: unknown } };

function allFlagsOn(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CLASSPILOT_PROTOCOL_V3_ENABLED: "true" };
  for (const flag of [
    "SCOPED_AUTHORITY_CHECKS_V1", "AUTH_BOUND_TELEMETRY_V1", "EXACT_BINDING_ACK_V2", "EXACT_TAB_CLOSE_V2",
    "STUDENT_CHAT_IDEMPOTENCY_V1", "SCREENSHOT_OBSERVATION_LEASE_V1", "SCREENSHOT_TRACKING_WINDOW_LEASE_V1",
    "SCREENSHOT_ACTIVE_OBSERVATION_CADENCE_V1", "SAFETY_EVIDENCE_CAPTURE_V1", "KIOSK_LAUNCH_TICKET_V2",
    "STUDENT_AUTH_GATE_PRESENCE_V1", "LATE_SIGNIN_RESTRICTION_SSO_V1", "RESTRICTION_AUTH_PASS_THROUGH_V1",
    "SCHEDULED_CLASSROOM_V1", "PRECISE_RESTRICTION_RESOURCES_V1",
  ]) env[`CLASSPILOT_CAP_${flag}`] = "true";
  return env;
}

// What the fleet's 2.9.6 negotiates even with the precise server flag on.
const ACCEPTED_2_9_6 = negotiateClasspilotSurfaceProtocol({
  surface: "heartbeat",
  payload: fixture.requests.heartbeat.body,
  scope: { schoolId: BINDING.schoolId },
  env: allFlagsOn(),
}).acceptedCapabilities as readonly string[];
// A 2.10.0-shaped advertisement: 2.9.6 plus the precise capability.
const ACCEPTED_2_10_0 = negotiateClasspilotSurfaceProtocol({
  surface: "heartbeat",
  payload: { capabilities: [...fixture.requests.heartbeat.body.capabilities, PRECISE], clientProtocolVersion: 3 },
  scope: { schoolId: BINDING.schoolId },
  env: allFlagsOn(),
}).acceptedCapabilities as readonly string[];

const DOC = normalizeAllowedResource({ url: "https://docs.google.com/document/d/1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuVwXyZ/edit" });
const VIDEO = normalizeAllowedResource({ url: "https://youtu.be/dQw4w9WgXcQ" });
const SECTION = normalizeAllowedResource({ url: "https://www.nasa.gov/solar-system" });

function controlState(restrictions: unknown, overrides: Partial<ClasspilotStudentControlState> = {}): ClasspilotStudentControlState {
  return {
    id: "control-precise",
    schoolId: BINDING.schoolId,
    studentId: BINDING.studentId,
    teachingSessionId: "teaching-session-precise",
    supervisionContextId: null,
    revision: 7,
    desiredState: { restrictions },
    sourceCommandId: "command-precise",
    scheduledEndAt: new Date("2026-09-29T16:00:00.000Z"),
    hardExpiresAt: new Date("2026-09-30T03:00:00.000Z"),
    enforcementHealth: "synced",
    appliedRevision: 7,
    lastOutcome: "applied",
    lastError: null,
    lastAcknowledgedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function deliver(restrictions: unknown, acceptedCapabilities: readonly string[], exactBinding: typeof BINDING | null = BINDING) {
  return serializeClasspilotStudentControlStateForDelivery({
    state: controlState(restrictions),
    gateActive: true,
    acceptedCapabilities,
    exactBinding,
    now: NOW,
  });
}

function waypoint(resource: AllowedResource) {
  return applyClasspilotControlCommand(emptyClasspilotRestrictions(), "lock-screen", {
    url: resource.type === "resource" ? resource.canonicalUrl : `https://${resource.hostname}${"pathPrefix" in resource ? resource.pathPrefix : ""}`,
    resource,
  }, NOW);
}

function flightPath(allowedDomains: string[], resources: AllowedResource[]) {
  return applyClasspilotControlCommand(emptyClasspilotRestrictions(), "apply-flight-path", {
    flightPathId: "path-precise",
    flightPathName: "Moon Phases",
    allowedDomains,
    ...(resources.length > 0 ? { resources } : {}),
  }, NOW);
}

const WITHHELD = { classroomState: null, withheld: true, withheldReason: "precise_restriction_capability_required" };

describe("precise restriction projection", () => {
  it("negotiates the capability only for a 2.10.0-shaped advertisement", () => {
    assert.equal(ACCEPTED_2_9_6.includes(PRECISE), false);
    assert.equal(ACCEPTED_2_10_0.includes(PRECISE), true);
  });

  it("withholds precise Waypoints and Flight Paths from the archived 2.9.6 capability set", () => {
    for (const restrictions of [waypoint(DOC), waypoint(VIDEO), waypoint(SECTION), flightPath([], [DOC]), flightPath(["khanacademy.org"], [SECTION, VIDEO])]) {
      assert.deepEqual(deliver(restrictions, ACCEPTED_2_9_6), WITHHELD);
    }
  });

  it("delivers them to a capable exact binding with canonical entries and website hosts only in allowedDomains", () => {
    const deliveredWaypoint = deliver(waypoint(VIDEO), ACCEPTED_2_10_0);
    assert.equal(deliveredWaypoint.withheld, false);
    assert.deepEqual(deliveredWaypoint.classroomState?.restrictions.screenLock, {
      active: true,
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      resource: VIDEO,
    });
    const mixed = flightPath(["khanacademy.org"], [SECTION, DOC, VIDEO]);
    const deliveredPath = deliver(mixed, ACCEPTED_2_10_0);
    assert.equal(deliveredPath.withheld, false);
    assert.deepEqual(deliveredPath.classroomState?.restrictions.flightPath, {
      active: true,
      allowedDomains: ["khanacademy.org"],
      name: "Moon Phases",
      resources: [SECTION, DOC, VIDEO],
    });
    for (const host of ["nasa.gov", "docs.google.com", "youtube.com"]) {
      assert.equal(deliveredPath.classroomState?.restrictions.flightPath.allowedDomains.includes(host), false,
        `${host} is never widened into the legacy host list`);
    }
  });

  it("requires the exact binding as well as the accepted capability", () => {
    assert.deepEqual(deliver(waypoint(DOC), ACCEPTED_2_10_0, null), WITHHELD);
    assert.deepEqual(deliver(waypoint(DOC), ACCEPTED_2_10_0, { ...BINDING, studentId: "someone-else" }), WITHHELD);
    assert.deepEqual(deliver(waypoint(DOC), [PRECISE, "scopedAuthorityChecksV1"], BINDING).withheld, false);
  });

  it("keeps website-only restrictions byte-identical to the pre-PR golden for every client", () => {
    const golden = JSON.stringify(legacyFrames.classroomState.restrictions);
    for (const accepted of [[], ACCEPTED_2_9_6, ACCEPTED_2_10_0]) {
      const delivered = deliver(JSON.parse(golden) as unknown, accepted);
      assert.equal(delivered.withheld, false);
      assert.equal(JSON.stringify(delivered.classroomState?.restrictions), golden);
    }
    // A website-only Flight Path payload carries no resources key at all.
    const websites = normalizeAllowedResourceList([{ type: "website", hostname: "khanacademy.org" }]);
    const payload = classpilotFlightPathApplyPayload({
      schoolId: BINDING.schoolId,
      flightPath: { id: "path-websites", flightPathName: "Sites", allowedDomains: ["ixl.com"], resources: preciseRestrictionResources(websites) },
      env: {},
    });
    assert.deepEqual(payload, { flightPathId: "path-websites", flightPathName: "Sites", allowedDomains: ["ixl.com"] });
    assert.deepEqual(legacyHostProjection(websites), ["khanacademy.org"]);
  });

  it("withholds a stored entry that fails re-validation, even from a capable binding", () => {
    const corrupted: Array<[string, unknown]> = [
      ["non-canonical hostname", { screenLock: { active: true, url: DOC.type === "resource" ? DOC.canonicalUrl : "", resource: { ...DOC, hostname: "DOCS.google.com" } } }],
      ["client-chosen canonical URL", { screenLock: { active: true, url: "https://evil.example.com/", resource: { ...DOC, canonicalUrl: "https://evil.example.com/" } } }],
      ["url that is not the resource's canonical URL", { screenLock: { active: true, url: "https://docs.google.com/", resource: DOC } }],
      ["website entry as a Waypoint resource", { screenLock: { active: true, url: "https://khanacademy.org", resource: { type: "website", hostname: "khanacademy.org", includeSubdomains: true } } }],
      ["resource on an inactive Waypoint", { screenLock: { active: false, resource: DOC } }],
      ["resources on an inactive Flight Path", { flightPath: { active: false, allowedDomains: [], resources: [DOC] } }],
      ["empty resources", { flightPath: { active: true, allowedDomains: ["ixl.com"], resources: [] } }],
      ["resources that are not a list", { flightPath: { active: true, allowedDomains: ["ixl.com"], resources: DOC } }],
      ["duplicate entries", { flightPath: { active: true, allowedDomains: [], resources: [DOC, DOC] } }],
      ["section with a trailing slash", { flightPath: { active: true, allowedDomains: [], resources: [{ ...SECTION, pathPrefix: "/solar-system/" }] } }],
      ["unknown key", { flightPath: { active: true, allowedDomains: [], resources: [{ ...VIDEO, note: "x" }] } }],
      ["too many entries", {
        flightPath: {
          active: true,
          allowedDomains: [],
          resources: Array.from({ length: MAX_RESTRICTION_RESOURCES + 1 }, (_, index) => ({
            ...VIDEO,
            resourceId: `v${String(index).padStart(10, "0")}`,
            canonicalUrl: `https://www.youtube.com/watch?v=v${String(index).padStart(10, "0")}`,
          })),
        },
      }],
    ];
    snapshotHeartbeatHotPathMetrics({ reset: true });
    for (const [name, restrictions] of corrupted) {
      assert.equal(classpilotPreciseRestrictionPayload(restrictions).state, "invalid", name);
      assert.deepEqual(deliver(restrictions, ACCEPTED_2_10_0), WITHHELD, name);
      assert.equal(effectiveClasspilotControlEnforcementHealth(controlState(restrictions), "2.10.0", NOW, {
        gateActive: true, acceptedCapabilities: ACCEPTED_2_10_0, exactBinding: BINDING,
      }), "unsupported", name);
      assert.equal(classpilotPreciseRestrictionCapabilityRequired({
        desiredState: { restrictions }, acceptedCapabilities: ACCEPTED_2_10_0,
      }), true, name);
    }
    assert.equal(snapshotHeartbeatHotPathMetrics({ reset: true }).counters.preciseRestrictionDeliveryWithheld, corrupted.length);
  });

  it("never serializes a resource Waypoint without its resource, whatever else changes", () => {
    const commands: Array<[string, Record<string, unknown>]> = [
      ["apply-block-list", { blockListId: "games", blockListName: "Games", blockedDomains: ["poki.com"] }],
      ["attention-mode", { active: true, message: "Look up" }],
      ["attention-mode", { active: false }],
      ["limit-tabs", { maxTabs: 2 }],
      ["temp-unblock", { domain: "wikipedia.org", durationMinutes: 5 }],
      ["remove-block-list", {}],
    ];
    let restrictions = waypoint(DOC);
    for (const [command, payload] of commands) {
      restrictions = applyClasspilotControlCommand(restrictions, command, payload, NOW);
      for (const accepted of [[], ACCEPTED_2_9_6, ACCEPTED_2_10_0]) {
        const delivered = deliver(restrictions, accepted);
        if (delivered.withheld) {
          assert.deepEqual(delivered, WITHHELD, command);
          continue;
        }
        assert.ok(accepted.includes(PRECISE), `${command}: only a capable binding receives it`);
        assert.deepEqual(delivered.classroomState?.restrictions.screenLock, {
          active: true,
          url: DOC.type === "resource" ? DOC.canonicalUrl : "",
          resource: DOC,
        }, command);
      }
    }
    // Replacing or clearing it yields an ordinary, deliverable Waypoint state.
    for (const [command, payload] of [
      ["unlock-screen", { screenOnly: true }],
      ["unlock-screen", {}],
      ["lock-screen", { url: "https://www.ixl.com/math" }],
      ["apply-flight-path", { flightPathId: "math", flightPathName: "Math", allowedDomains: ["ixl.com"] }],
    ] as const) {
      const replaced = applyClasspilotControlCommand(restrictions, command, payload, NOW);
      assert.equal("resource" in replaced.screenLock, false, command);
      assert.equal(deliver(replaced, ACCEPTED_2_9_6).withheld, false, command);
    }
  });

  it("rebuilds precise rows from classroom states exactly as the reducer writes them", () => {
    const row = (stateType: string, payload: Record<string, unknown>): ClasspilotClassroomState => ({
      id: `row-${stateType}`,
      schoolId: BINDING.schoolId,
      teachingSessionId: "teaching-session-precise",
      supervisionContextId: null,
      studentId: BINDING.studentId,
      stateType,
      stateKey: "active",
      payload,
      commandId: "command-precise",
      appliedBy: "teacher-precise",
      appliedAt: NOW,
      expiresAt: null,
      clearedAt: null,
      updatedAt: NOW,
    });
    const rebuilt = restrictionsFromClassroomStates([
      row("flight-path", { flightPathId: "path", flightPathName: "Moon", allowedDomains: ["khanacademy.org"], resources: [SECTION, VIDEO] }),
    ], NOW);
    assert.deepEqual(rebuilt.flightPath, {
      active: true, allowedDomains: ["khanacademy.org"], name: "Moon", resources: [SECTION, VIDEO],
    });
    assert.deepEqual(deliver(rebuilt, ACCEPTED_2_10_0).classroomState?.restrictions.flightPath, rebuilt.flightPath);
  });

  it("keeps the largest list the authoring rules accept inside the desired-state and realtime budgets", () => {
    // 44-character Google file ids: the byte budget, not the 200-entry cap,
    // is what binds for Docs (about 189 entries).
    const inputs = Array.from({ length: MAX_RESTRICTION_RESOURCES }, (_, index) => ({
      url: `https://docs.google.com/document/d/${String(index).padStart(44, "D")}/edit`,
    }));
    let docs: AllowedResource[] = [];
    for (let count = inputs.length; count > 0 && docs.length === 0; count -= 1) {
      try {
        docs = normalizeAllowedResourceList(inputs.slice(0, count));
      } catch {
        // Over the authoring byte budget; try one fewer.
      }
    }
    assert.ok(docs.length >= 180, `${docs.length} Google Docs fit the authoring budget`);
    const allowedDomains = Array.from({ length: 100 }, (_, index) => `site${index}.example.edu`);
    const restrictions = flightPath(allowedDomains, docs);
    const desiredBytes = Buffer.byteLength(JSON.stringify({ restrictions }), "utf8");
    assert.ok(desiredBytes <= 64 * 1024, `desired state ${desiredBytes} bytes fits the 64 KiB store budget`);
    const delivered = deliver(restrictions, ACCEPTED_2_10_0);
    assert.equal(delivered.withheld, false);
    const deliveredBytes = Buffer.byteLength(JSON.stringify(delivered.classroomState), "utf8");
    assert.ok(deliveredBytes <= 128 * 1024, `delivered snapshot ${deliveredBytes} bytes fits the realtime cache`);
  });

  it("projects the accepted capability, never the raw advertisement, on every public surface", () => {
    const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
    for (const [path, set] of [
      ["../src/routes/classpilot/devices.ts", "acceptedCapabilities"],
      ["../src/routes/compat.ts", "acceptedCapabilities"],
      ["../src/services/classpilotCoverageHydration.ts", "acceptedCapabilities"],
    ] as const) {
      const text = source(path);
      assert.match(text, new RegExp(`preciseRestrictionResourcesV1: ${set}\\.has\\("preciseRestrictionResourcesV1"\\)`), path);
      assert.doesNotMatch(text, /preciseRestrictionResourcesV1: (?:extensionCapabilities|capabilities)\.has/, path);
    }
    assert.match(
      source("../src/routes/compat.ts"),
      /preciseRestrictionResourcesV1: isClasspilotCapabilityActive\(\s*"preciseRestrictionResourcesV1",\s*\{ schoolId \}\s*\)/
    );
  });
});

describe("precise restriction reporting (pure)", () => {
  it("accepts the resource policy source on blocked-navigation events", () => {
    const event = sanitizeExtensionMonitoringEvent({
      sourceEventId: "evt-precise-policy",
      schemaVersion: 1,
      type: "navigation_blocked",
      occurredAt: NOW.toISOString(),
      url: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
      metadata: { policySource: "resource" },
    }, new Date(NOW.getTime() + 1_000));
    assert.equal(event?.metadata.policySource, "resource");
  });
});
