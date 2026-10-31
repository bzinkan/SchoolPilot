import assert from "node:assert/strict";
import pg from "pg";
import { runSchoolPilotMigrationLedger } from "../dist/db/migrationLedger.js";
import { classpilotScheduleBoundaryMigration } from "../dist/db/classpilotScheduleBoundaryMigration.js";
import { classpilotTodayScheduleMigration } from "../dist/db/classpilotTodayScheduleMigration.js";
import { runTodayScheduleContractCli } from "../dist/cli/contractClasspilotTodaySchedule.js";

// Disposable CI alone prepares the separately staged contraction before its
// write tests. Production must first verify convergence of both serving roles.
const connectionString = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
assert.ok(connectionString);
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(connectionString).hostname), "Only a disposable local test database is permitted");
const sourceSha = process.env.GIT_SHA;
assert.ok(sourceSha && /^[0-9a-f]{40}$/.test(sourceSha), "The exact CI source SHA is required");
const pool = new pg.Pool({ connectionString, max: 2 });
try {
  await runSchoolPilotMigrationLedger({ pool, migrations: [classpilotScheduleBoundaryMigration, classpilotTodayScheduleMigration], applicationSha: sourceSha });
} finally { await pool.end(); }
const exit = await runTodayScheduleContractCli(["--execute", "--expected-source-sha", sourceSha], {
  ...process.env, DATABASE_URL: connectionString, DATABASE_URL_PRIVILEGED: connectionString,
  GIT_SHA: sourceSha, CLASSPILOT_TODAY_SCHEDULE_MODE: "off",
});
assert.equal(exit, 0, "The disposable fixture's ledgered Today contraction must complete");
