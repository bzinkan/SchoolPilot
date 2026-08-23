import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

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
];
