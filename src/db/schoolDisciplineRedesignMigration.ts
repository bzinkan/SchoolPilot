import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

export const SCHOOL_DISCIPLINE_REDESIGN_SQL = `
ALTER TABLE school_discipline_records ALTER COLUMN source_note_id DROP NOT NULL;
ALTER TABLE school_discipline_records ADD COLUMN IF NOT EXISTS draft_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE school_discipline_records ADD COLUMN IF NOT EXISTS draft_receipts JSONB NOT NULL DEFAULT '[]';
ALTER TABLE school_discipline_records DROP CONSTRAINT IF EXISTS school_discipline_records_draft;
ALTER TABLE school_discipline_records ADD CONSTRAINT school_discipline_records_draft CHECK(draft_revision>0 AND jsonb_typeof(draft_receipts)='array' AND jsonb_array_length(draft_receipts)<=100);
ALTER TABLE school_discipline_versions ADD COLUMN IF NOT EXISTS created_by VARCHAR;
CREATE INDEX IF NOT EXISTS school_discipline_versions_student_date ON school_discipline_versions(school_id,(snapshot->>'studentId'),(snapshot->>'entryDate'),record_id) WHERE state='published';
CREATE INDEX IF NOT EXISTS school_discipline_records_source_note ON school_discipline_records(school_id,source_note_id) WHERE source_note_id IS NOT NULL;
ALTER TABLE school_discipline_attachments ADD COLUMN IF NOT EXISTS client_request_id UUID;
ALTER TABLE school_discipline_attachments ADD COLUMN IF NOT EXISTS input_sha256 TEXT;
ALTER TABLE school_discipline_attachments ADD COLUMN IF NOT EXISTS input_content_type TEXT;
ALTER TABLE school_discipline_attachments ADD COLUMN IF NOT EXISTS input_byte_size INTEGER;
ALTER TABLE school_discipline_attachments ADD COLUMN IF NOT EXISTS upload_lease_id UUID;
ALTER TABLE school_discipline_attachments DROP CONSTRAINT IF EXISTS school_discipline_attachments_status;
ALTER TABLE school_discipline_attachments ADD CONSTRAINT school_discipline_attachments_status CHECK(status IN ('pending','uploading','ready','committed','delete_pending','deleted'));
CREATE UNIQUE INDEX IF NOT EXISTS school_discipline_attachments_request ON school_discipline_attachments(school_id,version_id,client_request_id);
-- Existing grant rows and audit events are retained as history, never as authority.
DROP TRIGGER IF EXISTS school_discipline_membership_revoke ON school_memberships;
`;
export const schoolDisciplineRedesignMigration: SchoolPilotMigration = {
  id: "school-discipline-redesign-20260928", checksum: createHash("sha256").update(SCHOOL_DISCIPLINE_REDESIGN_SQL).digest("hex"),
  mode: "transactional", apply: async connection => { await connection.query(SCHOOL_DISCIPLINE_REDESIGN_SQL); },
};
