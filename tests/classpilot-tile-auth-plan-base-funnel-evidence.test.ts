import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
  extractClasspilotTileAuthorizationPlanBaseFunnelEvidence,
  validateClasspilotTileAuthorizationPlanBaseFunnelEvidence,
} from "../scripts/validate-classpilot-tile-auth-plan-base-funnel-evidence.mjs";

const counts = {
  syntheticDescribedGroups: 2,
  syntheticSchoolGroups: 2,
  primaryTeacherGroups: 2,
  licensedGroups: 2,
  activeRosterStudents: 80,
  canonicalMappedRosterStudents: 80,
  unsupervisedRosterStudents: 80,
  noCoTeacherGroups: 2,
  exactCohortGroups: 2,
  eligibleGroupSchools: 1,
  activeOfficeMemberships: 1,
  uniqueOfficeMembershipSchools: 1,
  activeOfficeStudents: 80,
  canonicalMappedOfficeStudents: 80,
  unrosteredOfficeStudents: 40,
  unsupervisedOfficeStudents: 40,
  officeCohortReadySchools: 1,
  alternateTeacherReadySchools: 1,
  eligibleSchools: 1,
  selectedSchools: 1,
  selectedGroups: 1,
  selectedCoTeachers: 0,
  selectedOfficeStaff: 0,
  selectedOfficeCohorts: 0,
  finalBases: 0,
};

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    version: "classpilot-tile-auth-plan-base-funnel-v1",
    failureStage: "base_funnel",
    firstEmptyStage: "selectedCoTeachers",
    cohortSize: 40,
    counts: { ...counts },
    sessionPosture: null,
    ...overrides,
  };
}

function events(value: unknown) {
  return {
    events: [
      { message: "ordinary log output" },
      {
        message: JSON.stringify({
          status: "failed",
          failureCode: "representative_scenario_missing",
          labels: [],
          invalidTeachingSessionSchools: 0,
          funnelEvidence: value,
        }),
      },
    ],
  };
}

describe("ClassPilot plan-base funnel evidence", () => {
  it("validates and extracts one canonical sanitized failure", () => {
    const expected = evidence();
    assert.deepEqual(
      validateClasspilotTileAuthorizationPlanBaseFunnelEvidence(expected),
      expected
    );
    assert.deepEqual(
      extractClasspilotTileAuthorizationPlanBaseFunnelEvidence(
        events(expected)
      ),
      expected
    );
    assert.doesNotMatch(
      JSON.stringify(expected),
      /school-sensitive|student-sensitive|fixture-sensitive-primary|@|\bSELECT\s|fixture_id/i
    );
  });

  it("accepts base-shape and conflicting-session evidence only with their exact posture", () => {
    const passingCounts = {
      ...counts,
      selectedCoTeachers: 1,
      selectedOfficeStaff: 1,
      selectedOfficeCohorts: 1,
      finalBases: 1,
    };
    assert.equal(
      validateClasspilotTileAuthorizationPlanBaseFunnelEvidence(
        evidence({
          failureStage: "base_shape",
          firstEmptyStage: "none",
          counts: passingCounts,
        })
      ).failureStage,
      "base_shape"
    );
    assert.deepEqual(
      validateClasspilotTileAuthorizationPlanBaseFunnelEvidence(
        evidence({
          failureStage: "session_posture",
          firstEmptyStage: "none",
          counts: passingCounts,
          sessionPosture: {
            requiredSessionPairs: 80,
            reusedActiveSessionPairs: 42,
            missingSessionPairs: 37,
            conflictingSessionPairs: 1,
          },
        })
      ).sessionPosture,
      {
        requiredSessionPairs: 80,
        reusedActiveSessionPairs: 42,
        missingSessionPairs: 37,
        conflictingSessionPairs: 1,
      }
    );
  });

  it("rejects tampering, identifiers, malformed counts, and impossible arithmetic", () => {
    const invalid = [
      { ...evidence(), tenantId: "forbidden" },
      evidence({ version: "classpilot-tile-auth-plan-base-funnel-v0" }),
      evidence({ failureStage: "database_error" }),
      evidence({ firstEmptyStage: "licensedGroups" }),
      evidence({ counts: { ...counts, selectedCoTeachers: -1 } }),
      evidence({ counts: { ...counts, selectedCoTeachers: 1.5 } }),
      evidence({
        counts: {
          ...counts,
          canonicalMappedRosterStudents: 81,
        },
      }),
      evidence({
        counts: { ...counts, fixtureId: "forbidden" },
      }),
      evidence({
        failureStage: "session_posture",
        firstEmptyStage: "none",
        counts: {
          ...counts,
          selectedCoTeachers: 1,
          selectedOfficeStaff: 1,
          selectedOfficeCohorts: 1,
          finalBases: 1,
        },
        sessionPosture: {
          requiredSessionPairs: 80,
          reusedActiveSessionPairs: 40,
          missingSessionPairs: 40,
          conflictingSessionPairs: 0,
        },
      }),
    ];
    for (const value of invalid) {
      assert.throws(
        () =>
          validateClasspilotTileAuthorizationPlanBaseFunnelEvidence(value),
        /classpilot_tile_authorization_plan_base_funnel_invalid/
      );
    }
  });

  it("requires exactly one eligible failed event and exposes a stdin CLI", () => {
    const document = events(evidence());
    assert.throws(
      () =>
        extractClasspilotTileAuthorizationPlanBaseFunnelEvidence({
          events: [
            ...document.events,
            document.events[1],
          ],
        }),
      /classpilot_tile_authorization_plan_base_funnel_invalid/
    );
    assert.throws(
      () =>
        extractClasspilotTileAuthorizationPlanBaseFunnelEvidence({
          events: [{
            message: JSON.stringify({
              status: "failed",
              failureCode: "database_operation_failed",
              funnelEvidence: evidence(),
            }),
          }],
        }),
      /classpilot_tile_authorization_plan_base_funnel_invalid/
    );
    assert.throws(
      () =>
        extractClasspilotTileAuthorizationPlanBaseFunnelEvidence({
          events: [{
            message: JSON.stringify({
              ...JSON.parse(document.events[1].message),
              schoolId: "forbidden",
            }),
          }],
        }),
      /classpilot_tile_authorization_plan_base_funnel_invalid/
    );

    const script = resolve(
      "scripts/validate-classpilot-tile-auth-plan-base-funnel-evidence.mjs"
    );
    const result = spawnSync(process.execPath, [script], {
      cwd: process.cwd(),
      encoding: "utf8",
      input: JSON.stringify(document),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), evidence());
  });
});
