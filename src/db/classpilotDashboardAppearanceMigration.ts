import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

// Additive presentation-only columns on two already RLS-covered tables: the
// school's appearance governance and one background image record per teacher.
// Constraint lookups are table-scoped so a per-schema fixture is not fooled by
// a same-named constraint elsewhere in the database.
export const CLASSPILOT_DASHBOARD_APPEARANCE_SQL = `
ALTER TABLE settings ADD COLUMN IF NOT EXISTS appearance JSONB;
ALTER TABLE classpilot_teacher_preferences ADD COLUMN IF NOT EXISTS dashboard_theme_asset JSONB;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='settings_cp_appearance_object_check'
    AND conrelid='settings'::regclass) THEN
    ALTER TABLE settings ADD CONSTRAINT settings_cp_appearance_object_check
      CHECK (appearance IS NULL OR jsonb_typeof(appearance)='object');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='classpilot_teacher_preferences_dashboard_theme_asset_object'
    AND conrelid='classpilot_teacher_preferences'::regclass) THEN
    ALTER TABLE classpilot_teacher_preferences ADD CONSTRAINT classpilot_teacher_preferences_dashboard_theme_asset_object
      CHECK (dashboard_theme_asset IS NULL OR jsonb_typeof(dashboard_theme_asset)='object');
  END IF;
END $$;
`;

export const classpilotDashboardAppearanceMigration: SchoolPilotMigration = {
  id: "classpilot-dashboard-appearance-20261016",
  checksum: createHash("sha256").update(CLASSPILOT_DASHBOARD_APPEARANCE_SQL).digest("hex"),
  mode: "transactional",
  apply: async connection => { await connection.query(CLASSPILOT_DASHBOARD_APPEARANCE_SQL); },
};
