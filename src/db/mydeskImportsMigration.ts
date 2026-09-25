import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

export const MYDESK_IMPORTS_SQL = `
CREATE TABLE IF NOT EXISTS mydesk_imports (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(), school_id TEXT NOT NULL REFERENCES schools(id),
  author_id VARCHAR NOT NULL REFERENCES users(id), client_request_id UUID NOT NULL,
  request_fingerprint TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'uploading', revision INTEGER NOT NULL DEFAULT 1,
  expected_source_count INTEGER NOT NULL,
  selected_group_ids JSONB NOT NULL DEFAULT '[]'::jsonb, page_decisions JSONB NOT NULL DEFAULT '[]'::jsonb,
  mutation_receipts JSONB NOT NULL DEFAULT '[]'::jsonb, commit_receipt JSONB,
  expires_at TIMESTAMPTZ NOT NULL, upload_expires_at TIMESTAMPTZ NOT NULL,
  lease_id UUID, lease_until TIMESTAMPTZ, next_attempt_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0, page_count INTEGER NOT NULL DEFAULT 0, quota_date DATE, last_error_code TEXT,
  quota_usage JSONB NOT NULL DEFAULT '[]'::jsonb, model_version TEXT, prompt_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), deleted_at TIMESTAMPTZ,
  CONSTRAINT mydesk_imports_owner_id UNIQUE(school_id,author_id,id)
);
CREATE TABLE IF NOT EXISTS mydesk_import_assets (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(), school_id TEXT NOT NULL REFERENCES schools(id),
  author_id VARCHAR NOT NULL REFERENCES users(id), import_id VARCHAR NOT NULL,
  kind TEXT NOT NULL, parent_asset_id VARCHAR, page_number INTEGER,
  client_request_id UUID NOT NULL, request_fingerprint TEXT NOT NULL, storage_key TEXT NOT NULL,
  original_filename TEXT NOT NULL DEFAULT '', content_type TEXT, input_sha256 TEXT, sha256 TEXT,
  byte_size INTEGER, width INTEGER, height INTEGER, page_count INTEGER,
  status TEXT NOT NULL DEFAULT 'pending', lease_id UUID, lease_until TIMESTAMPTZ, processed_at TIMESTAMPTZ,
  next_cleanup_at TIMESTAMPTZ, cleanup_attempts INTEGER NOT NULL DEFAULT 0, last_error_code TEXT, attachment_id VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), deleted_at TIMESTAMPTZ,
  CONSTRAINT mydesk_import_assets_owner_id UNIQUE(school_id,author_id,import_id,id),
  CONSTRAINT mydesk_import_assets_run_fk FOREIGN KEY(school_id,author_id,import_id) REFERENCES mydesk_imports(school_id,author_id,id)
);
CREATE TABLE IF NOT EXISTS mydesk_import_items (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(), school_id TEXT NOT NULL REFERENCES schools(id),
  author_id VARCHAR NOT NULL REFERENCES users(id), import_id VARCHAR NOT NULL, client_request_id UUID NOT NULL,
  ordinal INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  regions JSONB NOT NULL DEFAULT '[]'::jsonb, subject_names JSONB NOT NULL DEFAULT '[]'::jsonb,
  group_id VARCHAR, student_id VARCHAR, roster_revision TEXT, category TEXT NOT NULL DEFAULT 'note',
  title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', entry_date DATE,
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb, reviewed BOOLEAN NOT NULL DEFAULT false,
  excluded BOOLEAN NOT NULL DEFAULT false, review_fingerprint TEXT, approved_asset_id VARCHAR,
  extraction_status TEXT NOT NULL DEFAULT 'pending', extract_requested BOOLEAN NOT NULL DEFAULT true, note_id VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), deleted_at TIMESTAMPTZ,
  CONSTRAINT mydesk_import_items_owner_id UNIQUE(school_id,author_id,import_id,id),
  CONSTRAINT mydesk_import_items_run_fk FOREIGN KEY(school_id,author_id,import_id) REFERENCES mydesk_imports(school_id,author_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS mydesk_imports_request ON mydesk_imports(school_id,author_id,client_request_id);
CREATE INDEX IF NOT EXISTS mydesk_imports_queue ON mydesk_imports(status,next_attempt_at,lease_until);
CREATE INDEX IF NOT EXISTS mydesk_imports_owner ON mydesk_imports(school_id,author_id,created_at);
CREATE INDEX IF NOT EXISTS mydesk_imports_quota ON mydesk_imports(school_id,quota_date);
CREATE UNIQUE INDEX IF NOT EXISTS mydesk_import_assets_request ON mydesk_import_assets(school_id,author_id,import_id,client_request_id);
CREATE UNIQUE INDEX IF NOT EXISTS mydesk_import_assets_key ON mydesk_import_assets(storage_key);
CREATE INDEX IF NOT EXISTS mydesk_import_assets_cleanup ON mydesk_import_assets(status,next_cleanup_at);
CREATE INDEX IF NOT EXISTS mydesk_import_assets_run ON mydesk_import_assets(school_id,author_id,import_id);
CREATE UNIQUE INDEX IF NOT EXISTS mydesk_import_items_request ON mydesk_import_items(school_id,author_id,import_id,client_request_id);
CREATE INDEX IF NOT EXISTS mydesk_import_items_run ON mydesk_import_items(school_id,author_id,import_id,ordinal);
ALTER TABLE mydesk_import_assets DROP CONSTRAINT IF EXISTS mydesk_import_assets_parent_fk;
ALTER TABLE mydesk_import_assets ADD CONSTRAINT mydesk_import_assets_parent_fk FOREIGN KEY(school_id,author_id,import_id,parent_asset_id) REFERENCES mydesk_import_assets(school_id,author_id,import_id,id);
ALTER TABLE mydesk_import_items DROP CONSTRAINT IF EXISTS mydesk_import_items_approved_fk;
ALTER TABLE mydesk_import_items ADD CONSTRAINT mydesk_import_items_approved_fk FOREIGN KEY(school_id,author_id,import_id,approved_asset_id) REFERENCES mydesk_import_assets(school_id,author_id,import_id,id);
-- Install checks separately so a nonproduction Drizzle bootstrap receives the canonical constraints too.
ALTER TABLE mydesk_imports DROP CONSTRAINT IF EXISTS mydesk_imports_state;
ALTER TABLE mydesk_imports ADD CONSTRAINT mydesk_imports_state CHECK(status IN ('uploading','queued','processing','review','failed','completed','cancelled','expired'));
ALTER TABLE mydesk_imports DROP CONSTRAINT IF EXISTS mydesk_imports_bounds;
ALTER TABLE mydesk_imports ADD CONSTRAINT mydesk_imports_bounds CHECK(revision>0 AND expected_source_count BETWEEN 1 AND 5 AND attempts>=0 AND page_count BETWEEN 0 AND 20 AND request_fingerprint ~ '^[0-9a-f]{64}$' AND (last_error_code IS NULL OR last_error_code ~ '^[A-Za-z0-9_]{1,64}$') AND ((lease_id IS NULL)=(lease_until IS NULL)));
ALTER TABLE mydesk_imports DROP CONSTRAINT IF EXISTS mydesk_imports_provenance;
ALTER TABLE mydesk_imports ADD CONSTRAINT mydesk_imports_provenance CHECK((model_version IS NULL OR model_version ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$') AND (prompt_version IS NULL OR prompt_version ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'));
ALTER TABLE mydesk_imports DROP CONSTRAINT IF EXISTS mydesk_imports_json;
ALTER TABLE mydesk_imports ADD CONSTRAINT mydesk_imports_json CHECK(
  CASE WHEN jsonb_typeof(selected_group_ids)='array' THEN jsonb_array_length(selected_group_ids)<=20 AND octet_length(selected_group_ids::text)<=8192 ELSE false END
  AND CASE WHEN jsonb_typeof(page_decisions)='array' THEN jsonb_array_length(page_decisions)<=20 AND octet_length(page_decisions::text)<=8192 ELSE false END
  AND CASE WHEN jsonb_typeof(mutation_receipts)='array' THEN jsonb_array_length(mutation_receipts)<=100 AND octet_length(mutation_receipts::text)<=32768 ELSE false END
  AND CASE WHEN jsonb_typeof(quota_usage)='array' THEN jsonb_array_length(quota_usage)<=8 AND octet_length(quota_usage::text)<=4096 ELSE false END
  AND (commit_receipt IS NULL OR (jsonb_typeof(commit_receipt)='object' AND octet_length(commit_receipt::text)<=16384))
);
ALTER TABLE mydesk_import_items DROP CONSTRAINT IF EXISTS mydesk_import_items_bounds;
ALTER TABLE mydesk_import_items ADD CONSTRAINT mydesk_import_items_bounds CHECK(
  ordinal BETWEEN 0 AND 49 AND revision>0 AND char_length(title)<=160 AND char_length(body)<=5000
  AND category IN ('note','detention','referral','uniform','positive','parent_contact','other')
  AND (group_id IS NULL OR char_length(group_id) BETWEEN 1 AND 128)
  AND (student_id IS NULL OR char_length(student_id) BETWEEN 1 AND 128)
  AND (roster_revision IS NULL OR roster_revision ~ '^[0-9a-f]{64}$')
  AND (review_fingerprint IS NULL OR review_fingerprint ~ '^[0-9a-f]{64}$')
  AND extraction_status IN ('pending','ready','failed')
);
ALTER TABLE mydesk_import_items DROP CONSTRAINT IF EXISTS mydesk_import_items_json;
ALTER TABLE mydesk_import_items ADD CONSTRAINT mydesk_import_items_json CHECK(
  CASE WHEN jsonb_typeof(regions)='array' THEN jsonb_array_length(regions)<=20 AND octet_length(regions::text)<=65536 ELSE false END
  AND CASE WHEN jsonb_typeof(subject_names)='array' THEN jsonb_array_length(subject_names)<=20 AND octet_length(subject_names::text)<=16384 ELSE false END
  AND CASE WHEN jsonb_typeof(warnings)='array' THEN jsonb_array_length(warnings)<=20 AND octet_length(warnings::text)<=16384 ELSE false END
);
ALTER TABLE mydesk_import_assets DROP CONSTRAINT IF EXISTS mydesk_import_assets_state;
ALTER TABLE mydesk_import_assets ADD CONSTRAINT mydesk_import_assets_state CHECK(kind IN ('source','page','approved') AND status IN ('pending','uploading','ready','promoted','delete_pending','deleted'));
ALTER TABLE mydesk_import_assets DROP CONSTRAINT IF EXISTS mydesk_import_assets_bounds;
ALTER TABLE mydesk_import_assets ADD CONSTRAINT mydesk_import_assets_bounds CHECK(
  request_fingerprint ~ '^[0-9a-f]{64}$' AND char_length(original_filename)<=255
  AND (input_sha256 IS NULL OR input_sha256 ~ '^[0-9a-f]{64}$') AND (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$')
  AND (byte_size IS NULL OR byte_size BETWEEN 1 AND 10485760)
  AND (content_type IS NULL OR content_type IN ('image/jpeg','image/png','image/webp','application/pdf'))
  AND (width IS NULL OR width BETWEEN 1 AND 4096) AND (height IS NULL OR height BETWEEN 1 AND 4096)
  AND (page_number IS NULL OR page_number BETWEEN 1 AND 20) AND (page_count IS NULL OR page_count BETWEEN 1 AND 20)
  AND cleanup_attempts>=0 AND (last_error_code IS NULL OR last_error_code ~ '^[A-Za-z0-9_]{1,64}$')
  AND ((lease_id IS NULL)=(lease_until IS NULL))
  AND (status NOT IN ('ready','promoted') OR (content_type IS NOT NULL AND byte_size IS NOT NULL AND sha256 IS NOT NULL))
  AND (status<>'promoted' OR (kind='approved' AND attachment_id IS NOT NULL AND lease_id IS NULL))
);
CREATE OR REPLACE FUNCTION check_mydesk_import_author_school() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM school_memberships WHERE school_id=NEW.school_id AND user_id=NEW.author_id) THEN
    RAISE EXCEPTION 'My Desk import author must belong to the same school' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mydesk_imports_author_school ON mydesk_imports;
CREATE TRIGGER mydesk_imports_author_school BEFORE INSERT OR UPDATE OF school_id,author_id ON mydesk_imports
  FOR EACH ROW EXECUTE FUNCTION check_mydesk_import_author_school();
ALTER TABLE mydesk_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE mydesk_imports FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mydesk_imports;
CREATE POLICY tenant_isolation ON mydesk_imports USING(school_id=current_setting('app.school_id',true) OR current_setting('app.is_super',true)='on') WITH CHECK(school_id=current_setting('app.school_id',true) OR current_setting('app.is_super',true)='on');
ALTER TABLE mydesk_import_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE mydesk_import_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mydesk_import_items;
CREATE POLICY tenant_isolation ON mydesk_import_items USING(school_id=current_setting('app.school_id',true) OR current_setting('app.is_super',true)='on') WITH CHECK(school_id=current_setting('app.school_id',true) OR current_setting('app.is_super',true)='on');
ALTER TABLE mydesk_import_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE mydesk_import_assets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mydesk_import_assets;
CREATE POLICY tenant_isolation ON mydesk_import_assets USING(school_id=current_setting('app.school_id',true) OR current_setting('app.is_super',true)='on') WITH CHECK(school_id=current_setting('app.school_id',true) OR current_setting('app.is_super',true)='on');
`;

export const mydeskImportsMigration: SchoolPilotMigration = {
  id: "mydesk-ai-imports-20260925", checksum: createHash("sha256").update(MYDESK_IMPORTS_SQL).digest("hex"),
  mode: "transactional", apply: async connection => { await connection.query(MYDESK_IMPORTS_SQL); },
};
