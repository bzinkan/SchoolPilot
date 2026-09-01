import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyClasspilotControlCommand,
  classpilotLateSignInRevisionAppliedToBinding,
  classpilotRestrictionAuthCapabilityRequired,
  classpilotRestrictionAuthProjectionRevision,
  emptyClasspilotRestrictions,
  effectiveClasspilotControlEnforcementHealth,
  normalizeClasspilotRestrictions,
  readClasspilotLateSignInDeliveryProvenance,
  recordClasspilotLateSignInAppliedBinding,
  serializeClasspilotStudentControlState,
  serializeClasspilotStudentControlStateForDelivery,
  withClasspilotLateSignInOrigin,
} from "../src/services/classpilotClassroomState.js";
import type { ClasspilotStudentControlState } from "../src/schema/classpilot.js";
import { snapshotHeartbeatHotPathMetrics } from "../src/services/heartbeatHotPathMetrics.js";
import { classpilotScreenshotAuthorityForDeliveredControl } from "../src/services/classpilotScreenshotPolicy.js";
import {
  classpilotCurrentPageSignedOutSkipReason,
  countClasspilotCurrentPageSignedOutSkips,
} from "../src/services/classpilotCurrentPage.js";

function controlState(overrides: Partial<ClasspilotStudentControlState> = {}): ClasspilotStudentControlState {
  const now = new Date("2026-08-13T12:00:00.000Z");
  return {
    id: "control-1",
    schoolId: "school-1",
    studentId: "student-1",
    teachingSessionId: null,
    supervisionContextId: "coverage-1",
    revision: 8,
    desiredState: { restrictions: emptyClasspilotRestrictions() },
    sourceCommandId: null,
    scheduledEndAt: new Date(now.getTime() + 60_000),
    hardExpiresAt: new Date(now.getTime() + 120_000),
    enforcementHealth: "synced",
    appliedRevision: 8,
    lastOutcome: "applied",
    lastError: null,
    lastAcknowledgedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const enabledSsoPolicy = {
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

describe("ClassPilot full classroom state", () => {
  it("counts only signed-out current-page skips with a stable machine reason", () => {
    const reason = classpilotCurrentPageSignedOutSkipReason({
      currentPageRequested: true,
      explicitlySignedOut: true,
    });
    assert.equal(reason, "current_page_requires_online_student");
    assert.equal(countClasspilotCurrentPageSignedOutSkips([
      { unavailableReason: reason },
      { unavailableReason: "current_page_unavailable" },
      { unavailableReason: "Student signal is unavailable; restriction was not changed" },
    ]), 1);
    assert.equal(classpilotCurrentPageSignedOutSkipReason({
      currentPageRequested: true,
      explicitlySignedOut: false,
    }), undefined);
  });

  it("keeps screenshot authority on the delivered classroom revision boundary", () => {
    const projection = {
      authority: {
        kind: "teaching_session" as const,
        teachingSessionId: "teaching-session-1",
        controlRevision: 8,
      },
      authorityStartedAt: new Date("2026-08-13T11:59:00.000Z"),
      authorityExpiresAt: new Date("2026-08-13T12:01:00.000Z"),
    };

    assert.strictEqual(
      classpilotScreenshotAuthorityForDeliveredControl({
        projection,
        deliveredControlRevision: 8,
      }),
      projection,
    );
    assert.deepEqual(
      classpilotScreenshotAuthorityForDeliveredControl({
        projection,
        deliveredControlRevision: 0,
      }),
      {
        ...projection,
        authority: {
          kind: "student_session",
          controlRevision: 0,
        },
      },
    );
    assert.equal(
      classpilotScreenshotAuthorityForDeliveredControl({
        projection: undefined,
        deliveredControlRevision: 0,
      }),
      undefined,
    );
    assert.throws(
      () => classpilotScreenshotAuthorityForDeliveredControl({
        projection,
        deliveredControlRevision: -1,
      }),
      /Invalid delivered ClassPilot control revision/,
    );
  });

  it("composes independent controls without losing existing state", () => {
    let state = applyClasspilotControlCommand(emptyClasspilotRestrictions(), "apply-block-list", {
      blockedDomains: ["Example.com"],
      blockListName: "Test",
    });
    state = applyClasspilotControlCommand(state, "attention-mode", { active: true, message: "Eyes up" });
    state = applyClasspilotControlCommand(state, "limit-tabs", { maxTabs: 2 });
    assert.deepEqual(state.blockList, { active: true, blockedDomains: ["example.com"], name: "Test" });
    assert.deepEqual(state.attentionMode, { active: true, message: "Eyes up" });
    assert.equal(state.tabLimit, 2);
  });

  it("screen unlock clears URL lock and Flight Path but retains independent controls", () => {
    const previous = normalizeClasspilotRestrictions({
      screenLock: { active: true, url: "https://example.test" },
      flightPath: { active: true, allowedDomains: ["example.test"] },
      blockList: { active: true, blockedDomains: ["chat.example"] },
      attentionMode: { active: true, message: "Focus" },
      tabLimit: 2,
    });
    const result = applyClasspilotControlCommand(previous, "unlock-screen", {});
    assert.equal(result.screenLock.active, false);
    assert.equal(result.flightPath.active, false);
    assert.equal(result.blockList.active, true);
    assert.equal(result.attentionMode.active, true);
    assert.equal(result.tabLimit, 2);
  });

  it("screen-only unlock preserves the active Flight Path", () => {
    const previous = normalizeClasspilotRestrictions({
      screenLock: { active: true, url: "https://example.test" },
      flightPath: { active: true, allowedDomains: ["example.test"], name: "Research" },
    });
    const result = applyClasspilotControlCommand(previous, "unlock-screen", { screenOnly: true });
    assert.equal(result.screenLock.active, false);
    assert.deepEqual(result.flightPath, {
      active: true,
      allowedDomains: ["example.test"],
      name: "Research",
    });
  });

  it("preserves Flight Path through a screen-lock overlay sequence", () => {
    const flightPath = applyClasspilotControlCommand(emptyClasspilotRestrictions(), "apply-flight-path", {
      allowedDomains: ["khanacademy.org", "ixl.com"],
      flightPathName: "Math",
    });
    const locked = applyClasspilotControlCommand(flightPath, "lock-screen", {
      url: "https://classroom.example/attention",
    });
    assert.equal(locked.screenLock.active, true);
    assert.equal(locked.flightPath.active, true);
    assert.deepEqual(locked.flightPath.allowedDomains, ["khanacademy.org", "ixl.com"]);

    const unlocked = applyClasspilotControlCommand(locked, "unlock-screen", { screenOnly: true });
    assert.equal(unlocked.screenLock.active, false);
    assert.equal(unlocked.flightPath.active, true);
    assert.deepEqual(unlocked.flightPath.allowedDomains, ["khanacademy.org", "ixl.com"]);
  });

  it("bounds temporary allows and supplies an expiry", () => {
    const now = new Date("2026-08-13T12:00:00.000Z");
    const result = applyClasspilotControlCommand(emptyClasspilotRestrictions(), "temp-unblock", {
      domain: "Example.com",
      durationMinutes: 5,
    }, now);
    assert.deepEqual(result.temporaryAllows, [{
      domain: "example.com",
      expiresAt: "2026-08-13T12:05:00.000Z",
    }]);
  });

  it("rejects oversized rule lists before applying a partial policy", () => {
    assert.throws(
      () => applyClasspilotControlCommand(emptyClasspilotRestrictions(), "apply-block-list", {
        blockedDomains: Array.from({ length: 1_001 }, (_, index) => `site-${index}.example`),
      }),
      (error: any) => error?.code === "CLASSROOM_RULE_LIMIT_EXCEEDED"
    );
    assert.throws(
      () => normalizeClasspilotRestrictions({
        flightPath: { active: true, allowedDomains: Array(1_001).fill("example.com") },
      }),
      (error: any) => error?.code === "CLASSROOM_RULE_LIMIT_EXCEEDED"
    );
  });

  it("serializes supervision as the exclusive canonical scope", () => {
    const snapshot = serializeClasspilotStudentControlState(controlState());
    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.revision, 8);
    assert.equal(snapshot.teachingSessionId, null);
    assert.equal(snapshot.supervisionContextId, "coverage-1");
  });

  it("withholds deferred-origin state unless the exact-school gate and negotiated binding agree", () => {
    snapshotHeartbeatHotPathMetrics({ reset: true });
    const now = new Date("2026-08-13T12:00:00.000Z");
    const desiredState = withClasspilotLateSignInOrigin({
      desiredState: {
        restrictions: normalizeClasspilotRestrictions({
          screenLock: { active: true, url: "https://waypoint.example/" },
        }),
      },
      commandId: "command-deferred",
      createdAt: new Date("2026-08-13T11:59:00.000Z"),
    });
    const state = controlState({
      schoolId: "school-1",
      studentId: "student-1",
      desiredState,
      sourceCommandId: "command-deferred",
      enforcementHealth: "pending",
      appliedRevision: null,
    });
    const exactBinding = {
      schoolId: "school-1",
      studentId: "student-1",
      studentSessionId: "session-new",
      deviceId: "device-new",
    };

    assert.deepEqual(serializeClasspilotStudentControlStateForDelivery({
      state,
      gateActive: false,
      acceptedCapabilities: ["lateSignInRestrictionSsoV1"],
      exactBinding,
      now,
    }), {
      classroomState: null,
      withheld: true,
      withheldReason: "late_sign_in_capability_required",
    });
    assert.deepEqual(serializeClasspilotStudentControlStateForDelivery({
      state,
      gateActive: true,
      acceptedCapabilities: [],
      exactBinding,
      now,
    }), {
      classroomState: null,
      withheld: true,
      withheldReason: "late_sign_in_capability_required",
    });
    assert.deepEqual(serializeClasspilotStudentControlStateForDelivery({
      state,
      gateActive: true,
      acceptedCapabilities: ["lateSignInRestrictionSsoV1"],
      exactBinding: { ...exactBinding, studentId: "student-other" },
      now,
    }), {
      classroomState: null,
      withheld: true,
      withheldReason: "late_sign_in_capability_required",
    });

    const delivered = serializeClasspilotStudentControlStateForDelivery({
      state,
      gateActive: true,
      acceptedCapabilities: ["lateSignInRestrictionSsoV1"],
      exactBinding,
      now,
    });
    assert.equal(delivered.withheld, false);
    assert.deepEqual(delivered.classroomState?.deliveryContext, {
      lateSignInRestrictionSso: true,
    });
    assert.equal(delivered.classroomState?.revision, state.revision);
    const metrics = snapshotHeartbeatHotPathMetrics({ reset: true });
    assert.equal(metrics.counters.lateSignInStampedInspection, 4);
    assert.equal(metrics.counters.lateSignInRollback, 1);
  });

  it("keeps deferred origin immutable while recording application per exact binding", () => {
    const createdAt = new Date("2026-08-13T11:59:00.000Z");
    const desiredState = withClasspilotLateSignInOrigin({
      desiredState: { restrictions: emptyClasspilotRestrictions() },
      commandId: "command-origin",
      createdAt,
    });
    const firstApplied = recordClasspilotLateSignInAppliedBinding({
      desiredState,
      binding: {
        schoolId: "school-1",
        studentId: "student-1",
        studentSessionId: "session-new",
        deviceId: "device-new",
      },
      revision: 8,
      appliedAt: new Date("2026-08-13T12:00:00.000Z"),
    });
    const secondApplied = recordClasspilotLateSignInAppliedBinding({
      desiredState: firstApplied,
      binding: {
        schoolId: "school-1",
        studentId: "student-1",
        studentSessionId: "session-old",
        deviceId: "device-old",
      },
      revision: 8,
      appliedAt: new Date("2026-08-13T12:01:00.000Z"),
    });
    const provenance = readClasspilotLateSignInDeliveryProvenance(secondApplied);
    assert.equal(provenance?.origin, "deferred");
    assert.equal(provenance?.originCommandId, "command-origin");
    assert.equal(provenance?.originCreatedAt, createdAt.toISOString());
    assert.deepEqual(
      provenance?.appliedBindings.map(({ studentSessionId, deviceId }) => ({
        studentSessionId,
        deviceId,
      })),
      [
        { studentSessionId: "session-new", deviceId: "device-new" },
        { studentSessionId: "session-old", deviceId: "device-old" },
      ],
    );
    assert.equal(classpilotLateSignInRevisionAppliedToBinding({
      desiredState: secondApplied,
      binding: {
        schoolId: "school-1",
        studentId: "student-1",
        studentSessionId: "session-new",
        deviceId: "device-new",
      },
      revision: 8,
    }), true);
    assert.equal(classpilotLateSignInRevisionAppliedToBinding({
      desiredState: secondApplied,
      binding: {
        schoolId: "school-1",
        studentId: "student-1",
        studentSessionId: "session-replacement",
        deviceId: "device-new",
      },
      revision: 8,
    }), false);

    assert.equal(effectiveClasspilotControlEnforcementHealth(
      controlState({ desiredState: secondApplied, enforcementHealth: "synced" }),
      "2.7.9",
      new Date("2026-08-13T12:00:30.000Z"),
      {
        gateActive: true,
        acceptedCapabilities: ["lateSignInRestrictionSsoV1"],
        exactBinding: {
          schoolId: "school-1",
          studentId: "student-1",
          studentSessionId: "session-new",
          deviceId: "device-new",
        },
      },
    ), "synced");
    assert.equal(effectiveClasspilotControlEnforcementHealth(
      controlState({ desiredState: secondApplied, enforcementHealth: "synced" }),
      "2.7.9",
      new Date("2026-08-13T12:00:30.000Z"),
      {
        gateActive: true,
        acceptedCapabilities: ["lateSignInRestrictionSsoV1"],
        exactBinding: {
          schoolId: "school-1",
          studentId: "student-1",
          studentSessionId: "session-replacement",
          deviceId: "device-new",
        },
      },
    ), "pending");
    assert.equal(effectiveClasspilotControlEnforcementHealth(
      controlState({ desiredState: secondApplied, enforcementHealth: "synced" }),
      "2.7.8",
      new Date("2026-08-13T12:00:30.000Z"),
      {
        gateActive: true,
        acceptedCapabilities: [],
        exactBinding: null,
      },
    ), "unsupported");
    assert.equal(
      readClasspilotLateSignInDeliveryProvenance(
        withClasspilotLateSignInOrigin({
          desiredState: secondApplied,
          commandId: "later-command-must-not-replace-origin",
        }),
      )?.originCommandId,
      "command-origin",
    );

    const stateAfterAck = controlState({ desiredState: secondApplied });
    assert.deepEqual(serializeClasspilotStudentControlStateForDelivery({
      state: stateAfterAck,
      gateActive: false,
      acceptedCapabilities: ["lateSignInRestrictionSsoV1"],
      exactBinding: {
        schoolId: "school-1",
        studentId: "student-1",
        studentSessionId: "session-old",
        deviceId: "device-old",
      },
    }), {
      classroomState: null,
      withheld: true,
      withheldReason: "late_sign_in_capability_required",
    });
    assert.deepEqual(serializeClasspilotStudentControlStateForDelivery({
      state: stateAfterAck,
      gateActive: true,
      acceptedCapabilities: [],
      exactBinding: {
        schoolId: "school-1",
        studentId: "student-1",
        studentSessionId: "session-old",
        deviceId: "device-old",
      },
    }), {
      classroomState: null,
      withheld: true,
      withheldReason: "late_sign_in_capability_required",
    });
  });

  it("expires a deferred restriction before a later sign-in without losing provenance", () => {
    const now = new Date("2026-08-13T12:00:00.000Z");
    const desiredState = withClasspilotLateSignInOrigin({
      desiredState: {
        restrictions: normalizeClasspilotRestrictions({
          screenLock: { active: true, url: "https://expired.example/" },
        }),
      },
      commandId: "expired-offline-command",
      createdAt: new Date("2026-08-13T11:00:00.000Z"),
    });
    const state = controlState({
      desiredState,
      scheduledEndAt: new Date("2026-08-13T11:59:00.000Z"),
      hardExpiresAt: new Date("2026-08-13T12:30:00.000Z"),
    });
    const delivered = serializeClasspilotStudentControlStateForDelivery({
      state,
      gateActive: true,
      acceptedCapabilities: ["lateSignInRestrictionSsoV1"],
      exactBinding: {
        schoolId: "school-1",
        studentId: "student-1",
        studentSessionId: "session-after-expiry",
        deviceId: "device-after-expiry",
      },
      now,
    });
    assert.equal(delivered.withheld, false);
    assert.equal(delivered.classroomState?.restrictions.screenLock.active, false);
    assert.equal(delivered.classroomState?.deliveryContext, undefined);
    assert.equal(
      readClasspilotLateSignInDeliveryProvenance(state.desiredState)?.originCommandId,
      "expired-offline-command",
    );
  });

  it("omits late-sign-in delivery context from ordinary live state", () => {
    const delivered = serializeClasspilotStudentControlStateForDelivery({
      state: controlState(),
      gateActive: true,
      acceptedCapabilities: ["lateSignInRestrictionSsoV1"],
      exactBinding: {
        schoolId: "school-1",
        studentId: "student-1",
        studentSessionId: "session-1",
        deviceId: "device-1",
      },
    });
    assert.equal(delivered.withheld, false);
    assert.equal(delivered.classroomState?.deliveryContext, undefined);
  });

  it("projects a school-authored SSO envelope only to an exact accepted live binding", () => {
    const now = new Date("2026-08-13T12:00:00.000Z");
    const state = controlState({
      desiredState: {
        restrictions: normalizeClasspilotRestrictions({
          screenLock: { active: true, url: "https://classroom.google.com/u/0/h" },
        }),
      },
    });
    const exactBinding = {
      schoolId: "school-1",
      studentId: "student-1",
      studentSessionId: "session-1",
      deviceId: "device-1",
    };
    const authPassThrough = {
      gateActive: true,
      policyRevision: 7,
      policy: enabledSsoPolicy,
    };

    assert.deepEqual(serializeClasspilotStudentControlStateForDelivery({
      state,
      gateActive: true,
      acceptedCapabilities: [],
      exactBinding,
      authPassThrough,
      now,
    }), {
      classroomState: null,
      withheld: true,
      withheldReason: "restriction_auth_update_required",
    });

    const delivered = serializeClasspilotStudentControlStateForDelivery({
      state,
      gateActive: true,
      acceptedCapabilities: ["restrictionAuthPassThroughV1"],
      exactBinding,
      authPassThrough,
      now,
    });
    assert.equal(delivered.withheld, false);
    assert.deepEqual(delivered.classroomState?.authPassThrough, {
      schemaVersion: 1,
      policyRevision: 14,
      defaultProfileId: "clever",
      attemptTtlSeconds: 300,
      profiles: enabledSsoPolicy.profiles,
    });
    assert.equal(delivered.classroomState?.authPassThroughPolicyRevision, 14);
    assert.equal(delivered.classroomState?.deliveryContext, undefined);
    assert.doesNotMatch(JSON.stringify(delivered), /student-1|session-1|device-1/);

    const rolloutOff = serializeClasspilotStudentControlStateForDelivery({
      state,
      gateActive: true,
      acceptedCapabilities: [],
      exactBinding,
      authPassThrough: { ...authPassThrough, gateActive: false },
      now,
    });
    assert.equal(rolloutOff.withheld, false);
    assert.equal(rolloutOff.classroomState?.authPassThrough, undefined);
    assert.equal(
      rolloutOff.classroomState?.authPassThroughPolicyRevision,
      15,
      "operator rollback carries a strictly newer tombstone"
    );
  });

  it("requires both legacy and auth pass-through capabilities for a deferred destination", () => {
    const now = new Date("2026-08-13T12:00:00.000Z");
    const state = controlState({
      desiredState: withClasspilotLateSignInOrigin({
        desiredState: {
          restrictions: normalizeClasspilotRestrictions({
            screenLock: { active: true, url: "https://classroom.google.com/u/0/h" },
          }),
        },
        commandId: "deferred-waypoint",
      }),
    });
    const exactBinding = {
      schoolId: "school-1",
      studentId: "student-1",
      studentSessionId: "session-1",
      deviceId: "device-1",
    };
    const authPassThrough = {
      gateActive: true,
      policyRevision: 2,
      policy: enabledSsoPolicy,
    };

    assert.equal(serializeClasspilotStudentControlStateForDelivery({
      state,
      gateActive: true,
      acceptedCapabilities: ["lateSignInRestrictionSsoV1"],
      exactBinding,
      authPassThrough,
      now,
    }).withheldReason, "restriction_auth_update_required");
    assert.equal(serializeClasspilotStudentControlStateForDelivery({
      state,
      gateActive: true,
      acceptedCapabilities: ["restrictionAuthPassThroughV1"],
      exactBinding,
      authPassThrough,
      now,
    }).withheldReason, "late_sign_in_capability_required");

    const delivered = serializeClasspilotStudentControlStateForDelivery({
      state,
      gateActive: true,
      acceptedCapabilities: [
        "lateSignInRestrictionSsoV1",
        "restrictionAuthPassThroughV1",
      ],
      exactBinding,
      authPassThrough,
      now,
    });
    assert.equal(delivered.withheld, false);
    assert.deepEqual(delivered.classroomState?.deliveryContext, {
      lateSignInRestrictionSso: true,
    });
    assert.equal(delivered.classroomState?.authPassThrough?.policyRevision, 4);
    assert.equal(delivered.classroomState?.authPassThroughPolicyRevision, 4);
  });

  it("makes delayed ACK capability requirements follow current rollout and policy", () => {
    const desiredState = {
      restrictions: normalizeClasspilotRestrictions({
        flightPath: {
          active: true,
          allowedDomains: ["classroom.google.com"],
        },
      }),
    };
    assert.equal(classpilotRestrictionAuthCapabilityRequired({
      desiredState,
      gateActive: false,
      policy: enabledSsoPolicy,
    }), false, "the same revision may have been delivered before rollout");
    assert.equal(classpilotRestrictionAuthCapabilityRequired({
      desiredState,
      gateActive: true,
      policy: enabledSsoPolicy,
    }), true, "a delayed old-client ACK must be rejected after activation");
    assert.equal(classpilotRestrictionAuthCapabilityRequired({
      desiredState,
      gateActive: true,
      policy: { ...enabledSsoPolicy, enabled: false, defaultProfileId: null },
    }), false);
  });

  it("orders policy edits and operator rollback with a monotonic wire fence", () => {
    const enabledAtSeven = classpilotRestrictionAuthProjectionRevision({
      policyRevision: 7,
      gateActive: true,
    });
    const rollbackAtSeven = classpilotRestrictionAuthProjectionRevision({
      policyRevision: 7,
      gateActive: false,
    });
    const reenabledAfterReviewedPatch = classpilotRestrictionAuthProjectionRevision({
      policyRevision: 8,
      gateActive: true,
    });
    assert.equal(enabledAtSeven, 14);
    assert.equal(rollbackAtSeven, 15);
    assert.equal(reenabledAfterReviewedPatch, 16);
    assert.ok(enabledAtSeven < rollbackAtSeven);
    assert.ok(rollbackAtSeven < reenabledAfterReviewedPatch);
  });

  it("reports a pre-policy restriction unsupported until the current binding accepts auth pass-through", () => {
    const desiredState = {
      restrictions: normalizeClasspilotRestrictions({
        screenLock: {
          active: true,
          url: "https://classroom.google.com/c/example",
        },
      }),
    };
    const state = controlState({ desiredState, enforcementHealth: "synced" });
    const baseDelivery = {
      gateActive: true,
      exactBinding: {
        schoolId: "school-1",
        studentId: "student-1",
        studentSessionId: "session-1",
        deviceId: "device-1",
      },
      restrictionAuthCapabilityRequired: true,
    };
    assert.equal(effectiveClasspilotControlEnforcementHealth(
      state,
      "2.8.0",
      new Date("2026-08-13T12:00:30.000Z"),
      { ...baseDelivery, acceptedCapabilities: [] },
    ), "unsupported");
    assert.equal(effectiveClasspilotControlEnforcementHealth(
      state,
      "2.8.1",
      new Date("2026-08-13T12:00:30.000Z"),
      {
        ...baseDelivery,
        acceptedCapabilities: ["restrictionAuthPassThroughV1"],
        restrictionAuthPolicyRevision: 14,
        appliedAuthPolicyRevision: 12,
      },
    ), "pending");
    assert.equal(effectiveClasspilotControlEnforcementHealth(
      state,
      "2.8.1",
      new Date("2026-08-13T12:00:30.000Z"),
      {
        ...baseDelivery,
        acceptedCapabilities: ["restrictionAuthPassThroughV1"],
        restrictionAuthPolicyRevision: 14,
        appliedAuthPolicyRevision: 14,
      },
    ), "synced");
  });

  it("reports snapshot enforcement unsupported until version 2.6.0", () => {
    const state = controlState();
    const now = new Date("2026-08-13T12:00:00.000Z");
    assert.equal(effectiveClasspilotControlEnforcementHealth(state, undefined, now), "unsupported");
    assert.equal(effectiveClasspilotControlEnforcementHealth(state, "garbage", now), "unsupported");
    assert.equal(effectiveClasspilotControlEnforcementHealth(state, "2.5.99", now), "unsupported");
    assert.equal(effectiveClasspilotControlEnforcementHealth(state, "2.6.0", now), "synced");
  });
});
