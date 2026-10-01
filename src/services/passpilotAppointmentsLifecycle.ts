import type { Pool } from "pg";

/** Worker-only bounded maintenance, including after feature/license rollback.
 * It never issues, expires, returns or cancels a pass. A retained open pass
 * keeps only its appointment linkage; private notes expire independently. */
export async function maintainPasspilotAppointments(connection: Pick<Pool, "query">, now = new Date(), limit = 500) {
  const batch = Math.max(1, Math.min(limit, 5000));
  // Safe during schema-first expansion before the table exists. Avoid any
  // runtime mode dependency: rollback must continue scrubbing retained notes.
  const exists = await connection.query("SELECT to_regclass('public.passpilot_appointments') IS NOT NULL AS present");
  if (!exists.rows[0]?.present) return { missed: 0, scrubbed: 0, deleted: 0 };
  const missed = await connection.query(`WITH due AS (
    SELECT id FROM passpilot_appointments WHERE status='scheduled' AND ends_at<=$1
    ORDER BY ends_at LIMIT $2 FOR UPDATE SKIP LOCKED
  ) UPDATE passpilot_appointments AS appointment SET status='missed', missed_at=$1, updated_at=$1, revision=revision+1
    FROM due WHERE appointment.id=due.id AND appointment.status='scheduled'`, [now, batch]);
  const scrubbed = await connection.query(`WITH due AS (
    SELECT id FROM passpilot_appointments WHERE retained_until<=$1 AND notes_scrubbed_at IS NULL
    ORDER BY retained_until LIMIT $2 FOR UPDATE SKIP LOCKED
  ) UPDATE passpilot_appointments AS appointment SET staff_notes=NULL, create_fingerprint=repeat('0',64),
    notes_scrubbed_at=$1, updated_at=$1 FROM due WHERE appointment.id=due.id`, [now, batch]);
  const deleted = await connection.query(`WITH due AS (
    SELECT appointment.id FROM passpilot_appointments AS appointment WHERE appointment.retained_until<=$1
      AND NOT EXISTS (SELECT 1 FROM passes WHERE passes.school_id=appointment.school_id
        AND passes.student_id=appointment.student_id AND passes.id=appointment.pass_id AND passes.status='active')
    ORDER BY appointment.retained_until LIMIT $2 FOR UPDATE OF appointment SKIP LOCKED
  ) DELETE FROM passpilot_appointments AS appointment USING due WHERE appointment.id=due.id`, [now, batch]);
  return { missed: missed.rowCount ?? 0, scrubbed: scrubbed.rowCount ?? 0, deleted: deleted.rowCount ?? 0 };
}
