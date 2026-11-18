import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

export const CLASSPILOT_APPS_SQL = `
SET LOCAL lock_timeout = '10s';
CREATE TABLE IF NOT EXISTS classpilot_app_buttons (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id TEXT NOT NULL REFERENCES schools(id),
  owner_teacher_id TEXT REFERENCES users(id),
  scope TEXT NOT NULL,
  name TEXT NOT NULL,
  launch_url TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT classpilot_app_buttons_scope_check CHECK (
    (scope = 'personal' AND owner_teacher_id IS NOT NULL)
    OR (scope = 'school' AND owner_teacher_id IS NULL)
  ),
  CONSTRAINT classpilot_app_buttons_name_check CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT classpilot_app_buttons_launch_url_check CHECK (char_length(launch_url) BETWEEN 1 AND 4096),
  CONSTRAINT classpilot_app_buttons_revision_check CHECK (revision > 0)
);
ALTER TABLE classpilot_app_buttons ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='classpilot_app_buttons'::regclass AND conname='classpilot_app_buttons_revision_check') THEN
    ALTER TABLE classpilot_app_buttons ADD CONSTRAINT classpilot_app_buttons_revision_check CHECK (revision > 0);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS classpilot_app_buttons_school_owner_idx
  ON classpilot_app_buttons(school_id,owner_teacher_id);
CREATE TABLE IF NOT EXISTS classpilot_app_button_preferences (
  school_id TEXT NOT NULL REFERENCES schools(id),
  teacher_id TEXT NOT NULL REFERENCES users(id),
  app_key TEXT NOT NULL,
  saved BOOLEAN NOT NULL DEFAULT false,
  favorite BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(school_id,teacher_id,app_key),
  CONSTRAINT classpilot_app_button_preferences_favorite_check CHECK (NOT favorite OR saved)
);
ALTER TABLE classpilot_app_buttons ENABLE ROW LEVEL SECURITY;
ALTER TABLE classpilot_app_buttons FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON classpilot_app_buttons;
CREATE POLICY tenant_isolation ON classpilot_app_buttons
  USING (school_id = current_setting('app.school_id',true) OR current_setting('app.is_super',true) = 'on')
  WITH CHECK (school_id = current_setting('app.school_id',true) OR current_setting('app.is_super',true) = 'on');
ALTER TABLE classpilot_app_button_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE classpilot_app_button_preferences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON classpilot_app_button_preferences;
CREATE POLICY tenant_isolation ON classpilot_app_button_preferences
  USING (school_id = current_setting('app.school_id',true) OR current_setting('app.is_super',true) = 'on')
  WITH CHECK (school_id = current_setting('app.school_id',true) OR current_setting('app.is_super',true) = 'on');
`;

export const classpilotAppsMigration: SchoolPilotMigration = {
  id: "classpilot-apps-20261118",
  checksum: createHash("sha256").update(CLASSPILOT_APPS_SQL).digest("hex"),
  mode: "transactional",
  apply: async connection => { await connection.query(CLASSPILOT_APPS_SQL); },
};
