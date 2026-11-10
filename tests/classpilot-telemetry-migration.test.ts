import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { Client } from "pg";
import { classpilotTelemetryIdempotencyMigration, CLASSPILOT_TELEMETRY_IDEMPOTENCY_SQL } from "../src/db/classpilotTelemetryIdempotencyMigration.js";

test("idempotency migration is additive, immutable and adds no heartbeat index or tenant table", async () => {
  const sql = CLASSPILOT_TELEMETRY_IDEMPOTENCY_SQL;
  assert.match(sql, /ALTER TABLE heartbeats ADD COLUMN IF NOT EXISTS telemetry_payload_hash VARCHAR\(64\)/);
  assert.doesNotMatch(sql, /CREATE (?:UNIQUE )?INDEX|CREATE TABLE|DROP /i);
  assert.equal(classpilotTelemetryIdempotencyMigration.mode, "transactional");
  assert.equal(classpilotTelemetryIdempotencyMigration.checksum, createHash("sha256").update(sql).digest("hex"));
  const calls: unknown[] = [];
  const client = new Client();
  Object.defineProperty(client, "query", { value: async (value: unknown) => {
    calls.push(value); return { rows: [], command: "ALTER", rowCount: null, oid: 0, fields: [] };
  } });
  await classpilotTelemetryIdempotencyMigration.apply(client);
  assert.deepEqual(calls, [sql]);
});
