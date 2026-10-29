import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

export const CLASSPILOT_WINDOWS_BROWSER_SQL = `
CREATE TABLE IF NOT EXISTS classpilot_windows_guards (
 id text PRIMARY KEY, school_id text NOT NULL REFERENCES schools(id), installation_id text NOT NULL,student_id text NOT NULL,
 credential_hash text NOT NULL,os_session_nonce text NOT NULL,student_credential_fingerprint text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),last_seen_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,absolute_expires_at timestamptz NOT NULL,ended_at timestamptz,end_reason text,
 CONSTRAINT cp_windows_guard_school_id_unique UNIQUE(school_id,id),
 CONSTRAINT cp_windows_guard_school_id_student_unique UNIQUE(school_id,id,student_id),
 CONSTRAINT cp_windows_guard_installation_fk FOREIGN KEY(school_id,installation_id) REFERENCES classpilot_native_installations(school_id,id),
 CONSTRAINT cp_windows_guard_student_fk FOREIGN KEY(school_id,student_id) REFERENCES students(school_id,id),
 CONSTRAINT cp_windows_guard_hash_check CHECK(credential_hash ~ '^[a-f0-9]{64}$' AND student_credential_fingerprint ~ '^[a-f0-9]{64}$'),
 CONSTRAINT cp_windows_guard_expiry_check CHECK(expires_at<=absolute_expires_at AND absolute_expires_at>created_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS cp_windows_guard_active_student_unique ON classpilot_windows_guards(school_id,student_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS cp_windows_guard_active_installation_unique ON classpilot_windows_guards(installation_id) WHERE ended_at IS NULL;
CREATE TABLE IF NOT EXISTS classpilot_windows_browsers (
 id text PRIMARY KEY,school_id text NOT NULL REFERENCES schools(id),guard_id text NOT NULL,student_id text NOT NULL,
 browser_family text NOT NULL,profile_id text NOT NULL,credential_hash text NOT NULL,source_ref text NOT NULL,binding_revision integer NOT NULL DEFAULT 1,
 client_protocol_version integer NOT NULL,extension_version text NOT NULL,accepted_capabilities jsonb NOT NULL,
 extension_capabilities jsonb NOT NULL DEFAULT '[]',capability_blocked_revision integer,
 restriction_override jsonb,school_policy_ack jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),last_seen_at timestamptz NOT NULL DEFAULT now(),ended_at timestamptz,
 CONSTRAINT cp_windows_browser_school_id_unique UNIQUE(school_id,id),CONSTRAINT cp_windows_browser_source_unique UNIQUE(source_ref),
 CONSTRAINT cp_windows_browser_school_id_student_unique UNIQUE(school_id,id,student_id),
 CONSTRAINT cp_windows_browser_guard_fk FOREIGN KEY(school_id,guard_id,student_id) REFERENCES classpilot_windows_guards(school_id,id,student_id),
 CONSTRAINT cp_windows_browser_student_fk FOREIGN KEY(school_id,student_id) REFERENCES students(school_id,id),
 CONSTRAINT cp_windows_browser_family_check CHECK(browser_family IN ('chrome','edge')),
 CONSTRAINT cp_windows_browser_hash_check CHECK(credential_hash ~ '^[a-f0-9]{64}$'),CONSTRAINT cp_windows_browser_revision_check CHECK(binding_revision>0)
);
CREATE UNIQUE INDEX IF NOT EXISTS cp_windows_browser_active_family_unique ON classpilot_windows_browsers(guard_id,browser_family) WHERE ended_at IS NULL;
ALTER TABLE classpilot_windows_browsers ADD COLUMN IF NOT EXISTS extension_capabilities jsonb NOT NULL DEFAULT '[]';
ALTER TABLE classpilot_windows_browsers ADD COLUMN IF NOT EXISTS capability_blocked_revision integer;
CREATE TABLE IF NOT EXISTS classpilot_windows_pairing_proofs (
 id text PRIMARY KEY,school_id text NOT NULL REFERENCES schools(id),guard_id text NOT NULL,browser_family text NOT NULL,profile_id text NOT NULL,challenge text NOT NULL,
 token_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,consumed_at timestamptz,
 CONSTRAINT cp_windows_proof_guard_fk FOREIGN KEY(school_id,guard_id) REFERENCES classpilot_windows_guards(school_id,id),
 CONSTRAINT cp_windows_proof_family_check CHECK(browser_family IN ('chrome','edge')),
 CONSTRAINT cp_windows_proof_hash_check CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT cp_windows_proof_expiry_check CHECK(expires_at>created_at AND expires_at<=created_at+interval '60 seconds')
);
CREATE TABLE IF NOT EXISTS classpilot_windows_commands (
 id text PRIMARY KEY,school_id text NOT NULL REFERENCES schools(id),actor_id text NOT NULL,teaching_session_id text,supervision_context_id text,context_authority_revision text,
 command_type text NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,
 CONSTRAINT cp_windows_command_school_id_unique UNIQUE(school_id,id),
 CONSTRAINT cp_windows_command_context_check CHECK(num_nonnulls(teaching_session_id,supervision_context_id)=1)
);
CREATE TABLE IF NOT EXISTS classpilot_windows_command_targets (
 id text PRIMARY KEY,school_id text NOT NULL REFERENCES schools(id),command_id text NOT NULL,browser_id text NOT NULL,student_id text NOT NULL,
 source_ref text NOT NULL,binding_revision integer NOT NULL,control_revision integer NOT NULL,status text NOT NULL DEFAULT 'pending',result jsonb,delivered_at timestamptz,acked_at timestamptz,
 CONSTRAINT cp_windows_target_command_fk FOREIGN KEY(school_id,command_id) REFERENCES classpilot_windows_commands(school_id,id),
 CONSTRAINT cp_windows_target_browser_fk FOREIGN KEY(school_id,browser_id,student_id) REFERENCES classpilot_windows_browsers(school_id,id,student_id),
 CONSTRAINT cp_windows_target_student_fk FOREIGN KEY(school_id,student_id) REFERENCES students(school_id,id),
 CONSTRAINT cp_windows_target_command_browser_unique UNIQUE(command_id,browser_id),
 CONSTRAINT cp_windows_target_status_check CHECK(status IN ('pending','delivered','succeeded','failed','expired','stale'))
);
${["classpilot_windows_guards","classpilot_windows_browsers","classpilot_windows_pairing_proofs","classpilot_windows_commands","classpilot_windows_command_targets"].map(table=>`
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ${table};
CREATE POLICY tenant_isolation ON ${table} USING(school_id=current_setting('app.school_id',true) OR current_setting('app.is_super',true)='on')
 WITH CHECK(school_id=current_setting('app.school_id',true) OR current_setting('app.is_super',true)='on');`).join("\n")}
`;
export const classpilotWindowsBrowserMigration:SchoolPilotMigration={id:"classpilot-windows-browser-20261028",checksum:createHash("sha256").update(CLASSPILOT_WINDOWS_BROWSER_SQL).digest("hex"),mode:"transactional",apply:async connection=>{await connection.query(CLASSPILOT_WINDOWS_BROWSER_SQL);}};
