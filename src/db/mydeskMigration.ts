import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

export const MYDESK_SQL = `
CREATE TABLE IF NOT EXISTS mydesk_notes (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id TEXT NOT NULL REFERENCES schools(id),
  author_id VARCHAR NOT NULL REFERENCES users(id),
  client_request_id UUID NOT NULL,
  request_fingerprint TEXT NOT NULL CONSTRAINT mydesk_notes_fingerprint CHECK(request_fingerprint ~ '^[0-9a-f]{64}$'),
  target_kind TEXT NOT NULL DEFAULT 'general' CONSTRAINT mydesk_notes_target_kind CHECK(target_kind IN ('general','class','student')),
  group_id VARCHAR, filing_group_id VARCHAR, group_name TEXT,
  student_id VARCHAR, filing_student_id VARCHAR, student_name TEXT,
  category TEXT NOT NULL DEFAULT 'note' CONSTRAINT mydesk_notes_category CHECK(category ~ '^[a-z][a-z0-9_]{0,31}$'),
  title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', entry_date DATE NOT NULL,
  pinned BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'pending' CONSTRAINT mydesk_notes_status CHECK(status IN ('pending','active','deleted')),
  revision INTEGER NOT NULL DEFAULT 1 CONSTRAINT mydesk_notes_revision CHECK(revision > 0),
  expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), deleted_at TIMESTAMPTZ,
  CONSTRAINT mydesk_notes_target_shape CHECK (
    (target_kind='general' AND filing_group_id IS NULL AND filing_student_id IS NULL AND group_id IS NULL AND student_id IS NULL)
    OR (target_kind='class' AND filing_group_id IS NOT NULL AND group_name IS NOT NULL AND filing_student_id IS NULL AND student_id IS NULL)
    OR (target_kind='student' AND filing_group_id IS NOT NULL AND group_name IS NOT NULL AND filing_student_id IS NOT NULL AND student_name IS NOT NULL)),
  CONSTRAINT mydesk_notes_group_fk FOREIGN KEY(school_id,group_id) REFERENCES groups(school_id,id) ON DELETE SET NULL (group_id),
  CONSTRAINT mydesk_notes_student_fk FOREIGN KEY(school_id,student_id) REFERENCES students(school_id,id) ON DELETE SET NULL (student_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS mydesk_notes_school_id ON mydesk_notes(school_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS mydesk_notes_owner_id ON mydesk_notes(school_id,author_id,id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='mydesk_notes'::regclass AND conname='mydesk_notes_owner_id') THEN
    ALTER TABLE mydesk_notes ADD CONSTRAINT mydesk_notes_owner_id UNIQUE USING INDEX mydesk_notes_owner_id;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS mydesk_notes_request ON mydesk_notes(school_id,author_id,client_request_id);
CREATE INDEX IF NOT EXISTS mydesk_notes_page ON mydesk_notes(school_id,author_id,pinned,entry_date DESC,created_at DESC,id) WHERE status='active';
CREATE INDEX IF NOT EXISTS mydesk_notes_class_page ON mydesk_notes(school_id,author_id,filing_group_id,entry_date DESC,id) WHERE status='active';
CREATE INDEX IF NOT EXISTS mydesk_notes_student_page ON mydesk_notes(school_id,author_id,filing_student_id,entry_date DESC,id) WHERE status='active';
CREATE INDEX IF NOT EXISTS mydesk_notes_pending_expiry ON mydesk_notes(expires_at,id) WHERE status='pending';

-- The bootstrap Drizzle schema cannot express column-list SET NULL. Reconcile
-- its NO ACTION constraints as well as databases created directly by this SQL.
ALTER TABLE mydesk_notes DROP CONSTRAINT IF EXISTS mydesk_notes_group_fk;
ALTER TABLE mydesk_notes ADD CONSTRAINT mydesk_notes_group_fk
  FOREIGN KEY(school_id,group_id) REFERENCES groups(school_id,id) ON DELETE SET NULL (group_id);
ALTER TABLE mydesk_notes DROP CONSTRAINT IF EXISTS mydesk_notes_student_fk;
ALTER TABLE mydesk_notes ADD CONSTRAINT mydesk_notes_student_fk
  FOREIGN KEY(school_id,student_id) REFERENCES students(school_id,id) ON DELETE SET NULL (student_id);

CREATE TABLE IF NOT EXISTS mydesk_attachments (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id TEXT NOT NULL REFERENCES schools(id),
  author_id VARCHAR NOT NULL REFERENCES users(id),
  note_id VARCHAR NOT NULL, client_request_id UUID NOT NULL, storage_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CONSTRAINT mydesk_attachments_fingerprint CHECK(request_fingerprint ~ '^[0-9a-f]{64}$'),
  original_filename TEXT NOT NULL DEFAULT '',
  content_type TEXT CONSTRAINT mydesk_attachments_content_type CHECK(content_type IN ('image/jpeg','image/png','image/webp','application/pdf')),
  input_sha256 TEXT CONSTRAINT mydesk_attachments_input_hash CHECK(input_sha256 ~ '^[0-9a-f]{64}$'),
  sha256 TEXT CONSTRAINT mydesk_attachments_hash CHECK(sha256 ~ '^[0-9a-f]{64}$'),
  byte_size INTEGER CONSTRAINT mydesk_attachments_size CHECK(byte_size BETWEEN 1 AND 10485760),
  committed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending' CONSTRAINT mydesk_attachments_status CHECK(status IN ('pending','uploading','ready','delete_pending','deleted')),
  upload_lease_id UUID, upload_lease_until TIMESTAMPTZ, next_cleanup_at TIMESTAMPTZ,
  cleanup_attempts INTEGER NOT NULL DEFAULT 0 CONSTRAINT mydesk_attachments_attempts CHECK(cleanup_attempts >= 0), last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), deleted_at TIMESTAMPTZ,
  CONSTRAINT mydesk_attachments_ready CHECK(status <> 'ready' OR (content_type IS NOT NULL AND byte_size IS NOT NULL AND sha256 IS NOT NULL AND input_sha256 IS NOT NULL)),
  CONSTRAINT mydesk_attachments_owner_note_fk FOREIGN KEY(school_id,author_id,note_id) REFERENCES mydesk_notes(school_id,author_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS mydesk_attachments_school_id ON mydesk_attachments(school_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS mydesk_attachments_request ON mydesk_attachments(school_id,author_id,note_id,client_request_id);
CREATE UNIQUE INDEX IF NOT EXISTS mydesk_attachments_storage_key ON mydesk_attachments(storage_key);
CREATE INDEX IF NOT EXISTS mydesk_attachments_note ON mydesk_attachments(school_id,author_id,note_id,created_at,id);
CREATE INDEX IF NOT EXISTS mydesk_attachments_cleanup ON mydesk_attachments(next_cleanup_at,id) WHERE status IN ('delete_pending','deleted');
CREATE INDEX IF NOT EXISTS mydesk_attachments_upload_lease ON mydesk_attachments(upload_lease_until,id) WHERE status='uploading';
CREATE INDEX IF NOT EXISTS mydesk_attachments_staged_expiry ON mydesk_attachments(created_at,id) WHERE committed_at IS NULL AND status IN ('pending','uploading','ready');

CREATE OR REPLACE FUNCTION check_mydesk_author_school() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM school_memberships WHERE school_id=NEW.school_id AND user_id=NEW.author_id) THEN
    RAISE EXCEPTION 'My Desk author must belong to the same school' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mydesk_notes_author_school ON mydesk_notes;
CREATE TRIGGER mydesk_notes_author_school BEFORE INSERT OR UPDATE OF school_id,author_id ON mydesk_notes
  FOR EACH ROW EXECUTE FUNCTION check_mydesk_author_school();

ALTER TABLE mydesk_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE mydesk_notes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mydesk_notes;
CREATE POLICY tenant_isolation ON mydesk_notes
  USING (school_id = current_setting('app.school_id', true) OR current_setting('app.is_super', true) = 'on')
  WITH CHECK (school_id = current_setting('app.school_id', true) OR current_setting('app.is_super', true) = 'on');
ALTER TABLE mydesk_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE mydesk_attachments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mydesk_attachments;
CREATE POLICY tenant_isolation ON mydesk_attachments
  USING (school_id = current_setting('app.school_id', true) OR current_setting('app.is_super', true) = 'on')
  WITH CHECK (school_id = current_setting('app.school_id', true) OR current_setting('app.is_super', true) = 'on');
`;

export const mydeskMigration: SchoolPilotMigration = {
  id: "mydesk-private-notebook-20260925",
  checksum: createHash("sha256").update(MYDESK_SQL).digest("hex"),
  mode: "transactional",
  apply: async connection => { await connection.query(MYDESK_SQL); },
};
