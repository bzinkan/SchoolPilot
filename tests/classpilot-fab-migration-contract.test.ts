import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const REQUIRED_FAB_TABLES = [
  "classpilot_active_hands",
  "session_settings",
  "classpilot_chat_deliveries",
  "polls",
  "poll_responses",
] as const;

test("ClassPilot FAB/chat/poll startup migration is fail-closed and RLS-wired", async () => {
  const [startup, schema, storage, workflow, deploy, allowlistHelper, guidance] = await Promise.all([
    readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/schema/classpilot.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/services/storage.ts", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/ci-build.yml", import.meta.url), "utf8"),
    readFile(new URL("../scripts/deploy.sh", import.meta.url), "utf8"),
    readFile(new URL("../scripts/enforce-deploy-rls-allowlist.mjs", import.meta.url), "utf8"),
    readFile(new URL("../CLAUDE.md", import.meta.url), "utf8"),
  ]);
  for (const table of REQUIRED_FAB_TABLES) {
    assert.match(startup, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
    assert.match(schema, new RegExp(`"${table}"`));
    assert.match(workflow, new RegExp(`(?:^|,)${table}(?:,|$)`));
  }
  const oneShotFabBundle = "classpilot_chat_deliveries,poll_responses,polls,session_settings";
  assert.match(deploy, new RegExp(oneShotFabBundle));
  assert.match(allowlistHelper, /CLASSPILOT_FAB_RLS_TABLES/);
  for (const table of REQUIRED_FAB_TABLES.slice(1)) {
    assert.match(allowlistHelper, new RegExp(`"${table}"`));
  }
  assert.match(guidance, new RegExp(oneShotFabBundle));
  assert.match(startup, /FATAL: ClassPilot FAB release-critical migration failed/);
  assert.match(startup, /throw err/);
  assert.match(startup, /requiredFabColumns\.rowCount !== 13/);
  assert.match(startup, /requiredFabIndexes\.rowCount !== 12/);
  assert.match(startup, /requiredFabConstraints\.rowCount !== 1/);
  assert.match(startup, /requiredFabTriggers\.rowCount !== 6/);
  assert.match(startup, /classpilot_validate_active_hand_parents/);
  assert.match(startup, /classpilot_validate_chat_delivery_parents/);
  assert.match(startup, /classpilot_validate_command_message_parents/);
  assert.match(startup, /hand\.cleared_at IS NULL[\s\S]*any_device\.device_id = hand\.device_id/);
  assert.match(startup, /active hand session and student must belong to the same school/);
  assert.match(startup, /cleared hand device cannot belong to another school/);
  assert.match(startup, /NEW\.device_id IS DISTINCT FROM OLD\.device_id/);
  assert.match(startup, /ClassPilot session-setting parent tenant verification failed/);
  assert.match(startup, /poll command authority does not match its session/);
  assert.match(startup, /poll response student does not belong to the poll school/);
  assert.match(startup, /poll response device does not belong to the poll school/);
  assert.match(startup, /response\.device_id IS NOT NULL AND device\.device_id IS NULL/);
  assert.match(startup, /SET device_id = NULL, updated_at = now\(\)/);
  const orphanCleanup = startup.indexOf("DELETE FROM poll_responses response");
  const responseSchoolBackfill = startup.indexOf("UPDATE poll_responses response SET school_id");
  const responseParentTrigger = startup.indexOf("CREATE OR REPLACE FUNCTION classpilot_bind_poll_response_school");
  const responseParentAudit = startup.indexOf("const invalidPollResponseParents");
  assert.ok(orphanCleanup >= 0, "legacy missing-student poll responses must be normalized");
  assert.ok(
    orphanCleanup < responseSchoolBackfill
      && responseSchoolBackfill < responseParentTrigger
      && responseParentTrigger < responseParentAudit,
    "legacy orphan cleanup must precede backfill, trigger installation, and the fail-closed audit",
  );
  const orphanCleanupSql = startup.slice(orphanCleanup, responseSchoolBackfill);
  assert.match(orphanCleanupSql, /USING polls poll/);
  assert.match(orphanCleanupSql, /response\.school_id IS NULL OR response\.school_id = poll\.school_id/);
  assert.match(orphanCleanupSql, /NOT EXISTS \([\s\S]*FROM students any_student[\s\S]*any_student\.id = response\.student_id/);
  assert.match(orphanCleanupSql, /NOT EXISTS \([\s\S]*FROM devices cross_school_device[\s\S]*cross_school_device\.school_id <> poll\.school_id/);
  assert.match(startup, /legacy poll responses whose student no longer exists/);
  assert.match(startup, /ADD CONSTRAINT poll_responses_school_student_fk[\s\S]*FOREIGN KEY \(school_id, student_id\)[\s\S]*ON DELETE RESTRICT[\s\S]*NOT VALID/);
  assert.match(startup, /VALIDATE CONSTRAINT poll_responses_school_student_fk/);
  assert.match(schema, /poll_responses_school_student_idx/);
  assert.match(schema, /name: "poll_responses_school_student_fk"[\s\S]*\.onDelete\("restrict"\)/);
  assert.doesNotMatch(storage, /export async function createPollResponse\s*\(/);
  assert.match(storage, /export async function createPollResponseFirstWrite\s*\(/);
  assert.match(startup, /!catalog\.has_tenant_isolation_policy/);
  assert.match(startup, /REQUIRE_RLS_TABLE_ENFORCEMENT/);
  assert.match(startup, /PARTITION BY COALESCE\(mapping\.keeper_id, session\.student_id\)[\s\S]*UPDATE student_sessions session[\s\S]*ranked\.ordinal > 1/);
  assert.match(startup, /Duplicate student cleanup rolled back; retained original rows/);
  assert.match(startup, /ALTER TABLE polls ALTER COLUMN is_active SET NOT NULL/);
  assert.match(startup, /ALTER TABLE chat_messages ALTER COLUMN school_id SET NOT NULL/);
});
