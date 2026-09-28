import { MYDESK_IMPORTS_SQL } from "../../src/db/mydeskImportsMigration.js";
import { MYDESK_WORKSPACE_SQL } from "../../src/db/mydeskWorkspaceMigration.js";
import { SCHOOL_DISCIPLINE_SQL } from "../../src/db/schoolDisciplineMigration.js";
import { MYDESK_GRADE_FILING_SQL } from "../../src/db/mydeskGradeFilingMigration.js";
import { MYDESK_IMPORT_DESTINATION_SQL } from "../../src/db/mydeskImportDestinationMigration.js";
import { SCHOOL_DISCIPLINE_REDESIGN_SQL } from "../../src/db/schoolDisciplineRedesignMigration.js";
import { STUDENT_INFORMATION_REDESIGN_SQL } from "../../src/db/studentInformationRedesignMigration.js";
import { IMPORT_PROCESSING_STAGES_SQL } from "../../src/db/importProcessingStagesMigration.js";

/** HTTP/service fixtures run the same additive chain as a released application. */
export async function applyMyDeskRedesign(database: { query(sql: string): Promise<unknown> }) {
  for (const sql of [MYDESK_IMPORTS_SQL, MYDESK_WORKSPACE_SQL, SCHOOL_DISCIPLINE_SQL,
    MYDESK_GRADE_FILING_SQL, MYDESK_IMPORT_DESTINATION_SQL, SCHOOL_DISCIPLINE_REDESIGN_SQL,
    STUDENT_INFORMATION_REDESIGN_SQL, IMPORT_PROCESSING_STAGES_SQL]) await database.query(sql);
}
