import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { SchoolPilotMigration } from "./migrationLedger.js";

/**
 * PassPilot issuance rules (PASSPILOT_RULES_MODE). Four tenant tables with
 * forced RLS and the canonical tenant_isolation predicate required by
 * rlsEnforcement.ts, plus the nullable passes.rule_override_code column.
 * Every constraint and index is named to match src/schema/passpilot.ts.
 *
 * The CHECK on passes is added NOT VALID: the column is new, so every
 * existing row is NULL, and skipping validation avoids a full-table scan
 * while the ACCESS EXCLUSIVE lock is held. New writes are still checked.
 */
export const PASSPILOT_RULES_SQL = `
SET LOCAL lock_timeout = '10s';
CREATE TABLE IF NOT EXISTS passpilot_destination_policies (
  school_id TEXT NOT NULL CONSTRAINT pp_destination_policies_school_fk REFERENCES schools(id),
  destination TEXT NOT NULL CONSTRAINT pp_destination_policies_destination_check
    CHECK (destination IN ('bathroom','nurse','office','counselor','other_classroom')),
  max_concurrent INTEGER NOT NULL CONSTRAINT pp_destination_policies_max_concurrent_check
    CHECK (max_concurrent BETWEEN 1 AND 500),
  enabled BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT,
  CONSTRAINT passpilot_destination_policies_pkey PRIMARY KEY (school_id, destination)
);
ALTER TABLE passpilot_destination_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE passpilot_destination_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON passpilot_destination_policies;
CREATE POLICY tenant_isolation ON passpilot_destination_policies
  USING (school_id = current_setting('app.school_id', true) OR current_setting('app.is_super', true) = 'on')
  WITH CHECK (school_id = current_setting('app.school_id', true) OR current_setting('app.is_super', true) = 'on');

CREATE TABLE IF NOT EXISTS passpilot_pass_limits (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id TEXT NOT NULL CONSTRAINT pp_pass_limits_school_fk REFERENCES schools(id),
  student_id TEXT,
  daily_limit INTEGER CONSTRAINT pp_pass_limits_daily_check
    CHECK (daily_limit IS NULL OR daily_limit BETWEEN 0 AND 50),
  period_limit INTEGER CONSTRAINT pp_pass_limits_period_check
    CHECK (period_limit IS NULL OR period_limit BETWEEN 0 AND 50),
  enabled BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT,
  CONSTRAINT pp_pass_limits_any_limit_check CHECK (daily_limit IS NOT NULL OR period_limit IS NOT NULL),
  CONSTRAINT pp_pass_limits_student_school_fk FOREIGN KEY (school_id, student_id)
    REFERENCES students(school_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS pp_pass_limits_school_default_unique
  ON passpilot_pass_limits (school_id) WHERE student_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS pp_pass_limits_school_student_unique
  ON passpilot_pass_limits (school_id, student_id) WHERE student_id IS NOT NULL;
ALTER TABLE passpilot_pass_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE passpilot_pass_limits FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON passpilot_pass_limits;
CREATE POLICY tenant_isolation ON passpilot_pass_limits
  USING (school_id = current_setting('app.school_id', true) OR current_setting('app.is_super', true) = 'on')
  WITH CHECK (school_id = current_setting('app.school_id', true) OR current_setting('app.is_super', true) = 'on');

CREATE TABLE IF NOT EXISTS passpilot_encounter_restrictions (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id TEXT NOT NULL CONSTRAINT pp_encounter_restrictions_school_fk REFERENCES schools(id),
  student_a_id TEXT NOT NULL,
  student_b_id TEXT NOT NULL,
  reason_note TEXT CONSTRAINT pp_encounter_restrictions_note_check
    CHECK (reason_note IS NULL OR char_length(reason_note) <= 500),
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT,
  CONSTRAINT pp_encounter_restrictions_pair_order_check
    CHECK (student_a_id COLLATE "C" < student_b_id COLLATE "C"),
  CONSTRAINT pp_encounter_restrictions_pair_unique UNIQUE (school_id, student_a_id, student_b_id),
  CONSTRAINT pp_encounter_restrictions_student_a_fk FOREIGN KEY (school_id, student_a_id)
    REFERENCES students(school_id, id) ON DELETE CASCADE,
  CONSTRAINT pp_encounter_restrictions_student_b_fk FOREIGN KEY (school_id, student_b_id)
    REFERENCES students(school_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS pp_encounter_restrictions_school_student_b_idx
  ON passpilot_encounter_restrictions (school_id, student_b_id);
ALTER TABLE passpilot_encounter_restrictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE passpilot_encounter_restrictions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON passpilot_encounter_restrictions;
CREATE POLICY tenant_isolation ON passpilot_encounter_restrictions
  USING (school_id = current_setting('app.school_id', true) OR current_setting('app.is_super', true) = 'on')
  WITH CHECK (school_id = current_setting('app.school_id', true) OR current_setting('app.is_super', true) = 'on');

CREATE TABLE IF NOT EXISTS passpilot_pass_denials (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id TEXT NOT NULL CONSTRAINT pp_pass_denials_school_fk REFERENCES schools(id),
  student_id TEXT NOT NULL,
  destination TEXT NOT NULL CONSTRAINT pp_pass_denials_destination_check
    CHECK (destination IN ('bathroom','nurse','office','counselor','other_classroom','custom')),
  rule_code TEXT NOT NULL CONSTRAINT pp_pass_denials_rule_code_check
    CHECK (rule_code IN ('PASSPILOT_RULE_DAILY_LIMIT','PASSPILOT_RULE_PERIOD_LIMIT','PASSPILOT_RULE_DESTINATION_CAPACITY','PASSPILOT_RULE_ENCOUNTER')),
  issued_via TEXT NOT NULL CONSTRAINT pp_pass_denials_issued_via_check
    CHECK (issued_via IN ('teacher','kiosk','ai')),
  actor_user_id TEXT,
  teacher_id TEXT,
  class_source TEXT CONSTRAINT pp_pass_denials_class_source_check
    CHECK (class_source IS NULL OR class_source IN ('legacy_grades','classpilot_groups')),
  grade_id TEXT,
  classpilot_group_id TEXT,
  supervision_context_id TEXT,
  issuing_kiosk_session_id TEXT,
  window_kind TEXT CONSTRAINT pp_pass_denials_window_kind_check
    CHECK (window_kind IS NULL OR window_kind IN ('day','bell_period','class_window','kiosk_block')),
  details JSONB NOT NULL DEFAULT '{}'::jsonb CONSTRAINT pp_pass_denials_details_check
    CHECK (jsonb_typeof(details) = 'object'),
  overridden BOOLEAN NOT NULL DEFAULT false,
  denied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pp_pass_denials_single_class_check CHECK (NOT (grade_id IS NOT NULL AND classpilot_group_id IS NOT NULL)),
  CONSTRAINT pp_pass_denials_student_school_fk FOREIGN KEY (school_id, student_id)
    REFERENCES students(school_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS pp_pass_denials_school_denied_idx
  ON passpilot_pass_denials (school_id, denied_at);
CREATE INDEX IF NOT EXISTS pp_pass_denials_school_student_denied_idx
  ON passpilot_pass_denials (school_id, student_id, denied_at);
ALTER TABLE passpilot_pass_denials ENABLE ROW LEVEL SECURITY;
ALTER TABLE passpilot_pass_denials FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON passpilot_pass_denials;
CREATE POLICY tenant_isolation ON passpilot_pass_denials
  USING (school_id = current_setting('app.school_id', true) OR current_setting('app.is_super', true) = 'on')
  WITH CHECK (school_id = current_setting('app.school_id', true) OR current_setting('app.is_super', true) = 'on');

ALTER TABLE passes ADD COLUMN IF NOT EXISTS rule_override_code TEXT;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'passes_rule_override_code_check' AND conrelid = 'passes'::regclass
  ) THEN
    ALTER TABLE passes ADD CONSTRAINT passes_rule_override_code_check CHECK (
      rule_override_code IS NULL OR rule_override_code IN (
        'PASSPILOT_RULE_DAILY_LIMIT','PASSPILOT_RULE_PERIOD_LIMIT',
        'PASSPILOT_RULE_DESTINATION_CAPACITY','PASSPILOT_RULE_ENCOUNTER'
      )
    ) NOT VALID;
  END IF;
END $$;
`;

export const passpilotRulesMigration: SchoolPilotMigration = {
  id: "passpilot-rules-20260929",
  checksum: createHash("sha256").update(PASSPILOT_RULES_SQL).digest("hex"),
  mode: "transactional",
  apply: async (connection) => { await connection.query(PASSPILOT_RULES_SQL); },
};

export const PASSPILOT_RULES_STUDENT_ISSUED_INDEX_NAME = "passes_school_student_issued_idx";
export const PASSPILOT_RULES_ACTIVE_DESTINATION_INDEX_NAME = "passes_school_destination_active_idx";

/**
 * Per-student daily/period counts read (school_id, student_id, issued_at);
 * destination capacity reads today's active passes per destination. Both run
 * under the per-school issuance lock, so they are built online (CONCURRENTLY
 * never blocks pass writes). Each statement must run on its own: CONCURRENTLY
 * is rejected inside a transaction block, including a multi-statement string.
 */
export const PASSPILOT_RULES_STUDENT_ISSUED_INDEX_SQL = `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${PASSPILOT_RULES_STUDENT_ISSUED_INDEX_NAME}
  ON passes (school_id, student_id, issued_at)`;
export const PASSPILOT_RULES_ACTIVE_DESTINATION_INDEX_SQL = `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${PASSPILOT_RULES_ACTIVE_DESTINATION_INDEX_NAME}
  ON passes (school_id, destination) WHERE status = 'active'`;

const PASSPILOT_RULES_INDEX_BUILDS = [
  [PASSPILOT_RULES_STUDENT_ISSUED_INDEX_NAME, PASSPILOT_RULES_STUDENT_ISSUED_INDEX_SQL],
  [PASSPILOT_RULES_ACTIVE_DESTINATION_INDEX_NAME, PASSPILOT_RULES_ACTIVE_DESTINATION_INDEX_SQL],
] as const;

export const PASSPILOT_RULES_INDEXES_CONTRACT = PASSPILOT_RULES_INDEX_BUILDS
  .map(([, statement]) => statement)
  .join(";\n");

const INVALID_INDEX_SQL = `
SELECT 1 FROM pg_index idx
  JOIN pg_class rel ON rel.oid = idx.indexrelid
  JOIN pg_namespace ns ON ns.oid = rel.relnamespace
  WHERE ns.nspname = 'public' AND rel.relname = $1 AND NOT idx.indisvalid
  LIMIT 1
`;

/** Runs on one session and outside a transaction (ledger nontransactional mode). */
export async function ensurePasspilotRulesIndexesOnline(
  connection: Pick<PoolClient, "query">
): Promise<void> {
  // An interrupted CONCURRENTLY build leaves an invalid index that IF NOT
  // EXISTS would silently keep; drop it so the rebuild starts clean.
  for (const [name] of PASSPILOT_RULES_INDEX_BUILDS) {
    const invalid = await connection.query(INVALID_INDEX_SQL, [name]);
    if ((invalid.rowCount ?? 0) > 0) {
      await connection.query(`DROP INDEX CONCURRENTLY IF EXISTS public.${name}`);
    }
  }
  await connection.query("SET statement_timeout = '10min'");
  try {
    for (const [, statement] of PASSPILOT_RULES_INDEX_BUILDS) {
      await connection.query(statement);
    }
  } finally {
    await connection.query("RESET statement_timeout");
  }
}

export const passpilotRulesIndexesMigration: SchoolPilotMigration = {
  id: "passpilot-rules-indexes-online-20260929",
  checksum: createHash("sha256").update(PASSPILOT_RULES_INDEXES_CONTRACT).digest("hex"),
  mode: "nontransactional",
  apply: async (connection) => { await ensurePasspilotRulesIndexesOnline(connection); },
};
