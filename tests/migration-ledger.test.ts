import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runSchoolPilotMigrationLedger } from "../src/db/migrationLedger.js";
import {
  CLASSPILOT_27_EXPAND_SQL,
  schoolPilot27Migrations,
} from "../src/db/migrations27.js";

function fakePool() {
  const rows = new Map<string, { checksum: string; status: string }>();
  const applied: string[] = [];
  const query = async (statement: string, values: unknown[] = []) => {
    if (/SELECT checksum, status FROM schema_migrations/.test(statement)) {
      const row = rows.get(String(values[0]));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (/INSERT INTO schema_migrations/.test(statement)) {
      rows.set(String(values[0]), { checksum: String(values[1]), status: "running" });
    }
    if (/SET status = 'complete'/.test(statement)) {
      const row = rows.get(String(values[0]));
      if (row) row.status = "complete";
    }
    if (/SET status = 'failed'/.test(statement)) {
      const row = rows.get(String(values[0]));
      if (row) row.status = "failed";
    }
    if (statement === "APPLY") applied.push(statement);
    return { rows: [], rowCount: 0 };
  };
  const pool = {
    query,
    connect: async () => ({ query, release: () => {} }),
  };
  return { pool: pool as any, rows, applied };
}

test("production migration tasks bind the ledger to the exact deployed SHA", () => {
  const deploy = readFileSync(new URL("../scripts/deploy.sh", import.meta.url), "utf8");
  assert.match(deploy, /DEPLOY_APPLICATION_SHA="\$LOCAL_SHA" node -e/);
  assert.match(
    deploy,
    /\{ name: "GIT_SHA", value: process\.env\.DEPLOY_APPLICATION_SHA \}/
  );
});

test("migration ledger applies once and checksum-verifies every later run", async () => {
  const fixture = fakePool();
  const checksum = createHash("sha256").update("apply-once").digest("hex");
  const migration = {
    id: "test_apply_once",
    checksum,
    mode: "transactional" as const,
    apply: async (connection: any) => { await connection.query("APPLY"); },
  };
  const first = await runSchoolPilotMigrationLedger({
    pool: fixture.pool,
    migrations: [migration],
    applicationSha: "test-sha",
  });
  const second = await runSchoolPilotMigrationLedger({
    pool: fixture.pool,
    migrations: [migration],
    applicationSha: "test-sha",
  });
  assert.equal(first[0]?.status, "applied");
  assert.equal(second[0]?.status, "skipped");
  assert.equal(fixture.applied.length, 1);

  await assert.rejects(() => runSchoolPilotMigrationLedger({
    pool: fixture.pool,
    migrations: [{ ...migration, checksum: "0".repeat(64) }],
  }), /checksum mismatch/);
});

test("ClassPilot 2.7 expand migration checksum covers the exact additive SQL", () => {
  assert.equal(
    schoolPilot27Migrations[0]?.checksum,
    createHash("sha256").update(CLASSPILOT_27_EXPAND_SQL).digest("hex")
  );
  assert.match(CLASSPILOT_27_EXPAND_SQL, /ADD COLUMN IF NOT EXISTS report_version/);
  assert.match(CLASSPILOT_27_EXPAND_SQL, /ADD COLUMN IF NOT EXISTS client_message_id/);
  assert.match(CLASSPILOT_27_EXPAND_SQL, /chat_messages_student_client_unique/);
});

test("production one-off mode is ledger-only and legacy convergence fails closed", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const oneOffStart = source.indexOf("async function runMigrationsAndExit");
  const oneOffEnd = source.indexOf("async function runLegacyMigrationsAndExit", oneOffStart);
  assert.notEqual(oneOffStart, -1);
  assert.notEqual(oneOffEnd, -1);
  const oneOff = source.slice(oneOffStart, oneOffEnd);
  assert.match(oneOff, /await runVersionedMigrations\(\)/);
  assert.doesNotMatch(oneOff, /runStartupMigrations/);

  const legacyStart = source.indexOf("export async function runStartupMigrations");
  assert.notEqual(legacyStart, -1);
  const legacyGuard = source.slice(legacyStart, legacyStart + 500);
  assert.match(legacyGuard, /NODE_ENV === "production"/);
  assert.match(legacyGuard, /LEGACY_STARTUP_MIGRATIONS_FORBIDDEN/);
});
