import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

export const ROSTER_INTEGRATION_TABLES = ["roster_integration_connections", "roster_integration_runs", "roster_integration_identities", "roster_integration_memberships"] as const;
export const ROSTER_INTEGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS roster_integration_connections (
 id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(), school_id TEXT NOT NULL REFERENCES schools(id), provider TEXT NOT NULL CHECK(provider IN ('oneroster','clever')),
 name TEXT NOT NULL, provider_identity TEXT NOT NULL, encrypted_token TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','reconnect_required')),
 mapping JSONB NOT NULL DEFAULT '{"organizationIds":[]}', revision INTEGER NOT NULL DEFAULT 0, automatic_sync BOOLEAN NOT NULL DEFAULT false,
 initial_reviewed_at TIMESTAMPTZ, last_attempt_local_date TEXT, last_attempt_at TIMESTAMPTZ, last_success_at TIMESTAMPTZ, last_error_code TEXT,
 created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CONSTRAINT roster_connections_school_id_unique UNIQUE(school_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS roster_connections_source_unique ON roster_integration_connections(school_id,provider,provider_identity);
CREATE INDEX IF NOT EXISTS roster_connections_due_idx ON roster_integration_connections(status,automatic_sync);
CREATE TABLE IF NOT EXISTS roster_integration_runs (
 id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(), school_id TEXT NOT NULL, connection_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'staged', requested_by TEXT,
 automatic BOOLEAN NOT NULL DEFAULT false, snapshot JSONB, mapping JSONB, plan JSONB, plan_hash TEXT, base_revision INTEGER, cursor INTEGER NOT NULL DEFAULT 0,
 total_steps INTEGER NOT NULL DEFAULT 0, summary JSONB NOT NULL DEFAULT '{}', error_code TEXT, expires_at TIMESTAMPTZ NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CONSTRAINT roster_runs_school_id_unique UNIQUE(school_id,id),
 CONSTRAINT roster_runs_connection_fk FOREIGN KEY(school_id,connection_id) REFERENCES roster_integration_connections(school_id,id),
 CONSTRAINT roster_runs_state_check CHECK(status IN ('fetching','staged','preview','held','applying','completed','failed','expired'))
);
CREATE INDEX IF NOT EXISTS roster_runs_connection_idx ON roster_integration_runs(school_id,connection_id,created_at);
CREATE INDEX IF NOT EXISTS roster_runs_status_idx ON roster_integration_runs(status,updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS roster_runs_one_applying ON roster_integration_runs(school_id,connection_id) WHERE status IN ('fetching','applying');
CREATE TABLE IF NOT EXISTS roster_integration_identities (
 id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(), school_id TEXT NOT NULL, connection_id TEXT NOT NULL, entity_type TEXT NOT NULL CHECK(entity_type IN ('student','teacher','class')),
 external_id TEXT NOT NULL, internal_id TEXT NOT NULL, owned_fields JSONB NOT NULL DEFAULT '[]', last_applied JSONB NOT NULL DEFAULT '{}',
 source_created BOOLEAN NOT NULL DEFAULT false, source_present BOOLEAN NOT NULL DEFAULT true, last_run_id TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CONSTRAINT roster_identities_connection_fk FOREIGN KEY(school_id,connection_id) REFERENCES roster_integration_connections(school_id,id),
 CONSTRAINT roster_identities_run_fk FOREIGN KEY(school_id,last_run_id) REFERENCES roster_integration_runs(school_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS roster_identities_external_unique ON roster_integration_identities(school_id,connection_id,entity_type,external_id);
CREATE UNIQUE INDEX IF NOT EXISTS roster_identities_internal_unique ON roster_integration_identities(school_id,connection_id,entity_type,internal_id);
CREATE INDEX IF NOT EXISTS roster_identities_internal_idx ON roster_integration_identities(school_id,entity_type,internal_id);
CREATE TABLE IF NOT EXISTS roster_integration_memberships (
 id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(), school_id TEXT NOT NULL, connection_id TEXT NOT NULL, group_id TEXT NOT NULL,
 member_id TEXT NOT NULL, member_type TEXT NOT NULL CHECK(member_type IN ('student','teacher')), role TEXT NOT NULL CHECK(role IN ('student','primary','co-teacher')),
 owns_membership BOOLEAN NOT NULL DEFAULT false, manual_preserved BOOLEAN NOT NULL DEFAULT false, source_present BOOLEAN NOT NULL DEFAULT true,
 physical_row_id TEXT, last_run_id TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CONSTRAINT roster_memberships_connection_fk FOREIGN KEY(school_id,connection_id) REFERENCES roster_integration_connections(school_id,id),
 CONSTRAINT roster_memberships_group_fk FOREIGN KEY(school_id,group_id) REFERENCES groups(school_id,id),
 CONSTRAINT roster_memberships_run_fk FOREIGN KEY(school_id,last_run_id) REFERENCES roster_integration_runs(school_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS roster_memberships_source_unique ON roster_integration_memberships(school_id,connection_id,group_id,member_type,member_id);
CREATE INDEX IF NOT EXISTS roster_memberships_target_idx ON roster_integration_memberships(school_id,group_id,member_type,member_id);
CREATE OR REPLACE FUNCTION check_roster_integration_target_school() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='roster_integration_identities' THEN
  IF NEW.entity_type='student' AND NOT EXISTS(SELECT 1 FROM students WHERE school_id=NEW.school_id AND id=NEW.internal_id) THEN RAISE EXCEPTION 'Roster student target must belong to school' USING ERRCODE='23514'; END IF;
  IF NEW.entity_type='class' AND NOT EXISTS(SELECT 1 FROM groups WHERE school_id=NEW.school_id AND id=NEW.internal_id) THEN RAISE EXCEPTION 'Roster class target must belong to school' USING ERRCODE='23514'; END IF;
  IF NEW.entity_type='teacher' AND NOT EXISTS(SELECT 1 FROM school_memberships WHERE school_id=NEW.school_id AND user_id=NEW.internal_id AND status='active' AND role IN ('teacher','admin','school_admin')) THEN RAISE EXCEPTION 'Roster teacher target must be active school teaching staff' USING ERRCODE='23514'; END IF;
 ELSE
  IF NEW.member_type='student' AND NOT EXISTS(SELECT 1 FROM students WHERE school_id=NEW.school_id AND id=NEW.member_id) THEN RAISE EXCEPTION 'Roster membership student must belong to school' USING ERRCODE='23514'; END IF;
  IF NEW.member_type='teacher' AND NOT EXISTS(SELECT 1 FROM school_memberships WHERE school_id=NEW.school_id AND user_id=NEW.member_id) THEN RAISE EXCEPTION 'Roster membership teacher must belong to school' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS roster_identity_target_school ON roster_integration_identities;
CREATE TRIGGER roster_identity_target_school BEFORE INSERT OR UPDATE ON roster_integration_identities FOR EACH ROW EXECUTE FUNCTION check_roster_integration_target_school();
DROP TRIGGER IF EXISTS roster_membership_target_school ON roster_integration_memberships;
CREATE TRIGGER roster_membership_target_school BEFORE INSERT OR UPDATE ON roster_integration_memberships FOR EACH ROW EXECUTE FUNCTION check_roster_integration_target_school();
` + ROSTER_INTEGRATION_TABLES.map(table => `
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ${table};
CREATE POLICY tenant_isolation ON ${table} USING(school_id=current_setting('app.school_id',true) OR current_setting('app.is_super',true)='on') WITH CHECK(school_id=current_setting('app.school_id',true) OR current_setting('app.is_super',true)='on');
`).join("\n");

export const rosterIntegrationsMigration: SchoolPilotMigration = { id: "20260905-roster-integrations-v1", mode: "transactional", checksum: createHash("sha256").update(ROSTER_INTEGRATIONS_SQL).digest("hex"), apply: async connection => { await connection.query(ROSTER_INTEGRATIONS_SQL); } };
