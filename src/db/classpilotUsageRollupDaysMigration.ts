import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

// Additive: never infer completion from pre-ledger aggregate rows. A compatible
// writer replaces aggregates and then commits this row in the same transaction.
export const CLASSPILOT_USAGE_ROLLUP_DAYS_SQL = `
SET LOCAL lock_timeout = '10s';
CREATE TABLE IF NOT EXISTS classpilot_usage_rollup_days (
  school_id TEXT NOT NULL CONSTRAINT cp_usage_days_school_fk REFERENCES schools(id) ON DELETE CASCADE,
  usage_date DATE NOT NULL,
  day_start_at TIMESTAMPTZ NOT NULL,
  day_end_at TIMESTAMPTZ NOT NULL,
  processed_through TIMESTAMPTZ NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_final BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT cp_usage_days_school_date_unique UNIQUE (school_id, usage_date),
  CONSTRAINT cp_usage_days_window_check CHECK (
    day_start_at < day_end_at AND processed_through >= day_start_at
    AND processed_through <= day_end_at AND (NOT is_final OR processed_through = day_end_at)
  )
);
ALTER TABLE classpilot_usage_rollup_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE classpilot_usage_rollup_days FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON classpilot_usage_rollup_days;
CREATE POLICY tenant_isolation ON classpilot_usage_rollup_days
  USING (school_id = current_setting('app.school_id', true) OR current_setting('app.is_super', true) = 'on')
  WITH CHECK (school_id = current_setting('app.school_id', true) OR current_setting('app.is_super', true) = 'on');

-- Statement-level transition tables keep this bounded by affected school/days,
-- rather than one ledger query for every aggregate row. Direct old writers and
-- cleanup paths invalidate coverage; only the new atomic writer restores it.
-- FK CASCADE/SET NULL preserves a computed snapshot of the remaining retained
-- data. Transition-table statement triggers can run after trigger nesting has
-- unwound, so pg_trigger_depth is not a reliable FK discriminator. Instead,
-- recognize only missing-parent DELETEs and exact missing-parent SET NULLs.
CREATE OR REPLACE FUNCTION invalidate_classpilot_usage_days_new() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM classpilot_usage_rollup_days AS day USING (
    SELECT DISTINCT school_id, usage_date FROM new_usage_rows
  ) AS changed WHERE day.school_id = changed.school_id AND day.usage_date = changed.usage_date;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION invalidate_classpilot_usage_days_old() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM classpilot_usage_rollup_days AS day USING (
    SELECT DISTINCT changed.school_id, changed.usage_date FROM old_usage_rows AS changed
    WHERE EXISTS (SELECT 1 FROM students AS student
      WHERE student.school_id = changed.school_id AND student.id = changed.student_id)
  ) AS changed WHERE day.school_id = changed.school_id AND day.usage_date = changed.usage_date;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION invalidate_classpilot_usage_days_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  WITH retained AS (
    SELECT prior.id FROM old_usage_rows AS prior JOIN new_usage_rows AS next ON next.id = prior.id
    WHERE (to_jsonb(prior) - 'class_id' - 'session_id') = (to_jsonb(next) - 'class_id' - 'session_id')
      AND (prior.class_id IS DISTINCT FROM next.class_id OR prior.session_id IS DISTINCT FROM next.session_id)
      AND (prior.class_id IS NOT DISTINCT FROM next.class_id OR (
        prior.class_id IS NOT NULL AND next.class_id IS NULL AND NOT EXISTS (
          SELECT 1 FROM groups AS parent WHERE parent.school_id = prior.school_id AND parent.id = prior.class_id)))
      AND (prior.session_id IS NOT DISTINCT FROM next.session_id OR (
        prior.session_id IS NOT NULL AND next.session_id IS NULL AND NOT EXISTS (
          SELECT 1 FROM teaching_sessions AS parent WHERE parent.school_id = prior.school_id AND parent.id = prior.session_id)))
  ), changed AS (
    SELECT school_id, usage_date FROM old_usage_rows WHERE id NOT IN (SELECT id FROM retained)
    UNION SELECT school_id, usage_date FROM new_usage_rows WHERE id NOT IN (SELECT id FROM retained)
  )
  DELETE FROM classpilot_usage_rollup_days AS day USING changed
    WHERE day.school_id = changed.school_id AND day.usage_date = changed.usage_date;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS cp_usage_days_insert ON classpilot_usage_rollups;
CREATE TRIGGER cp_usage_days_insert AFTER INSERT ON classpilot_usage_rollups
  REFERENCING NEW TABLE AS new_usage_rows FOR EACH STATEMENT EXECUTE FUNCTION invalidate_classpilot_usage_days_new();
DROP TRIGGER IF EXISTS cp_usage_days_delete ON classpilot_usage_rollups;
CREATE TRIGGER cp_usage_days_delete AFTER DELETE ON classpilot_usage_rollups
  REFERENCING OLD TABLE AS old_usage_rows FOR EACH STATEMENT EXECUTE FUNCTION invalidate_classpilot_usage_days_old();
DROP TRIGGER IF EXISTS cp_usage_days_update ON classpilot_usage_rollups;
CREATE TRIGGER cp_usage_days_update AFTER UPDATE ON classpilot_usage_rollups
  REFERENCING OLD TABLE AS old_usage_rows NEW TABLE AS new_usage_rows
  FOR EACH STATEMENT EXECUTE FUNCTION invalidate_classpilot_usage_days_update();
`;

export const classpilotUsageRollupDaysMigration: SchoolPilotMigration = {
  id: "classpilot-usage-rollup-days-20260930",
  checksum: createHash("sha256").update(CLASSPILOT_USAGE_ROLLUP_DAYS_SQL).digest("hex"),
  mode: "transactional",
  apply: async (connection) => { await connection.query(CLASSPILOT_USAGE_ROLLUP_DAYS_SQL); },
};
