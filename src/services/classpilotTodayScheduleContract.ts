import { sql } from "drizzle-orm";
import type { db } from "../db.js";
import { classpilotTodayScheduleContractMigration } from "../db/classpilotTodayScheduleContractMigration.js";

/** Metadata read only: a write flag must never substitute for staged contraction. */
export async function assertTodayScheduleWriteContract(database: Pick<typeof db, "execute">): Promise<void> {
  const result = await database.execute(sql`SELECT
    to_regclass('public.classpilot_scheduled_conflicts_unique') IS NULL AS contracted,
    EXISTS(SELECT 1 FROM public.schema_migrations WHERE id=${classpilotTodayScheduleContractMigration.id}
      AND checksum=${classpilotTodayScheduleContractMigration.checksum} AND status='complete') AS recorded`);
  if (result.rows[0]?.contracted !== true || result.rows[0]?.recorded !== true) throw Object.assign(
    new Error("Today's schedule is not available until deployment verification finishes."), {
      status: 503, code: "TODAY_SCHEDULE_DEPLOYMENT_PENDING",
    });
}
