import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

/**
 * The schedule boundary migration seeds one row per school so the boundary
 * queue always has something to wake, and it seeds the document as `{}`. A
 * school that never opened the scheduling editor therefore stores an empty
 * document where every reader expects a versioned one. Rewrite exactly those
 * rows to the default document so the stored state matches what the editor
 * would have written. Readers tolerate `{}` as well, which covers rows the
 * boundary insert seeds for schools created after this runs.
 */
export const CLASSPILOT_SCHEDULE_CONFIG_REPAIR_SQL = `
UPDATE classpilot_school_schedules
  SET config = '{"schemaVersion":1,"yearStart":null,"yearEnd":null,"cycleAnchorDate":null,"cycleAnchorDay":"A","periods":[],"profiles":[],"defaultProfileId":null,"weekdayProfiles":{},"dateOverrides":{},"scheduleProfiles":[],"profileApplications":[]}'::jsonb
  WHERE config = '{}'::jsonb;
`;

export const classpilotScheduleConfigRepairMigration: SchoolPilotMigration = {
  id: "classpilot-schedule-config-repair-20260916",
  checksum: createHash("sha256").update(CLASSPILOT_SCHEDULE_CONFIG_REPAIR_SQL).digest("hex"),
  mode: "transactional",
  apply: async (connection) => { await connection.query(CLASSPILOT_SCHEDULE_CONFIG_REPAIR_SQL); },
};
