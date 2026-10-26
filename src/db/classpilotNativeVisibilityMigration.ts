import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

// Additive native identities never replace the extension's device/session rows.
export const CLASSPILOT_NATIVE_VISIBILITY_SQL = `
SET LOCAL lock_timeout = '10s';
CREATE TABLE IF NOT EXISTS classpilot_native_enrollment_tokens (
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id),
  token_hash TEXT NOT NULL,
  issued_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CONSTRAINT cp_native_enrollment_school_id_unique UNIQUE(school_id,id),
  CONSTRAINT cp_native_enrollment_hash_check CHECK(token_hash ~ '^[a-f0-9]{64}$')
);
CREATE TABLE IF NOT EXISTS classpilot_native_installations (
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id),
  credential_hash TEXT NOT NULL,
  enrollment_token_id TEXT NOT NULL,
  client_version TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'windows',
  binding_revision INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  CONSTRAINT cp_native_installation_school_id_unique UNIQUE(school_id,id),
  CONSTRAINT cp_native_installation_enrollment_unique UNIQUE(enrollment_token_id),
  CONSTRAINT cp_native_installation_enrollment_fk FOREIGN KEY(school_id,enrollment_token_id)
    REFERENCES classpilot_native_enrollment_tokens(school_id,id),
  CONSTRAINT cp_native_installation_hash_check CHECK(credential_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT cp_native_installation_revision_check CHECK(binding_revision >= 0),
  CONSTRAINT cp_native_installation_platform_check CHECK(platform = 'windows')
);
CREATE TABLE IF NOT EXISTS classpilot_native_sessions (
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id),
  installation_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  credential_hash TEXT NOT NULL,
  os_session_nonce TEXT NOT NULL,
  student_credential_fingerprint TEXT NOT NULL,
  binding_revision INTEGER NOT NULL,
  source_ref TEXT NOT NULL,
  source_generation TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  end_reason TEXT,
  CONSTRAINT cp_native_session_school_id_unique UNIQUE(school_id,id),
  CONSTRAINT cp_native_session_source_ref_unique UNIQUE(source_ref),
  CONSTRAINT cp_native_session_installation_fk FOREIGN KEY(school_id,installation_id)
    REFERENCES classpilot_native_installations(school_id,id),
  CONSTRAINT cp_native_session_student_fk FOREIGN KEY(school_id,student_id)
    REFERENCES students(school_id,id),
  CONSTRAINT cp_native_session_hash_check CHECK(credential_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT cp_native_session_student_fingerprint_check CHECK(student_credential_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT cp_native_session_revision_check CHECK(binding_revision > 0),
  CONSTRAINT cp_native_session_expiry_check CHECK(expires_at <= absolute_expires_at AND absolute_expires_at > created_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS cp_native_session_active_installation_unique
  ON classpilot_native_sessions(installation_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS cp_native_session_active_student_unique
  ON classpilot_native_sessions(school_id,student_id) WHERE ended_at IS NULL;
ALTER TABLE classpilot_native_enrollment_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE classpilot_native_enrollment_tokens FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON classpilot_native_enrollment_tokens;
CREATE POLICY tenant_isolation ON classpilot_native_enrollment_tokens
  USING(school_id = current_setting('app.school_id',true) OR current_setting('app.is_super',true) = 'on')
  WITH CHECK(school_id = current_setting('app.school_id',true) OR current_setting('app.is_super',true) = 'on');
ALTER TABLE classpilot_native_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE classpilot_native_installations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON classpilot_native_installations;
CREATE POLICY tenant_isolation ON classpilot_native_installations
  USING(school_id = current_setting('app.school_id',true) OR current_setting('app.is_super',true) = 'on')
  WITH CHECK(school_id = current_setting('app.school_id',true) OR current_setting('app.is_super',true) = 'on');
ALTER TABLE classpilot_native_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE classpilot_native_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON classpilot_native_sessions;
CREATE POLICY tenant_isolation ON classpilot_native_sessions
  USING(school_id = current_setting('app.school_id',true) OR current_setting('app.is_super',true) = 'on')
  WITH CHECK(school_id = current_setting('app.school_id',true) OR current_setting('app.is_super',true) = 'on');
`;

export const classpilotNativeVisibilityMigration: SchoolPilotMigration = {
  id: "classpilot-native-visibility-20261026",
  checksum: createHash("sha256").update(CLASSPILOT_NATIVE_VISIBILITY_SQL).digest("hex"),
  mode: "transactional",
  apply: async connection => { await connection.query(CLASSPILOT_NATIVE_VISIBILITY_SQL); },
};
