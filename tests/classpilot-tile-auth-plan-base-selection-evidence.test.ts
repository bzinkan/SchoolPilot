import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
  extractClasspilotTileAuthorizationPlanBaseSelectionEvidence,
  validateClasspilotTileAuthorizationPlanBaseSelectionEvidence,
} from "../scripts/validate-classpilot-tile-auth-plan-base-selection-evidence.mjs";

const selection = {
  version: "classpilot-tile-auth-plan-base-selection-v1",
  cohortSize: 40,
  canonicalPrimaryOnlyGroups: 19,
  exactCohortGroups: 19,
  eligibleSchools: 1,
  finalBases: 1,
};

function events(value: unknown) {
  return {
    events: [
      { message: "ordinary output" },
      { message: JSON.stringify(value) },
    ],
  };
}

describe("ClassPilot plan-base selection evidence", () => {
  it("extracts exactly one canonical production selection companion", () => {
    assert.deepEqual(
      validateClasspilotTileAuthorizationPlanBaseSelectionEvidence(selection),
      selection
    );
    assert.deepEqual(
      extractClasspilotTileAuthorizationPlanBaseSelectionEvidence(
        events(selection)
      ),
      selection
    );
  });

  it("rejects drift, extra properties, duplicates, and identifiers", () => {
    for (const value of [
      { ...selection, canonicalPrimaryOnlyGroups: 20 },
      { ...selection, exactCohortGroups: 18 },
      { ...selection, eligibleSchools: 2 },
      { ...selection, schoolId: "forbidden" },
    ]) {
      assert.throws(
        () =>
          validateClasspilotTileAuthorizationPlanBaseSelectionEvidence(value),
        /classpilot_tile_authorization_plan_base_selection_invalid/
      );
    }
    assert.throws(
      () =>
        extractClasspilotTileAuthorizationPlanBaseSelectionEvidence({
          events: [
            { message: JSON.stringify(selection) },
            { message: JSON.stringify(selection) },
          ],
        }),
      /classpilot_tile_authorization_plan_base_selection_invalid/
    );
  });

  it("exposes a fail-closed stdin validator", () => {
    const script = resolve(
      "scripts/validate-classpilot-tile-auth-plan-base-selection-evidence.mjs"
    );
    const result = spawnSync(process.execPath, [script], {
      cwd: process.cwd(),
      encoding: "utf8",
      input: JSON.stringify(events(selection)),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), selection);
  });
});
