import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { CLASSPILOT_SCHEDULE_CONFIG_REPAIR_SQL } from "../src/db/classpilotScheduleConfigRepairMigration.js";
import { emptySchoolSchedulingConfig } from "../src/services/classpilotSchedulingRules.js";

process.env.REDIS_URL = "";
const { pool, sessionPool } = await import("../src/db.js");
const { runWithTenantContext } = await import("../src/middleware/tenantContext.js");
const scheduling = await import("../src/services/classpilotScheduling.js");

const seeded = randomUUID();
const configured = randomUUID();
const schoolIds = [seeded, configured];
const saved = {
  ...emptySchoolSchedulingConfig(), yearStart: "2026-08-24", yearEnd: "2027-06-11",
  periods: [{ id: "p1", name: "Period 1" }],
  profiles: [{ id: "regular", name: "Regular", periods: { p1: { startTime: "08:00", endTime: "08:50" } } }],
  defaultProfileId: "regular",
};
const storedConfig = async (schoolId: string) =>
  (await pool.query<{ config: unknown }>("SELECT config FROM classpilot_school_schedules WHERE school_id=$1", [schoolId])).rows[0]?.config;

before(async () => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.DATABASE_URL || "").hostname),
    "Schedule config repair tests require a local fixture database.");
  for (const id of schoolIds) {
    await pool.query("INSERT INTO schools(id,name,domain) VALUES($1,'Repair fixture',$2)", [id, `${id}.example.edu`]);
    await pool.query("INSERT INTO settings(school_id,school_name,ws_shared_key,instructional_calendar) VALUES($1,'Repair fixture','fixture-only','{}'::jsonb)", [id]);
  }
  // Exactly what the schedule boundary migration seeds for every school: a row
  // so the boundary queue has something to wake, holding an empty document.
  await pool.query("INSERT INTO classpilot_school_schedules(school_id,config) SELECT id,'{}'::jsonb FROM schools WHERE id=ANY($1::text[]) ON CONFLICT (school_id) DO NOTHING", [schoolIds]);
  await pool.query("UPDATE classpilot_school_schedules SET config=$2::jsonb WHERE school_id=$1", [configured, JSON.stringify(saved)]);
});

after(async () => {
  await pool.query("DELETE FROM classpilot_school_schedules WHERE school_id=ANY($1::text[])", [schoolIds]);
  await pool.query("DELETE FROM settings WHERE school_id=ANY($1::text[])", [schoolIds]);
  await pool.query("DELETE FROM schools WHERE id=ANY($1::text[])", [schoolIds]);
  await Promise.all([pool.end(), sessionPool.end()]);
});

// The scheduler reconciles every active tenant through this read. A seeded
// empty document used to throw here, which aborted the whole tenant block and
// left its scheduled classes unstarted.
test("a seeded empty document reads as the default schedule", async () => {
  const context = await runWithTenantContext({ schoolId: seeded }, () => scheduling.getSchoolSchedulingContext(seeded));
  assert.deepEqual(context.config, emptySchoolSchedulingConfig());
  assert.equal(context.revision, 0);
});

test("a configured document still reads exactly as saved", async () => {
  const context = await runWithTenantContext({ schoolId: configured }, () => scheduling.getSchoolSchedulingContext(configured));
  assert.deepEqual(context.config, saved);
});

test("the repair rewrites seeded documents and leaves configured ones alone", async () => {
  const result = await pool.query(CLASSPILOT_SCHEDULE_CONFIG_REPAIR_SQL);
  assert.ok((result.rowCount ?? 0) >= 1);
  assert.deepEqual(await storedConfig(seeded), emptySchoolSchedulingConfig());
  assert.deepEqual(await storedConfig(configured), saved);
});

test("the repair is idempotent", async () => {
  const result = await pool.query(CLASSPILOT_SCHEDULE_CONFIG_REPAIR_SQL);
  assert.equal(result.rowCount ?? 0, 0);
  assert.deepEqual(await storedConfig(seeded), emptySchoolSchedulingConfig());
});
