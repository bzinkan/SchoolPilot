import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

export const CLASSPILOT_SUPERVISION_REPORTS_SQL = `
CREATE TABLE IF NOT EXISTS classpilot_supervision_report_segments (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  context_id TEXT NOT NULL,
  staff_id TEXT, staff_name_snapshot TEXT, context_name_snapshot TEXT, context_type TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL, window_end TIMESTAMPTZ,
  state TEXT NOT NULL DEFAULT 'active', closure_reason TEXT, partial_adoption BOOLEAN NOT NULL DEFAULT false,
  timezone TEXT NOT NULL, tracking_policy JSONB, retention_hours INTEGER NOT NULL DEFAULT 720,
  report_version INTEGER NOT NULL DEFAULT 2, summary JSONB,
  settle_at TIMESTAMPTZ, next_attempt_at TIMESTAMPTZ, attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT, lease_expires_at TIMESTAMPTZ, last_error TEXT,
  materialized_at TIMESTAMPTZ, expires_at TIMESTAMPTZ, detail_expired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cp_supervision_report_school_id_unique UNIQUE(school_id,id),
  CONSTRAINT cp_supervision_report_context_fk FOREIGN KEY(school_id,context_id)
    REFERENCES classpilot_supervision_contexts(school_id,id) ON DELETE CASCADE,
  CONSTRAINT cp_supervision_report_state_check CHECK(state IN ('active','pending','materializing','ready','failed','expired')),
  CONSTRAINT cp_supervision_report_window_check CHECK(window_end IS NULL OR window_end>=window_start),
  CONSTRAINT cp_supervision_report_closed_check CHECK(state='active' OR (window_end IS NOT NULL AND settle_at IS NOT NULL AND expires_at IS NOT NULL)),
  CONSTRAINT cp_supervision_report_attempt_check CHECK(attempt_count>=0 AND report_version>0 AND retention_hours BETWEEN 24 AND 8760)
);
CREATE UNIQUE INDEX IF NOT EXISTS cp_supervision_report_active_context_unique ON classpilot_supervision_report_segments(school_id,context_id) WHERE state='active';
CREATE INDEX IF NOT EXISTS cp_supervision_report_context_idx ON classpilot_supervision_report_segments(school_id,context_id);
CREATE INDEX IF NOT EXISTS cp_supervision_report_staff_idx ON classpilot_supervision_report_segments(school_id,staff_id,window_start);
CREATE INDEX IF NOT EXISTS cp_supervision_report_due_idx ON classpilot_supervision_report_segments(state,next_attempt_at);
CREATE INDEX IF NOT EXISTS cp_supervision_report_retention_idx ON classpilot_supervision_report_segments(expires_at);

CREATE TABLE IF NOT EXISTS classpilot_supervision_student_reports (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  school_id TEXT NOT NULL, report_id TEXT NOT NULL, student_id TEXT NOT NULL,
  student_name_snapshot TEXT NOT NULL, participation_intervals JSONB NOT NULL DEFAULT '[]'::jsonb,
  result JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cp_supervision_student_report_parent_fk FOREIGN KEY(school_id,report_id)
    REFERENCES classpilot_supervision_report_segments(school_id,id) ON DELETE CASCADE,
  CONSTRAINT cp_supervision_student_report_intervals_check CHECK(jsonb_typeof(participation_intervals)='array')
);
CREATE UNIQUE INDEX IF NOT EXISTS cp_supervision_student_report_unique ON classpilot_supervision_student_reports(school_id,report_id,student_id);
CREATE INDEX IF NOT EXISTS cp_supervision_student_report_student_idx ON classpilot_supervision_student_reports(school_id,student_id);

-- Validate authority at capture, preserving immutable report detail when the
-- live roster subsequently changes or a student is removed before retention.
CREATE OR REPLACE FUNCTION cp_supervision_report_student_binding()
RETURNS trigger LANGUAGE plpgsql AS $student_binding$
BEGIN
  IF TG_OP='UPDATE' AND NEW.school_id=OLD.school_id AND NEW.student_id=OLD.student_id THEN RETURN NEW; END IF;
  IF NOT EXISTS(SELECT 1 FROM students WHERE school_id=NEW.school_id AND id=NEW.student_id) THEN
    RAISE EXCEPTION 'Supervision report student must belong to the report school' USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END;
$student_binding$;
DROP TRIGGER IF EXISTS cp_supervision_report_student_binding ON classpilot_supervision_student_reports;
CREATE TRIGGER cp_supervision_report_student_binding BEFORE INSERT OR UPDATE OF school_id,student_id
  ON classpilot_supervision_student_reports FOR EACH ROW EXECUTE FUNCTION cp_supervision_report_student_binding();

CREATE TABLE IF NOT EXISTS classpilot_supervision_summary_deliveries (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  school_id TEXT NOT NULL, report_id TEXT NOT NULL, recipient_staff_id TEXT,
  recipient_kind TEXT NOT NULL, recipient_email TEXT, recipient_name TEXT,
  state TEXT NOT NULL DEFAULT 'waiting_report', attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT, lease_expires_at TIMESTAMPTZ, submission_started_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(), provider_message_id TEXT, last_error TEXT, sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cp_supervision_delivery_report_fk FOREIGN KEY(school_id,report_id)
    REFERENCES classpilot_supervision_report_segments(school_id,id) ON DELETE CASCADE,
  CONSTRAINT cp_supervision_delivery_kind_check CHECK(recipient_kind IN ('supervisor','central')),
  CONSTRAINT cp_supervision_delivery_state_check CHECK(state IN ('waiting_report','queued','leased','retry','sent','failed','unknown','expired')),
  CONSTRAINT cp_supervision_delivery_attempt_check CHECK(attempt_count>=0)
);
CREATE UNIQUE INDEX IF NOT EXISTS cp_supervision_delivery_kind_unique ON classpilot_supervision_summary_deliveries(school_id,report_id,recipient_kind);
CREATE UNIQUE INDEX IF NOT EXISTS cp_supervision_delivery_email_unique ON classpilot_supervision_summary_deliveries(school_id,report_id,lower(btrim(recipient_email)));
CREATE INDEX IF NOT EXISTS cp_supervision_delivery_due_idx ON classpilot_supervision_summary_deliveries(state,next_attempt_at);
CREATE INDEX IF NOT EXISTS cp_supervision_delivery_lease_idx ON classpilot_supervision_summary_deliveries(state,lease_expires_at);

DO $supervision_report_rls$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['classpilot_supervision_report_segments','classpilot_supervision_student_reports','classpilot_supervision_summary_deliveries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I',table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (school_id=current_setting(''app.school_id'',true) OR current_setting(''app.is_super'',true)=''on'') WITH CHECK (school_id=current_setting(''app.school_id'',true) OR current_setting(''app.is_super'',true)=''on'')',table_name);
  END LOOP;
END;
$supervision_report_rls$;
`;

export const classpilotSupervisionReportsMigration: SchoolPilotMigration = {
  id: "classpilot-supervision-activity-reports-20260910",
  checksum: createHash("sha256").update(CLASSPILOT_SUPERVISION_REPORTS_SQL).digest("hex"),
  mode: "transactional",
  apply: async (connection) => { await connection.query(CLASSPILOT_SUPERVISION_REPORTS_SQL); },
};
