import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migrationSource = readFileSync(
  new URL("../src/index.ts", import.meta.url),
  "utf8"
);
const passpilotSchemaSource = readFileSync(
  new URL("../src/schema/passpilot.ts", import.meta.url),
  "utf8"
);
const coreSchemaSource = readFileSync(
  new URL("../src/schema/core.ts", import.meta.url),
  "utf8"
);
const sharedSchemaSource = readFileSync(
  new URL("../src/schema/shared.ts", import.meta.url),
  "utf8"
);
const validationSource = readFileSync(
  new URL("../src/schema/validation.ts", import.meta.url),
  "utf8"
);
const schoolsRouteSource = readFileSync(
  new URL("../src/routes/schools.ts", import.meta.url),
  "utf8"
);
const superAdminRouteSource = readFileSync(
  new URL("../src/routes/admin/superAdmin.ts", import.meta.url),
  "utf8"
);

function requiredBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0, `missing source marker: ${startMarker}`);
  assert.ok(end > start, `missing source boundary after: ${startMarker}`);
  return source.slice(start, end);
}

describe("PassPilot canonical ClassPilot-class migration contract", () => {
  it("defines the additive compatibility fields and closed enum domains", () => {
    const settingsBlock = requiredBlock(
      sharedSchemaSource,
      "export const settings",
      "export type Settings"
    );
    assert.match(settingsBlock, /passpilotClassSource:\s*text\("passpilot_class_source"\)[\s\S]*\.notNull\(\)[\s\S]*\.default\("legacy_grades"\)/);
    assert.match(settingsBlock, /\$type<"legacy_grades" \| "classpilot_groups">\(\)/);
    assert.match(settingsBlock, /passpilotClassCutoverAt:\s*timestamp\("passpilot_class_cutover_at",\s*\{[\s\S]*withTimezone:\s*true/);
    assert.match(settingsBlock, /passpilotClassMigrationRevision:\s*integer\("passpilot_class_migration_revision"\)[\s\S]*\.notNull\(\)[\s\S]*\.default\(0\)/);
    assert.match(settingsBlock, /passpilotCanonicalWritesAt:\s*timestamp\("passpilot_canonical_writes_at",\s*\{[\s\S]*withTimezone:\s*true/);
    assert.match(settingsBlock, /settings_passpilot_class_source_check/);
    assert.match(settingsBlock, /settings_passpilot_class_migration_revision_check/);

    const schoolsBlock = requiredBlock(
      coreSchemaSource,
      "export const schools",
      "export type School"
    );
    assert.match(schoolsBlock, /kioskClasspilotGroupId:\s*varchar\("kiosk_classpilot_group_id"\)/);

    const gradesBlock = requiredBlock(
      passpilotSchemaSource,
      "export const grades",
      "export type Grade"
    );
    assert.match(gradesBlock, /classpilotGroupId:\s*text\("classpilot_group_id"\)/);
    assert.match(gradesBlock, /migrationState:\s*text\("migration_state"\)[\s\S]*\.default\("pending"\)/);
    assert.match(gradesBlock, /\$type<"pending" \| "auto_linked" \| "confirmed" \| "history_only">\(\)/);
    assert.match(gradesBlock, /mappingRevision:\s*integer\("mapping_revision"\)\.notNull\(\)\.default\(0\)/);
    assert.match(gradesBlock, /mappingMethod:\s*text\("mapping_method"\)/);
    assert.match(gradesBlock, /mappingReviewerId:\s*text\("mapping_reviewer_id"\)/);
    assert.match(gradesBlock, /mappedAt:\s*timestamp\("mapped_at",\s*\{\s*withTimezone:\s*true\s*\}\)/);
    assert.match(gradesBlock, /index\("grades_school_classpilot_group_idx"\)/);
    assert.doesNotMatch(
      gradesBlock,
      /uniqueIndex\("grades_school_classpilot_group_idx"\)/,
      "multiple preserved grades may map to the same canonical group"
    );

    const passesBlock = requiredBlock(
      passpilotSchemaSource,
      "export const passes",
      "export type Pass"
    );
    assert.match(passesBlock, /classpilotGroupId:\s*text\("classpilot_group_id"\)/);
    assert.match(passesBlock, /classNameSnapshot:\s*text\("class_name_snapshot"\)/);
    assert.match(passesBlock, /passes_school_classpilot_group_status_idx/);
    assert.match(passesBlock, /passes_school_classpilot_group_issued_idx/);
    assert.match(passesBlock, /passes_single_class_source_check/);
    assert.match(passesBlock, /NOT \(\$\{table\.gradeId\} IS NOT NULL AND \$\{table\.classpilotGroupId\} IS NOT NULL\)/);
  });

  it("keeps startup DDL, backfill, checks, and integrity assertions fail-closed", () => {
    const migrationBlock = requiredBlock(
      migrationSource,
      "// PassPilot canonical ClassPilot-class compatibility is required",
      "// RLS Phase 1: add school_id to derived tables"
    );

    for (const column of [
      "passpilot_class_source",
      "passpilot_class_cutover_at",
      "passpilot_class_migration_revision",
      "passpilot_canonical_writes_at",
      "kiosk_classpilot_group_id",
      "classpilot_group_id",
      "class_name_snapshot",
      "migration_state",
      "mapping_revision",
      "mapping_method",
      "mapping_reviewer_id",
      "mapped_at",
    ]) {
      assert.match(migrationBlock, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}\\b`));
    }

    assert.match(migrationBlock, /UPDATE settings[\s\S]*COALESCE\(passpilot_class_source, 'legacy_grades'\)/);
    assert.match(migrationBlock, /UPDATE grades[\s\S]*COALESCE\(migration_state, 'pending'\)/);
    assert.match(migrationBlock, /UPDATE passes AS pass[\s\S]*SET class_name_snapshot = grade\.name/);
    assert.match(migrationBlock, /schedulerPool\.query/);

    for (const constraint of [
      "settings_passpilot_class_source_check",
      "settings_passpilot_class_migration_revision_check",
      "grades_migration_state_check",
      "grades_mapping_revision_check",
      "passes_single_class_source_check",
    ]) {
      assert.match(migrationBlock, new RegExp(`ADD CONSTRAINT ${constraint}`));
      assert.match(migrationBlock, new RegExp(`VALIDATE CONSTRAINT ${constraint}`));
    }

    for (const indexName of [
      "grades_school_classpilot_group_idx",
      "grades_school_migration_state_idx",
      "passes_school_classpilot_group_status_idx",
      "passes_school_classpilot_group_issued_idx",
    ]) {
      assert.match(migrationBlock, new RegExp(`CREATE INDEX IF NOT EXISTS ${indexName}`));
      assert.doesNotMatch(
        migrationBlock,
        new RegExp(`CREATE UNIQUE INDEX IF NOT EXISTS ${indexName}`)
      );
    }

    assert.match(migrationBlock, /PassPilot canonical class data integrity check failed/);
    assert.match(migrationBlock, /PassPilot canonical class schema integrity check failed/);
    assert.doesNotMatch(migrationBlock, /\btry\s*\{/);
    assert.doesNotMatch(migrationBlock, /\bcatch\s*\(/);
    assert.doesNotMatch(migrationBlock, /console\.warn/);
  });

  it("orders cross-table integrity after ClassPilot group safety-net DDL", () => {
    const settingsReady = migrationSource.indexOf(
      "[migration] ClassPilot instructional calendar settings ready"
    );
    const columnsStart = migrationSource.indexOf(
      "// PassPilot canonical ClassPilot-class compatibility is required"
    );
    const groupsReady = migrationSource.indexOf(
      "[migration] groups table ready"
    );
    const groupStudentsReady = migrationSource.indexOf(
      "[migration] group_students table ready"
    );
    const groupTeachersReady = migrationSource.indexOf(
      "[migration] group_teachers table ready"
    );
    const groupIntegrityStart = migrationSource.indexOf(
      "// Canonical PassPilot mappings depend on the ClassPilot groups base table"
    );

    assert.ok(settingsReady >= 0 && columnsStart > settingsReady);
    assert.ok(groupsReady >= 0 && groupIntegrityStart > groupsReady);
    assert.ok(groupStudentsReady >= 0 && groupIntegrityStart > groupStudentsReady);
    assert.ok(groupTeachersReady >= 0 && groupIntegrityStart > groupTeachersReady);

    const groupIntegrityBlock = requiredBlock(
      migrationSource,
      "// Canonical PassPilot mappings depend on the ClassPilot groups base table",
      "// GoPilot homeroom co-teacher junction table"
    );
    assert.match(groupIntegrityBlock, /LEFT JOIN groups AS class_group ON class_group\.id = grade\.classpilot_group_id/);
    assert.match(groupIntegrityBlock, /LEFT JOIN groups AS class_group ON class_group\.id = pass\.classpilot_group_id/);
    assert.match(groupIntegrityBlock, /LEFT JOIN groups AS class_group ON class_group\.id = school\.kiosk_classpilot_group_id/);
    assert.match(groupIntegrityBlock, /PassPilot canonical group integrity check failed/);
    assert.doesNotMatch(groupIntegrityBlock, /\btry\s*\{/);
    assert.doesNotMatch(groupIntegrityBlock, /\bcatch\s*\(/);
    assert.doesNotMatch(groupIntegrityBlock, /console\.warn/);
  });

  it("never infers new-school canonical admission from licenses alone", () => {
    assert.match(
      validationSource,
      /passpilotClassModelAcknowledged:\s*z\.literal\(true\)\.optional\(\)/
    );
    for (const source of [schoolsRouteSource, superAdminRouteSource]) {
      assert.match(
        source,
        /const startsCanonical = passpilotClassModelAcknowledged === true[\s\S]*initialProducts\.has\("PASSPILOT"\)[\s\S]*initialProducts\.has\("CLASSPILOT"\)/
      );
      assert.match(source, /passpilotClassModelAcknowledged: startsCanonical/);
    }
  });
});
