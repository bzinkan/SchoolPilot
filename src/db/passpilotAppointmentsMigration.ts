import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

export const PASSPILOT_APPOINTMENTS_SQL = `
SET LOCAL lock_timeout = '10s';
CREATE UNIQUE INDEX IF NOT EXISTS passes_school_student_id_unique ON passes(school_id,student_id,id);
CREATE TABLE IF NOT EXISTS passpilot_appointments (
 id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
 school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 student_id VARCHAR NOT NULL,
 created_by VARCHAR REFERENCES users(id) ON DELETE SET NULL,
 updated_by VARCHAR REFERENCES users(id) ON DELETE SET NULL,
 activated_by VARCHAR REFERENCES users(id) ON DELETE SET NULL,
 create_request_id UUID NOT NULL, create_fingerprint TEXT NOT NULL,
 destination TEXT NOT NULL, custom_destination TEXT, staff_notes TEXT,
 starts_at TIMESTAMPTZ NOT NULL, ends_at TIMESTAMPTZ NOT NULL,
 school_timezone TEXT NOT NULL, retained_until TIMESTAMPTZ NOT NULL,
 duration INTEGER NOT NULL DEFAULT 5, status TEXT NOT NULL DEFAULT 'scheduled', revision INTEGER NOT NULL DEFAULT 1,
 pass_id VARCHAR, activated_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, cancelled_at TIMESTAMPTZ,
 missed_at TIMESTAMPTZ, notes_scrubbed_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CONSTRAINT pp_appointments_school_id_unique UNIQUE(school_id,id),
 CONSTRAINT pp_appointments_create_request_unique UNIQUE(school_id,created_by,create_request_id),
 CONSTRAINT pp_appointments_pass_unique UNIQUE(school_id,pass_id),
 CONSTRAINT pp_appointments_student_school_fk FOREIGN KEY(school_id,student_id) REFERENCES students(school_id,id) ON DELETE CASCADE,
 CONSTRAINT pp_appointments_status_check CHECK(status IN ('scheduled','activated','completed','cancelled','missed')),
 CONSTRAINT pp_appointments_bounds_check CHECK(revision>0 AND duration BETWEEN 1 AND 120 AND starts_at<ends_at
  AND ends_at<=retained_until AND char_length(school_timezone) BETWEEN 1 AND 128 AND create_fingerprint ~ '^[a-f0-9]{64}$'
  AND (staff_notes IS NULL OR char_length(staff_notes)<=2000)),
 CONSTRAINT pp_appointments_destination_check CHECK(destination IN ('bathroom','nurse','office','counselor','other_classroom','custom')
  AND ((destination='custom' AND custom_destination IS NOT NULL AND char_length(custom_destination) BETWEEN 1 AND 200)
    OR (destination<>'custom' AND custom_destination IS NULL)))
);
ALTER TABLE passpilot_appointments DROP CONSTRAINT IF EXISTS pp_appointments_pass_student_school_fk;
ALTER TABLE passpilot_appointments ADD CONSTRAINT pp_appointments_pass_student_school_fk
 FOREIGN KEY(school_id,student_id,pass_id) REFERENCES passes(school_id,student_id,id) ON DELETE SET NULL (pass_id);
CREATE INDEX IF NOT EXISTS pp_appointments_school_window_idx ON passpilot_appointments(school_id,starts_at,id);
CREATE INDEX IF NOT EXISTS pp_appointments_school_student_window_idx ON passpilot_appointments(school_id,student_id,starts_at,id);
CREATE INDEX IF NOT EXISTS pp_appointments_pending_end_idx ON passpilot_appointments(ends_at) WHERE status='scheduled';
CREATE INDEX IF NOT EXISTS pp_appointments_retention_idx ON passpilot_appointments(retained_until);
ALTER TABLE passpilot_appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE passpilot_appointments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON passpilot_appointments;
CREATE POLICY tenant_isolation ON passpilot_appointments
 USING(school_id=current_setting('app.school_id',true) OR current_setting('app.is_super',true)='on')
 WITH CHECK(school_id=current_setting('app.school_id',true) OR current_setting('app.is_super',true)='on');

-- Every return/cancel path, including kiosk and Rules/appointments-off cleanup,
-- changes the linked lifecycle in the same transaction as the explicit pass
-- action. Crossing the overdue threshold never runs this transition.
CREATE OR REPLACE FUNCTION complete_passpilot_appointment_from_pass() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status='active' AND NEW.status IN ('returned','canceled') THEN
  -- Pre-activation expansion compatibility only: an old restricted pass writer
  -- may not yet have the new table's grants. Governed activation requires all
  -- writers/grants to be compatible; after activation rollback retains them.
  -- PostgreSQL comma-separated privileges mean ANY, so check each separately.
  IF NOT has_table_privilege(current_user,'public.passpilot_appointments','SELECT')
     OR NOT has_table_privilege(current_user,'public.passpilot_appointments','UPDATE') THEN
   RETURN NEW;
  END IF;
  UPDATE passpilot_appointments SET
   status=CASE WHEN NEW.status='returned' THEN 'completed' ELSE 'cancelled' END,
   completed_at=CASE WHEN NEW.status='returned' THEN COALESCE(NEW.returned_at AT TIME ZONE 'UTC',clock_timestamp()) ELSE completed_at END,
   cancelled_at=CASE WHEN NEW.status='canceled' THEN clock_timestamp() ELSE cancelled_at END,
   revision=revision+1, updated_at=clock_timestamp()
  WHERE school_id=NEW.school_id AND student_id=NEW.student_id AND pass_id=NEW.id AND status='activated';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pp_appointment_pass_completion ON passes;
CREATE TRIGGER pp_appointment_pass_completion AFTER UPDATE OF status ON passes
 FOR EACH ROW EXECUTE FUNCTION complete_passpilot_appointment_from_pass();
`;

export const passpilotAppointmentsMigration: SchoolPilotMigration = {
  id: "passpilot-appointments-expand-20260930",
  checksum: createHash("sha256").update(PASSPILOT_APPOINTMENTS_SQL).digest("hex"),
  mode: "transactional",
  apply: async (connection) => { await connection.query(PASSPILOT_APPOINTMENTS_SQL); },
};
