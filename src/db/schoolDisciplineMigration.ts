import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

export const SCHOOL_DISCIPLINE_SQL = `
CREATE TABLE IF NOT EXISTS school_discipline_records (
 id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(), school_id TEXT NOT NULL REFERENCES schools(id),
 submitted_by VARCHAR NOT NULL REFERENCES users(id), submitted_by_name TEXT NOT NULL,
 client_request_id UUID NOT NULL, request_fingerprint TEXT NOT NULL, source_note_id VARCHAR NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CONSTRAINT school_discipline_records_status CHECK(status IN ('pending','submitted','withdrawn','abandoned')),
 revision INTEGER NOT NULL DEFAULT 0 CONSTRAINT school_discipline_records_revision CHECK(revision>=0), current_version_id VARCHAR,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CONSTRAINT school_discipline_records_school_id UNIQUE(school_id,id),
 CONSTRAINT school_discipline_records_request UNIQUE(school_id,submitted_by,client_request_id)
);
CREATE INDEX IF NOT EXISTS school_discipline_records_owner_page ON school_discipline_records(school_id,submitted_by,created_at DESC,id);
CREATE INDEX IF NOT EXISTS school_discipline_records_school_page ON school_discipline_records(school_id,created_at DESC,id);
CREATE TABLE IF NOT EXISTS school_discipline_versions (
 id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(), school_id TEXT NOT NULL,record_id VARCHAR NOT NULL,
 number INTEGER NOT NULL CONSTRAINT school_discipline_versions_number CHECK(number>0),
 kind TEXT NOT NULL CONSTRAINT school_discipline_versions_kind CHECK(kind IN ('submission','correction','withdrawal')),
 state TEXT NOT NULL DEFAULT 'preparing' CONSTRAINT school_discipline_versions_state CHECK(state IN ('preparing','published','abandoned')),
 client_request_id UUID NOT NULL,request_fingerprint TEXT NOT NULL,reason TEXT,snapshot JSONB NOT NULL,
 source_note_id VARCHAR,source_note_revision INTEGER,source_fingerprint TEXT,lease_id UUID,lease_until TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),published_at TIMESTAMPTZ,
 CONSTRAINT school_discipline_versions_snapshot CHECK(jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=20000),
 CONSTRAINT school_discipline_versions_school_id UNIQUE(school_id,id),
 CONSTRAINT school_discipline_versions_request UNIQUE(school_id,record_id,client_request_id),
 CONSTRAINT school_discipline_versions_parent FOREIGN KEY(school_id,record_id) REFERENCES school_discipline_records(school_id,id)
);
CREATE INDEX IF NOT EXISTS school_discipline_versions_record ON school_discipline_versions(school_id,record_id,number);
CREATE UNIQUE INDEX IF NOT EXISTS school_discipline_versions_published_number ON school_discipline_versions(school_id,record_id,number) WHERE state='published';
CREATE TABLE IF NOT EXISTS school_discipline_attachments (
 id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),school_id TEXT NOT NULL,version_id VARCHAR NOT NULL,
 storage_key TEXT NOT NULL CONSTRAINT school_discipline_attachments_key UNIQUE,source_storage_key TEXT,source_attachment_id VARCHAR,
 filename TEXT NOT NULL DEFAULT '',content_type TEXT NOT NULL,byte_size INTEGER NOT NULL,sha256 TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CONSTRAINT school_discipline_attachments_status CHECK(status IN ('pending','ready','committed','delete_pending','deleted')),
 lease_until TIMESTAMPTZ,next_cleanup_at TIMESTAMPTZ,cleanup_attempts INTEGER NOT NULL DEFAULT 0,last_error_code TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CONSTRAINT school_discipline_attachments_size CHECK(byte_size>0 AND byte_size<=10485760),
 CONSTRAINT school_discipline_attachments_hash CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 CONSTRAINT school_discipline_attachments_parent FOREIGN KEY(school_id,version_id) REFERENCES school_discipline_versions(school_id,id)
);
CREATE INDEX IF NOT EXISTS school_discipline_attachments_version ON school_discipline_attachments(school_id,version_id);
CREATE INDEX IF NOT EXISTS school_discipline_attachments_cleanup ON school_discipline_attachments(status,next_cleanup_at);
CREATE TABLE IF NOT EXISTS school_discipline_access (
 id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),school_id TEXT NOT NULL REFERENCES schools(id),user_id VARCHAR NOT NULL REFERENCES users(id),
 enabled BOOLEAN NOT NULL DEFAULT false,revision INTEGER NOT NULL DEFAULT 0,updated_by VARCHAR,
 mutation_receipts JSONB NOT NULL DEFAULT '[]',updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CONSTRAINT school_discipline_access_owner UNIQUE(school_id,user_id),
 CONSTRAINT school_discipline_access_revision CHECK(revision>=0),
 CONSTRAINT school_discipline_access_receipts CHECK(jsonb_typeof(mutation_receipts)='array' AND jsonb_array_length(mutation_receipts)<=100)
);
-- Published school records are independent, immutable snapshots. Operational
-- retention may delete them in dependency order, but no writer can rewrite them.
CREATE OR REPLACE FUNCTION school_discipline_immutable_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state='published' THEN RAISE EXCEPTION 'Published discipline versions are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS school_discipline_versions_immutable ON school_discipline_versions;
CREATE TRIGGER school_discipline_versions_immutable BEFORE UPDATE ON school_discipline_versions FOR EACH ROW EXECUTE FUNCTION school_discipline_immutable_version();
-- Covers every membership writer, including aliases, guided transitions, imports
-- and direct administrative maintenance. Reactivation never revives a grant.
CREATE OR REPLACE FUNCTION school_discipline_revoke_membership_access() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE revoked_id VARCHAR; previous_school_id TEXT := current_setting('app.school_id',true);
BEGIN
 IF OLD.role IN ('admin','school_admin') AND OLD.status='active' THEN
   -- Memberships are global auth rows. Scope this fixed-target housekeeping even
   -- when its caller has no tenant GUC, then restore the caller's original scope.
   PERFORM set_config('app.school_id',OLD.school_id,true);
   -- Serialize different membership-row updates for the same grant before the
   -- next READ COMMITTED statement checks remaining memberships. Otherwise two
   -- concurrent removals could each observe the other's old active row.
   PERFORM 1 FROM school_discipline_access WHERE school_id=OLD.school_id AND user_id=OLD.user_id FOR UPDATE;
   IF NOT EXISTS(SELECT 1 FROM school_memberships WHERE school_id=OLD.school_id AND user_id=OLD.user_id AND status='active' AND role IN ('admin','school_admin')) THEN
   UPDATE school_discipline_access SET enabled=false,revision=revision+1,updated_by=NULL,mutation_receipts='[]',updated_at=now()
     WHERE school_id=OLD.school_id AND user_id=OLD.user_id AND enabled RETURNING id INTO revoked_id;
   IF revoked_id IS NOT NULL THEN INSERT INTO audit_logs(school_id,action,entity_type,entity_id,metadata)
     VALUES(OLD.school_id,'discipline.access.auto_revoked','discipline_access',revoked_id,jsonb_build_object('userId',OLD.user_id,'reason','membership_changed')); END IF;
   END IF;
 END IF;
 PERFORM set_config('app.school_id',COALESCE(previous_school_id,''),true);
 RETURN NULL;
EXCEPTION WHEN OTHERS THEN
 PERFORM set_config('app.school_id',COALESCE(previous_school_id,''),true);
 RAISE;
END $$;
DROP TRIGGER IF EXISTS school_discipline_membership_revoke ON school_memberships;
CREATE TRIGGER school_discipline_membership_revoke AFTER UPDATE OR DELETE ON school_memberships FOR EACH ROW EXECUTE FUNCTION school_discipline_revoke_membership_access();
${["school_discipline_records", "school_discipline_versions", "school_discipline_attachments", "school_discipline_access"].map(table => `
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ${table};
CREATE POLICY tenant_isolation ON ${table} USING(school_id=current_setting('app.school_id',true) OR current_setting('app.is_super',true)='on')
 WITH CHECK(school_id=current_setting('app.school_id',true) OR current_setting('app.is_super',true)='on');`).join("\n")}
`;
export const schoolDisciplineMigration: SchoolPilotMigration = { id: "school-discipline-records-20260927", checksum: createHash("sha256").update(SCHOOL_DISCIPLINE_SQL).digest("hex"),
  mode: "transactional", apply: async connection => { await connection.query(SCHOOL_DISCIPLINE_SQL); } };
