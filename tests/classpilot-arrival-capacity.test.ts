import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("ClassPilot school-arrival capacity controls", () => {
  it("uses one bound tenant lease and reuses the validated heartbeat session", () => {
    const middleware = source("src/middleware/requireDeviceAuth.ts");
    const routes = source("src/routes/classpilot/devices.ts");

    assert.doesNotMatch(middleware, /activeStudentSessionCache/);
    assert.match(
      middleware,
      /bindTenantContext\(req, res,[\s\S]*?resolveActiveStudentTokenSession\(payload\)[\s\S]*?res\.locals\.activeStudentSession = activeSession/
    );
    assert.match(middleware, /next\(studentAuthenticationServiceError\(error\)\)/);
    assert.match(
      routes,
      /const activeSession = res\.locals\.activeStudentSession as \{ studentId\?: string \} \| undefined;/
    );
    assert.doesNotMatch(routes, /getActiveSessionByDevice/);
  });

  it("uses one tenant lease for student WebSocket bootstrap without per-auth success logs", () => {
    const websocket = source("src/realtime/websocket.ts");
    const studentBlock = websocket.slice(
      websocket.indexOf("// Student auth requires"),
      websocket.indexOf("// Staff auth via userToken")
    );

    assert.equal(studentBlock.match(/runWithTenantContext\(/g)?.length, 1);
    assert.match(studentBlock, /resolveActiveStudentTokenSession\(payload\)/);
    assert.match(studentBlock, /buildStudentFabState\(schoolId, payload\.studentId, \{[\s\S]*?schoolSettings/);
    assert.match(studentBlock, /Authentication service unavailable/);
    assert.doesNotMatch(websocket, /Student authenticated:|Staff authenticated:|Client connected/);
    assert.match(websocket, /type: "websocket_activity"/);
  });

  it("filters expired hands on read and reuses already-loaded school settings", () => {
    const storage = source("src/services/storage.ts");
    const fab = source("src/services/classpilotFab.ts");
    const handsBlock = storage.slice(
      storage.indexOf("export async function getActiveHandsForStudent"),
      storage.indexOf("export async function upsertClasspilotActiveHand")
    );

    assert.doesNotMatch(handsBlock, /clearExpiredClasspilotActiveHands/);
    assert.match(handsBlock, /expiresAt[\s\S]*?> now\(\)/);
    assert.match(fab, /knownSchoolSettings \?\? await getSettingsForSchool/);
    assert.match(fab, /options\.schoolSettings/);
  });

  it("batch-loads tenant-validated command sessions instead of querying each student serially", () => {
    const commands = source("src/routes/classpilot/commands.ts");
    const storage = source("src/services/storage.ts");
    const batchLookup = storage.slice(
      storage.indexOf("export async function getActiveSessionsForStudents"),
      storage.indexOf("export async function getActiveSessionByDevice")
    );

    assert.match(commands, /getActiveSessionsForStudents\(schoolId, selectedStudentIds\)/);
    assert.doesNotMatch(commands, /getActiveSessionByStudent/);
    assert.match(batchLookup, /inArray\(studentSessions\.studentId, uniqueStudentIds\)/);
    assert.match(batchLookup, /eq\(studentSessions\.isActive, true\)/);
    assert.match(batchLookup, /eq\(students\.schoolId, schoolId\)/);
    assert.match(batchLookup, /eq\(devices\.schoolId, schoolId\)/);
  });

  it("enables only the measured production weekday arrival-capacity schedule", () => {
    const ecs = source("infra/modules/ecs/main.tf");
    const alarms = source("infra/alarms.tf");
    const production = source("infra/production.tfvars");
    const ha = source("infra/production-ha-2000.tfvars");

    assert.equal((ecs.match(/resource "aws_appautoscaling_scheduled_action"/g) ?? []).length, 2);
    assert.match(ecs, /ignore_changes = \[task_definition, desired_count\]/);
    assert.match(ecs, /max_capacity\s*=\s*var\.api_max_capacity/);
    assert.match(ecs, /api_arrival_scale_up[\s\S]*?min_capacity = var\.api_arrival_min_capacity/);
    assert.match(ecs, /api_arrival_scale_down[\s\S]*?min_capacity = var\.desired_count/);
    assert.match(ecs, /var\.desired_count <= var\.api_max_capacity/);
    assert.match(ecs, /var\.api_arrival_min_capacity <= var\.api_max_capacity/);
    assert.match(ecs, /var\.desired_count <= var\.api_arrival_min_capacity/);
    assert.match(ecs, /target_value\s*=\s*70\.0/);
    assert.match(production, /enable_api_arrival_capacity\s*=\s*true/);
    assert.match(production, /api_arrival_min_capacity\s*=\s*6/);
    assert.match(production, /api_max_capacity\s*=\s*8/);
    assert.match(production, /api_arrival_scale_up_schedule\s*=\s*"cron\(45 5 \? \* MON-FRI \*\)"/);
    assert.match(production, /api_arrival_scale_down_schedule\s*=\s*"cron\(0 10 \? \* MON-FRI \*\)"/);
    assert.match(production, /api_arrival_schedule_timezone\s*=\s*"America\/New_York"/);
    assert.match(ha, /enable_api_arrival_capacity\s*=\s*false/);
    assert.match(alarms, /expression\s*=\s*"desired - running"/);
    assert.match(alarms, /metric_name\s*=\s*"DesiredTaskCount"/);
    assert.match(alarms, /metric_name\s*=\s*"RunningTaskCount"/);
  });
});
