import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

/** Additive metadata only: both parent tables already belong to the RLS registry. */
export const CLASSPILOT_SCHEDULE_PROFILE_SUPERVISION_SQL = `
ALTER TABLE classpilot_school_schedules
  ADD COLUMN IF NOT EXISTS profile_activation_outcomes JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE classpilot_supervision_contexts
  ADD COLUMN IF NOT EXISTS schedule_profile_application_id TEXT,
  ADD COLUMN IF NOT EXISTS schedule_profile_block_id TEXT,
  ADD COLUMN IF NOT EXISTS schedule_profile_date TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='classpilot_school_schedules'::regclass AND conname='cp_schedule_profile_outcomes_object_check') THEN
    ALTER TABLE classpilot_school_schedules ADD CONSTRAINT cp_schedule_profile_outcomes_object_check
      CHECK (jsonb_typeof(profile_activation_outcomes) = 'object');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='classpilot_supervision_contexts'::regclass AND conname='cp_supervision_schedule_profile_metadata_check') THEN
    ALTER TABLE classpilot_supervision_contexts ADD CONSTRAINT cp_supervision_schedule_profile_metadata_check CHECK (
      (schedule_profile_application_id IS NULL AND schedule_profile_block_id IS NULL AND schedule_profile_date IS NULL)
      OR (schedule_profile_application_id IS NOT NULL AND length(schedule_profile_application_id) BETWEEN 1 AND 128
        AND schedule_profile_block_id IS NOT NULL AND length(schedule_profile_block_id) BETWEEN 1 AND 128
        AND schedule_profile_date IS NOT NULL AND schedule_profile_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
    );
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS cp_supervision_schedule_profile_unique
  ON classpilot_supervision_contexts(school_id,schedule_profile_application_id,schedule_profile_date,schedule_profile_block_id)
  WHERE schedule_profile_application_id IS NOT NULL;
`;

export const classpilotScheduleProfileSupervisionMigration: SchoolPilotMigration = {
  id: "classpilot-schedule-profile-supervision-20260905",
  checksum: createHash("sha256").update(CLASSPILOT_SCHEDULE_PROFILE_SUPERVISION_SQL).digest("hex"),
  mode: "transactional",
  apply: async (connection) => { await connection.query(CLASSPILOT_SCHEDULE_PROFILE_SUPERVISION_SQL); },
};
