import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

/**
 * Precise restriction resources on Flight Paths (roadmap PR 2). Additive only:
 * every existing row gets an empty list, so every existing Flight Path keeps
 * serializing exactly as before. The column holds section and resource
 * entries (see src/services/restrictionResources.ts); website entries stay in
 * allowed_domains, the list ClassPilot 2.9.x enforces. flight_paths is already
 * an RLS-enforced tenant table, so no registry or policy change is needed.
 *
 * The CHECK is added NOT VALID and then validated in the same transaction.
 * The ADD COLUMN already holds the table lock and the new column is the
 * constant '[]' on every row, so validation is a trivial scan of a small
 * table; the split keeps the pattern safe to re-run and lets the startup
 * mirror skip validation once it has succeeded. CASE (not AND) guarantees
 * jsonb_array_length is only evaluated for arrays.
 */
export const FLIGHT_PATH_RESOURCES_EXPAND_SQL = `
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE flight_paths
  ADD COLUMN IF NOT EXISTS resources JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $flight_path_resources_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'flight_paths_resources_check'
      AND conrelid = 'flight_paths'::regclass
  ) THEN
    ALTER TABLE flight_paths
      ADD CONSTRAINT flight_paths_resources_check
      CHECK (
        CASE
          WHEN jsonb_typeof(resources) = 'array'
            THEN jsonb_array_length(resources) <= 200 AND octet_length(resources::text) <= 65536
          ELSE false
        END
      ) NOT VALID;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'flight_paths_resources_check'
      AND conrelid = 'flight_paths'::regclass
      AND NOT convalidated
  ) THEN
    ALTER TABLE flight_paths VALIDATE CONSTRAINT flight_paths_resources_check;
  END IF;
END;
$flight_path_resources_constraints$;
`;

export const flightPathResourcesMigration: SchoolPilotMigration = {
  id: "20260929_flight_path_resources_expand",
  checksum: createHash("sha256").update(FLIGHT_PATH_RESOURCES_EXPAND_SQL).digest("hex"),
  mode: "transactional",
  apply: async (connection) => { await connection.query(FLIGHT_PATH_RESOURCES_EXPAND_SQL); },
};
