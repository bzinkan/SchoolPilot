import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

// A teacher's background library: an additive JSONB array column beside the
// original single-image record, which stays in place (never dropped, never
// nulled) so a rollback still finds it. The one-time backfill copies a READY
// legacy image into an otherwise empty library; reserved or uploading records
// are abandoned. The data step runs under the system tenant context, like the
// preferences backfill, because the table forces RLS. Re-running is a no-op.
export const CLASSPILOT_DASHBOARD_THEME_LIBRARY_SQL = `
ALTER TABLE classpilot_teacher_preferences ADD COLUMN IF NOT EXISTS dashboard_theme_assets JSONB NOT NULL DEFAULT '[]'::jsonb;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='classpilot_teacher_preferences_dashboard_theme_assets_array'
    AND conrelid='classpilot_teacher_preferences'::regclass) THEN
    ALTER TABLE classpilot_teacher_preferences ADD CONSTRAINT classpilot_teacher_preferences_dashboard_theme_assets_array
      CHECK (jsonb_typeof(dashboard_theme_assets)='array');
  END IF;
END $$;
DO $$
DECLARE previous_is_super TEXT;
BEGIN
  previous_is_super := current_setting('app.is_super', true);
  PERFORM set_config('app.is_super', 'on', true);
  UPDATE classpilot_teacher_preferences SET dashboard_theme_assets = jsonb_build_array(dashboard_theme_asset)
    WHERE dashboard_theme_asset IS NOT NULL AND dashboard_theme_asset->>'status' = 'ready' AND dashboard_theme_assets = '[]'::jsonb;
  PERFORM set_config('app.is_super', COALESCE(previous_is_super, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.is_super', COALESCE(previous_is_super, ''), true);
  RAISE;
END $$;
`;

export const classpilotDashboardThemeLibraryMigration: SchoolPilotMigration = {
  id: "classpilot-dashboard-theme-library-20261018",
  checksum: createHash("sha256").update(CLASSPILOT_DASHBOARD_THEME_LIBRARY_SQL).digest("hex"),
  mode: "transactional",
  apply: async connection => { await connection.query(CLASSPILOT_DASHBOARD_THEME_LIBRARY_SQL); },
};
