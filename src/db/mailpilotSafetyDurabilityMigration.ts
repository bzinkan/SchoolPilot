import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

export const MAILPILOT_SAFETY_DURABILITY_SQL=`
ALTER TABLE email_alerts ADD COLUMN IF NOT EXISTS safety_source_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS email_alerts_school_student_message_unique ON email_alerts(school_id,student_id,gmail_message_id);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='email_alerts'::regclass AND conname='email_alerts_gmail_message_unique') THEN
  ALTER TABLE email_alerts DROP CONSTRAINT email_alerts_gmail_message_unique;
 END IF;
END $$;
DROP INDEX IF EXISTS email_alerts_gmail_message_unique;
CREATE INDEX IF NOT EXISTS safety_alert_mailpilot_source_idx ON student_safety_alerts(school_id,student_id,source_id) WHERE source_type='mailpilot';
UPDATE email_alerts e SET safety_source_id='gmail-v1:'||encode(sha256(convert_to(
 '['||to_json(e.school_id)::text||','||to_json(e.student_id)::text||','||to_json(e.gmail_message_id)::text||']','UTF8')),'hex')
 WHERE safety_source_id IS NULL;
UPDATE student_safety_alerts a SET source_id=e.safety_source_id FROM email_alerts e
 WHERE a.school_id=e.school_id AND a.student_id=e.student_id AND a.source_type='mailpilot' AND a.source_id=e.id;
CREATE OR REPLACE FUNCTION copy_mailpilot_safety_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE email_alerts SET reviewed_at=NEW.reviewed_at,reviewed_by=COALESCE(reviewed_by,NEW.reviewed_by)
 WHERE school_id=NEW.school_id AND student_id=NEW.student_id AND reviewed_at IS NULL
   AND (safety_source_id=NEW.source_id OR id=NEW.source_id);
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mailpilot_safety_review ON student_safety_alerts;
CREATE TRIGGER mailpilot_safety_review AFTER INSERT OR UPDATE OF reviewed_at,reviewed_by ON student_safety_alerts
 FOR EACH ROW WHEN(NEW.source_type='mailpilot' AND NEW.reviewed_at IS NOT NULL) EXECUTE FUNCTION copy_mailpilot_safety_review();
WITH reviewed AS (
 SELECT DISTINCT ON(e.id) e.id,a.reviewed_at,a.reviewed_by FROM email_alerts e
 JOIN student_safety_alerts a ON a.school_id=e.school_id AND a.student_id=e.student_id AND a.source_type='mailpilot'
   AND (a.source_id=e.safety_source_id OR a.source_id=e.id)
 WHERE e.reviewed_at IS NULL AND a.reviewed_at IS NOT NULL ORDER BY e.id,a.reviewed_at,a.id
)
UPDATE email_alerts e SET reviewed_at=r.reviewed_at,reviewed_by=COALESCE(e.reviewed_by,r.reviewed_by) FROM reviewed r WHERE e.id=r.id;
`;

export const mailpilotSafetyDurabilityMigration:SchoolPilotMigration={
  id:"20260905-mailpilot-safety-durability-v1",mode:"transactional",
  checksum:createHash("sha256").update(MAILPILOT_SAFETY_DURABILITY_SQL).digest("hex"),
  apply:async connection=>{await connection.query(MAILPILOT_SAFETY_DURABILITY_SQL);},
};
