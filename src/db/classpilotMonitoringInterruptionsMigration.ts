import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

export const CLASSPILOT_MONITORING_INTERRUPTION_TENANT_TABLES = [
  "classpilot_monitoring_expectations", "classpilot_monitoring_interruptions",
  "classpilot_monitoring_interruption_settings", "classpilot_monitoring_interruption_digests",
] as const;
const parentConstraints = ([
  ["classpilot_monitoring_expectations", "cp_monitoring_expectation"],
  ["classpilot_monitoring_interruptions", "cp_monitoring_interruption"],
] as const).flatMap(([table, prefix]) => [
  [table, `${prefix}_school_fk`, "FOREIGN KEY(school_id) REFERENCES schools(id) ON DELETE CASCADE"],
  [table, `${prefix}_student_fk`, "FOREIGN KEY(school_id,student_id) REFERENCES students(school_id,id) ON DELETE CASCADE"],
  [table, `${prefix}_session_fk`, "FOREIGN KEY(student_session_id,student_id,device_id) REFERENCES student_sessions(id,student_id,device_id) ON DELETE CASCADE"],
  [table, `${prefix}_device_fk`, "FOREIGN KEY(school_id,device_id) REFERENCES devices(school_id,device_id) ON DELETE CASCADE"],
  [table, `${prefix}_class_fk`, "FOREIGN KEY(school_id,teaching_session_id) REFERENCES teaching_sessions(school_id,id) ON DELETE CASCADE"],
  [table, `${prefix}_coverage_fk`, "FOREIGN KEY(school_id,supervision_context_id) REFERENCES classpilot_supervision_contexts(school_id,id) ON DELETE CASCADE"],
  [table, `${prefix}_scope_check`, "CHECK(scope_type IN ('teaching_session','supervision_context'))"],
]);
const constraints = [...parentConstraints,
  ["classpilot_monitoring_interruption_settings", "cp_monitoring_interruption_settings_school_fk", "FOREIGN KEY(school_id) REFERENCES schools(id) ON DELETE CASCADE"],
  ["classpilot_monitoring_interruption_settings", "cp_monitoring_interruption_settings_revision_check", "CHECK(revision>=0)"],
  ["classpilot_monitoring_interruption_settings", "cp_monitoring_interruption_settings_status_check", "CHECK(scan_status IN ('healthy','uncertain','not_expected','unknown'))"],
  ["classpilot_monitoring_interruption_digests", "cp_monitoring_digest_school_fk", "FOREIGN KEY(school_id) REFERENCES schools(id) ON DELETE CASCADE"],
  ["classpilot_monitoring_interruption_digests", "cp_monitoring_digest_recipient_fk", "FOREIGN KEY(recipient_user_id) REFERENCES users(id) ON DELETE CASCADE"],
  ["classpilot_monitoring_interruption_digests", "cp_monitoring_digest_status_check", "CHECK(status IN ('pending','sending','sent','unknown','failed','cancelled'))"],
  ["classpilot_monitoring_interruptions", "cp_monitoring_interruption_end_check", "CHECK((ended_at IS NULL AND end_reason IS NULL) OR (ended_at IS NOT NULL AND end_reason IS NOT NULL))"],
  ["classpilot_monitoring_interruptions", "cp_monitoring_interruption_recovery_check", "CHECK(recovered_at IS NULL OR (ended_at IS NOT NULL AND end_reason='telemetry_resumed'))"],
];
export const CLASSPILOT_MONITORING_INTERRUPTION_SQL = `
CREATE TABLE IF NOT EXISTS classpilot_monitoring_expectations (
 id text PRIMARY KEY DEFAULT gen_random_uuid()::text, school_id text NOT NULL REFERENCES schools(id) ON DELETE CASCADE, student_id text NOT NULL,
 student_session_id text NOT NULL REFERENCES student_sessions(id) ON DELETE CASCADE, device_id text NOT NULL, scope_type text NOT NULL CONSTRAINT cp_monitoring_expectation_scope_check CHECK(scope_type IN ('teaching_session','supervision_context')),
 scope_id text NOT NULL, scope_name text NOT NULL, scope_started_at timestamptz NOT NULL, scope_ends_at timestamptz,
 last_observed_at timestamptz NOT NULL, last_checked_at timestamptz NOT NULL, uncertain_since timestamptz, retention_expires_at timestamptz NOT NULL,
 CONSTRAINT cp_monitoring_expectation_student_fk FOREIGN KEY(school_id,student_id) REFERENCES students(school_id,id) ON DELETE CASCADE);
CREATE UNIQUE INDEX IF NOT EXISTS cp_monitoring_expectation_student_unique ON classpilot_monitoring_expectations(school_id,student_id);
CREATE INDEX IF NOT EXISTS cp_monitoring_expectation_retention_idx ON classpilot_monitoring_expectations(retention_expires_at);
CREATE TABLE IF NOT EXISTS classpilot_monitoring_interruptions (
 id text PRIMARY KEY DEFAULT gen_random_uuid()::text, expectation_id text NOT NULL, school_id text NOT NULL REFERENCES schools(id) ON DELETE CASCADE, student_id text NOT NULL,
 student_session_id text NOT NULL REFERENCES student_sessions(id) ON DELETE CASCADE, device_id text NOT NULL, scope_type text NOT NULL CONSTRAINT cp_monitoring_interruption_scope_check CHECK(scope_type IN ('teaching_session','supervision_context')),
 scope_id text NOT NULL, scope_name text NOT NULL, last_observed_at timestamptz NOT NULL, detected_at timestamptz NOT NULL,
 recovered_at timestamptz, ended_at timestamptz, end_reason text, uncertain_since timestamptz, retention_expires_at timestamptz NOT NULL,
 CONSTRAINT cp_monitoring_interruption_end_check CHECK((ended_at IS NULL AND end_reason IS NULL) OR (ended_at IS NOT NULL AND end_reason IS NOT NULL)),
 CONSTRAINT cp_monitoring_interruption_recovery_check CHECK(recovered_at IS NULL OR (ended_at IS NOT NULL AND end_reason='telemetry_resumed')),
 CONSTRAINT cp_monitoring_interruption_student_fk FOREIGN KEY(school_id,student_id) REFERENCES students(school_id,id) ON DELETE CASCADE);
CREATE UNIQUE INDEX IF NOT EXISTS cp_monitoring_interruption_open_unique ON classpilot_monitoring_interruptions(expectation_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS cp_monitoring_interruption_school_time_idx ON classpilot_monitoring_interruptions(school_id,detected_at);
CREATE INDEX IF NOT EXISTS cp_monitoring_interruption_retention_idx ON classpilot_monitoring_interruptions(retention_expires_at);
CREATE TABLE IF NOT EXISTS classpilot_monitoring_interruption_settings (
 school_id text PRIMARY KEY REFERENCES schools(id) ON DELETE CASCADE, digest_enabled boolean NOT NULL DEFAULT false, revision integer NOT NULL DEFAULT 0 CONSTRAINT cp_monitoring_interruption_settings_revision_check CHECK(revision>=0),
 updated_by text, updated_at timestamptz NOT NULL DEFAULT now(), last_scanned_at timestamptz, last_healthy_at timestamptz,
 scan_status text NOT NULL DEFAULT 'unknown' CONSTRAINT cp_monitoring_interruption_settings_status_check CHECK(scan_status IN ('healthy','uncertain','not_expected','unknown')));
CREATE TABLE IF NOT EXISTS classpilot_monitoring_interruption_digests (
 id text PRIMARY KEY DEFAULT gen_random_uuid()::text, school_id text NOT NULL REFERENCES schools(id) ON DELETE CASCADE, local_date text NOT NULL, recipient_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 status text NOT NULL DEFAULT 'pending' CONSTRAINT cp_monitoring_digest_status_check CHECK(status IN ('pending','sending','sent','unknown','failed','cancelled')), attempts integer NOT NULL DEFAULT 0,
 due_at timestamptz NOT NULL, claimed_at timestamptz, completed_at timestamptz, error_code text, retention_expires_at timestamptz NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS cp_monitoring_digest_daily_recipient_unique ON classpilot_monitoring_interruption_digests(school_id,local_date,recipient_user_id);
CREATE INDEX IF NOT EXISTS cp_monitoring_digest_due_idx ON classpilot_monitoring_interruption_digests(status,due_at);
CREATE INDEX IF NOT EXISTS cp_monitoring_digest_retention_idx ON classpilot_monitoring_interruption_digests(retention_expires_at);
${["classpilot_monitoring_expectations", "classpilot_monitoring_interruptions"].map((table) => `
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS teaching_session_id text GENERATED ALWAYS AS (CASE WHEN scope_type='teaching_session' THEN scope_id END) STORED REFERENCES teaching_sessions(id) ON DELETE CASCADE;
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS supervision_context_id text GENERATED ALWAYS AS (CASE WHEN scope_type='supervision_context' THEN scope_id END) STORED REFERENCES classpilot_supervision_contexts(id) ON DELETE CASCADE;
`).join("\n")}
CREATE UNIQUE INDEX IF NOT EXISTS cp_monitoring_device_parent_unique ON devices(school_id,device_id);
CREATE UNIQUE INDEX IF NOT EXISTS cp_monitoring_session_parent_unique ON student_sessions(id,student_id,device_id);
CREATE UNIQUE INDEX IF NOT EXISTS cp_monitoring_class_parent_unique ON teaching_sessions(school_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS cp_monitoring_coverage_parent_unique ON classpilot_supervision_contexts(school_id,id);
-- Converge a Drizzle-created table or an earlier nonproduction fixture without
-- dropping data. Invalid existing parent rows abort the transaction.
${CLASSPILOT_MONITORING_INTERRUPTION_TENANT_TABLES.map((table) => ["school_id", "student_session_id", "teaching_session_id", "supervision_context_id", "recipient_user_id"].map((column) => `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_${column}_fkey;`).join("\n")).join("\n")}
${constraints.map(([table, name, definition]) => `DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='${table}'::regclass AND conname='${name}') THEN
  ALTER TABLE ${table} ADD CONSTRAINT ${name} ${definition};
 END IF;
END $$;`).join("\n")}
CREATE OR REPLACE FUNCTION validate_classpilot_monitoring_interruption_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM student_sessions a JOIN students s ON s.id=a.student_id
   WHERE a.id=NEW.student_session_id AND a.student_id=NEW.student_id AND a.device_id=NEW.device_id AND s.school_id=NEW.school_id
   AND EXISTS(SELECT 1 FROM devices d WHERE d.school_id=NEW.school_id AND d.device_id=NEW.device_id))
 THEN RAISE EXCEPTION 'Invalid monitoring interruption binding' USING ERRCODE='23514'; END IF;
 IF NEW.scope_type='teaching_session' THEN
  IF NOT EXISTS(SELECT 1 FROM teaching_sessions c JOIN classpilot_session_students r ON r.school_id=c.school_id AND r.teaching_session_id=c.id
    WHERE c.school_id=NEW.school_id AND c.id=NEW.scope_id AND r.student_id=NEW.student_id)
  THEN RAISE EXCEPTION 'Invalid monitoring interruption class scope' USING ERRCODE='23514'; END IF;
 ELSIF NEW.scope_type='supervision_context' THEN
  IF NOT EXISTS(SELECT 1 FROM classpilot_supervision_contexts c JOIN classpilot_supervision_students r ON r.school_id=c.school_id AND r.context_id=c.id
    WHERE c.school_id=NEW.school_id AND c.id=NEW.scope_id AND r.student_id=NEW.student_id)
  THEN RAISE EXCEPTION 'Invalid monitoring interruption coverage scope' USING ERRCODE='23514'; END IF;
 ELSE RAISE EXCEPTION 'Invalid monitoring interruption scope type' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
${["classpilot_monitoring_expectations", "classpilot_monitoring_interruptions"].map((table) => `
DROP TRIGGER IF EXISTS cp_monitoring_interruption_binding ON ${table};
CREATE TRIGGER cp_monitoring_interruption_binding BEFORE INSERT OR UPDATE OF school_id,student_id,student_session_id,device_id,scope_type,scope_id ON ${table}
 FOR EACH ROW EXECUTE FUNCTION validate_classpilot_monitoring_interruption_binding();`).join("\n")}
${["classpilot_monitoring_expectations", "classpilot_monitoring_interruptions"].map((table) => `DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM ${table} e WHERE
  (e.scope_type='teaching_session' AND NOT EXISTS(SELECT 1 FROM classpilot_session_students r WHERE r.school_id=e.school_id AND r.teaching_session_id=e.scope_id AND r.student_id=e.student_id)) OR
  (e.scope_type='supervision_context' AND NOT EXISTS(SELECT 1 FROM classpilot_supervision_students r WHERE r.school_id=e.school_id AND r.context_id=e.scope_id AND r.student_id=e.student_id)))
 THEN RAISE EXCEPTION 'Existing monitoring scope membership is invalid' USING ERRCODE='23514'; END IF;
END $$;`).join("\n")}
${CLASSPILOT_MONITORING_INTERRUPTION_TENANT_TABLES.map((table) => `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ${table};
CREATE POLICY tenant_isolation ON ${table} FOR ALL USING (school_id=current_setting('app.school_id',true) OR current_setting('app.is_super',true)='on') WITH CHECK(school_id=current_setting('app.school_id',true) OR current_setting('app.is_super',true)='on');`).join("\n")}
`;
export const classpilotMonitoringInterruptionsMigration: SchoolPilotMigration = {
  id: "classpilot-monitoring-interruptions-20260905", checksum: createHash("sha256").update(CLASSPILOT_MONITORING_INTERRUPTION_SQL).digest("hex"),
  mode: "transactional", apply: async (connection) => { await connection.query(CLASSPILOT_MONITORING_INTERRUPTION_SQL); },
};
