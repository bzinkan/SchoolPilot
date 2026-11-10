import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

// Private payload identity only. The existing primary key provides durable
// cross-task deduplication; no index or public screenshot-health field is added.
export const CLASSPILOT_TELEMETRY_IDEMPOTENCY_SQL = `
ALTER TABLE heartbeats ADD COLUMN IF NOT EXISTS telemetry_payload_hash VARCHAR(64);
`;
export const classpilotTelemetryIdempotencyMigration: SchoolPilotMigration = {
  id: "classpilot-telemetry-idempotency-20261109",
  checksum: createHash("sha256").update(CLASSPILOT_TELEMETRY_IDEMPOTENCY_SQL).digest("hex"),
  mode: "transactional",
  apply: async connection => { await connection.query(CLASSPILOT_TELEMETRY_IDEMPOTENCY_SQL); },
};
