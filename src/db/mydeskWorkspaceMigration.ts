import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

export const MYDESK_WORKSPACE_SQL = `
CREATE TABLE IF NOT EXISTS mydesk_preferences (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id TEXT NOT NULL REFERENCES schools(id), author_id VARCHAR NOT NULL REFERENCES users(id),
  preferred_classes JSONB NOT NULL DEFAULT '{}'::jsonb,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mydesk_preferences_bounds CHECK(revision>0 AND jsonb_typeof(preferred_classes)='object' AND octet_length(preferred_classes::text)<=8192)
);
CREATE UNIQUE INDEX IF NOT EXISTS mydesk_preferences_owner ON mydesk_preferences(school_id,author_id);
CREATE OR REPLACE FUNCTION check_mydesk_preferences_author_school() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM school_memberships WHERE school_id=NEW.school_id AND user_id=NEW.author_id) THEN
    RAISE EXCEPTION 'My Desk preference author must belong to the same school' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mydesk_preferences_author_school ON mydesk_preferences;
CREATE TRIGGER mydesk_preferences_author_school BEFORE INSERT OR UPDATE OF school_id,author_id ON mydesk_preferences
  FOR EACH ROW EXECUTE FUNCTION check_mydesk_preferences_author_school();
ALTER TABLE mydesk_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE mydesk_preferences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mydesk_preferences;
CREATE POLICY tenant_isolation ON mydesk_preferences
  USING(school_id=current_setting('app.school_id',true) OR current_setting('app.is_super',true)='on')
  WITH CHECK(school_id=current_setting('app.school_id',true) OR current_setting('app.is_super',true)='on');
ALTER TABLE mydesk_imports ADD COLUMN IF NOT EXISTS preferences_snapshot JSONB NOT NULL DEFAULT '{"revision":0,"preferredClasses":{}}'::jsonb;
ALTER TABLE mydesk_imports ADD COLUMN IF NOT EXISTS source_note_id VARCHAR;
ALTER TABLE mydesk_imports ADD COLUMN IF NOT EXISTS source_attachment_id VARCHAR;
ALTER TABLE mydesk_imports DROP CONSTRAINT IF EXISTS mydesk_imports_workspace_snapshot;
ALTER TABLE mydesk_imports ADD CONSTRAINT mydesk_imports_workspace_snapshot CHECK(
  jsonb_typeof(preferences_snapshot)='object' AND octet_length(preferences_snapshot::text)<=12288
  AND ((source_note_id IS NULL)=(source_attachment_id IS NULL))
  AND (source_note_id IS NULL OR char_length(source_note_id) BETWEEN 1 AND 128)
  AND (source_attachment_id IS NULL OR char_length(source_attachment_id) BETWEEN 1 AND 128)
);
`;
export const mydeskWorkspaceMigration: SchoolPilotMigration = {
  id: "mydesk-workspace-expansion-20260926", checksum: createHash("sha256").update(MYDESK_WORKSPACE_SQL).digest("hex"),
  mode: "transactional", apply: async connection => { await connection.query(MYDESK_WORKSPACE_SQL); },
};
