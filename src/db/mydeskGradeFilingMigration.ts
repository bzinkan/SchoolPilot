import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

// Existing labels remain deliberately unknown: current rosters cannot establish
// which grade a historical note was filed under.
export const MYDESK_GRADE_FILING_SQL = `
ALTER TABLE mydesk_notes ADD COLUMN IF NOT EXISTS filing_grade_level TEXT;
ALTER TABLE mydesk_notes ADD COLUMN IF NOT EXISTS filing_school_year TEXT;
ALTER TABLE mydesk_preferences ADD COLUMN IF NOT EXISTS view_by TEXT NOT NULL DEFAULT 'grades';
ALTER TABLE mydesk_preferences DROP CONSTRAINT IF EXISTS mydesk_preferences_view_by;
ALTER TABLE mydesk_preferences ADD CONSTRAINT mydesk_preferences_view_by CHECK(view_by IN ('grades','classes'));
ALTER TABLE mydesk_notes DROP CONSTRAINT IF EXISTS mydesk_notes_target_kind;
ALTER TABLE mydesk_notes ADD CONSTRAINT mydesk_notes_target_kind CHECK(target_kind IN ('general','grade','class','student'));
ALTER TABLE mydesk_notes DROP CONSTRAINT IF EXISTS mydesk_notes_target_shape;
ALTER TABLE mydesk_notes ADD CONSTRAINT mydesk_notes_target_shape CHECK(
 (target_kind='general' AND filing_group_id IS NULL AND filing_student_id IS NULL AND group_id IS NULL AND student_id IS NULL AND filing_grade_level IS NULL)
 OR (target_kind='grade' AND filing_grade_level IS NOT NULL AND filing_group_id IS NULL AND group_id IS NULL AND filing_student_id IS NULL AND student_id IS NULL)
 OR (target_kind='class' AND filing_group_id IS NOT NULL AND group_name IS NOT NULL AND filing_student_id IS NULL AND student_id IS NULL)
 OR (target_kind='student' AND filing_student_id IS NOT NULL AND student_name IS NOT NULL AND
   ((filing_group_id IS NOT NULL AND group_name IS NOT NULL) OR (filing_group_id IS NULL AND group_id IS NULL AND filing_grade_level IS NOT NULL)))
);
ALTER TABLE mydesk_notes DROP CONSTRAINT IF EXISTS mydesk_notes_grade_bounds;
ALTER TABLE mydesk_notes ADD CONSTRAINT mydesk_notes_grade_bounds CHECK(
 (filing_grade_level IS NULL OR char_length(filing_grade_level) BETWEEN 1 AND 40)
 AND (filing_school_year IS NULL OR char_length(filing_school_year) BETWEEN 1 AND 100)
);
CREATE INDEX IF NOT EXISTS mydesk_notes_grade_page ON mydesk_notes(school_id,author_id,filing_grade_level,entry_date DESC,id) WHERE status='active';
`;
export const mydeskGradeFilingMigration: SchoolPilotMigration = {
  id: "mydesk-grade-filing-20260927", checksum: createHash("sha256").update(MYDESK_GRADE_FILING_SQL).digest("hex"),
  mode: "transactional", apply: async connection => { await connection.query(MYDESK_GRADE_FILING_SQL); },
};
