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
  const [startup, schema, workflow, deploy, allowlistHelper, guidance] = await Promise.all([
    readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/schema/classpilot.ts", import.meta.url), "utf8"),
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
  assert.match(startup, /requiredFabIndexes\.rowCount !== 11/);
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
  assert.match(startup, /!catalog\.has_tenant_isolation_policy/);
  assert.match(startup, /REQUIRE_RLS_TABLE_ENFORCEMENT/);
  assert.match(startup, /PARTITION BY COALESCE\(mapping\.keeper_id, session\.student_id\)[\s\S]*UPDATE student_sessions session[\s\S]*ranked\.ordinal > 1/);
  assert.match(startup, /Duplicate student cleanup rolled back; retained original rows/);
  assert.match(startup, /ALTER TABLE polls ALTER COLUMN is_active SET NOT NULL/);
  assert.match(startup, /ALTER TABLE chat_messages ALTER COLUMN school_id SET NOT NULL/);
});
