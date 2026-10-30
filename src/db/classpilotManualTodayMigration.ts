import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

// Additive columns on existing tenant tables; no RLS inventory change.
export const CLASSPILOT_MANUAL_TODAY_SQL = `
ALTER TABLE groups ADD COLUMN IF NOT EXISTS schedule_manual_date TEXT;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS allow_teacher_manual_today BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE teaching_sessions ADD COLUMN IF NOT EXISTS manual_expires_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS teaching_sessions_manual_expiry_idx
  ON teaching_sessions(manual_expires_at) WHERE end_time IS NULL AND manual_expires_at IS NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='groups_schedule_manual_date_check' AND conrelid='groups'::regclass) THEN
    ALTER TABLE groups ADD CONSTRAINT groups_schedule_manual_date_check
      CHECK (schedule_manual_date IS NULL OR schedule_manual_date ~ '^\\d{4}-\\d{2}-\\d{2}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='teaching_sessions_manual_expiry_check' AND conrelid='teaching_sessions'::regclass) THEN
    ALTER TABLE teaching_sessions ADD CONSTRAINT teaching_sessions_manual_expiry_check
      CHECK (manual_expires_at IS NULL OR (scheduled_date IS NULL AND manual_expires_at > start_time));
  END IF;
END $$;
`;

export const classpilotManualTodayMigration: SchoolPilotMigration = {
  id: "classpilot-manual-today-20261030",
  checksum: createHash("sha256").update(CLASSPILOT_MANUAL_TODAY_SQL).digest("hex"),
  mode: "transactional",
  apply: async connection => { await connection.query(CLASSPILOT_MANUAL_TODAY_SQL); },
};
