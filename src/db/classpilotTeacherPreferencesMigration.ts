import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

// Bootstrap is schema-only. Never repeat the account-wide backfill at startup:
// memberships created after this release must start with school inheritance.
export const CLASSPILOT_TEACHER_PREFERENCES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS classpilot_teacher_preferences (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id TEXT NOT NULL REFERENCES schools(id),
  teacher_id TEXT NOT NULL REFERENCES users(id),
  max_tabs_per_student INTEGER,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT classpilot_teacher_preferences_bounds CHECK (
    revision > 0 AND (max_tabs_per_student IS NULL OR max_tabs_per_student BETWEEN 1 AND 100)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS classpilot_teacher_preferences_owner
  ON classpilot_teacher_preferences(school_id, teacher_id);
CREATE OR REPLACE FUNCTION check_classpilot_teacher_preferences_school() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM school_memberships WHERE school_id=NEW.school_id AND user_id=NEW.teacher_id) THEN
    RAISE EXCEPTION 'Teacher preference owner must belong to the same school' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS classpilot_teacher_preferences_school ON classpilot_teacher_preferences;
CREATE TRIGGER classpilot_teacher_preferences_school BEFORE INSERT OR UPDATE OF school_id,teacher_id
  ON classpilot_teacher_preferences FOR EACH ROW EXECUTE FUNCTION check_classpilot_teacher_preferences_school();
ALTER TABLE classpilot_teacher_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE classpilot_teacher_preferences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON classpilot_teacher_preferences;
CREATE POLICY tenant_isolation ON classpilot_teacher_preferences
  USING(school_id=current_setting('app.school_id',true) OR current_setting('app.is_super',true)='on')
  WITH CHECK(school_id=current_setting('app.school_id',true) OR current_setting('app.is_super',true)='on');
`;

// This block runs once under the checksum ledger. Restore the caller's system
// context even on failure; only this one migration intentionally spans schools.
export const CLASSPILOT_TEACHER_PREFERENCES_BACKFILL_SQL = `
DO $$
DECLARE previous_is_super TEXT; copied_count INTEGER; inherited_count INTEGER;
BEGIN
  previous_is_super := current_setting('app.is_super', true);
  PERFORM set_config('app.is_super', 'on', true);
  WITH eligible AS (
    SELECT DISTINCT m.school_id, m.user_id
    FROM school_memberships m
    JOIN schools s ON s.id=m.school_id
    JOIN users u ON u.id=m.user_id
    WHERE m.status='active' AND m.role IN ('teacher','admin','school_admin')
      AND s.status = 'active' AND s.is_active = true AND s.disabled_at IS NULL
      AND s.deleted_at IS NULL AND s.plan_status <> 'canceled'
      AND (s.active_until IS NULL OR s.active_until > now())
      AND EXISTS (SELECT 1 FROM product_licenses p WHERE p.school_id=m.school_id
        AND p.product='CLASSPILOT' AND p.status='active' AND (p.expires_at IS NULL OR p.expires_at > now()))
  ), inserted AS (
    INSERT INTO classpilot_teacher_preferences(school_id,teacher_id,max_tabs_per_student)
    SELECT e.school_id,e.user_id,
      CASE WHEN btrim(t.max_tabs_per_student) ~ '^[0-9]{1,3}$' THEN
        CASE WHEN btrim(t.max_tabs_per_student)::integer BETWEEN 1 AND 100
          THEN btrim(t.max_tabs_per_student)::integer ELSE NULL END
        ELSE NULL END
    FROM eligible e LEFT JOIN teacher_settings t ON t.teacher_id=e.user_id
    ON CONFLICT(school_id,teacher_id) DO NOTHING
    RETURNING max_tabs_per_student
  )
  SELECT count(*) FILTER (WHERE max_tabs_per_student IS NOT NULL),
    count(*) FILTER (WHERE max_tabs_per_student IS NULL)
    INTO copied_count,inherited_count FROM inserted;
  PERFORM set_config('app.is_super', COALESCE(previous_is_super, ''), true);
  RAISE NOTICE 'ClassPilot preference migration: copied=%, inherited=%', copied_count,inherited_count;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.is_super', COALESCE(previous_is_super, ''), true);
  RAISE;
END $$;
`;

export const CLASSPILOT_TEACHER_PREFERENCES_SQL = CLASSPILOT_TEACHER_PREFERENCES_SCHEMA_SQL + CLASSPILOT_TEACHER_PREFERENCES_BACKFILL_SQL;
export const classpilotTeacherPreferencesMigration: SchoolPilotMigration = {
  id: "classpilot-teacher-preferences-20260927",
  checksum: createHash("sha256").update(CLASSPILOT_TEACHER_PREFERENCES_SQL).digest("hex"),
  mode: "transactional",
  apply: async connection => { await connection.query(CLASSPILOT_TEACHER_PREFERENCES_SQL); },
};
