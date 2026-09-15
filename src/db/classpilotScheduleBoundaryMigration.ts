import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

/** Queue metadata is independent of the scheduling document's optimistic revision. */
export const CLASSPILOT_SCHEDULE_BOUNDARY_SQL = `
ALTER TABLE classpilot_school_schedules
  ADD COLUMN IF NOT EXISTS next_boundary_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS boundary_generation INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS boundary_lease_owner TEXT,
  ADD COLUMN IF NOT EXISTS boundary_lease_until TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS cp_schedule_next_boundary_idx
  ON classpilot_school_schedules(next_boundary_at) WHERE next_boundary_at IS NOT NULL;

INSERT INTO classpilot_school_schedules(school_id, config)
  SELECT id, '{}'::jsonb FROM schools WHERE deleted_at IS NULL
  ON CONFLICT (school_id) DO NOTHING;

CREATE OR REPLACE FUNCTION cp_wake_schedule_boundary() RETURNS trigger AS $$
DECLARE scope_id text;
BEGIN
  IF TG_TABLE_NAME = 'schools' THEN
    scope_id := COALESCE(NEW.id, OLD.id);
  ELSIF TG_TABLE_NAME = 'group_teachers' THEN
    SELECT school_id INTO scope_id FROM groups WHERE id = COALESCE(NEW.group_id, OLD.group_id);
  ELSE
    scope_id := COALESCE(NEW.school_id, OLD.school_id);
  END IF;
  UPDATE classpilot_school_schedules
    SET next_boundary_at = now(), boundary_generation = boundary_generation + 1
    WHERE school_id = scope_id;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;

-- Do not trigger on queue lease writes, or the worker would wake itself forever.
DROP TRIGGER IF EXISTS cp_schedule_document_boundary_wake ON classpilot_school_schedules;
CREATE TRIGGER cp_schedule_document_boundary_wake AFTER UPDATE OF config, profile_activation_outcomes
  ON classpilot_school_schedules FOR EACH ROW
  WHEN (OLD.config IS DISTINCT FROM NEW.config OR OLD.profile_activation_outcomes IS DISTINCT FROM NEW.profile_activation_outcomes)
  EXECUTE FUNCTION cp_wake_schedule_boundary();

DROP TRIGGER IF EXISTS cp_groups_boundary_wake ON groups;
CREATE TRIGGER cp_groups_boundary_wake AFTER INSERT OR UPDATE OR DELETE ON groups
  FOR EACH ROW EXECUTE FUNCTION cp_wake_schedule_boundary();
DROP TRIGGER IF EXISTS cp_group_teachers_boundary_wake ON group_teachers;
CREATE TRIGGER cp_group_teachers_boundary_wake AFTER INSERT OR UPDATE OR DELETE ON group_teachers
  FOR EACH ROW EXECUTE FUNCTION cp_wake_schedule_boundary();
DROP TRIGGER IF EXISTS cp_settings_boundary_wake ON settings;
CREATE TRIGGER cp_settings_boundary_wake AFTER INSERT OR UPDATE ON settings
  FOR EACH ROW EXECUTE FUNCTION cp_wake_schedule_boundary();
DROP TRIGGER IF EXISTS cp_school_boundary_wake ON schools;
CREATE TRIGGER cp_school_boundary_wake AFTER UPDATE OF school_timezone, status, is_active, active_until, disabled_at, deleted_at, plan_status ON schools
  FOR EACH ROW EXECUTE FUNCTION cp_wake_schedule_boundary();
DROP TRIGGER IF EXISTS cp_schedule_change_boundary_wake ON classpilot_schedule_changes;
CREATE TRIGGER cp_schedule_change_boundary_wake AFTER INSERT OR UPDATE OR DELETE ON classpilot_schedule_changes
  FOR EACH ROW EXECUTE FUNCTION cp_wake_schedule_boundary();
DROP TRIGGER IF EXISTS cp_supervision_boundary_wake ON classpilot_supervision_contexts;
CREATE TRIGGER cp_supervision_boundary_wake AFTER INSERT OR UPDATE OR DELETE ON classpilot_supervision_contexts
  FOR EACH ROW EXECUTE FUNCTION cp_wake_schedule_boundary();
DROP TRIGGER IF EXISTS cp_session_boundary_wake ON teaching_sessions;
CREATE TRIGGER cp_session_boundary_wake AFTER INSERT OR UPDATE OF end_time, scheduled_start_at, scheduled_end_at, session_mode, scheduled_state ON teaching_sessions
  FOR EACH ROW EXECUTE FUNCTION cp_wake_schedule_boundary();
DROP TRIGGER IF EXISTS cp_license_boundary_wake ON product_licenses;
CREATE TRIGGER cp_license_boundary_wake AFTER INSERT OR UPDATE OR DELETE ON product_licenses
  FOR EACH ROW EXECUTE FUNCTION cp_wake_schedule_boundary();
`;

export const classpilotScheduleBoundaryMigration: SchoolPilotMigration = {
  id: "classpilot-schedule-boundaries-20260915",
  checksum: createHash("sha256").update(CLASSPILOT_SCHEDULE_BOUNDARY_SQL).digest("hex"),
  mode: "transactional",
  apply: async (connection) => { await connection.query(CLASSPILOT_SCHEDULE_BOUNDARY_SQL); },
};
