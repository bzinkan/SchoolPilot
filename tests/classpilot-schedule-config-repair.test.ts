import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CLASSPILOT_SCHEDULE_BOUNDARY_SQL, classpilotScheduleBoundaryMigration } from "../src/db/classpilotScheduleBoundaryMigration.js";
import { CLASSPILOT_SCHEDULE_CONFIG_REPAIR_SQL, classpilotScheduleConfigRepairMigration } from "../src/db/classpilotScheduleConfigRepairMigration.js";
import { selectSchoolPilot27MigrationPlan } from "../src/db/migrations27.js";
import { emptySchoolSchedulingConfig } from "../src/services/classpilotSchedulingRules.js";

const document = () => {
  const match = /'(\{"schemaVersion".*\})'::jsonb/.exec(CLASSPILOT_SCHEDULE_CONFIG_REPAIR_SQL);
  assert.ok(match?.[1], "The repair must write one inline JSON document.");
  return JSON.parse(match[1]) as unknown;
};

describe("ClassPilot schedule config repair migration", () => {
  // The repair exists because the boundary migration seeds an empty document.
  // If that seed ever changes, this repair's reason to exist changes with it.
  it("repairs the document shape the boundary migration seeds", () => {
    assert.match(CLASSPILOT_SCHEDULE_BOUNDARY_SQL, /INSERT INTO classpilot_school_schedules\(school_id, config\)\s+SELECT id, '\{\}'::jsonb/);
    assert.match(CLASSPILOT_SCHEDULE_CONFIG_REPAIR_SQL, /WHERE config = '\{\}'::jsonb;/);
  });
  it("writes exactly the default document the editor would have saved", () => {
    assert.deepEqual(document(), emptySchoolSchedulingConfig());
  });
  it("touches no other row", () => {
    const statements = CLASSPILOT_SCHEDULE_CONFIG_REPAIR_SQL.split(";").map((part) => part.trim()).filter(Boolean);
    assert.equal(statements.length, 1);
    assert.match(CLASSPILOT_SCHEDULE_CONFIG_REPAIR_SQL, /^\s*UPDATE classpilot_school_schedules/);
  });
  it("keeps its checksum pinned to its statement", () => {
    assert.equal(classpilotScheduleConfigRepairMigration.checksum,
      createHash("sha256").update(CLASSPILOT_SCHEDULE_CONFIG_REPAIR_SQL).digest("hex"));
    assert.equal(classpilotScheduleConfigRepairMigration.mode, "transactional");
  });
  // A repair that only ships behind the staff-identity contract rollout would
  // never reach production on an ordinary deploy.
  it("runs on an ordinary deploy, after the rows it repairs exist", () => {
    const plan = selectSchoolPilot27MigrationPlan({ contractRolloutRequested: false, contractPreviouslyApplied: false });
    const ids = plan.map((migration) => migration.id);
    assert.ok(ids.includes(classpilotScheduleConfigRepairMigration.id));
    assert.ok(ids.indexOf(classpilotScheduleConfigRepairMigration.id) > ids.indexOf(classpilotScheduleBoundaryMigration.id));
  });
});
