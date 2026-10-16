import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

// Additive presentation-only column on an already RLS-covered table. The
// constraint lookup is table-scoped so a per-schema fixture is not fooled by a
// same-named constraint elsewhere in the database.
export const CLASSPILOT_DASHBOARD_THEME_SQL = `
ALTER TABLE classpilot_teacher_preferences ADD COLUMN IF NOT EXISTS dashboard_theme JSONB;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='classpilot_teacher_preferences_dashboard_theme_object'
    AND conrelid='classpilot_teacher_preferences'::regclass) THEN
    ALTER TABLE classpilot_teacher_preferences ADD CONSTRAINT classpilot_teacher_preferences_dashboard_theme_object
      CHECK (dashboard_theme IS NULL OR jsonb_typeof(dashboard_theme)='object');
  END IF;
END $$;
`;

export const classpilotDashboardThemeMigration: SchoolPilotMigration = {
  id: "classpilot-dashboard-theme-20261016",
  checksum: createHash("sha256").update(CLASSPILOT_DASHBOARD_THEME_SQL).digest("hex"),
  mode: "transactional",
  apply: async connection => { await connection.query(CLASSPILOT_DASHBOARD_THEME_SQL); },
};
