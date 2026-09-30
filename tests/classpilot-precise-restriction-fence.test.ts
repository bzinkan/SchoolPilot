import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  CLASSPILOT_PRECISE_RESTRICTION_ENFORCEMENT_UNAVAILABLE_REASON,
  CLASSPILOT_PRECISE_RESTRICTION_TARGET_UNAVAILABLE_REASON,
  applyClasspilotControlCommand,
  classpilotCommandPayloadRequiresPreciseCapability,
  classpilotControlStateRequiresPreciseCapability,
  classpilotRestrictionsRequirePreciseCapability,
  effectiveClasspilotControlEnforcementHealth,
  emptyClasspilotRestrictions,
  normalizeClasspilotRestrictions,
  restrictionsFromClassroomStates,
  serializeClasspilotStudentControlState,
  serializeClasspilotStudentControlStateForDelivery,
  withClasspilotLateSignInOrigin,
} from "../src/services/classpilotClassroomState.js";
import type {
  ClasspilotClassroomState,
  ClasspilotStudentControlState,
} from "../src/schema/classpilot.js";
import { snapshotHeartbeatHotPathMetrics } from "../src/services/heartbeatHotPathMetrics.js";

// Roadmap PR 2-pre forward-compatibility fence, as converted by PR 2. A precise
// Waypoint is stored as `screenLock.resource` and precise Flight Path entries
// as `flightPath.resources`. A payload carrying either key is never degraded
// to a whole-domain lock or an empty Flight Path: it is withheld from every
// binding that has not negotiated preciseRestrictionResourcesV1 (and from
// every binding when it fails re-validation), and every payload that exists
// today still serializes exactly as before. Capable delivery is covered in
// classpilot-precise-restriction-projection.test.ts.

const NOW = new Date("2026-09-29T15:00:00.000Z");
const APPLIED_AT = new Date("2026-09-29T14:55:00.000Z");
const BINDING = {
  schoolId: "school-golden",
  studentId: "student-golden",
  studentSessionId: "session-golden",
  deviceId: "device-golden",
};
const SSO_POLICY = {
  schemaVersion: 1 as const,
  enabled: true,
  defaultProfileId: "clever",
  attemptTtlSeconds: 300 as const,
  profiles: [{
    id: "clever",
    name: "Clever",
    startUrl: "https://clever.com/in/example-district",
    hostRules: [
      { hostname: "clever.com", includeSubdomains: true },
      { hostname: "accounts.google.com", includeSubdomains: false },
    ],
  }],
};

// The capability set ClassPilot 2.9.6 negotiates under an all-on server, plus
// focusTabV1 spoofed in. Without preciseRestrictionResourcesV1 accepted,
// nothing may unlock the fence. (PR 2 deliberately removed that name from
// this spoofed set: a binding that negotiated it now receives valid entries.)
const EVERY_CAPABILITY = [
  "scopedAuthorityChecksV1",
  "authBoundTelemetryV1",
  "exactBindingAckV2",
  "exactTabCloseV2",
  "studentChatIdempotencyV1",
  "lateSignInRestrictionSsoV1",
  "restrictionAuthPassThroughV1",
  "restrictionPortalFirstV1",
  "scheduledClassroomV1",
  "focusTabV1",
];
const PRECISE_CAPABLE = [...EVERY_CAPABILITY, "preciseRestrictionResourcesV1"];

function classroomRow(
  stateType: string,
  stateKey: string,
  payload: Record<string, unknown>,
  expiresAt: Date | null = null
): ClasspilotClassroomState {
  return {
    id: `row-${stateType}-${stateKey}`,
    schoolId: BINDING.schoolId,
    teachingSessionId: "teaching-session-golden",
    supervisionContextId: null,
    studentId: BINDING.studentId,
    stateType,
    stateKey,
    payload,
    commandId: `command-${stateType}`,
    appliedBy: "teacher-golden",
    appliedAt: APPLIED_AT,
    expiresAt,
    clearedAt: null,
    updatedAt: APPLIED_AT,
  };
}

function controlState(
  desiredState: unknown,
  overrides: Partial<ClasspilotStudentControlState> = {}
): ClasspilotStudentControlState {
  return {
    id: "control-golden",
    schoolId: BINDING.schoolId,
    studentId: BINDING.studentId,
    teachingSessionId: "teaching-session-golden",
    supervisionContextId: null,
    revision: 41,
    desiredState,
    sourceCommandId: "command-golden",
    scheduledEndAt: new Date("2026-09-29T16:00:00.000Z"),
    hardExpiresAt: new Date("2026-09-30T02:55:00.000Z"),
    enforcementHealth: "pending",
    appliedRevision: null,
    lastOutcome: null,
    lastError: null,
    lastAcknowledgedAt: null,
    createdAt: APPLIED_AT,
    updatedAt: APPLIED_AT,
    ...overrides,
  };
}

// Today's stored payload shapes, exactly as the dispatcher and scheduled
// classroom tools persist them.
const LEGACY_ROWS = [
  classroomRow("flight-path", "flight-path-golden", {
    flightPathId: "flight-path-golden",
    flightPathName: "Math Practice",
    allowedDomains: ["khanacademy.org", "IXL.com", "ixl.com"],
  }),
  classroomRow("screen-lock", "active", { url: "https://www.ixl.com/math" }),
  classroomRow("block-list", "block-list-golden", {
    blockListId: "block-list-golden",
    blockListName: "Games",
    blockedDomains: ["coolmathgames.com", "Poki.com"],
  }),
  classroomRow("attention", "active", { active: true, message: "Eyes on the board" }),
  classroomRow("tab-limit", "active", { maxTabs: 3 }),
  classroomRow(
    "temporary-allow",
    "youtube.com",
    { domain: "youtube.com", durationMinutes: 10 },
    new Date("2026-09-29T15:10:00.000Z")
  ),
];

const COMMAND_BY_STATE_TYPE: Record<string, string> = {
  "screen-lock": "lock-screen",
  "flight-path": "apply-flight-path",
  "block-list": "apply-block-list",
  attention: "attention-mode",
  "tab-limit": "limit-tabs",
  "temporary-allow": "temp-unblock",
};

// Golden literals captured from origin/main a811b04d before this fence existed.
const GOLDEN_RESTRICTIONS = '{"screenLock":{"active":true,"url":"https://www.ixl.com/math"},"flightPath":{"active":true,"allowedDomains":["khanacademy.org","ixl.com"],"name":"Math Practice"},"blockList":{"active":true,"blockedDomains":["coolmathgames.com","poki.com"],"name":"Games"},"attentionMode":{"active":true,"message":"Eyes on the board"},"tabLimit":3,"temporaryAllows":[{"domain":"youtube.com","expiresAt":"2026-09-29T15:10:00.000Z"}]}';
const GOLDEN_DELIVERY_PLAIN = '{"classroomState":{"schemaVersion":1,"revision":41,"teachingSessionId":"teaching-session-golden","supervisionContextId":null,"receivedAt":"2026-09-29T15:00:00.000Z","scheduledEndAt":"2026-09-29T16:00:00.000Z","hardExpiresAt":"2026-09-30T02:55:00.000Z","restrictions":{"screenLock":{"active":true,"url":"https://www.ixl.com/math"},"flightPath":{"active":true,"allowedDomains":["khanacademy.org","ixl.com"],"name":"Math Practice"},"blockList":{"active":true,"blockedDomains":["coolmathgames.com","poki.com"],"name":"Games"},"attentionMode":{"active":true,"message":"Eyes on the board"},"tabLimit":3,"temporaryAllows":[{"domain":"youtube.com","expiresAt":"2026-09-29T15:10:00.000Z"}]}},"withheld":false}';
const GOLDEN_DELIVERY_AUTH = '{"classroomState":{"schemaVersion":1,"revision":41,"teachingSessionId":"teaching-session-golden","supervisionContextId":null,"receivedAt":"2026-09-29T15:00:00.000Z","scheduledEndAt":"2026-09-29T16:00:00.000Z","hardExpiresAt":"2026-09-30T02:55:00.000Z","restrictions":{"screenLock":{"active":true,"url":"https://www.ixl.com/math"},"flightPath":{"active":true,"allowedDomains":["khanacademy.org","ixl.com"],"name":"Math Practice"},"blockList":{"active":true,"blockedDomains":["coolmathgames.com","poki.com"],"name":"Games"},"attentionMode":{"active":true,"message":"Eyes on the board"},"tabLimit":3,"temporaryAllows":[{"domain":"youtube.com","expiresAt":"2026-09-29T15:10:00.000Z"}]},"authPassThroughPolicyRevision":12,"authPassThrough":{"schemaVersion":1,"policyRevision":12,"defaultProfileId":"clever","attemptTtlSeconds":300,"profiles":[{"id":"clever","name":"Clever","startUrl":"https://clever.com/in/example-district","hostRules":[{"hostname":"clever.com","includeSubdomains":true},{"hostname":"accounts.google.com","includeSubdomains":false}]}]}},"withheld":false}';
const GOLDEN_DELIVERY_DEFERRED = '{"classroomState":{"schemaVersion":1,"revision":41,"teachingSessionId":"teaching-session-golden","supervisionContextId":null,"receivedAt":"2026-09-29T15:00:00.000Z","scheduledEndAt":"2026-09-29T16:00:00.000Z","hardExpiresAt":"2026-09-30T02:55:00.000Z","restrictions":{"screenLock":{"active":true,"url":"https://www.ixl.com/math"},"flightPath":{"active":true,"allowedDomains":["khanacademy.org","ixl.com"],"name":"Math Practice"},"blockList":{"active":true,"blockedDomains":["coolmathgames.com","poki.com"],"name":"Games"},"attentionMode":{"active":true,"message":"Eyes on the board"},"tabLimit":3,"temporaryAllows":[{"domain":"youtube.com","expiresAt":"2026-09-29T15:10:00.000Z"}]},"deliveryContext":{"lateSignInRestrictionSso":true}},"withheld":false}';
const GOLDEN_DELIVERY_AUTH_REQUIRED = '{"classroomState":null,"withheld":true,"withheldReason":"restriction_auth_update_required"}';

// PR 2 shapes (plan "Wire contract"): one AllowedResource on a Waypoint and
// an AllowedResource[] on a Flight Path.
const DOCS_ID = "1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuVwXyZ_-abcd";
const DOCS_RESOURCE = {
  type: "resource",
  hostname: "docs.google.com",
  includeSubdomains: false,
  provider: "google_docs",
  resourceId: DOCS_ID,
  canonicalUrl: `https://docs.google.com/document/d/${DOCS_ID}/edit`,
};
const YOUTUBE_RESOURCE = {
  type: "resource",
  hostname: "youtube.com",
  includeSubdomains: false,
  provider: "youtube",
  resourceId: "dQw4w9WgXcQ",
  canonicalUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
};
const CLASSROOM_SECTION = {
  type: "section",
  hostname: "classroom.google.com",
  includeSubdomains: false,
  pathPrefix: "/c/NjE2MzQ1Njc4",
};
const KHAN_WEBSITE = { type: "website", hostname: "khanacademy.org", includeSubdomains: true };

type PreciseCase = {
  name: string;
  /** The raw key PR 2 wrote and its value, which must survive verbatim. */
  key: "resource" | "resources";
  value: unknown;
  /** Whether the entries pass PR 2's re-validation (so a capable binding may receive them). */
  valid: boolean;
  /** Desired snapshot restrictions as PR 2 would persist them. */
  restrictions: Record<string, unknown>;
  /** The same restriction as classpilot_classroom_states rows. */
  rows: ClasspilotClassroomState[];
};

function waypointCase(name: string, resource: unknown, url: string = DOCS_RESOURCE.canonicalUrl, valid = false): PreciseCase {
  return {
    name,
    key: "resource",
    value: resource,
    valid,
    restrictions: { screenLock: { active: true, url, resource } },
    rows: [classroomRow("screen-lock", "active", { url, resource })],
  };
}

function flightPathCase(name: string, allowedDomains: string[], resources: unknown, valid = false): PreciseCase {
  return {
    name,
    key: "resources",
    value: resources,
    valid,
    restrictions: {
      flightPath: { active: true, allowedDomains, name: "Reading", resources },
    },
    rows: [classroomRow("flight-path", "flight-path-precise", {
      flightPathId: "flight-path-precise",
      flightPathName: "Reading",
      allowedDomains,
      resources,
    })],
  };
}

const PRECISE_CASES: PreciseCase[] = [
  waypointCase("Docs resource Waypoint", DOCS_RESOURCE, DOCS_RESOURCE.canonicalUrl, true),
  // Out of contract under PR 2: the Waypoint url is not the resource's canonical URL.
  waypointCase("YouTube resource Waypoint", YOUTUBE_RESOURCE, "https://www.youtube.com/watch"),
  waypointCase("Classroom section Waypoint", CLASSROOM_SECTION, "https://classroom.google.com/c/NjE2MzQ1Njc4", true),
  flightPathCase("resource-only Flight Path", [], [DOCS_RESOURCE, YOUTUBE_RESOURCE], true),
  flightPathCase("mixed Flight Path", ["khanacademy.org"], [KHAN_WEBSITE, CLASSROOM_SECTION, DOCS_RESOURCE], true),
  flightPathCase("website-only resources", ["khanacademy.org"], [KHAN_WEBSITE], true),
  flightPathCase("malformed resources: string", ["khanacademy.org"], DOCS_RESOURCE.canonicalUrl),
  flightPathCase("malformed resources: null", ["khanacademy.org"], null),
  flightPathCase("malformed resources: object", ["khanacademy.org"], { type: "resource" }),
  flightPathCase("malformed resources: junk entries", ["khanacademy.org"], [null, 7, { type: "resource" }]),
  flightPathCase("malformed resources: empty array", [], []),
  waypointCase("malformed resource: null", null),
  waypointCase("malformed resource: URL string", DOCS_RESOURCE.canonicalUrl),
  waypointCase("malformed resource: array", [DOCS_RESOURCE]),
];

const WITHHELD = {
  classroomState: null,
  withheld: true,
  withheldReason: "precise_restriction_capability_required",
};

type DeliveryOptions = Parameters<typeof serializeClasspilotStudentControlStateForDelivery>[0];

function deliveryAttempts(state: ClasspilotStudentControlState): DeliveryOptions[] {
  const authPassThrough = { gateActive: true, policyRevision: 6, policy: SSO_POLICY };
  return [
    { state, gateActive: false, acceptedCapabilities: [], exactBinding: BINDING, now: NOW },
    { state, gateActive: true, acceptedCapabilities: EVERY_CAPABILITY, exactBinding: BINDING, now: NOW },
    { state, gateActive: true, acceptedCapabilities: EVERY_CAPABILITY, exactBinding: BINDING, authPassThrough, now: NOW },
    {
      state,
      gateActive: true,
      acceptedCapabilities: EVERY_CAPABILITY,
      exactBinding: BINDING,
      authPassThrough,
      portalFirstOnLogin: true as const,
      now: NOW,
    },
    // The capability without an exact binding never releases the entries.
    { state, gateActive: true, acceptedCapabilities: ["preciseRestrictionResourcesV1"], exactBinding: null, now: NOW },
    {
      state,
      gateActive: true,
      acceptedCapabilities: PRECISE_CAPABLE,
      exactBinding: { ...BINDING, studentId: "another-student" },
      now: NOW,
    },
  ];
}

describe("PR 2-pre fence: today's payloads serialize byte-identically", () => {
  it("rebuilds classroom-state rows into the exact golden restriction set", () => {
    assert.equal(JSON.stringify(restrictionsFromClassroomStates(LEGACY_ROWS, NOW)), GOLDEN_RESTRICTIONS);
    const composed = LEGACY_ROWS.reduce(
      (current: unknown, row) => applyClasspilotControlCommand(
        current,
        COMMAND_BY_STATE_TYPE[row.stateType]!,
        row.stateType === "temporary-allow" ? { ...(row.payload as object), expiresAt: row.expiresAt } : row.payload,
        NOW
      ),
      emptyClasspilotRestrictions()
    );
    assert.equal(JSON.stringify(composed), GOLDEN_RESTRICTIONS);
    const stored = JSON.parse(GOLDEN_RESTRICTIONS) as unknown;
    assert.equal(
      JSON.stringify(normalizeClasspilotRestrictions(normalizeClasspilotRestrictions(stored))),
      GOLDEN_RESTRICTIONS
    );
    assert.equal(classpilotRestrictionsRequirePreciseCapability(stored), false);
  });

  it("delivers the golden snapshot unchanged on every legacy delivery variant", () => {
    const restrictions = JSON.parse(GOLDEN_RESTRICTIONS) as unknown;
    const state = controlState({ restrictions });
    assert.equal(JSON.stringify(serializeClasspilotStudentControlStateForDelivery({
      state,
      gateActive: false,
      acceptedCapabilities: [],
      exactBinding: BINDING,
      now: NOW,
    })), GOLDEN_DELIVERY_PLAIN);
    assert.equal(JSON.stringify(serializeClasspilotStudentControlStateForDelivery({
      state,
      gateActive: false,
      acceptedCapabilities: ["restrictionAuthPassThroughV1"],
      exactBinding: BINDING,
      authPassThrough: { gateActive: true, policyRevision: 6, policy: SSO_POLICY },
      now: NOW,
    })), GOLDEN_DELIVERY_AUTH);
    assert.equal(JSON.stringify(serializeClasspilotStudentControlStateForDelivery({
      state: controlState(withClasspilotLateSignInOrigin({
        desiredState: { restrictions },
        commandId: "command-deferred-golden",
        createdAt: APPLIED_AT,
      })),
      gateActive: true,
      acceptedCapabilities: ["lateSignInRestrictionSsoV1"],
      exactBinding: BINDING,
      now: NOW,
    })), GOLDEN_DELIVERY_DEFERRED);
    assert.equal(JSON.stringify(serializeClasspilotStudentControlStateForDelivery({
      state,
      gateActive: false,
      acceptedCapabilities: [],
      exactBinding: BINDING,
      authPassThrough: { gateActive: true, policyRevision: 6, policy: SSO_POLICY },
      now: NOW,
    })), GOLDEN_DELIVERY_AUTH_REQUIRED);
    assert.equal(effectiveClasspilotControlEnforcementHealth(state, "2.9.6", NOW), "pending");
    assert.equal(effectiveClasspilotControlEnforcementHealth(
      controlState({ restrictions }, { enforcementHealth: "synced" }),
      "2.9.6",
      NOW,
      { gateActive: false, acceptedCapabilities: [], exactBinding: BINDING }
    ), "synced");
  });

  it("does not mistake Lesson Activity resources for precise restrictions", () => {
    const lessonPayload = { action: "start", title: "Read", resources: [{ url: "https://docs.google.com/document/d/x/edit" }] };
    assert.equal(classpilotCommandPayloadRequiresPreciseCapability("lesson-activity", lessonPayload), false);
    assert.equal(classpilotCommandPayloadRequiresPreciseCapability("open-tab", { url: "https://a.example", resource: DOCS_RESOURCE }), false);
    assert.equal(classpilotCommandPayloadRequiresPreciseCapability("apply-block-list", { blockedDomains: ["a.example"], resources: [] }), false);
    assert.equal(classpilotCommandPayloadRequiresPreciseCapability("lock-screen", { url: "https://www.ixl.com/math" }), false);
    assert.equal(classpilotCommandPayloadRequiresPreciseCapability("lock-screen", { url: "https://www.ixl.com/math", resource: undefined }), false);
    assert.equal(classpilotCommandPayloadRequiresPreciseCapability("apply-flight-path", { allowedDomains: ["ixl.com"] }), false);
  });
});

describe("PR 2-pre fence: PR-2-shaped payloads are withheld on every path", () => {
  for (const precise of PRECISE_CASES) {
    it(`${precise.name}: normalization preserves the raw key instead of degrading`, () => {
      assert.equal(classpilotRestrictionsRequirePreciseCapability(precise.restrictions), true);
      const normalized = normalizeClasspilotRestrictions(precise.restrictions);
      const reloaded = normalizeClasspilotRestrictions(JSON.parse(JSON.stringify(normalized)) as unknown);
      const fromRows = restrictionsFromClassroomStates(precise.rows, NOW);
      for (const restrictions of [normalized, reloaded, fromRows]) {
        const carrier: Record<string, unknown> = precise.key === "resource"
          ? restrictions.screenLock
          : restrictions.flightPath;
        assert.ok(Object.prototype.hasOwnProperty.call(carrier, precise.key), `${precise.key} survives`);
        assert.deepEqual(carrier[precise.key], precise.value);
        assert.equal(classpilotRestrictionsRequirePreciseCapability(restrictions), true);
      }
    });

    it(`${precise.name}: every non-capable delivery surface withholds instead of serializing a legacy restriction`, () => {
      const stored = controlState({ restrictions: precise.restrictions });
      const rebuilt = controlState({ restrictions: restrictionsFromClassroomStates(precise.rows, NOW) });
      const deferred = controlState(withClasspilotLateSignInOrigin({
        desiredState: { restrictions: precise.restrictions },
        commandId: "command-deferred-precise",
        createdAt: APPLIED_AT,
      }));
      for (const state of [stored, rebuilt, deferred]) {
        for (const attempt of deliveryAttempts(state)) {
          const delivered = serializeClasspilotStudentControlStateForDelivery(attempt);
          assert.equal(delivered.classroomState, null, "no domain lock or empty Flight Path is ever serialized");
          // A deferred row is first fenced by the unchanged late-sign-in gate;
          // once that gate admits the binding, the precise fence withholds it.
          const exactBound = attempt.exactBinding?.schoolId === BINDING.schoolId
            && attempt.exactBinding?.studentId === BINDING.studentId;
          const lateSignInFenced = state === deferred && !(
            attempt.gateActive && attempt.acceptedCapabilities.includes("lateSignInRestrictionSsoV1") && exactBound
          );
          assert.deepEqual(delivered, lateSignInFenced
            ? { classroomState: null, withheld: true, withheldReason: "late_sign_in_capability_required" }
            : WITHHELD);
        }
        // A capable exact binding receives only entries that re-validate.
        const capable = serializeClasspilotStudentControlStateForDelivery({
          state,
          gateActive: true,
          acceptedCapabilities: PRECISE_CAPABLE,
          exactBinding: BINDING,
          now: NOW,
        });
        if (precise.valid) {
          assert.equal(capable.withheld, false, precise.name);
          const carrier: Record<string, unknown> = precise.key === "resource"
            ? capable.classroomState!.restrictions.screenLock
            : capable.classroomState!.restrictions.flightPath;
          assert.deepEqual(carrier[precise.key], precise.value, "a valid entry is delivered verbatim, never degraded");
        } else {
          assert.deepEqual(capable, WITHHELD, "an entry that fails re-validation is withheld even from a capable binding");
        }
      }
    });

    it(`${precise.name}: enforcement health is unsupported for non-capable clients until the snapshot expires`, () => {
      const synced = controlState(
        { restrictions: precise.restrictions },
        { enforcementHealth: "synced", appliedRevision: 41, lastOutcome: "applied" }
      );
      for (const delivery of [
        undefined,
        { gateActive: true, acceptedCapabilities: EVERY_CAPABILITY, exactBinding: BINDING },
        {
          gateActive: true,
          acceptedCapabilities: EVERY_CAPABILITY,
          exactBinding: BINDING,
          restrictionAuthCapabilityRequired: false,
          restrictionAuthPolicyRevision: 12,
          appliedAuthPolicyRevision: 12,
        },
        {
          gateActive: true,
          acceptedCapabilities: PRECISE_CAPABLE,
          exactBinding: BINDING,
          preciseRestrictionCapabilityRequired: true,
        },
      ]) {
        assert.equal(effectiveClasspilotControlEnforcementHealth(synced, "2.10.0", NOW, delivery), "unsupported");
      }
      assert.equal(
        effectiveClasspilotControlEnforcementHealth(synced, "2.10.0", NOW, {
          gateActive: true,
          acceptedCapabilities: PRECISE_CAPABLE,
          exactBinding: BINDING,
        }),
        precise.valid ? "synced" : "unsupported",
        "a capable binding reports its stored health only for entries that re-validate"
      );
      assert.equal(
        effectiveClasspilotControlEnforcementHealth(synced, "2.10.0", new Date("2026-09-29T16:00:01.000Z")),
        "expired"
      );
    });
  }

  it("keeps a precise snapshot withheld when other teacher controls change around it", () => {
    for (const precise of PRECISE_CASES) {
      let restrictions = normalizeClasspilotRestrictions(precise.restrictions);
      restrictions = applyClasspilotControlCommand(restrictions, "apply-block-list", {
        blockListId: "games",
        blockListName: "Games",
        blockedDomains: ["poki.com"],
      }, NOW);
      restrictions = applyClasspilotControlCommand(restrictions, "attention-mode", { active: true, message: "Look up" }, NOW);
      restrictions = applyClasspilotControlCommand(restrictions, "limit-tabs", { maxTabs: 2 }, NOW);
      restrictions = applyClasspilotControlCommand(restrictions, "temp-unblock", { domain: "wikipedia.org", durationMinutes: 5 }, NOW);
      if (precise.key === "resources") {
        restrictions = applyClasspilotControlCommand(restrictions, "unlock-screen", { screenOnly: true }, NOW);
      }
      assert.equal(classpilotRestrictionsRequirePreciseCapability(restrictions), true, precise.name);
      assert.deepEqual(serializeClasspilotStudentControlStateForDelivery({
        state: controlState({ restrictions }),
        gateActive: true,
        acceptedCapabilities: EVERY_CAPABILITY,
        exactBinding: BINDING,
        now: NOW,
      }), WITHHELD, precise.name);
    }
  });

  it("lets a teacher on this image clear or replace a precise restriction with a deliverable state", () => {
    const waypoint = normalizeClasspilotRestrictions({
      screenLock: { active: true, url: DOCS_RESOURCE.canonicalUrl, resource: DOCS_RESOURCE },
      blockList: { active: true, blockedDomains: ["poki.com"], name: "Games" },
    });
    const flightPath = normalizeClasspilotRestrictions({
      flightPath: { active: true, allowedDomains: [], name: "Reading", resources: [DOCS_RESOURCE] },
    });
    const replacements: Array<[string, ReturnType<typeof normalizeClasspilotRestrictions>]> = [
      ["full unlock", applyClasspilotControlCommand(waypoint, "unlock-screen", {}, NOW)],
      ["screen-only unlock", applyClasspilotControlCommand(waypoint, "unlock-screen", { screenOnly: true }, NOW)],
      ["legacy Waypoint", applyClasspilotControlCommand(waypoint, "lock-screen", { url: "https://www.ixl.com/math" }, NOW)],
      ["legacy Flight Path over a Waypoint", applyClasspilotControlCommand(waypoint, "apply-flight-path", {
        flightPathId: "math",
        flightPathName: "Math",
        allowedDomains: ["ixl.com"],
      }, NOW)],
      ["remove Flight Path", applyClasspilotControlCommand(flightPath, "remove-flight-path", {}, NOW)],
      ["full unlock of a Flight Path", applyClasspilotControlCommand(flightPath, "unlock-screen", {}, NOW)],
      ["legacy Flight Path over a precise one", applyClasspilotControlCommand(flightPath, "apply-flight-path", {
        flightPathId: "math",
        flightPathName: "Math",
        allowedDomains: ["ixl.com"],
      }, NOW)],
    ];
    for (const [name, restrictions] of replacements) {
      assert.equal(classpilotRestrictionsRequirePreciseCapability(restrictions), false, name);
      const delivered = serializeClasspilotStudentControlStateForDelivery({
        state: controlState({ restrictions }),
        gateActive: false,
        acceptedCapabilities: [],
        exactBinding: BINDING,
        now: NOW,
      });
      assert.equal(delivered.withheld, false, name);
      assert.ok(delivered.classroomState, name);
      assert.equal("resource" in delivered.classroomState.restrictions.screenLock, false, name);
      assert.equal("resources" in delivered.classroomState.restrictions.flightPath, false, name);
    }
    assert.equal(
      applyClasspilotControlCommand(waypoint, "unlock-screen", { screenOnly: true }, NOW).blockList.active,
      true,
      "clearing the Waypoint keeps unrelated controls"
    );
  });

  it("still delivers the empty clear of an expired precise snapshot", () => {
    const expired = controlState(
      { restrictions: { screenLock: { active: true, url: DOCS_RESOURCE.canonicalUrl, resource: DOCS_RESOURCE } } },
      { scheduledEndAt: new Date("2026-09-29T14:59:00.000Z") }
    );
    const delivered = serializeClasspilotStudentControlStateForDelivery({
      state: expired,
      gateActive: false,
      acceptedCapabilities: [],
      exactBinding: BINDING,
      now: NOW,
    });
    assert.equal(delivered.withheld, false);
    assert.deepEqual(delivered.classroomState?.restrictions, emptyClasspilotRestrictions());
    assert.equal(effectiveClasspilotControlEnforcementHealth(expired, "2.9.6", NOW), "expired");
  });

  it("counts withheld deliveries without identifiers and reads raw or serialized snapshots alike", () => {
    snapshotHeartbeatHotPathMetrics({ reset: true });
    const state = controlState({
      restrictions: { flightPath: { active: true, allowedDomains: [], resources: [DOCS_RESOURCE] } },
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      serializeClasspilotStudentControlStateForDelivery({
        state,
        gateActive: false,
        acceptedCapabilities: [],
        exactBinding: BINDING,
        now: NOW,
      });
    }
    const metrics = snapshotHeartbeatHotPathMetrics({ reset: true });
    assert.equal(metrics.counters.preciseRestrictionDeliveryWithheld, 3);
    assert.equal(classpilotControlStateRequiresPreciseCapability(state.desiredState), true);
    assert.equal(classpilotControlStateRequiresPreciseCapability(
      serializeClasspilotStudentControlState(state, NOW)
    ), true, "the raw serializer keeps the marker for internal and teacher readers");
    assert.equal(classpilotControlStateRequiresPreciseCapability({
      screenLock: { active: true, url: DOCS_RESOURCE.canonicalUrl, resource: DOCS_RESOURCE },
    }), true, "a flat legacy desired shape is read like the serializer reads it");
    assert.equal(classpilotControlStateRequiresPreciseCapability(null), false);
    assert.equal(classpilotControlStateRequiresPreciseCapability({ restrictions: "corrupt" }), false);
  });
});

describe("PR 2-pre fence: honest withheld outcomes", () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const section = (value: string, start: string, end: string) => {
    const startIndex = value.indexOf(start);
    assert.notEqual(startIndex, -1, `missing section start: ${start}`);
    const endIndex = value.indexOf(end, startIndex + start.length);
    assert.notEqual(endIndex, -1, `missing section end: ${end}`);
    return value.slice(startIndex, endIndex);
  };

  it("pins the exact strings PR 2 and the dashboard key on", () => {
    assert.equal(
      CLASSPILOT_PRECISE_RESTRICTION_TARGET_UNAVAILABLE_REASON,
      "Unsupported client: preciseRestrictionResourcesV1 is required"
    );
    assert.ok(CLASSPILOT_PRECISE_RESTRICTION_TARGET_UNAVAILABLE_REASON.startsWith("Unsupported client:"));
    assert.equal(
      CLASSPILOT_PRECISE_RESTRICTION_ENFORCEMENT_UNAVAILABLE_REASON,
      "Extension update required for this Waypoint or Flight Path"
    );
  });

  it("maps the precise withheld reason to an unavailable target on both dispatcher delivery paths", () => {
    const dispatcher = source("../src/services/classpilotCommandDispatcher.ts");
    const late = section(dispatcher, "const classroomStateByStudent = new Map", "const currentPageAuthEnvelope");
    assert.match(
      late,
      /delivered\.withheldReason === "precise_restriction_capability_required"[\s\S]*?authUnavailableReasons\.set\([\s\S]*?CLASSPILOT_PRECISE_RESTRICTION_TARGET_UNAVAILABLE_REASON/
    );
    const inLock = section(dispatcher, "const delivered = serializeClasspilotStudentControlStateForDelivery({\n                  state: currentControlState", "return {\n                  kind: \"ready\" as const,\n                  classroomState: delivered.classroomState");
    assert.match(
      inLock,
      /delivered\.withheldReason === "precise_restriction_capability_required"\s*\?\s*CLASSPILOT_PRECISE_RESTRICTION_TARGET_UNAVAILABLE_REASON/
    );
    const markers = dispatcher.match(/markClasspilotCommandTargetsUnavailableWithReasons\(\s*created\.id,\s*(authUnavailableReasons\.keys\(\)|lateAuthUnavailableStudentIds),\s*authUnavailableReasons\s*\)/g);
    assert.equal(markers?.length, 2, "both withheld mappings persist the real per-target reason");
    const direct = dispatcher.match(/await markClasspilotCommandTargetsUnavailable\(/g);
    assert.equal(direct?.length, 2, "only the reason helper and the binding-race path call storage directly");
    assert.match(
      dispatcher,
      /persistence\.rejectedStudentIds\.length > 0\) \{\n    await markClasspilotCommandTargetsUnavailable\(\n      created\.id,\n      persistence\.rejectedStudentIds\n    \);/,
      "the binding-race path keeps its accurate storage default"
    );
  });

  it("refuses a replayed precise payload before the command row and never frames one", () => {
    const dispatcher = source("../src/services/classpilotCommandDispatcher.ts");
    const gate = section(dispatcher, "if (classpilotCommandPayloadRequiresPreciseCapability(options.commandType, commandPayload))", "const issuedAt = new Date();");
    // PR 2: a replayed payload that no longer validates, or a school whose
    // rollout is off, still refuses every target; otherwise only a live
    // target whose fresh snapshot ACCEPTED the capability keeps its target.
    assert.match(gate, /classpilotPreciseCommandPayloadValid\(options\.commandType, commandPayload\)[\s\S]*preciseRestrictionResourcesActive\(options\.schoolId\)/);
    assert.match(gate, /read\.snapshot\.acceptedCapabilities\?\.includes\(PRECISE_RESTRICTION_RESOURCES_CAPABILITY\)/);
    assert.doesNotMatch(gate, /extensionCapabilities/, "the 32-capped raw advertisement never admits a target");
    assert.match(gate, /available: false,[\s\S]*stateAuthorized: false,[\s\S]*lateSignInEligible: false,[\s\S]*unavailableReason: !preciseDeliverable \|\| live\s*\? CLASSPILOT_PRECISE_RESTRICTION_TARGET_UNAVAILABLE_REASON/);
    assert.ok(
      dispatcher.indexOf("if (classpilotCommandPayloadRequiresPreciseCapability(options.commandType, commandPayload))")
        < dispatcher.indexOf("const created = await createClasspilotCommandWithTargets("),
      "the fence runs before the command and its targets are committed"
    );
    const frame = section(dispatcher, "export function classpilotCommandFrameForTarget", "const deliveryEnvelope = {");
    assert.match(
      frame,
      /classpilotCommandPayloadRequiresPreciseCapability\(commandType, payload\)[\s\S]*classpilotControlStateRequiresPreciseCapability\(classroomState\)[\s\S]*!preciseClassroomState[\s\S]*!delivery\.requiredCapabilities\?\.includes\(PRECISE_RESTRICTION_RESOURCES_CAPABILITY\)[\s\S]*return null;/,
      "a precise payload is framed only with its precise snapshot and a declared capability"
    );
  });

  it("reports the precise reason on the teacher dashboard projection", () => {
    const compat = source("../src/routes/compat.ts");
    const requirement = section(compat, "const preciseRestrictionCapabilityRequired = ", "const desiredClassroomState");
    assert.match(
      requirement,
      /classpilotPreciseRestrictionCapabilityRequired\(\{\s*desiredState: visibleOwnedDesiredControlState\.desiredState,\s*acceptedCapabilities,/
    );
    const aggregate = section(compat, "const enforcementHealth = visibleOwnedDesiredControlState", "const publicExtensionContract");
    assert.match(aggregate, /restrictionAuthCapabilityRequired,\s*preciseRestrictionCapabilityRequired,/);
    assert.match(
      aggregate,
      /preciseRestrictionUpdateRequired = enforcementHealth === "unsupported"\s*&& preciseRestrictionCapabilityRequired/
    );
    assert.match(
      compat,
      /enforcementUnavailableReason: restrictionAuthUpdateRequired && !preciseRestrictionUpdateRequired[\s\S]*?: preciseRestrictionUpdateRequired\s*\?\s*CLASSPILOT_PRECISE_RESTRICTION_ENFORCEMENT_UNAVAILABLE_REASON/
    );
  });

  it("keeps the raw serializer off every device delivery surface", () => {
    const callers = [
      "../src/routes/compat.ts",
      "../src/services/classpilotCommandDispatcher.ts",
      "../src/routes/classpilot/devices.ts",
      "../src/realtime/websocket.ts",
      "../src/services/classpilotControlStateDelivery.ts",
      "../src/services/classpilotSessionLifecycle.ts",
      "../src/services/classpilotScheduledClassroomTools.ts",
      "../src/services/storage.ts",
    ].map((path) => [path, (source(path).match(/serializeClasspilotStudentControlState\(/g) ?? []).length] as const);
    assert.deepEqual(Object.fromEntries(callers), {
      // Teacher DTO only; it shows the stored snapshot and the precise reason.
      "../src/routes/compat.ts": 1,
      // Internal auth-relevance probe; delivery goes through the fenced serializer.
      "../src/services/classpilotCommandDispatcher.ts": 1,
      "../src/routes/classpilot/devices.ts": 0,
      "../src/realtime/websocket.ts": 0,
      "../src/services/classpilotControlStateDelivery.ts": 0,
      "../src/services/classpilotSessionLifecycle.ts": 0,
      "../src/services/classpilotScheduledClassroomTools.ts": 0,
      "../src/services/storage.ts": 0,
    });
  });
});
