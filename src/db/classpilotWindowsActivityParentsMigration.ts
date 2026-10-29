import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";
import { CLASSPILOT_SCHEDULED_CLASSROOM_GUARDS_SQL } from "./classpilotScheduledClassroomMigration.js";

// Preserve the immutable classroom-parent validator byte-for-byte except for
// the explicit second identity type. No legacy device/session rows are made.
const original=CLASSPILOT_SCHEDULED_CLASSROOM_GUARDS_SQL.split("CREATE OR REPLACE FUNCTION classpilot_validate_activity_parent()")[0]!;
const handCheck="AND NOT EXISTS(SELECT 1 FROM devices WHERE device_id=body->>'device_id' AND school_id=expected_school) THEN";
if(original.split(handCheck).length!==2)throw new Error("Canonical activity-parent validator shape changed");
const activity=original.replace(handCheck,`AND NOT EXISTS(SELECT 1 FROM devices WHERE device_id=body->>'device_id' AND school_id=expected_school)
    AND NOT classpilot_windows_activity_browser_parent(expected_school,body->>'student_id',body->>'device_id',body->>'student_session_id') THEN`)
  .replace("  RETURN;",`  IF body->>'device_id' IS NOT NULL AND (
    EXISTS(SELECT 1 FROM classpilot_windows_browsers WHERE id=body->>'device_id') OR
    (body->>'student_session_id'=body->>'device_id' AND NOT EXISTS(SELECT 1 FROM devices WHERE device_id=body->>'device_id'))
  ) AND NOT classpilot_windows_activity_browser_parent(expected_school,body->>'student_id',body->>'device_id',body->>'student_session_id') THEN
    RAISE EXCEPTION 'classroom activity browser parent must match the exact school and student' USING ERRCODE='23514';
  END IF;
  RETURN;`);

export const CLASSPILOT_WINDOWS_ACTIVITY_PARENTS_SQL=`
CREATE OR REPLACE FUNCTION classpilot_windows_activity_browser_parent(school_ref TEXT,student_ref TEXT,browser_ref TEXT,session_ref TEXT)
RETURNS boolean LANGUAGE sql STABLE AS $browser_parent$
 SELECT browser_ref IS NOT NULL AND student_ref IS NOT NULL
   AND (session_ref IS NULL OR session_ref=browser_ref)
   AND EXISTS(SELECT 1 FROM classpilot_windows_browsers browser
     JOIN classpilot_windows_guards guard ON guard.school_id=browser.school_id AND guard.id=browser.guard_id AND guard.student_id=browser.student_id
     WHERE browser.id=browser_ref AND browser.school_id=school_ref AND browser.student_id=student_ref)
$browser_parent$;
${activity}
CREATE OR REPLACE FUNCTION classpilot_bind_poll_response_school() RETURNS trigger LANGUAGE plpgsql AS $poll_school$
DECLARE expected_school TEXT;
BEGIN
 SELECT school_id INTO expected_school FROM polls WHERE id=NEW.poll_id;
 IF expected_school IS NULL OR (NEW.school_id IS NOT NULL AND NEW.school_id<>expected_school) THEN
   RAISE EXCEPTION 'poll response tenant does not match poll' USING ERRCODE='23514';
 END IF;
 NEW.school_id:=expected_school;
 IF NOT EXISTS(SELECT 1 FROM students student WHERE student.id=NEW.student_id AND student.school_id=expected_school) THEN
   RAISE EXCEPTION 'poll response student does not belong to the poll school' USING ERRCODE='23514';
 END IF;
 IF NEW.device_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM devices device WHERE device.device_id=NEW.device_id AND device.school_id=expected_school)
   AND NOT classpilot_windows_activity_browser_parent(expected_school,NEW.student_id,NEW.device_id,NULL) THEN
   RAISE EXCEPTION 'poll response device does not belong to the poll school' USING ERRCODE='23514';
 END IF;
 IF EXISTS(SELECT 1 FROM classpilot_windows_browsers browser WHERE browser.id=NEW.device_id)
   AND NOT classpilot_windows_activity_browser_parent(expected_school,NEW.student_id,NEW.device_id,NULL) THEN
   RAISE EXCEPTION 'poll response browser parent must match the exact school and student' USING ERRCODE='23514';
 END IF;
 NEW.updated_at:=COALESCE(NEW.updated_at,clock_timestamp());
 RETURN NEW;
END $poll_school$;
`;
export const classpilotWindowsActivityParentsMigration:SchoolPilotMigration={id:"classpilot-windows-activity-parents-20261029",checksum:createHash("sha256").update(CLASSPILOT_WINDOWS_ACTIVITY_PARENTS_SQL).digest("hex"),mode:"transactional",apply:async connection=>{await connection.query(CLASSPILOT_WINDOWS_ACTIVITY_PARENTS_SQL);}};
