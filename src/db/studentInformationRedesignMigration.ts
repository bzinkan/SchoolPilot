import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

export const STUDENT_INFORMATION_REDESIGN_SQL = `
CREATE TABLE IF NOT EXISTS student_contact_profiles (
 id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(), school_id TEXT NOT NULL REFERENCES schools(id), student_id VARCHAR,
 filing_student_id VARCHAR NOT NULL, student_name TEXT NOT NULL, data JSONB NOT NULL DEFAULT '{"contacts":[]}', mutation_receipts JSONB NOT NULL DEFAULT '[]', revision INTEGER NOT NULL DEFAULT 0,
 updated_by VARCHAR NOT NULL REFERENCES users(id), updated_by_name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CONSTRAINT student_contact_profiles_school_id UNIQUE(school_id,id),
 CONSTRAINT student_contact_profiles_student_fk FOREIGN KEY(school_id,student_id) REFERENCES students(school_id,id) ON DELETE SET NULL (student_id),
 CONSTRAINT student_contact_profiles_bounds CHECK(revision>=0 AND char_length(student_name)<=500 AND octet_length(data::text)<=65536 AND jsonb_typeof(data)='object')
);
CREATE UNIQUE INDEX IF NOT EXISTS student_contact_profiles_student ON student_contact_profiles(school_id,filing_student_id);
ALTER TABLE student_contact_profiles DROP CONSTRAINT IF EXISTS student_contact_profiles_student_fk;
ALTER TABLE student_contact_profiles ADD CONSTRAINT student_contact_profiles_student_fk FOREIGN KEY(school_id,student_id) REFERENCES students(school_id,id) ON DELETE SET NULL (student_id);
CREATE TABLE IF NOT EXISTS student_contact_profile_versions (
 id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(), school_id TEXT NOT NULL REFERENCES schools(id), author_id VARCHAR NOT NULL REFERENCES users(id),
 profile_id VARCHAR NOT NULL, revision INTEGER NOT NULL, request_id UUID NOT NULL, request_fingerprint TEXT NOT NULL, data JSONB NOT NULL, changes JSONB NOT NULL,
 reason TEXT NOT NULL, author_name TEXT NOT NULL, import_id VARCHAR, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CONSTRAINT student_contact_versions_profile_fk FOREIGN KEY(school_id,profile_id) REFERENCES student_contact_profiles(school_id,id),
 CONSTRAINT student_contact_versions_bounds CHECK(revision>0 AND request_fingerprint ~ '^[0-9a-f]{64}$' AND char_length(reason) BETWEEN 1 AND 500 AND octet_length(data::text)<=65536 AND octet_length(changes::text)<=65536)
);
CREATE UNIQUE INDEX IF NOT EXISTS student_contact_versions_revision ON student_contact_profile_versions(school_id,profile_id,revision);
CREATE UNIQUE INDEX IF NOT EXISTS student_contact_versions_request ON student_contact_profile_versions(school_id,author_id,request_id);
CREATE TABLE IF NOT EXISTS student_information_imports (
 id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(), school_id TEXT NOT NULL REFERENCES schools(id), author_id VARCHAR NOT NULL REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), client_request_id UUID NOT NULL, request_fingerprint TEXT NOT NULL,
 expected_source_count INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'uploading', revision INTEGER NOT NULL DEFAULT 1,
 selected_section_ids JSONB NOT NULL DEFAULT '[]', mutation_receipts JSONB NOT NULL DEFAULT '[]', commit_receipt JSONB, quota_usage JSONB NOT NULL DEFAULT '[]',
 model_version TEXT, prompt_version TEXT, units INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, lease_id UUID, lease_until TIMESTAMPTZ, next_attempt_at TIMESTAMPTZ, last_error_code TEXT,
 upload_expires_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
 CONSTRAINT student_information_imports_owner_id UNIQUE(school_id,author_id,id),
 CONSTRAINT student_information_imports_bounds CHECK(expected_source_count BETWEEN 1 AND 5 AND revision>0 AND units BETWEEN 0 AND 20 AND attempts BETWEEN 0 AND 3 AND status IN ('uploading','queued','processing','review','failed','completed','cancelled','expired') AND request_fingerprint ~ '^[0-9a-f]{64}$' AND ((lease_id IS NULL)=(lease_until IS NULL)) AND octet_length(selected_section_ids::text)<=8192 AND octet_length(mutation_receipts::text)<=32768 AND octet_length(quota_usage::text)<=4096 AND (commit_receipt IS NULL OR octet_length(commit_receipt::text)<=131072))
);
CREATE UNIQUE INDEX IF NOT EXISTS student_information_imports_request ON student_information_imports(school_id,author_id,client_request_id);
CREATE INDEX IF NOT EXISTS student_information_imports_queue ON student_information_imports(status,next_attempt_at);
CREATE TABLE IF NOT EXISTS student_information_import_assets (
 id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(), school_id TEXT NOT NULL REFERENCES schools(id), author_id VARCHAR NOT NULL REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), import_id VARCHAR NOT NULL, parent_id VARCHAR,
 client_request_id UUID NOT NULL, request_fingerprint TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', storage_key TEXT NOT NULL,
 filename TEXT NOT NULL DEFAULT '', content_type TEXT NOT NULL, input_sha256 TEXT NOT NULL, sha256 TEXT, byte_size INTEGER NOT NULL, label TEXT NOT NULL DEFAULT '', ordinal INTEGER NOT NULL DEFAULT 0,
 units INTEGER NOT NULL DEFAULT 0, hidden BOOLEAN NOT NULL DEFAULT false, warnings JSONB NOT NULL DEFAULT '[]', stats JSONB NOT NULL DEFAULT '{"pages":0,"sheets":0,"rows":0,"columns":0,"textBytes":0}', processed_at TIMESTAMPTZ,
 lease_id UUID, lease_until TIMESTAMPTZ, next_cleanup_at TIMESTAMPTZ, cleanup_attempts INTEGER NOT NULL DEFAULT 0,
 CONSTRAINT student_information_assets_owner_id UNIQUE(school_id,author_id,import_id,id),
 CONSTRAINT student_information_assets_import_fk FOREIGN KEY(school_id,author_id,import_id) REFERENCES student_information_imports(school_id,author_id,id),
 CONSTRAINT student_information_assets_parent_fk FOREIGN KEY(school_id,author_id,import_id,parent_id) REFERENCES student_information_import_assets(school_id,author_id,import_id,id),
 CONSTRAINT student_information_assets_bounds CHECK(kind IN ('source','section') AND status IN ('pending','uploading','ready','delete_pending','deleted') AND byte_size BETWEEN 1 AND 10485760 AND units BETWEEN 0 AND 20 AND request_fingerprint ~ '^[a-f0-9]{64}$' AND input_sha256 ~ '^[a-f0-9]{64}$' AND (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$') AND char_length(filename)<=255 AND char_length(label)<=200 AND octet_length(warnings::text)<=8192 AND ((lease_id IS NULL)=(lease_until IS NULL)))
);
CREATE UNIQUE INDEX IF NOT EXISTS student_information_assets_request ON student_information_import_assets(school_id,author_id,import_id,client_request_id);
CREATE UNIQUE INDEX IF NOT EXISTS student_information_assets_key ON student_information_import_assets(storage_key);
CREATE INDEX IF NOT EXISTS student_information_assets_cleanup ON student_information_import_assets(status,next_cleanup_at);
CREATE TABLE IF NOT EXISTS student_information_import_items (
 id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(), school_id TEXT NOT NULL REFERENCES schools(id), author_id VARCHAR NOT NULL REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), import_id VARCHAR NOT NULL, ordinal INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 source_section_id VARCHAR NOT NULL, student_name TEXT NOT NULL, student_identifier TEXT, student_id VARCHAR, base_revision INTEGER NOT NULL DEFAULT 0,
 proposed JSONB NOT NULL, changes JSONB NOT NULL DEFAULT '[]', warnings JSONB NOT NULL DEFAULT '[]', reviewed BOOLEAN NOT NULL DEFAULT false, excluded BOOLEAN NOT NULL DEFAULT false, review_fingerprint TEXT,
 CONSTRAINT student_information_items_import_fk FOREIGN KEY(school_id,author_id,import_id) REFERENCES student_information_imports(school_id,author_id,id),
 CONSTRAINT student_information_items_source_fk FOREIGN KEY(school_id,author_id,import_id,source_section_id) REFERENCES student_information_import_assets(school_id,author_id,import_id,id),
 CONSTRAINT student_information_items_bounds CHECK(ordinal BETWEEN 0 AND 499 AND revision>0 AND base_revision>=0 AND char_length(student_name)<=200 AND octet_length(proposed::text)<=65536 AND octet_length(changes::text)<=65536 AND octet_length(warnings::text)<=8192)
);
CREATE INDEX IF NOT EXISTS student_information_items_import ON student_information_import_items(school_id,author_id,import_id,ordinal);
ALTER TABLE student_contact_profiles DROP CONSTRAINT IF EXISTS student_contact_profiles_json;
ALTER TABLE student_contact_profiles ADD CONSTRAINT student_contact_profiles_json CHECK(
 CASE WHEN jsonb_typeof(data->'contacts')='array' THEN jsonb_array_length(data->'contacts')<=20 ELSE false END
 AND CASE WHEN jsonb_typeof(mutation_receipts)='array' THEN jsonb_array_length(mutation_receipts)<=100 AND octet_length(mutation_receipts::text)<=32768 ELSE false END);
ALTER TABLE student_information_imports DROP CONSTRAINT IF EXISTS student_information_imports_json;
ALTER TABLE student_information_imports ADD CONSTRAINT student_information_imports_json CHECK(
 CASE WHEN jsonb_typeof(selected_section_ids)='array' THEN jsonb_array_length(selected_section_ids)<=100 ELSE false END
 AND CASE WHEN jsonb_typeof(mutation_receipts)='array' THEN jsonb_array_length(mutation_receipts)<=100 ELSE false END
 AND CASE WHEN jsonb_typeof(quota_usage)='array' THEN jsonb_array_length(quota_usage)<=8 ELSE false END
 AND (model_version IS NULL OR model_version ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$')
 AND (prompt_version IS NULL OR prompt_version ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'));
CREATE OR REPLACE FUNCTION reject_student_contact_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION 'Student contact history is immutable' USING ERRCODE='23514'; END $$;
DROP TRIGGER IF EXISTS student_contact_history_immutable ON student_contact_profile_versions;
CREATE TRIGGER student_contact_history_immutable BEFORE UPDATE OR DELETE ON student_contact_profile_versions FOR EACH ROW EXECUTE FUNCTION reject_student_contact_history_mutation();
DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['student_contact_profiles','student_contact_profile_versions','student_information_imports','student_information_import_items','student_information_import_assets'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(school_id=current_setting(''app.school_id'',true) OR current_setting(''app.is_super'',true)=''on'') WITH CHECK(school_id=current_setting(''app.school_id'',true) OR current_setting(''app.is_super'',true)=''on'')',t);
 END LOOP;
END $$;
`;
export const studentInformationRedesignMigration: SchoolPilotMigration = {
  id: "student-information-redesign-20260928",
  checksum: createHash("sha256")
    .update(STUDENT_INFORMATION_REDESIGN_SQL)
    .digest("hex"),
  mode: "transactional",
  apply: async (connection) => {
    await connection.query(STUDENT_INFORMATION_REDESIGN_SQL);
  },
};
