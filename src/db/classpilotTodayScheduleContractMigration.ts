import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";
import type { PoolClient } from "pg";
import { hasCanonicalTenantPolicy, readRlsCatalog } from "./rlsEnforcement.js";
import { classpilotTodayScheduleMigration, CLASSPILOT_TODAY_CONTRACT_MIGRATION_ID } from "./classpilotTodayScheduleMigration.js";

// This contract is deliberately excluded from ordinary expansion. Only the
// guarded CLI first admits it; future migration plans retain completed entries.
export const CLASSPILOT_TODAY_SCHEDULE_CONTRACT_SQL = `
SET LOCAL lock_timeout = '10s';
LOCK TABLE public.classpilot_scheduled_conflicts IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE candidate RECORD; expected_definition TEXT; expected_count INTEGER := 0;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.schema_migrations WHERE id='${classpilotTodayScheduleMigration.id}'
    AND status='complete' AND checksum='${classpilotTodayScheduleMigration.checksum}') THEN
    RAISE EXCEPTION 'Today expansion ledger is not complete and exact' USING ERRCODE='23514';
  END IF;
  IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_policy p ON p.polrelid=c.oid WHERE n.nspname='public'
    AND c.relname IN ('classpilot_today_changes','classpilot_today_occurrences')
    AND c.relrowsecurity AND c.relforcerowsecurity AND p.polname='tenant_isolation'
    AND p.polcmd='*' AND p.polpermissive AND p.polroles=ARRAY[0::oid]
    AND (SELECT count(*) FROM pg_policy other WHERE other.polrelid=c.oid)=1
    AND pg_get_expr(p.polqual,p.polrelid)=$tenant$((school_id = current_setting('app.school_id'::text, true)) OR (current_setting('app.is_super'::text, true) = 'on'::text))$tenant$
    AND pg_get_expr(p.polwithcheck,p.polrelid)=$tenant$((school_id = current_setting('app.school_id'::text, true)) OR (current_setting('app.is_super'::text, true) = 'on'::text))$tenant$) <> 2 THEN
    RAISE EXCEPTION 'Today tables require both forced tenant policies' USING ERRCODE='23514';
  END IF;
  FOR candidate IN SELECT index_class.relname, pg_get_indexdef(i.indexrelid) AS definition,
    i.indisunique AND i.indisvalid AND i.indisready AND i.indislive AS ready
    FROM pg_index i JOIN pg_class index_class ON index_class.oid=i.indexrelid
    JOIN pg_class parent ON parent.oid=i.indrelid JOIN pg_namespace n ON n.oid=parent.relnamespace
    WHERE n.nspname='public' AND parent.relname='classpilot_scheduled_conflicts'
      AND index_class.relname IN ('classpilot_scheduled_conflicts_unique','classpilot_scheduled_conflicts_legacy_unique','cp_scheduled_conflicts_dated_occurrence_unique')
  LOOP
    expected_definition := CASE candidate.relname
      WHEN 'classpilot_scheduled_conflicts_unique' THEN 'CREATE UNIQUE INDEX classpilot_scheduled_conflicts_unique ON public.classpilot_scheduled_conflicts USING btree (school_id, group_id, scheduled_date, block_start_time)'
      WHEN 'classpilot_scheduled_conflicts_legacy_unique' THEN 'CREATE UNIQUE INDEX classpilot_scheduled_conflicts_legacy_unique ON public.classpilot_scheduled_conflicts USING btree (school_id, group_id, scheduled_date, block_start_time) WHERE (scheduled_occurrence_id IS NULL)'
      WHEN 'cp_scheduled_conflicts_dated_occurrence_unique' THEN 'CREATE UNIQUE INDEX cp_scheduled_conflicts_dated_occurrence_unique ON public.classpilot_scheduled_conflicts USING btree (school_id, scheduled_occurrence_id) WHERE (scheduled_occurrence_id IS NOT NULL)'
    END;
    IF NOT candidate.ready OR candidate.definition IS DISTINCT FROM expected_definition THEN
      RAISE EXCEPTION 'Today conflict index contract differs' USING ERRCODE='23514';
    END IF;
    IF candidate.relname <> 'classpilot_scheduled_conflicts_unique' THEN expected_count := expected_count+1; END IF;
  END LOOP;
  IF expected_count <> 2 THEN
    RAISE EXCEPTION 'Today conflict replacement indexes are missing' USING ERRCODE='23514';
  END IF;
END $$;
DROP INDEX IF EXISTS public.classpilot_scheduled_conflicts_unique;
`;

export const classpilotTodayScheduleContractMigration: SchoolPilotMigration = {
  id: CLASSPILOT_TODAY_CONTRACT_MIGRATION_ID,
  checksum: createHash("sha256").update(CLASSPILOT_TODAY_SCHEDULE_CONTRACT_SQL).digest("hex"),
  mode: "transactional",
  apply: async connection => { await connection.query(CLASSPILOT_TODAY_SCHEDULE_CONTRACT_SQL); },
};

/** Read-only postcondition, including when the immutable ledger already skipped. */
export async function verifyClasspilotTodayScheduleContract(connection: Pick<PoolClient, "query">): Promise<void> {
  const expected = new Map([
    ["classpilot_scheduled_conflicts_legacy_unique", "CREATE UNIQUE INDEX classpilot_scheduled_conflicts_legacy_unique ON public.classpilot_scheduled_conflicts USING btree (school_id, group_id, scheduled_date, block_start_time) WHERE (scheduled_occurrence_id IS NULL)"],
    ["cp_scheduled_conflicts_dated_occurrence_unique", "CREATE UNIQUE INDEX cp_scheduled_conflicts_dated_occurrence_unique ON public.classpilot_scheduled_conflicts USING btree (school_id, scheduled_occurrence_id) WHERE (scheduled_occurrence_id IS NOT NULL)"],
  ]);
  const result = await connection.query<{ name: string; definition: string; ready: boolean }>(`SELECT index_class.relname AS name,
    pg_get_indexdef(i.indexrelid) AS definition, i.indisunique AND i.indisvalid AND i.indisready AND i.indislive AS ready
    FROM pg_index i JOIN pg_class index_class ON index_class.oid=i.indexrelid
    JOIN pg_class parent ON parent.oid=i.indrelid JOIN pg_namespace n ON n.oid=parent.relnamespace
    WHERE n.nspname='public' AND parent.relname='classpilot_scheduled_conflicts'
      AND index_class.relname=ANY($1::text[])`, [[...expected.keys(), "classpilot_scheduled_conflicts_unique"]]);
  const tables = ["classpilot_today_changes", "classpilot_today_occurrences"];
  const catalog = await readRlsCatalog(connection, tables);
  const ledger = await connection.query(`SELECT 1 FROM public.schema_migrations WHERE id=$1 AND checksum=$2 AND status='complete'`,
    [classpilotTodayScheduleContractMigration.id, classpilotTodayScheduleContractMigration.checksum]);
  if (result.rows.length !== expected.size || result.rows.some(row => !row.ready || expected.get(row.name) !== row.definition)
    || catalog.length !== tables.length || catalog.some(row => !hasCanonicalTenantPolicy(row)) || ledger.rowCount !== 1) {
    throw new Error("TODAY_SCHEDULE_CONTRACT_POSTCONDITION");
  }
}
