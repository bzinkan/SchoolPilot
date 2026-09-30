import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

/**
 * Monitored Browser Time rollups (Digital Usage). One tenant table with forced
 * RLS and the canonical tenant_isolation predicate required by
 * rlsEnforcement.ts. Every constraint and index is named to match
 * src/schema/classpilot.ts.
 *
 * Same-school parents: students (CASCADE: a hard-deleted student leaves no
 * usage), and the class and teaching session (SET NULL on the one column, so
 * a removed class or session keeps the student's time without attribution).
 * The grain is unique with COALESCE over the nullable attribution columns;
 * NULLS NOT DISTINCT is not needed.
 *
 * The rollup rewrites a school-day hourly (DELETE + INSERT in one
 * transaction), so the table tunes autovacuum to reclaim that churn sooner.
 */
export const CLASSPILOT_USAGE_ROLLUPS_SQL = `
SET LOCAL lock_timeout = '10s';
CREATE TABLE IF NOT EXISTS classpilot_usage_rollups (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id TEXT NOT NULL CONSTRAINT cp_usage_rollups_school_fk REFERENCES schools(id),
  usage_date DATE NOT NULL,
  student_id TEXT NOT NULL,
  class_id TEXT,
  session_id TEXT,
  domain TEXT NOT NULL DEFAULT '' CONSTRAINT cp_usage_rollups_domain_check
    CHECK (char_length(domain) <= 253),
  classification TEXT NOT NULL CONSTRAINT cp_usage_rollups_classification_check
    CHECK (classification IN ('educational','non-educational','unknown')),
  seconds INTEGER NOT NULL CONSTRAINT cp_usage_rollups_seconds_check CHECK (seconds >= 0),
  heartbeat_count INTEGER NOT NULL CONSTRAINT cp_usage_rollups_heartbeat_count_check
    CHECK (heartbeat_count >= 0),
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cp_usage_rollups_student_school_fk FOREIGN KEY (school_id, student_id)
    REFERENCES students(school_id, id) ON DELETE CASCADE,
  CONSTRAINT cp_usage_rollups_class_school_fk FOREIGN KEY (school_id, class_id)
    REFERENCES groups(school_id, id) ON DELETE SET NULL (class_id),
  CONSTRAINT cp_usage_rollups_session_school_fk FOREIGN KEY (school_id, session_id)
    REFERENCES teaching_sessions(school_id, id) ON DELETE SET NULL (session_id)
);
-- A Drizzle-pushed table carries NO ACTION class/session keys (Drizzle cannot
-- express the column-list SET NULL form). Reconcile only when they differ.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'classpilot_usage_rollups'::regclass
      AND conname = 'cp_usage_rollups_class_school_fk'
      AND confdeltype = 'n'
      AND confdelsetcols = ARRAY[(
        SELECT attnum FROM pg_attribute
        WHERE attrelid = 'classpilot_usage_rollups'::regclass AND attname = 'class_id'
      )]::int2[]
  ) THEN
    ALTER TABLE classpilot_usage_rollups DROP CONSTRAINT IF EXISTS cp_usage_rollups_class_school_fk;
    ALTER TABLE classpilot_usage_rollups ADD CONSTRAINT cp_usage_rollups_class_school_fk
      FOREIGN KEY (school_id, class_id) REFERENCES groups(school_id, id) ON DELETE SET NULL (class_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'classpilot_usage_rollups'::regclass
      AND conname = 'cp_usage_rollups_session_school_fk'
      AND confdeltype = 'n'
      AND confdelsetcols = ARRAY[(
        SELECT attnum FROM pg_attribute
        WHERE attrelid = 'classpilot_usage_rollups'::regclass AND attname = 'session_id'
      )]::int2[]
  ) THEN
    ALTER TABLE classpilot_usage_rollups DROP CONSTRAINT IF EXISTS cp_usage_rollups_session_school_fk;
    ALTER TABLE classpilot_usage_rollups ADD CONSTRAINT cp_usage_rollups_session_school_fk
      FOREIGN KEY (school_id, session_id) REFERENCES teaching_sessions(school_id, id) ON DELETE SET NULL (session_id);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS cp_usage_rollups_grain_unique
  ON classpilot_usage_rollups (school_id, usage_date, student_id, (COALESCE(class_id, '')), (COALESCE(session_id, '')), domain, classification);
CREATE INDEX IF NOT EXISTS cp_usage_rollups_school_date_idx
  ON classpilot_usage_rollups (school_id, usage_date);
CREATE INDEX IF NOT EXISTS cp_usage_rollups_school_student_date_idx
  ON classpilot_usage_rollups (school_id, student_id, usage_date);
CREATE INDEX IF NOT EXISTS cp_usage_rollups_school_class_date_idx
  ON classpilot_usage_rollups (school_id, class_id, usage_date) WHERE class_id IS NOT NULL;
ALTER TABLE classpilot_usage_rollups SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05);
ALTER TABLE classpilot_usage_rollups ENABLE ROW LEVEL SECURITY;
ALTER TABLE classpilot_usage_rollups FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON classpilot_usage_rollups;
CREATE POLICY tenant_isolation ON classpilot_usage_rollups
  USING (school_id = current_setting('app.school_id', true) OR current_setting('app.is_super', true) = 'on')
  WITH CHECK (school_id = current_setting('app.school_id', true) OR current_setting('app.is_super', true) = 'on');
`;

export const classpilotUsageRollupsMigration: SchoolPilotMigration = {
  id: "classpilot-usage-rollups-20260929",
  checksum: createHash("sha256").update(CLASSPILOT_USAGE_ROLLUPS_SQL).digest("hex"),
  mode: "transactional",
  apply: async (connection) => { await connection.query(CLASSPILOT_USAGE_ROLLUPS_SQL); },
};
