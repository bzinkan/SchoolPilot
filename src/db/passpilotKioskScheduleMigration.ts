import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

export const PASSPILOT_KIOSK_SCHEDULE_SQL = `
CREATE TABLE IF NOT EXISTS passpilot_teacher_kiosk_settings (
  school_id TEXT NOT NULL REFERENCES schools(id),
  teacher_id TEXT NOT NULL REFERENCES users(id),
  mode TEXT NOT NULL DEFAULT 'manual' CONSTRAINT pp_teacher_kiosk_mode_check CHECK (mode IN ('manual','passpilot','classpilot')),
  schedule JSONB NOT NULL DEFAULT '{"blocks":[],"exceptions":[]}'::jsonb CONSTRAINT pp_teacher_kiosk_schedule_check CHECK (jsonb_typeof(schedule) = 'object'),
  revision INTEGER NOT NULL DEFAULT 0 CONSTRAINT pp_teacher_kiosk_revision_check CHECK (revision >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_by TEXT,
  PRIMARY KEY (school_id, teacher_id)
);
ALTER TABLE passpilot_teacher_kiosk_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE passpilot_teacher_kiosk_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON passpilot_teacher_kiosk_settings;
CREATE POLICY tenant_isolation ON passpilot_teacher_kiosk_settings
  USING (school_id = current_setting('app.school_id', true) OR current_setting('app.is_super', true) = 'on')
  WITH CHECK (school_id = current_setting('app.school_id', true) OR current_setting('app.is_super', true) = 'on');
ALTER TABLE passpilot_kiosk_sessions ADD COLUMN IF NOT EXISTS override_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS override_expires_at TIMESTAMPTZ;
ALTER TABLE passes ADD COLUMN IF NOT EXISTS supervision_context_id TEXT,
  ADD COLUMN IF NOT EXISTS activity_kind TEXT, ADD COLUMN IF NOT EXISTS activity_name_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS issuing_kiosk_session_id TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='passes_activity_shape_check' AND conrelid='passes'::regclass) THEN
    ALTER TABLE passes ADD CONSTRAINT passes_activity_shape_check CHECK (
      (supervision_context_id IS NULL AND activity_kind IS NULL AND activity_name_snapshot IS NULL)
      OR (supervision_context_id IS NOT NULL AND activity_kind IS NOT NULL AND activity_kind IN ('testing','coverage')
        AND activity_name_snapshot IS NOT NULL AND grade_id IS NULL AND classpilot_group_id IS NULL));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS passes_kiosk_teacher_active_idx ON passes(school_id,teacher_id)
  WHERE status='active' AND issued_via='kiosk';
CREATE OR REPLACE FUNCTION check_passpilot_kiosk_activity_parent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.supervision_context_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM classpilot_supervision_contexts WHERE id=NEW.supervision_context_id AND school_id=NEW.school_id
  ) THEN RAISE EXCEPTION 'Pass activity must belong to the same school' USING ERRCODE='23514'; END IF;
  IF NEW.issuing_kiosk_session_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM passpilot_kiosk_sessions WHERE id=NEW.issuing_kiosk_session_id AND school_id=NEW.school_id
  ) THEN RAISE EXCEPTION 'Pass kiosk must belong to the same school' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS passes_kiosk_activity_parent ON passes;
CREATE TRIGGER passes_kiosk_activity_parent BEFORE INSERT OR UPDATE OF school_id,supervision_context_id,issuing_kiosk_session_id
  ON passes FOR EACH ROW EXECUTE FUNCTION check_passpilot_kiosk_activity_parent();
CREATE OR REPLACE FUNCTION check_passpilot_kiosk_teacher_school() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM school_memberships WHERE school_id=NEW.school_id AND user_id=NEW.teacher_id) THEN
    RAISE EXCEPTION 'Kiosk teacher must belong to the same school' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pp_kiosk_teacher_school ON passpilot_teacher_kiosk_settings;
CREATE TRIGGER pp_kiosk_teacher_school BEFORE INSERT OR UPDATE OF school_id,teacher_id ON passpilot_teacher_kiosk_settings
  FOR EACH ROW EXECUTE FUNCTION check_passpilot_kiosk_teacher_school();
`;
export const passpilotKioskScheduleMigration: SchoolPilotMigration = {
  id: "passpilot-kiosk-schedule-20260924",
  checksum: createHash("sha256").update(PASSPILOT_KIOSK_SCHEDULE_SQL).digest("hex"),
  mode: "transactional",
  apply: async connection => { await connection.query(PASSPILOT_KIOSK_SCHEDULE_SQL); },
};
