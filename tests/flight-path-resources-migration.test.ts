import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  FLIGHT_PATH_RESOURCES_EXPAND_SQL,
  flightPathResourcesMigration,
} from "../src/db/flightPathResourcesMigration.js";
import { flightPathContentRevisionMigration } from "../src/db/flightPathContentRevisionMigration.js";
import {
  STAFF_IDENTITY_CONTRACT_MIGRATION_IDS,
  schoolPilot27ExpandMigrations,
  schoolPilot27Migrations,
} from "../src/db/migrations27.js";

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

describe("Flight Path precise resources schema rollout", () => {
  it("ships before the content revision expand and deferred staff identity contract", () => {
    const ids = schoolPilot27Migrations.map((migration) => migration.id);
    const index = ids.indexOf(flightPathResourcesMigration.id);
    const contractIndex = ids.indexOf(STAFF_IDENTITY_CONTRACT_MIGRATION_IDS[0]);
    assert.ok(index >= 0);
    assert.equal(ids[index + 1], flightPathContentRevisionMigration.id);
    assert.equal(index, contractIndex - 2);
    assert.ok(schoolPilot27ExpandMigrations.some((migration) => migration.id === flightPathResourcesMigration.id));
    assert.equal(new Set(ids).size, ids.length, "migration ids stay unique");
    assert.equal(flightPathResourcesMigration.id, "20260929_flight_path_resources_expand");
    assert.equal(flightPathResourcesMigration.mode, "transactional");
    assert.equal(
      flightPathResourcesMigration.checksum,
      createHash("sha256").update(FLIGHT_PATH_RESOURCES_EXPAND_SQL).digest("hex")
    );
  });

  it("adds an empty-list column and a NOT VALID then validated CHECK, idempotently", () => {
    const sql = FLIGHT_PATH_RESOURCES_EXPAND_SQL;
    assert.match(sql, /SET LOCAL lock_timeout = '15s';/);
    assert.match(sql, /ALTER TABLE flight_paths\s+ADD COLUMN IF NOT EXISTS resources JSONB NOT NULL DEFAULT '\[\]'::jsonb;/);
    assert.match(sql, /conname = 'flight_paths_resources_check'\s+AND conrelid = 'flight_paths'::regclass\s+\) THEN\s+ALTER TABLE flight_paths\s+ADD CONSTRAINT flight_paths_resources_check/);
    assert.match(
      sql,
      /CASE\s+WHEN jsonb_typeof\(resources\) = 'array'\s+THEN jsonb_array_length\(resources\) <= 200 AND octet_length\(resources::text\) <= 65536\s+ELSE false\s+END\s+\) NOT VALID;/
    );
    assert.match(sql, /AND NOT convalidated\s+\) THEN\s+ALTER TABLE flight_paths VALIDATE CONSTRAINT flight_paths_resources_check;/);
    assert.ok(sql.indexOf("NOT VALID") < sql.indexOf("VALIDATE CONSTRAINT"));
    // Additive only: no data rewrite, no removal, no policy or registry change.
    assert.doesNotMatch(sql, /\bDROP\b|\bDELETE\b|\bUPDATE\b|\bREFERENCES\b|ROW LEVEL SECURITY|CREATE POLICY|block_lists/);
  });

  it("mirrors the column and CHECK in Drizzle and in the nonproduction startup", async () => {
    const [schema, index] = await Promise.all([source("src/schema/classpilot.ts"), source("src/index.ts")]);
    assert.match(schema, /resources: jsonb\("resources"\)\.\$type<AllowedResource\[\]>\(\)\.notNull\(\)\.default\(sql`'\[\]'::jsonb`\)/);
    assert.match(
      schema,
      /check\(\s*"flight_paths_resources_check",\s*sql`CASE WHEN jsonb_typeof\(\$\{table\.resources\}\) = 'array' THEN jsonb_array_length\(\$\{table\.resources\}\) <= 200 AND octet_length\(\$\{table\.resources\}::text\) <= 65536 ELSE false END`\s*\)/
    );
    assert.match(index, /await pool\.query\(FLIGHT_PATH_RESOURCES_EXPAND_SQL\);/);
    assert.ok(
      index.indexOf("await pool.query(FLIGHT_PATH_RESOURCES_EXPAND_SQL);") > index.indexOf("await pool.query(IMPORT_PROCESSING_STAGES_SQL);"),
      "the startup mirror runs after the earlier expand modules"
    );
  });
});
