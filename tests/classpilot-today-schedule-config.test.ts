import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { isClasspilotTodayScheduleEnabled, CLASSPILOT_TODAY_SCHEDULE_RLS_TABLES } from "../src/config/classpilotTodaySchedule.js";
import { classpilotTodayScheduleMigration, CLASSPILOT_TODAY_SCHEDULE_SQL } from "../src/db/classpilotTodayScheduleMigration.js";
import { classpilotTodayScheduleContractMigration } from "../src/db/classpilotTodayScheduleContractMigration.js";
import { assertTodayScheduleContractExecution, parseTodayScheduleContractArgs } from "../src/cli/contractClasspilotTodaySchedule.js";
import { selectSchoolPilot27MigrationPlan } from "../src/db/migrations27.js";

test("today-schedule new writes require exact on and the complete tenant admission", () => {
  const admitted = { RLS_GUC_ENABLED: "true", RLS_ENABLED_TABLES: CLASSPILOT_TODAY_SCHEDULE_RLS_TABLES.join(",") };
  assert.equal(isClasspilotTodayScheduleEnabled({ ...admitted, CLASSPILOT_TODAY_SCHEDULE_MODE: "on" }), true);
  for (const mode of [undefined, "off", "ON", " on", "on ", "true", ""]) {
    assert.equal(isClasspilotTodayScheduleEnabled({ ...admitted, CLASSPILOT_TODAY_SCHEDULE_MODE: mode }), false);
  }
  for (const table of CLASSPILOT_TODAY_SCHEDULE_RLS_TABLES) {
    assert.equal(isClasspilotTodayScheduleEnabled({ ...admitted, CLASSPILOT_TODAY_SCHEDULE_MODE: "on", RLS_ENABLED_TABLES: table }), false);
  }
  for (const guc of [undefined, "false", "TRUE"]) {
    assert.equal(isClasspilotTodayScheduleEnabled({ ...admitted, CLASSPILOT_TODAY_SCHEDULE_MODE: "on", RLS_GUC_ENABLED: guc }), false);
  }
});

test("today-schedule immutable migration is wired into the ledger and local bootstrap", () => {
  assert.equal(classpilotTodayScheduleMigration.mode, "transactional");
  assert.equal(classpilotTodayScheduleMigration.checksum, createHash("sha256").update(CLASSPILOT_TODAY_SCHEDULE_SQL).digest("hex"));
  const ledger = readFileSync(new URL("../src/db/migrations27.ts", import.meta.url), "utf8");
  const bootstrap = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(ledger, /classpilotManualTodayMigration,\s+classpilotTodayScheduleMigration,\s*\]/);
  assert.match(bootstrap, /await pool\.query\(CLASSPILOT_TODAY_SCHEDULE_SQL\)/);
});

test("the conflict identity contraction requires explicit execution, exact source and new writes off", () => {
  const sha = "a".repeat(40);
  const options = parseTodayScheduleContractArgs(["--execute", "--expected-source-sha", sha]);
  const env = { GIT_SHA: sha, DATABASE_URL: "synthetic-connection-not-opened", CLASSPILOT_TODAY_SCHEDULE_MODE: "off" };
  assert.equal(assertTodayScheduleContractExecution(options, env), sha);
  assert.equal(assertTodayScheduleContractExecution(options, { ...env, DATABASE_URL_PRIVILEGED: "synthetic-migration-connection-not-opened" }), sha);
  assert.throws(() => assertTodayScheduleContractExecution(options, { ...env, DATABASE_URL: undefined, DATABASE_URL_PRIVILEGED: "synthetic-migration-connection-not-opened" }));
  assert.equal(assertTodayScheduleContractExecution(options, { ...env, CLASSPILOT_TODAY_SCHEDULE_MODE: undefined }), sha);
  for (const value of ["on", "OFF", "", " off"]) assert.throws(() => assertTodayScheduleContractExecution(options, { ...env, CLASSPILOT_TODAY_SCHEDULE_MODE: value }));
  assert.throws(() => assertTodayScheduleContractExecution({ ...options, execute: false }, env));
  assert.throws(() => assertTodayScheduleContractExecution(options, { ...env, GIT_SHA: "b".repeat(40) }));
  assert.throws(() => assertTodayScheduleContractExecution(options, { ...env, DATABASE_URL: undefined }));
  for (const invalid of [["--execute", "--execute"], ["--expected-source-sha", sha.toUpperCase()], ["--expected-source-sha"], ["--unknown"]]) {
    assert.throws(() => parseTodayScheduleContractArgs(invalid));
  }
});

test("ordinary migration plans never first contract and retain the exact completed contract afterward", () => {
  const options = { contractRolloutRequested: true, contractPreviouslyApplied: true };
  assert.equal(selectSchoolPilot27MigrationPlan(options).some(row => row.id === classpilotTodayScheduleContractMigration.id), false);
  const retained = selectSchoolPilot27MigrationPlan({ ...options, todayScheduleContractPreviouslyApplied: true });
  assert.deepEqual(retained.at(-1), classpilotTodayScheduleContractMigration);
  assert.equal(retained.filter(row => row.id === classpilotTodayScheduleContractMigration.id).length, 1);
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(source, /todayScheduleContractPreviouslyApplied/);
  assert.match(source, /ELSIF NOT EXISTS\(SELECT 1 FROM schema_migrations WHERE id='classpilot-today-conflict-identity-contract-20261031' AND status='complete'\)/);
});
