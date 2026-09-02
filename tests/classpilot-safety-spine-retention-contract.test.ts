import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

const SECTION_HEADER = "ClassPilot - Safety spine / messaging retention";

async function schedulerSource(): Promise<string> {
  return readFile(new URL("src/services/scheduler.ts", root), "utf8");
}

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0, `missing marker: ${startMarker}`);
  assert.ok(end > start, `missing marker after ${startMarker}: ${endMarker}`);
  return source.slice(start, end);
}

function safetySpineSection(source: string): string {
  return sliceBetween(source, SECTION_HEADER, "async function purgeOldErrorLogs");
}

test("the hourly purge block runs the safety spine purge immediately after heartbeats", async () => {
  const scheduler = await schedulerSource();
  const hourly = sliceBetween(scheduler, "async function runHeavyJobsSerially", "export function startScheduler");

  const heartbeats = hourly.indexOf("await purgeExpiredHeartbeats();");
  const spine = hourly.indexOf("await purgeClasspilotSafetySpineRetention();");
  const evidence = hourly.indexOf("await purgeExpiredEvidenceArtifactContent();");

  assert.ok(heartbeats >= 0, "heartbeat purge must stay registered in the hourly block");
  assert.ok(spine > heartbeats, "safety spine purge must run after the heartbeat purge");
  assert.ok(evidence > spine, "safety spine purge must run before the evidence content purge");
  assert.match(
    hourly.slice(heartbeats, spine),
    /^await purgeExpiredHeartbeats\(\);\s+$/,
    "nothing may run between the heartbeat purge and the safety spine purge"
  );
});

test("the safety spine purge lives outside the guarded heartbeat retention slice", async () => {
  const scheduler = await schedulerSource();
  const guarded = sliceBetween(
    scheduler,
    "async function purgeExpiredHeartbeats",
    "ClassPilot - Automatic class block scheduling"
  );

  assert.doesNotMatch(guarded, /purgeClasspilotSafetySpineRetention/);
  assert.doesNotMatch(guarded, /student_safety_cases|classpilot_ai_decisions|classpilot_chat_deliveries/);
  assert.ok(
    scheduler.indexOf(SECTION_HEADER) > scheduler.indexOf("ClassPilot - Automatic class block scheduling"),
    "the safety spine section must sit after the class block scheduling section"
  );
});

test("every safety spine statement is tenant-scoped, case-aware, and batched", async () => {
  const section = safetySpineSection(await schedulerSource());

  const tenantScoped = section.match(/school_id = \$1/g) ?? [];
  assert.ok(tenantScoped.length >= 5, `expected at least five tenant-scoped statements, saw ${tenantScoped.length}`);
  for (const table of [
    "classpilot_ai_decisions",
    "student_timeline_events",
    "student_safety_cases",
    "messages",
    "classpilot_chat_deliveries",
  ]) {
    assert.match(section, new RegExp(`table: "${table}"`), `missing retention statement for ${table}`);
  }
  assert.doesNotMatch(section, /productLicenses/, "licensing must never gate retention");

  // Timeline rows delete before their case so the join still sees closed_at.
  assert.ok(
    section.indexOf('table: "student_timeline_events"') < section.indexOf('table: "student_safety_cases"'),
    "timeline events must purge before safety cases"
  );
  assert.match(section, /LEFT JOIN student_safety_cases AS safety_case/);
  assert.match(section, /event\.case_id IS NULL AND event\.occurred_at < \$2/);
  assert.match(section, /event\.case_id IS NOT NULL AND safety_case\.id IS NULL AND event\.occurred_at < \$2/);
  assert.match(section, /status <> 'open'/);
  assert.equal(
    (section.match(/COALESCE\(safety_case\.closed_at, safety_case\.opened_at\) < \$\d/g) ?? []).length,
    2,
    "both the timeline join and the case delete must use the closed-case cutoff"
  );
  assert.match(section, /NOT EXISTS \(SELECT 1 FROM evidence_artifacts AS artifact/);
  assert.match(section, /artifact\.school_id = \$1 AND artifact\.case_id = safety_case\.id/);
  assert.match(section, /"timestamp" < \$2/);
  assert.match(section, /state <> 'leased' OR lease_expires_at IS NULL OR lease_expires_at < \$2/);
  assert.doesNotMatch(section, /school_id IS NULL/, "the NULL-school message orphan sweep is out of scope");

  assert.match(section, /RETENTION_BATCH_SIZE = 5000/);
  assert.match(section, /CLOSED_SAFETY_CASE_RETENTION_FLOOR_DAYS = 90/);
  assert.match(section, /LIMIT \$\{RETENTION_BATCH_SIZE\}/);
  assert.match(section, /while \(batchDeleted >= RETENTION_BATCH_SIZE\)/);
  assert.match(section, /Math\.max\(retentionDays, CLOSED_SAFETY_CASE_RETENTION_FLOOR_DAYS\)/);
  assert.match(section, /\.from\(schools\)/);
  assert.match(section, /parseClasspilotRetentionDays\(schoolSettings\?\.retentionHours\)/);
  assert.match(section, /job: "purgeClasspilotSafetySpineRetention"/);
});

test("the purge defaults to count mode and reports identifier-free totals", async () => {
  const section = safetySpineSection(await schedulerSource());
  const envExample = await readFile(new URL(".env.example", root), "utf8");

  assert.match(
    section,
    /process\.env\.CLASSPILOT_RETENTION_PURGE_SPINE_MODE === "delete" \? "delete" : "count"/,
    "anything but the exact string delete must stay in count mode"
  );
  assert.match(section, /SELECT count\(\*\)::int AS total FROM/);
  assert.match(envExample, /^CLASSPILOT_RETENTION_PURGE_SPINE_MODE=count$/m);

  const summary = sliceBetween(section, "[ClassPilot] Safety spine retention mode=", ");");
  assert.match(summary, /tenants=\$\{tenants\}/);
  assert.match(summary, /chatDeliveries=\$\{totals\.chatDeliveries\}/);
  assert.doesNotMatch(summary, /school\.id|schoolId/, "the summary line must never carry a tenant id");
  assert.equal(
    (section.match(/console\.log\(/g) ?? []).length,
    1,
    "the safety spine purge logs exactly one summary line per run"
  );
});
