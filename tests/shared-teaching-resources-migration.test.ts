import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  SHARED_TEACHING_RESOURCES_EXPAND_SQL,
  sharedTeachingResourcesMigration,
} from "../src/db/sharedTeachingResourcesMigration.js";
import {
  STAFF_IDENTITY_CONTRACT_MIGRATION_IDS,
  schoolPilot27ExpandMigrations,
  schoolPilot27Migrations,
} from "../src/db/migrations27.js";

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

describe("School Library schema rollout", () => {
  it("ships in the production expand plan before the deferred staff identity contract", () => {
    const ids = schoolPilot27Migrations.map((migration) => migration.id);
    const index = ids.indexOf(sharedTeachingResourcesMigration.id);
    const contractIndex = ids.indexOf(STAFF_IDENTITY_CONTRACT_MIGRATION_IDS[0]);
    assert.ok(index >= 0 && contractIndex > index);
    assert.equal(ids.indexOf("20260929_microsoft_sign_in_expand"), index - 1);
    assert.equal(ids.at(-1), "20260824_staff_identity_integrity_contract");
    assert.ok(schoolPilot27ExpandMigrations.some((migration) => migration.id === sharedTeachingResourcesMigration.id));
    assert.equal(new Set(ids).size, ids.length, "migration ids stay unique");
    assert.equal(sharedTeachingResourcesMigration.mode, "transactional");
    assert.equal(
      sharedTeachingResourcesMigration.checksum,
      createHash("sha256").update(SHARED_TEACHING_RESOURCES_EXPAND_SQL).digest("hex")
    );
  });

  it("is additive, idempotent and private by default on both tables", () => {
    const sql = SHARED_TEACHING_RESOURCES_EXPAND_SQL;
    assert.match(sql, /SET LOCAL lock_timeout = '15s';/);
    for (const table of ["flight_paths", "block_lists"]) {
      assert.match(
        sql,
        new RegExp(
          `ALTER TABLE ${table}\\s+ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private',`
            + `\\s+ADD COLUMN IF NOT EXISTS official BOOLEAN NOT NULL DEFAULT false,`
            + `\\s+ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,`
            + `\\s+ADD COLUMN IF NOT EXISTS published_by TEXT;`
        )
      );
      assert.match(sql, new RegExp(`conname = '${table}_visibility_check'\\s+AND conrelid = '${table}'::regclass`));
      assert.match(sql, new RegExp(`ADD CONSTRAINT ${table}_visibility_check\\s+CHECK \\(visibility IN \\('private', 'school'\\)\\)`));
      assert.match(
        sql,
        new RegExp(`CREATE INDEX IF NOT EXISTS ${table}_school_library_idx\\s+ON ${table} \\(school_id\\)\\s+WHERE visibility = 'school' OR official;`)
      );
    }
    // No data rewrite, no removal, and no user FK on published_by.
    assert.doesNotMatch(sql, /\bDROP\b|\bDELETE\b|\bUPDATE\b|\bREFERENCES\b/);
    // Both tables are already enforced tenant tables: no policy changes here.
    assert.doesNotMatch(sql, /ROW LEVEL SECURITY|CREATE POLICY/);
  });

  it("mirrors the columns, check and partial index in Drizzle and in the nonproduction startup", async () => {
    const [schema, index] = await Promise.all([source("src/schema/classpilot.ts"), source("src/index.ts")]);
    for (const table of ["flight_paths", "block_lists"]) {
      assert.match(schema, new RegExp(`index\\("${table}_school_library_idx"\\)\\s+\\.on\\(table\\.schoolId\\)\\s+\\.where\\(sql\`visibility = 'school' OR official\`\\)`));
      assert.match(schema, new RegExp(`check\\("${table}_visibility_check", sql\`\\$\\{table\\.visibility\\} IN \\('private', 'school'\\)\`\\)`));
    }
    assert.equal(
      schema.match(/visibility: text\("visibility"\)\.\$type<"private" \| "school">\(\)\.notNull\(\)\.default\("private"\)/g)?.length,
      2
    );
    assert.equal(schema.match(/official: boolean\("official"\)\.notNull\(\)\.default\(false\)/g)?.length, 2);
    assert.equal(schema.match(/publishedAt: timestamp\("published_at", \{ withTimezone: true \}\)/g)?.length, 2);
    assert.equal(schema.match(/publishedBy: text\("published_by"\),/g)?.length, 2);
    assert.match(index, /await pool\.query\(IMPORT_PROCESSING_STAGES_SQL\);\s+await pool\.query\(SHARED_TEACHING_RESOURCES_EXPAND_SQL\);/);
  });
});
