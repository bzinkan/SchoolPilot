import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

/**
 * School Library for Flight Paths and Block Lists. Additive only: every
 * existing row keeps visibility 'private' and official false, so nothing is
 * shared until an owner or administrator acts (and only while
 * CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE is on for the school). Both tables
 * are already RLS-enforced tenant tables, so no registry change is needed.
 * published_by is plain text like teacher_id (no user FK).
 */
export const SHARED_TEACHING_RESOURCES_EXPAND_SQL = `
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE flight_paths
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private',
  ADD COLUMN IF NOT EXISTS official BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS published_by TEXT;

ALTER TABLE block_lists
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private',
  ADD COLUMN IF NOT EXISTS official BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS published_by TEXT;

DO $shared_teaching_resources_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'flight_paths_visibility_check'
      AND conrelid = 'flight_paths'::regclass
  ) THEN
    ALTER TABLE flight_paths
      ADD CONSTRAINT flight_paths_visibility_check
      CHECK (visibility IN ('private', 'school'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'block_lists_visibility_check'
      AND conrelid = 'block_lists'::regclass
  ) THEN
    ALTER TABLE block_lists
      ADD CONSTRAINT block_lists_visibility_check
      CHECK (visibility IN ('private', 'school'));
  END IF;
END;
$shared_teaching_resources_constraints$;

CREATE INDEX IF NOT EXISTS flight_paths_school_library_idx
  ON flight_paths (school_id)
  WHERE visibility = 'school' OR official;

CREATE INDEX IF NOT EXISTS block_lists_school_library_idx
  ON block_lists (school_id)
  WHERE visibility = 'school' OR official;
`;

export const sharedTeachingResourcesMigration: SchoolPilotMigration = {
  id: "20260929_shared_teaching_resources_expand",
  checksum: createHash("sha256").update(SHARED_TEACHING_RESOURCES_EXPAND_SQL).digest("hex"),
  mode: "transactional",
  apply: async (connection) => { await connection.query(SHARED_TEACHING_RESOURCES_EXPAND_SQL); },
};
