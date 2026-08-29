import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";
import {
  CLASSPILOT_STUDENT_SESSION_RECOVERY_INDEXES_CONTRACT,
  ensureClasspilotStudentSessionRecoveryIndexesOnline,
} from "./classpilotStudentSessionRecoveryIndexes.js";
import { staffIdentityIntegrityMigration } from "./staffIdentityIntegrityMigration.js";

export { STAFF_IDENTITY_NORMALIZED_EMAIL_SQL } from "./staffIdentityIntegrityMigration.js";

export const CLASSPILOT_27_EXPAND_SQL = `
ALTER TABLE classpilot_session_reports
  ADD COLUMN IF NOT EXISTS report_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS total_unclassified_seconds INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_off_task_seconds INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_off_task_event_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_safety_alert_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE classpilot_session_student_reports
  ADD COLUMN IF NOT EXISTS unclassified_seconds INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS off_task_seconds INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS off_task_event_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS off_task_events JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS safety_alerts JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS student_session_id VARCHAR,
  ADD COLUMN IF NOT EXISTS client_message_id VARCHAR(128);

CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_student_client_unique
  ON chat_messages (school_id, student_id, student_session_id, client_message_id)
  WHERE client_message_id IS NOT NULL;
`;

export const CLASSPILOT_27_SAFETY_CAPTURE_SQL = `
CREATE TABLE IF NOT EXISTS classpilot_evidence_capture_requests (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  student_session_id VARCHAR NOT NULL,
  device_id TEXT NOT NULL,
  teaching_session_id VARCHAR,
  case_id TEXT,
  heartbeat_id TEXT NOT NULL,
  tab_ref VARCHAR(128) NOT NULL,
  tab_snapshot_revision INTEGER NOT NULL,
  expected_url_digest VARCHAR(64) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  artifact_id VARCHAR,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  CONSTRAINT cp_evidence_capture_school_id_fk_key UNIQUE (school_id, id),
  CONSTRAINT cp_evidence_capture_status_check
    CHECK (status IN ('pending', 'uploaded', 'expired', 'failed')),
  CONSTRAINT cp_evidence_capture_revision_check CHECK (tab_snapshot_revision > 0),
  CONSTRAINT cp_evidence_capture_window_check CHECK (expires_at > requested_at),
  CONSTRAINT cp_evidence_capture_student_school_fk
    FOREIGN KEY (school_id, student_id)
    REFERENCES students (school_id, id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS cp_evidence_capture_exact_binding_idx
  ON classpilot_evidence_capture_requests
  (school_id, student_id, student_session_id, device_id, status);

CREATE INDEX IF NOT EXISTS cp_evidence_capture_pending_expiry_idx
  ON classpilot_evidence_capture_requests (status, expires_at);

ALTER TABLE classpilot_evidence_capture_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE classpilot_evidence_capture_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON classpilot_evidence_capture_requests;
CREATE POLICY tenant_isolation ON classpilot_evidence_capture_requests
  USING (
    school_id = current_setting('app.school_id', true)
    OR current_setting('app.is_super', true) = 'on'
  )
  WITH CHECK (
    school_id = current_setting('app.school_id', true)
    OR current_setting('app.is_super', true) = 'on'
  );
`;

// Historical evidence rows predate exact device/session authority. Keep the
// new columns nullable during expansion, but make PostgreSQL enforce the full
// tuple for every newly inserted screenshot. NOT VALID deliberately leaves
// historical rows readable until a later audited backfill/contract migration.
// The relation may not exist yet on a brand-new database because the legacy
// bootstrap creates it later in the same one-off migration run.
export const CLASSPILOT_27_EVIDENCE_AUTHORITY_SQL = `
ALTER TABLE IF EXISTS evidence_artifacts
  ADD COLUMN IF NOT EXISTS device_id TEXT,
  ADD COLUMN IF NOT EXISTS student_session_id VARCHAR,
  ADD COLUMN IF NOT EXISTS binding_version TEXT;

DO $evidence_authority$
BEGIN
  IF to_regclass('evidence_artifacts') IS NULL THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'evidence_artifacts_screenshot_exact_authority_check'
      AND conrelid = to_regclass('evidence_artifacts')
  ) THEN
    EXECUTE $sql$
      ALTER TABLE evidence_artifacts
      ADD CONSTRAINT evidence_artifacts_screenshot_exact_authority_check
      CHECK (
        artifact_type <> 'screenshot'
        OR (
          device_id IS NOT NULL
          AND student_session_id IS NOT NULL
          AND binding_version IS NOT NULL
          AND captured_at IS NOT NULL
        )
      ) NOT VALID
    $sql$;
  END IF;

  EXECUTE $sql$
    CREATE INDEX IF NOT EXISTS evidence_artifacts_exact_authority_idx
    ON evidence_artifacts (
      school_id,
      device_id,
      student_id,
      student_session_id,
      captured_at
    )
  $sql$;
END;
$evidence_authority$;
`;

export const STAFF_IDENTITY_AUTH_VERSION_SQL = `
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 1;
`;

export const CLASSPILOT_STUDENT_SESSION_RECOVERY_SQL = `
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE student_sessions
  ADD COLUMN IF NOT EXISTS auth_kind TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS manual_lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS session_recovery_token_hash VARCHAR(64);

DO $student_session_recovery_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'student_sessions_auth_kind_check'
      AND conrelid = 'student_sessions'::regclass
  ) THEN
    ALTER TABLE student_sessions
      ADD CONSTRAINT student_sessions_auth_kind_check
      CHECK (auth_kind IN ('legacy', 'managed_profile', 'manual_shared'))
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'student_sessions_manual_lease_shape_check'
      AND conrelid = 'student_sessions'::regclass
  ) THEN
    ALTER TABLE student_sessions
      ADD CONSTRAINT student_sessions_manual_lease_shape_check
      CHECK (
        (auth_kind = 'manual_shared' AND manual_lease_expires_at IS NOT NULL)
        OR
        (auth_kind <> 'manual_shared'
          AND manual_lease_expires_at IS NULL
          AND session_recovery_token_hash IS NULL)
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'student_sessions_active_manual_recovery_check'
      AND conrelid = 'student_sessions'::regclass
  ) THEN
    ALTER TABLE student_sessions
      ADD CONSTRAINT student_sessions_active_manual_recovery_check
      CHECK (
        auth_kind <> 'manual_shared'
        OR is_active = false
        OR session_recovery_token_hash IS NOT NULL
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'student_sessions_recovery_token_hash_check'
      AND conrelid = 'student_sessions'::regclass
  ) THEN
    ALTER TABLE student_sessions
      ADD CONSTRAINT student_sessions_recovery_token_hash_check
      CHECK (
        session_recovery_token_hash IS NULL
        OR session_recovery_token_hash ~ '^[0-9a-f]{64}$'
      ) NOT VALID;
  END IF;
END;
$student_session_recovery_constraints$;

-- Phase A must remain compatible with already-running tasks whose INSERTs omit
-- auth_kind. Remove the superseded insert guard if an interrupted pre-release
-- migration installed it; a later contract migration may introduce a writer
-- guard only after all old tasks have drained.
DROP TRIGGER IF EXISTS student_sessions_reject_legacy_insert
  ON student_sessions;
DROP FUNCTION IF EXISTS reject_legacy_student_session_insert();

-- Once assigned, an auth kind is durable session history and cannot be
-- rewritten to evade or acquire lease semantics. Updates that leave the value
-- unchanged, including ordinary updates to retained legacy rows, remain valid.
CREATE OR REPLACE FUNCTION reject_student_session_auth_kind_change()
RETURNS trigger
LANGUAGE plpgsql
AS $student_session_auth_kind_guard$
BEGIN
  IF NEW.auth_kind IS DISTINCT FROM OLD.auth_kind THEN
    RAISE EXCEPTION USING
      ERRCODE = 'CP002',
      MESSAGE = 'CLASSPILOT_SESSION_AUTH_KIND_IMMUTABLE';
  END IF;

  RETURN NEW;
END;
$student_session_auth_kind_guard$;

DROP TRIGGER IF EXISTS student_sessions_auth_kind_immutable
  ON student_sessions;

CREATE TRIGGER student_sessions_auth_kind_immutable
BEFORE UPDATE OF auth_kind ON student_sessions
FOR EACH ROW
EXECUTE FUNCTION reject_student_session_auth_kind_change();
`;

export const CLASSPILOT_STUDENT_SESSION_RECOVERY_VALIDATE_SQL = `
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE student_sessions
  VALIDATE CONSTRAINT student_sessions_auth_kind_check;
ALTER TABLE student_sessions
  VALIDATE CONSTRAINT student_sessions_manual_lease_shape_check;
ALTER TABLE student_sessions
  VALIDATE CONSTRAINT student_sessions_active_manual_recovery_check;
ALTER TABLE student_sessions
  VALIDATE CONSTRAINT student_sessions_recovery_token_hash_check;
`;

// Rows marked legacy were created before explicit session auth kinds were
// issued. Retain any session with a heartbeat inside the manual-session lease
// window, but release abandoned rows so they no longer hide students from the
// login roster. The active/ended predicate makes this safe to run repeatedly.
export const CLASSPILOT_STALE_LEGACY_STUDENT_SESSION_CLEANUP_SQL = `
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '2min';

UPDATE student_sessions
SET
  is_active = false,
  ended_at = now(),
  session_recovery_token_hash = NULL
WHERE auth_kind = 'legacy'
  AND is_active = true
  AND ended_at IS NULL
  AND last_seen_at <= now() - interval '300 seconds';
`;

// Additive, Student Data-only persistence. Existing rows deliberately remain
// NULL so readers can distinguish legacy hostname-only aggregates from new
// rows whose safe site/app projection was computed from the active-tab URL.
export const CLASSPILOT_STUDENT_DATA_TOP_ACTIVITIES_SQL = `
ALTER TABLE classpilot_session_usage
  ADD COLUMN IF NOT EXISTS top_activities JSONB;
`;

export const schoolPilot27Migrations: readonly SchoolPilotMigration[] = [
  {
    id: "20260822_classpilot_2_7_expand",
    checksum: createHash("sha256").update(CLASSPILOT_27_EXPAND_SQL).digest("hex"),
    mode: "transactional",
    apply: async (connection) => {
      await connection.query(CLASSPILOT_27_EXPAND_SQL);
    },
  },
  {
    id: "20260822_classpilot_safety_capture_expand",
    checksum: createHash("sha256").update(CLASSPILOT_27_SAFETY_CAPTURE_SQL).digest("hex"),
    mode: "transactional",
    apply: async (connection) => {
      await connection.query(CLASSPILOT_27_SAFETY_CAPTURE_SQL);
    },
  },
  {
    id: "20260822_classpilot_evidence_authority_expand",
    checksum: createHash("sha256").update(CLASSPILOT_27_EVIDENCE_AUTHORITY_SQL).digest("hex"),
    mode: "transactional",
    apply: async (connection) => {
      await connection.query(CLASSPILOT_27_EVIDENCE_AUTHORITY_SQL);
    },
  },
  {
    id: "20260824_staff_identity_auth_version_expand",
    checksum: createHash("sha256").update(STAFF_IDENTITY_AUTH_VERSION_SQL).digest("hex"),
    mode: "transactional",
    apply: async (connection) => {
      await connection.query(STAFF_IDENTITY_AUTH_VERSION_SQL);
    },
  },
  {
    id: "20260827_classpilot_student_session_recovery_expand",
    checksum: createHash("sha256")
      .update(CLASSPILOT_STUDENT_SESSION_RECOVERY_SQL)
      .digest("hex"),
    mode: "transactional",
    apply: async (connection) => {
      await connection.query(CLASSPILOT_STUDENT_SESSION_RECOVERY_SQL);
    },
  },
  {
    id: "20260827_classpilot_student_session_recovery_validate",
    checksum: createHash("sha256")
      .update(CLASSPILOT_STUDENT_SESSION_RECOVERY_VALIDATE_SQL)
      .digest("hex"),
    mode: "transactional",
    apply: async (connection) => {
      await connection.query(CLASSPILOT_STUDENT_SESSION_RECOVERY_VALIDATE_SQL);
    },
  },
  {
    id: "20260827_classpilot_student_session_recovery_indexes_online",
    checksum: createHash("sha256")
      .update(CLASSPILOT_STUDENT_SESSION_RECOVERY_INDEXES_CONTRACT)
      .digest("hex"),
    mode: "nontransactional",
    apply: async (connection) => {
      await ensureClasspilotStudentSessionRecoveryIndexesOnline(connection);
    },
  },
  {
    id: "20260828_classpilot_stale_legacy_student_session_cleanup",
    checksum: createHash("sha256")
      .update(CLASSPILOT_STALE_LEGACY_STUDENT_SESSION_CLEANUP_SQL)
      .digest("hex"),
    mode: "transactional",
    apply: async (connection) => {
      await connection.query(CLASSPILOT_STALE_LEGACY_STUDENT_SESSION_CLEANUP_SQL);
    },
  },
  {
    id: "20260828_classpilot_student_data_top_activities_expand",
    checksum: createHash("sha256")
      .update(CLASSPILOT_STUDENT_DATA_TOP_ACTIVITIES_SQL)
      .digest("hex"),
    mode: "transactional",
    apply: async (connection) => {
      await connection.query(CLASSPILOT_STUDENT_DATA_TOP_ACTIVITIES_SQL);
    },
  },
  staffIdentityIntegrityMigration,
];

export const STAFF_IDENTITY_CONTRACT_MIGRATION_IDS = [
  staffIdentityIntegrityMigration.id,
] as const;

const firstStaffIdentityContractIndex = schoolPilot27Migrations.findIndex(
  (migration) => migration.id === STAFF_IDENTITY_CONTRACT_MIGRATION_IDS[0]
);
if (firstStaffIdentityContractIndex < 0) {
  throw new Error("Staff identity contract migration is missing from the ordered manifest");
}

/**
 * Stage-two production rollout: ship the credential version and recovery
 * tooling before enforcing the data contract. The single aggregate contract
 * migration is added only by the explicitly approved stage-five task, so its
 * email index and ownership backstops commit or roll back together.
 */
export const schoolPilot27ExpandMigrations: readonly SchoolPilotMigration[] =
  schoolPilot27Migrations.slice(0, firstStaffIdentityContractIndex);

export function selectSchoolPilot27MigrationPlan(options: {
  contractRolloutRequested: boolean;
  contractPreviouslyApplied: boolean;
}): readonly SchoolPilotMigration[] {
  return options.contractRolloutRequested || options.contractPreviouslyApplied
    ? schoolPilot27Migrations
    : schoolPilot27ExpandMigrations;
}
