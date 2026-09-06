import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

export const SAFETY_CENTER_TENANT_TABLES = ["student_safety_alerts", "student_safety_case_events", "safety_url_exceptions", "safety_notification_outbox"] as const;
const SAFETY_CONSTRAINTS = [
 ["student_safety_alerts","safety_alert_school_id_unique","UNIQUE(school_id,id)"],
 ["student_safety_alerts","safety_alert_case_id_unique","UNIQUE(school_id,case_id,id)"],
 ["student_safety_alerts","safety_alert_observation_unique","UNIQUE(school_id,case_id,fingerprint)"],
 ["student_safety_alerts","safety_alert_case_parent","FOREIGN KEY(school_id,case_id,student_id) REFERENCES student_safety_cases(school_id,id,student_id) ON DELETE CASCADE"],
 ["student_safety_alerts","safety_alert_student_parent","FOREIGN KEY(school_id,student_id) REFERENCES students(school_id,id) ON DELETE CASCADE"],
 ["student_safety_case_events","safety_case_event_parent","FOREIGN KEY(school_id,case_id) REFERENCES student_safety_cases(school_id,id) ON DELETE CASCADE"],
 ["student_safety_case_events","safety_case_event_alert_parent","FOREIGN KEY(school_id,case_id,alert_id) REFERENCES student_safety_alerts(school_id,case_id,id) ON DELETE CASCADE"],
 ["safety_url_exceptions","safety_url_exception_alert_parent","FOREIGN KEY(school_id,created_from_alert_id) REFERENCES student_safety_alerts(school_id,id)"],
 ["safety_url_exceptions","safety_url_exception_school_parent","FOREIGN KEY(school_id) REFERENCES schools(id) ON DELETE CASCADE"],
 ["safety_notification_outbox","safety_outbox_alert_recipient_kind_unique","UNIQUE(school_id,alert_id,recipient,kind)"],
 ["safety_notification_outbox","safety_outbox_case_alert_parent","FOREIGN KEY(school_id,case_id,alert_id) REFERENCES student_safety_alerts(school_id,case_id,id) ON DELETE CASCADE"],
 ["safety_notification_outbox","safety_outbox_kind_check","CHECK(kind IN ('initial','followup'))"],
 ["safety_notification_outbox","safety_outbox_status_check","CHECK(status IN ('pending','sending','sent','cancelled','failed','unknown'))"],
] as const;
export const SAFETY_CENTER_SQL = `
ALTER TABLE student_safety_cases
 ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ,
 ADD COLUMN IF NOT EXISTS acknowledged_by TEXT,
 ADD COLUMN IF NOT EXISTS assigned_to TEXT,
 ADD COLUMN IF NOT EXISTS resolution_note TEXT,
 ADD COLUMN IF NOT EXISTS merged_into TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS student_safety_cases_school_id_unique ON student_safety_cases(school_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS safety_case_student_parent_idx ON student_safety_cases(school_id,id,student_id);
CREATE TABLE IF NOT EXISTS student_safety_case_events (
 id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(), school_id TEXT NOT NULL,
 case_id TEXT NOT NULL, alert_id TEXT, actor_id TEXT, kind TEXT NOT NULL,
 note TEXT, metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS safety_case_events_case_idx ON student_safety_case_events(school_id,case_id,created_at,id);
-- Keep old IDs as redirects. Already exported packet bytes are never rewritten.
DO $merge$
DECLARE duplicate RECORD;
BEGIN
 FOR duplicate IN
  SELECT id,school_id,first_value(id) OVER(PARTITION BY school_id,student_id ORDER BY opened_at,id) AS survivor
  FROM student_safety_cases WHERE status='open'
 LOOP
  IF duplicate.id <> duplicate.survivor THEN
   UPDATE student_timeline_events SET case_id=duplicate.survivor WHERE school_id=duplicate.school_id AND case_id=duplicate.id;
   UPDATE evidence_artifacts SET case_id=duplicate.survivor WHERE school_id=duplicate.school_id AND case_id=duplicate.id;
   UPDATE classpilot_evidence_capture_requests SET case_id=duplicate.survivor WHERE school_id=duplicate.school_id AND case_id=duplicate.id;
   INSERT INTO student_safety_case_events(school_id,case_id,kind,metadata)
    VALUES(duplicate.school_id,duplicate.survivor,'case_merged',jsonb_build_object('previousCaseId',duplicate.id));
   UPDATE student_safety_cases SET status='closed',closed_at=now(),merged_into=duplicate.survivor,
    resolution_note='Consolidated duplicate open case',revision=revision+1 WHERE id=duplicate.id;
  END IF;
 END LOOP;
END $merge$;
CREATE UNIQUE INDEX IF NOT EXISTS safety_one_open_case_idx ON student_safety_cases(school_id,student_id) WHERE status='open';
CREATE TABLE IF NOT EXISTS student_safety_alerts (
 id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(), school_id TEXT NOT NULL, student_id TEXT NOT NULL, case_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL, url_fingerprint TEXT, url_ciphertext TEXT, source_type TEXT NOT NULL, source_id TEXT NOT NULL,
 concern TEXT NOT NULL, severity TEXT NOT NULL, classification_source TEXT, matched_term TEXT, reason TEXT,
 ruleset_version TEXT, model_version TEXT, confidence INTEGER, decision_id TEXT, heartbeat_id TEXT, teaching_session_id TEXT,
 first_seen_at TIMESTAMPTZ NOT NULL, last_seen_at TIMESTAMPTZ NOT NULL, observation_count INTEGER NOT NULL DEFAULT 1,
 revision INTEGER NOT NULL DEFAULT 0, reviewed_at TIMESTAMPTZ, reviewed_by TEXT, review_note TEXT
);
CREATE INDEX IF NOT EXISTS safety_alert_review_idx ON student_safety_alerts(school_id,reviewed_at,last_seen_at,id);
CREATE TABLE IF NOT EXISTS safety_url_exceptions (
 id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),school_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL,canonicalizer_version INTEGER NOT NULL DEFAULT 1,url_ciphertext TEXT NOT NULL,
 created_from_alert_id TEXT,created_by TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),revoked_at TIMESTAMPTZ,revoked_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS safety_active_url_exception_idx ON safety_url_exceptions(school_id,fingerprint) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS safety_notification_outbox (
 id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),school_id TEXT NOT NULL,case_id TEXT NOT NULL,alert_id TEXT NOT NULL,
 recipient TEXT NOT NULL,kind TEXT NOT NULL,alert_revision INTEGER NOT NULL,
 due_at TIMESTAMPTZ NOT NULL,status TEXT NOT NULL DEFAULT 'pending',
 attempts INTEGER NOT NULL DEFAULT 0,claimed_at TIMESTAMPTZ,completed_at TIMESTAMPTZ,provider_message_id TEXT,error_code TEXT
);
CREATE INDEX IF NOT EXISTS safety_notification_due_idx ON safety_notification_outbox(status,due_at);
ALTER TABLE safety_notification_outbox ADD COLUMN IF NOT EXISTS submission_started_at TIMESTAMPTZ;
ALTER TABLE student_safety_alerts ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;
ALTER TABLE student_safety_alerts ADD COLUMN IF NOT EXISTS acknowledged_by TEXT;
${SAFETY_CONSTRAINTS.map(([table,name,definition])=>`DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='${table}'::regclass AND conname='${name}') THEN
  ALTER TABLE ${table} ADD CONSTRAINT ${name} ${definition};
 END IF;
END $$;`).join("\n")}
-- Approval is configuration. Remove only its optional provenance reference when the source case expires.
CREATE OR REPLACE FUNCTION detach_safety_url_rule_provenance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 UPDATE safety_url_exceptions SET created_from_alert_id=NULL WHERE school_id=OLD.school_id AND created_from_alert_id=OLD.id;
 RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS detach_safety_url_rule_provenance ON student_safety_alerts;
CREATE TRIGGER detach_safety_url_rule_provenance BEFORE DELETE ON student_safety_alerts FOR EACH ROW EXECUTE FUNCTION detach_safety_url_rule_provenance();
${SAFETY_CENTER_TENANT_TABLES.map(table => `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ${table};
CREATE POLICY tenant_isolation ON ${table}
USING(school_id=current_setting('app.school_id',true) OR current_setting('app.is_super',true)='on')
WITH CHECK(school_id=current_setting('app.school_id',true) OR current_setting('app.is_super',true)='on');`).join("\n")}
`;
export const safetyCenterMigration: SchoolPilotMigration = {
 id: "classpilot-safety-center-20260905",checksum:createHash("sha256").update(SAFETY_CENTER_SQL).digest("hex"),mode:"transactional",
 apply:async connection=>{await connection.query(SAFETY_CENTER_SQL);},
};
