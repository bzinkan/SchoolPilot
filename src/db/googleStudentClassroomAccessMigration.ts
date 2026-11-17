import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

/** Nullable purpose approval on an existing tenant table; no grant or backfill. */
export const GOOGLE_STUDENT_CLASSROOM_ACCESS_SQL = `
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';
DO $$ BEGIN
  IF to_regclass('google_roster_connectors') IS NOT NULL THEN
    ALTER TABLE google_roster_connectors ADD COLUMN IF NOT EXISTS classroom_access_approval JSONB;
  END IF;
END $$;
`;
export const googleStudentClassroomAccessMigration: SchoolPilotMigration = {
  id: "20261116_google_student_classroom_access_approval_expand",
  checksum: createHash("sha256").update(GOOGLE_STUDENT_CLASSROOM_ACCESS_SQL).digest("hex"),
  mode: "transactional",
  apply: async connection => { await connection.query(GOOGLE_STUDENT_CLASSROOM_ACCESS_SQL); },
};
