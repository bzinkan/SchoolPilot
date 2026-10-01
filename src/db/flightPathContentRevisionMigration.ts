import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

/** Additive content fence on the existing RLS tenant table; no new table. */
export const FLIGHT_PATH_CONTENT_REVISION_SQL = `
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';
ALTER TABLE flight_paths ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp());
CREATE OR REPLACE FUNCTION schoolpilot_flight_path_content_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
    NEW.updated_at := greatest(date_trunc('milliseconds', clock_timestamp()),
      date_trunc('milliseconds', OLD.updated_at) + interval '1 millisecond');
  ELSE
    NEW.updated_at := OLD.updated_at;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS flight_paths_content_revision ON flight_paths;
CREATE TRIGGER flight_paths_content_revision BEFORE UPDATE ON flight_paths
FOR EACH ROW EXECUTE FUNCTION schoolpilot_flight_path_content_revision();
`;

export const flightPathContentRevisionMigration: SchoolPilotMigration = {
  id: "20260930_flight_path_content_revision_expand",
  checksum: createHash("sha256").update(FLIGHT_PATH_CONTENT_REVISION_SQL).digest("hex"),
  mode: "transactional",
  apply: async connection => { await connection.query(FLIGHT_PATH_CONTENT_REVISION_SQL); },
};
