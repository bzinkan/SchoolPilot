import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLASSPILOT_USAGE_ROLLUP_BUDGET_END_MINUTE,
  CLASSPILOT_USAGE_ROLLUP_CHANGED_SQL,
  CLASSPILOT_USAGE_ROLLUP_COMPLETE_SQL,
  CLASSPILOT_USAGE_ROLLUP_DELETE_SQL,
  CLASSPILOT_USAGE_ROLLUP_INSERT_SQL,
  CLASSPILOT_USAGE_ROLLUP_LAST_COMPUTED_SQL,
  CLASSPILOT_USAGE_ROLLUP_LOCK_SQL,
  CLASSPILOT_USAGE_ROLLUP_SETTINGS_SQL,
  CLASSPILOT_USAGE_ROLLUP_TRACKING_EVENTS_SQL,
  classpilotUsageExclusions,
  classpilotUsageExclusionsJson,
  classpilotUsageRetentionHorizon,
  classpilotUsageRollupDay,
  classpilotUsageRollupDays,
  classpilotUsageRollupDeadline,
  classpilotUsageRollupMetricRecord,
  classpilotUsageTrackingPolicy,
  rollupClasspilotUsageDay,
  runClasspilotUsageRollup,
  type ClasspilotUsageRollupPool,
} from "../src/services/classpilotUsageRollup.ts";
import { CLASSPILOT_USAGE_ROLLUP_TIMEOUT_SQL } from "../src/services/classpilotUsageRollupAdmission.ts";
import {
  CLASSPILOT_USAGE_ROLLUP_RLS_TABLES,
  parseClasspilotUsageModes,
  readClasspilotDigitalUsageMode,
  readClasspilotUsageRollupMode,
} from "../src/config/classpilotUsageModes.ts";
import {
  CLASSPILOT_USAGE_ROLLUPS_SQL,
  classpilotUsageRollupsMigration,
} from "../src/db/classpilotUsageRollupsMigration.ts";
import { CLASSPILOT_USAGE_ROLLUP_DAYS_SQL, classpilotUsageRollupDaysMigration } from "../src/db/classpilotUsageRollupDaysMigration.ts";
import {
  STAFF_IDENTITY_CONTRACT_MIGRATION_IDS,
  schoolPilot27ExpandMigrations,
  schoolPilot27Migrations,
} from "../src/db/migrations27.ts";
import { passpilotRulesIndexesMigration } from "../src/db/passpilotRulesMigration.ts";

const TENANT_PREDICATE =
  "school_id = current_setting('app.school_id', true) OR current_setting('app.is_super', true) = 'on'";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = (path: string) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n");
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  assert.ok(from >= 0, `missing marker: ${start}`);
  const to = text.indexOf(end, from + start.length);
  assert.ok(to > from, `missing marker after ${start}: ${end}`);
  return text.slice(from, to);
}

const TENANT_TABLES = [
  "heartbeats",
  "students",
  "classpilot_ai_decisions",
  "classpilot_session_students",
  "teaching_sessions",
  "groups",
  "classpilot_usage_rollups",
  "classpilot_usage_rollup_days",
  "classpilot_monitoring_events",
  "settings",
];
const ROLLUP_STATEMENTS = {
  CLASSPILOT_USAGE_ROLLUP_LOCK_SQL,
  CLASSPILOT_USAGE_ROLLUP_DELETE_SQL,
  CLASSPILOT_USAGE_ROLLUP_SETTINGS_SQL,
  CLASSPILOT_USAGE_ROLLUP_TRACKING_EVENTS_SQL,
  CLASSPILOT_USAGE_ROLLUP_LAST_COMPUTED_SQL,
  CLASSPILOT_USAGE_ROLLUP_CHANGED_SQL,
  CLASSPILOT_USAGE_ROLLUP_COMPLETE_SQL,
  CLASSPILOT_USAGE_ROLLUP_INSERT_SQL,
};

function cte(statement: string, name: string, next: string): string {
  return between(statement, `${name} AS`, `${next} AS`);
}

describe("classpilot_usage_rollups migration", () => {
  it("adds the separately checksummed forced-RLS computation ledger before the contract", () => {
    const migration = classpilotUsageRollupDaysMigration;
    assert.equal(migration.id, "classpilot-usage-rollup-days-20260930");
    assert.equal(migration.mode, "transactional");
    assert.equal(migration.checksum, sha256(CLASSPILOT_USAGE_ROLLUP_DAYS_SQL));
    const ids = schoolPilot27Migrations.map((entry) => entry.id);
    assert.equal(ids.indexOf(migration.id), ids.indexOf(classpilotUsageRollupsMigration.id) + 1);
    assert.ok(ids.indexOf(migration.id) < ids.indexOf(STAFF_IDENTITY_CONTRACT_MIGRATION_IDS[0]));
    assert.ok(schoolPilot27ExpandMigrations.includes(migration));
    const startup = source("src/index.ts");
    assert.ok(startup.indexOf("await pool.query(CLASSPILOT_USAGE_ROLLUP_DAYS_SQL)") > startup.indexOf("await pool.query(CLASSPILOT_USAGE_ROLLUPS_SQL)"));
    assert.ok(CLASSPILOT_USAGE_ROLLUP_DAYS_SQL.includes("ALTER TABLE classpilot_usage_rollup_days FORCE ROW LEVEL SECURITY"));
    assert.ok(CLASSPILOT_USAGE_ROLLUP_DAYS_SQL.includes(`USING (${TENANT_PREDICATE})`));
    for (const name of ["cp_usage_days_school_fk", "cp_usage_days_school_date_unique", "cp_usage_days_window_check"])
      assert.ok(source("src/schema/classpilot.ts").includes(`"${name}"`));
  });
  it("is a checksummed transactional expand migration before the staff identity contract", () => {
    assert.equal(classpilotUsageRollupsMigration.id, "classpilot-usage-rollups-20260929");
    assert.equal(classpilotUsageRollupsMigration.mode, "transactional");
    assert.equal(classpilotUsageRollupsMigration.checksum, sha256(CLASSPILOT_USAGE_ROLLUPS_SQL));
    const ids = schoolPilot27Migrations.map((migration) => migration.id);
    const rules = ids.indexOf(passpilotRulesIndexesMigration.id);
    const rollups = ids.indexOf(classpilotUsageRollupsMigration.id);
    const contract = ids.indexOf(STAFF_IDENTITY_CONTRACT_MIGRATION_IDS[0]);
    // Later expand migrations (the precise Flight Path resources column) sit
    // between this one and the contract; only the expand-before-contract order
    // matters.
    assert.ok(rules >= 0 && rollups === rules + 1 && contract > rollups);
    assert.equal(ids.filter((id) => id === classpilotUsageRollupsMigration.id).length, 1);
    assert.ok(schoolPilot27ExpandMigrations.some((migration) => migration.id === classpilotUsageRollupsMigration.id));
  });

  it("mirrors the ledger in non-production startup after the PassPilot rules indexes", () => {
    const startup = between(source("src/index.ts"), "export async function runStartupMigrations", "async function startServer");
    const rules = startup.indexOf("await pool.query(PASSPILOT_RULES_ACTIVE_DESTINATION_INDEX_SQL);");
    const rollups = startup.indexOf("await pool.query(CLASSPILOT_USAGE_ROLLUPS_SQL);");
    assert.ok(rules >= 0 && rollups > rules);
    assert.match(startup, /await pool\.query\(IMPORT_PROCESSING_STAGES_SQL\);\s+await pool\.query\(SHARED_TEACHING_RESOURCES_EXPAND_SQL\);/);
  });

  it("forces the canonical tenant policy and same-school parents", () => {
    const sql = CLASSPILOT_USAGE_ROLLUPS_SQL;
    assert.match(sql, /school_id TEXT NOT NULL CONSTRAINT cp_usage_rollups_school_fk REFERENCES schools\(id\)/);
    assert.ok(sql.includes("ALTER TABLE classpilot_usage_rollups ENABLE ROW LEVEL SECURITY;"));
    assert.ok(sql.includes("ALTER TABLE classpilot_usage_rollups FORCE ROW LEVEL SECURITY;"));
    assert.ok(sql.includes("DROP POLICY IF EXISTS tenant_isolation ON classpilot_usage_rollups;"));
    assert.ok(sql.includes(
      `CREATE POLICY tenant_isolation ON classpilot_usage_rollups\n  USING (${TENANT_PREDICATE})\n  WITH CHECK (${TENANT_PREDICATE});`
    ));
    assert.match(sql, /FOREIGN KEY \(school_id, student_id\)\s+REFERENCES students\(school_id, id\) ON DELETE CASCADE/);
    assert.match(sql, /FOREIGN KEY \(school_id, class_id\)\s+REFERENCES groups\(school_id, id\) ON DELETE SET NULL \(class_id\)/);
    assert.match(sql, /FOREIGN KEY \(school_id, session_id\)\s+REFERENCES teaching_sessions\(school_id, id\) ON DELETE SET NULL \(session_id\)/);
    assert.match(sql, /CHECK \(classification IN \('educational','non-educational','unknown'\)\)/);
    assert.match(sql, /cp_usage_rollups_grain_unique\s+ON classpilot_usage_rollups \(school_id, usage_date, student_id, \(COALESCE\(class_id, ''\)\), \(COALESCE\(session_id, ''\)\), domain, classification\)/);
    assert.match(sql, /cp_usage_rollups_school_class_date_idx\s+ON classpilot_usage_rollups \(school_id, class_id, usage_date\) WHERE class_id IS NOT NULL/);
    assert.doesNotMatch(sql, /device_id/);
  });

  it("declares every named constraint and index in the pushed Drizzle schema", () => {
    const schema = source("src/schema/classpilot.ts");
    const names = new Set([
      ...[...CLASSPILOT_USAGE_ROLLUPS_SQL.matchAll(/CONSTRAINT (cp_usage_rollups_\w+)/g)].map((match) => match[1]!),
      ...[...CLASSPILOT_USAGE_ROLLUPS_SQL.matchAll(/INDEX IF NOT EXISTS (\w+)/g)].map((match) => match[1]!),
    ]);
    assert.ok(names.size >= 12, `expected the full constraint and index set, got ${names.size}`);
    for (const name of names) assert.ok(schema.includes(`"${name}"`), `${name} must be declared in src/schema/classpilot.ts`);
    assert.doesNotMatch(schema, /screen time/i);
  });
});

describe("Monitored Browser Time rollup SQL", () => {
  it("drops heartbeats without a student and compares raw half-open timestamps", () => {
    const observed = cte(CLASSPILOT_USAGE_ROLLUP_INSERT_SQL, "observed", "excluded");
    assert.match(observed, /heartbeat\.student_id IS NOT NULL/);
    assert.match(observed, /heartbeat\."timestamp" >= \$2::timestamp\s+AND heartbeat\."timestamp" < \$3::timestamp/);
    assert.match(observed, /heartbeat\.student_id = student_scope\.id/);
    assert.match(CLASSPILOT_USAGE_ROLLUP_INSERT_SQL, /FROM students AS student_scope\s+CROSS JOIN LATERAL/);
    assert.match(CLASSPILOT_USAGE_ROLLUP_INSERT_SQL, /WHERE student_scope\.school_id = \$1/);
    for (const statement of Object.values(ROLLUP_STATEMENTS)) {
      assert.doesNotMatch(statement, /"timestamp"\s+AT TIME ZONE|observed_at\s+AT TIME ZONE/i);
    }
  });

  it("counts one observation per student per second across devices and caps attribution at 15 seconds", () => {
    assert.match(CLASSPILOT_USAGE_ROLLUP_INSERT_SQL, /DISTINCT ON \(student_id, date_trunc\('second', observed_at\)\)/);
    assert.match(CLASSPILOT_USAGE_ROLLUP_INSERT_SQL, /LEAST\(\s+15::numeric,/);
    assert.match(CLASSPILOT_USAGE_ROLLUP_INSERT_SQL, /LEAD\(observation\.observed_at\) OVER student_timeline/);
    assert.match(CLASSPILOT_USAGE_ROLLUP_INSERT_SQL, /EXTRACT\(EPOCH FROM \(\$3::timestamp - observation\.observed_at\)\)/);
    assert.match(CLASSPILOT_USAGE_ROLLUP_INSERT_SQL, /MIN\(excluded\.start_at\)/);
    assert.match(CLASSPILOT_USAGE_ROLLUP_INSERT_SQL, /PARTITION BY observation\.student_id ORDER BY observation\.observed_at, observation\.id/);
  });

  it("keeps domains only for http(s) URLs and prefers the newest AI decision with the teacher-intent exemption", () => {
    const normalized = cte(CLASSPILOT_USAGE_ROLLUP_INSERT_SQL, "normalized", "classified");
    const domains = cte(CLASSPILOT_USAGE_ROLLUP_INSERT_SQL, "url_domains", "normalized");
    assert.match(domains, /CASE WHEN observation\.active_tab_url ~\* '\^https\?:\/\/'/);
    assert.match(domains, /ELSE ''\s+END AS domain/);
    assert.match(domains, /'\^www\\\.'/);
    assert.match(normalized, /COALESCE\(url_domains\.domain, ''\) AS domain/);
    assert.match(normalized, /LEFT JOIN url_domains ON url_domains\.active_tab_url COLLATE "C" = observation\.active_tab_url COLLATE "C"/);
    assert.match(normalized, /COALESCE\(NULLIF\(ai_decision\.category, ''\), observation\.ai_category\)/);
    assert.match(normalized, /NULLIF\(ai_decision\.teacher_intent_source, ''\) IS NOT NULL\s+OR NULLIF\(observation\.teacher_intent_source, ''\) IS NOT NULL/);
    const schoolDecisions = cte(CLASSPILOT_USAGE_ROLLUP_INSERT_SQL, "school_ai_decisions", "school_excluded");
    assert.match(schoolDecisions, /FROM classpilot_ai_decisions\s+WHERE school_id = \$1 AND created_at >= \$2::timestamp/);
    assert.doesNotMatch(schoolDecisions, /created_at\s*</);
    const decisions = cte(CLASSPILOT_USAGE_ROLLUP_INSERT_SQL, "ai_decision", "normalized");
    assert.match(decisions, /DISTINCT ON \(decision\.heartbeat_id\)/);
    assert.match(decisions, /FROM school_ai_decisions AS decision\s+JOIN deduplicated AS observation ON observation\.id = decision\.heartbeat_id/);
    assert.match(decisions, /ORDER BY decision\.heartbeat_id, decision\.created_at DESC, decision\.id DESC/);
    assert.doesNotMatch(decisions, /CROSS JOIN LATERAL|LIMIT 1/);
    const classified = cte(CLASSPILOT_USAGE_ROLLUP_INSERT_SQL, "classified", "roster_window");
    assert.match(classified, /normalized\.category = 'non-educational' AND NOT normalized\.teacher_intent_exempt\s+AND normalized\.domain <> '' THEN 'non-educational'/);
  });

  it("attributes each observation to the newest session on its frozen roster", () => {
    const roster = cte(CLASSPILOT_USAGE_ROLLUP_INSERT_SQL, "school_roster_window", "grains");
    assert.match(roster, /JOIN classpilot_session_students AS roster/);
    assert.match(roster, /roster\.group_id AS class_id/);
    assert.match(roster, /GREATEST\(session\.start_time, roster\.captured_at AT TIME ZONE 'UTC'\)/);
    assert.match(roster, /session\.start_time \+ interval '12 hours'/);
    assert.match(CLASSPILOT_USAGE_ROLLUP_INSERT_SQL, /roster_window AS MATERIALIZED \(\s+SELECT \* FROM school_roster_window\s+WHERE student_id = student_scope\.id/);
    assert.match(CLASSPILOT_USAGE_ROLLUP_INSERT_SQL, /roster_intervals AS MATERIALIZED/);
    assert.match(CLASSPILOT_USAGE_ROLLUP_INSERT_SQL, /ORDER BY roster_intervals\.student_id, roster_intervals\.starts_at,\s+roster_window\.start_time DESC, roster_window\.session_id DESC/);
    // Supervision contexts are not a class dimension in v1.
    assert.doesNotMatch(CLASSPILOT_USAGE_ROLLUP_INSERT_SQL, /supervision/i);
  });

  it("scopes every tenant table in every statement to school_id = $1 and never reads device ids", () => {
    for (const [name, statement] of Object.entries(ROLLUP_STATEMENTS)) {
      assert.match(statement, /\$1/, name);
      assert.doesNotMatch(statement, /device_id/, name);
      for (const match of statement.matchAll(/(?:FROM|JOIN)\s+([a-z_]+)(?:\s+AS\s+([a-z_]+))?/g)) {
        const table = match[1]!;
        if (!TENANT_TABLES.includes(table)) continue;
        const alias = match[2];
        const predicate = alias ? `${alias}.school_id = $1` : "school_id = $1";
        assert.ok(statement.includes(predicate), `${name}: ${table} must carry ${predicate}`);
      }
    }
    assert.match(CLASSPILOT_USAGE_ROLLUP_LOCK_SQL, /pg_advisory_xact_lock\(hashtext\('classpilot_usage_rollup'\), hashtext\(\$1\)\)/);
    assert.equal(CLASSPILOT_USAGE_ROLLUP_DELETE_SQL, "DELETE FROM classpilot_usage_rollups WHERE school_id = $1 AND usage_date = $2::date");
  });
});

describe("usage mode readers", () => {
  const admitted = { RLS_GUC_ENABLED: "true", RLS_ENABLED_TABLES: `students,${CLASSPILOT_USAGE_ROLLUP_RLS_TABLES.join(",")}` };

  it("default off and fail closed until the rollup table is RLS-admitted", () => {
    assert.equal(readClasspilotUsageRollupMode({}), "off");
    assert.equal(readClasspilotDigitalUsageMode({}), "off");
    const on = { CLASSPILOT_USAGE_ROLLUP_MODE: "on", CLASSPILOT_DIGITAL_USAGE_MODE: "on" };
    assert.equal(readClasspilotUsageRollupMode(on), "off");
    assert.equal(readClasspilotUsageRollupMode({ ...on, RLS_GUC_ENABLED: "true", RLS_ENABLED_TABLES: "students" }), "off");
    assert.equal(readClasspilotUsageRollupMode({ ...on, RLS_GUC_ENABLED: "true", RLS_ENABLED_TABLES: "classpilot_usage_rollups" }), "off", "aggregate admission alone cannot activate the ledger writer");
    assert.equal(readClasspilotUsageRollupMode({ ...on, RLS_GUC_ENABLED: "false", RLS_ENABLED_TABLES: admitted.RLS_ENABLED_TABLES }), "off");
    assert.equal(readClasspilotUsageRollupMode({ ...on, ...admitted }), "on");
    assert.equal(readClasspilotDigitalUsageMode({ ...on, ...admitted }), "on");
  });

  it("never serves Digital Usage without the rollup and treats malformed values as off", () => {
    assert.equal(readClasspilotDigitalUsageMode({ CLASSPILOT_DIGITAL_USAGE_MODE: "on", ...admitted }), "off");
    assert.equal(readClasspilotUsageRollupMode({ CLASSPILOT_USAGE_ROLLUP_MODE: "on", CLASSPILOT_DIGITAL_USAGE_MODE: "off", ...admitted }), "on");
    for (const value of ["ON", "true", "1", " on", ""]) {
      assert.equal(readClasspilotUsageRollupMode({ CLASSPILOT_USAGE_ROLLUP_MODE: value, ...admitted }), "off", value);
      assert.throws(() => parseClasspilotUsageModes({ CLASSPILOT_USAGE_ROLLUP_MODE: value }), /configuration is invalid/);
    }
    assert.throws(() => parseClasspilotUsageModes({ CLASSPILOT_DIGITAL_USAGE_MODE: "on" }), /configuration is invalid/);
    assert.deepEqual(parseClasspilotUsageModes({}), { rollupMode: "off", digitalUsageMode: "off" });
  });
});

describe("rollup windows, retention horizon and budget", () => {
  it("uses DST-safe school-local days", () => {
    const fall = classpilotUsageRollupDay("2026-11-01", "America/New_York");
    assert.equal(fall.dayStartUtc.toISOString(), "2026-11-01T04:00:00.000Z");
    assert.equal(fall.dayEndUtc.toISOString(), "2026-11-02T05:00:00.000Z");
    const spring = classpilotUsageRollupDay("2026-03-08", "America/New_York");
    assert.equal(spring.dayEndUtc.getTime() - spring.dayStartUtc.getTime(), 23 * 3_600_000);
    const days = classpilotUsageRollupDays(new Date("2026-09-15T04:00:05Z"), "America/New_York");
    assert.equal(days.today.date, "2026-09-15");
    assert.equal(days.yesterday.date, "2026-09-14");
    assert.equal(days.yesterday.dayStartUtc.toISOString(), "2026-09-14T04:00:00.000Z");
  });

  it("stops taking work at :25 of the hour the heavy job started, before the :30 purge", () => {
    assert.ok(CLASSPILOT_USAGE_ROLLUP_BUDGET_END_MINUTE < 30);
    assert.equal(classpilotUsageRollupDeadline(new Date("2026-09-15T04:00:05Z")).toISOString(), "2026-09-15T04:25:00.000Z");
    assert.equal(classpilotUsageRollupDeadline(new Date("2026-09-15T04:59:59Z")).toISOString(), "2026-09-15T04:25:00.000Z");
  });

  it("finalizes a one-day-retention school's yesterday only before that hour's purge", () => {
    const yesterdayStart = new Date("2026-09-14T04:00:00Z");
    const firstTick = classpilotUsageRetentionHorizon({ now: new Date("2026-09-15T04:00:05Z"), retentionDays: 1 });
    assert.equal(firstTick.toISOString(), "2026-09-14T04:00:00.000Z");
    assert.equal(yesterdayStart < firstTick, false, "the first top-of-hour tick after midnight may finalize");
    const afterPurge = classpilotUsageRetentionHorizon({ now: new Date("2026-09-15T04:31:00Z"), retentionDays: 1 });
    assert.equal(yesterdayStart < afterPurge, true);
    const nextHour = classpilotUsageRetentionHorizon({ now: new Date("2026-09-15T05:00:05Z"), retentionDays: 1 });
    assert.equal(yesterdayStart < nextHour, true, "a partly purged day is never rewritten");
    const overran = classpilotUsageRetentionHorizon({
      now: new Date("2026-09-15T04:02:00Z"),
      retentionDays: 1,
      lastPurgeFinishedAt: new Date("2026-09-15T04:01:00Z"),
    });
    assert.equal(overran.toISOString(), "2026-09-14T04:01:00.000Z");
    const thirtyDays = classpilotUsageRetentionHorizon({ now: new Date("2026-09-15T05:00:05Z"), retentionDays: 30 });
    assert.equal(yesterdayStart < thirtyDays, false);
  });
});

describe("tracking exclusions", () => {
  const windowStart = new Date("2026-09-14T04:00:00Z");
  const windowEnd = new Date("2026-09-15T04:00:00Z");

  it("excludes after-hours time school-wide exactly as frozen report policies do", () => {
    const settings = {
      enable_tracking_hours: true,
      tracking_start_time: "08:00",
      tracking_end_time: "15:00",
      tracking_days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
      after_hours_mode: "limited",
    };
    const policy = classpilotUsageTrackingPolicy(settings, "America/New_York");
    assert.equal(policy.afterHoursMode, "off", "limited counts as off, like the report snapshot");
    const exclusions = classpilotUsageExclusions({ trackingPolicy: policy, trackingEvents: [], windowStart, windowEnd });
    assert.deepEqual(exclusions.map((row) => [row.studentId, row.start.toISOString(), row.end.toISOString()]), [
      [null, "2026-09-14T04:00:00.000Z", "2026-09-14T12:00:00.000Z"],
      [null, "2026-09-14T19:00:00.000Z", "2026-09-15T04:00:00.000Z"],
    ]);
    const full = classpilotUsageTrackingPolicy({ ...settings, after_hours_mode: "full" }, "America/New_York");
    assert.deepEqual(classpilotUsageExclusions({ trackingPolicy: full, trackingEvents: [], windowStart, windowEnd }), []);
    assert.deepEqual(classpilotUsageTrackingPolicy(undefined, "UTC").enableTrackingHours, false);
  });

  it("excludes server-authored tracking-off intervals per student and serializes UTC wall clocks", () => {
    const policy = classpilotUsageTrackingPolicy(undefined, "America/New_York");
    const events = [
      { studentId: "b", eventType: "monitoring_state_changed", origin: "server", occurredAt: new Date("2026-09-14T15:00:00.250Z"), metadata: { state: "off" } },
      { studentId: "b", eventType: "monitoring_state_changed", origin: "server", occurredAt: new Date("2026-09-14T15:10:00Z"), metadata: { state: "active" } },
      { studentId: "a", eventType: "monitoring_state_changed", origin: "extension", occurredAt: new Date("2026-09-14T15:00:00Z"), metadata: { state: "off" } },
    ];
    const exclusions = classpilotUsageExclusions({ trackingPolicy: policy, trackingEvents: events, windowStart, windowEnd });
    assert.equal(exclusions.length, 1, "extension telemetry never excludes time");
    assert.equal(classpilotUsageExclusionsJson(exclusions), JSON.stringify([
      { studentId: "b", start: "2026-09-14 15:00:00.250", end: "2026-09-14 15:10:00.000" },
    ]));
    assert.equal(
      classpilotUsageExclusionsJson([{ studentId: null, start: windowStart, end: windowEnd }]),
      JSON.stringify([{ studentId: "", start: "2026-09-14 04:00:00.000", end: "2026-09-15 04:00:00.000" }])
    );
  });
});

type Recorded = { text: string; values: unknown[] | undefined };

function recordingPool(options: { failInsert?: boolean; answer?: (text: string, values: unknown[] | undefined) => Record<string, unknown>[] } = {}) {
  const calls: Recorded[] = [];
  const releases: Array<Error | boolean | undefined> = [];
  const query = async (text: string, values?: unknown[]) => {
    calls.push({ text, values });
    if (text === CLASSPILOT_USAGE_ROLLUP_INSERT_SQL) {
      if (options.failInsert) throw new Error("insert failed");
      return { rows: [{ row_count: 3, seconds: "40", heartbeat_count: "4" }] };
    }
    return { rows: options.answer?.(text, values) ?? [] };
  };
  const pool: ClasspilotUsageRollupPool = {
    query,
    async connect() {
      return { query, release: (error?: Error | boolean) => { releases.push(error); } };
    },
  };
  return { pool, calls, releases };
}

describe("one-day rewrite transaction", () => {
  const day = classpilotUsageRollupDay("2026-09-14", "America/New_York");

  it("reconciles disjoint deltas once and never rewrites unchanged aggregate rows", () => {
    assert.match(CLASSPILOT_USAGE_ROLLUP_INSERT_SQL, /grains AS MATERIALIZED/);
    assert.match(CLASSPILOT_USAGE_ROLLUP_INSERT_SQL, /existing_grains AS MATERIALIZED/);
    assert.match(CLASSPILOT_USAGE_ROLLUP_INSERT_SQL, /reconciled AS MATERIALIZED/);
    assert.match(CLASSPILOT_USAGE_ROLLUP_INSERT_SQL, /FULL OUTER JOIN existing_grains/);
    assert.match(cte(CLASSPILOT_USAGE_ROLLUP_INSERT_SQL, "updated", "inserted"), /IS DISTINCT FROM/);
    assert.match(cte(CLASSPILOT_USAGE_ROLLUP_INSERT_SQL, "inserted", "deleted"), /WHERE reconciled\.existing_id IS NULL/);
    assert.match(CLASSPILOT_USAGE_ROLLUP_INSERT_SQL, /reconciled\.student_id IS NULL/);
    assert.doesNotMatch(CLASSPILOT_USAGE_ROLLUP_INSERT_SQL, /ON CONFLICT/i);
    assert.match(CLASSPILOT_USAGE_ROLLUP_INSERT_SQL, /FROM grains$/);
    assert.doesNotMatch(between(source("src/services/classpilotUsageRollup.ts"), "export async function rollupClasspilotUsageDay", "async function loadTrackingEvents"), /query\(CLASSPILOT_USAGE_ROLLUP_DELETE_SQL/);
  });

  it("locks the school and reconciles the day atomically with UTC wall-clock bounds", async () => {
    const originalTimeZone = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      const { pool, calls, releases } = recordingPool();
      const result = await rollupClasspilotUsageDay(pool, {
        schoolId: "school-1",
        day,
        windowEndUtc: day.dayEndUtc,
        exclusions: [{ studentId: null, start: new Date("2026-09-14T04:00:00Z"), end: new Date("2026-09-14T12:00:00Z") }],
      });
      assert.deepEqual(result, { rowCount: 3, seconds: 40, heartbeatCount: 4 });
      const workCalls = calls.filter(call => call.text !== CLASSPILOT_USAGE_ROLLUP_TIMEOUT_SQL);
      assert.deepEqual(workCalls.map((call) => call.text), [
        "BEGIN",
        CLASSPILOT_USAGE_ROLLUP_LOCK_SQL,
        CLASSPILOT_USAGE_ROLLUP_LAST_COMPUTED_SQL,
        CLASSPILOT_USAGE_ROLLUP_INSERT_SQL,
        CLASSPILOT_USAGE_ROLLUP_COMPLETE_SQL,
        "COMMIT",
      ]);
      assert.equal(calls.filter(call => call.text === CLASSPILOT_USAGE_ROLLUP_TIMEOUT_SQL).length, 5);
      assert.deepEqual(workCalls[1]!.values, ["school-1"]);
      assert.deepEqual(workCalls[3]!.values, [
        "school-1",
        "2026-09-14 04:00:00",
        "2026-09-15 04:00:00",
        "2026-09-14",
        JSON.stringify([{ studentId: "", start: "2026-09-14 04:00:00.000", end: "2026-09-14 12:00:00.000" }]),
      ]);
      assert.deepEqual(releases, [false]);
    } finally {
      if (originalTimeZone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimeZone;
    }
  });

  it("rolls back and releases on failure", async () => {
    const { pool, calls, releases } = recordingPool({ failInsert: true });
    await assert.rejects(rollupClasspilotUsageDay(pool, { schoolId: "school-1", day, windowEndUtc: day.dayEndUtc, exclusions: [] }), /insert failed/);
    assert.equal(calls.at(-1)!.text, "ROLLBACK");
    assert.deepEqual(releases, [false]);
  });

  it("does not let a stale queued cutoff regress newer or final coverage", async () => {
    const { pool, calls } = recordingPool({ answer: (text) => text === CLASSPILOT_USAGE_ROLLUP_LAST_COMPUTED_SQL
      ? [{ processed_through: day.dayEndUtc, is_final: true }] : [] });
    await rollupClasspilotUsageDay(pool, { schoolId: "school-1", day, windowEndUtc: new Date("2026-09-14T16:00:00Z"), exclusions: [] });
    assert.equal(calls.some((call) => call.text === CLASSPILOT_USAGE_ROLLUP_INSERT_SQL), false);
    assert.equal(calls.at(-1)?.text, "COMMIT");
  });
});

describe("hourly runner", () => {
  const schools = [
    { id: "school-a", timeZone: "America/New_York" },
    { id: "school-b", timeZone: "America/New_York" },
  ];
  function markers() {
    const complete = new Set<string>();
    return {
      complete,
      async isComplete(schoolId: string, date: string) { return complete.has(`${schoolId}:${date}`); },
      async markComplete(schoolId: string, date: string) { complete.add(`${schoolId}:${date}`); },
    };
  }
  const answer = (retentionHours: string) => (text: string) => {
    if (text === CLASSPILOT_USAGE_ROLLUP_SETTINGS_SQL) return [{ retention_hours: retentionHours }];
    if (text === CLASSPILOT_USAGE_ROLLUP_CHANGED_SQL) return [{ changed: true }];
    return [];
  };

  it("finalizes every school's yesterday before recomputing any today", async () => {
    const { pool, calls } = recordingPool({ answer: answer("720") });
    const done = markers();
    const outcome = await runClasspilotUsageRollup({
      pool,
      schools,
      now: new Date("2026-09-15T04:00:05Z"),
      deadline: new Date("2026-09-15T04:25:00Z"),
      markers: done,
      clock: () => new Date("2026-09-15T04:00:06Z"),
      concurrency: 1,
    });
    assert.equal(outcome.finalizedDays, 2);
    assert.equal(outcome.recomputedDays, 4);
    assert.equal(outcome.failedSchools, 0);
    assert.equal(outcome.budgetExhausted, false);
    const dates = calls.filter((call) => call.text === CLASSPILOT_USAGE_ROLLUP_INSERT_SQL).map((call) => [call.values![0], call.values![3]]);
    assert.deepEqual(dates, [["school-a", "2026-09-14"], ["school-b", "2026-09-14"], ["school-a", "2026-09-15"], ["school-b", "2026-09-15"]]);
    assert.deepEqual([...done.complete].sort(), ["school-a:2026-09-14", "school-b:2026-09-14"]);
  });

  it("never records a partly purged day as completed", async () => {
    const { pool, calls } = recordingPool({ answer: answer("24") });
    const done = markers();
    const outcome = await runClasspilotUsageRollup({
      pool,
      schools: [schools[0]!],
      now: new Date("2026-09-15T05:00:05Z"),
      deadline: new Date("2026-09-15T05:25:00Z"),
      markers: done,
      clock: () => new Date("2026-09-15T05:00:06Z"),
    });
    assert.equal(outcome.retentionSkippedDays, 1);
    assert.equal(outcome.finalizedDays, 0);
    assert.equal(done.complete.has("school-a:2026-09-14"), false);
    assert.deepEqual(
      calls.filter((call) => call.text === CLASSPILOT_USAGE_ROLLUP_INSERT_SQL).map((call) => call.values![3]),
      ["2026-09-15"],
      "only today is rewritten"
    );
  });

  it("defers the remaining work once the hour's budget is spent so the purge is never pushed out", async () => {
    const { pool } = recordingPool({ answer: answer("720") });
    let ticks = 0;
    const outcome = await runClasspilotUsageRollup({
      pool,
      schools,
      now: new Date("2026-09-15T04:00:05Z"),
      deadline: new Date("2026-09-15T04:25:00Z"),
      markers: markers(),
      // The first task overruns the budget.
      clock: () => new Date(ticks++ === 0 ? "2026-09-15T04:00:06Z" : "2026-09-15T04:26:00Z"),
      concurrency: 1,
    });
    assert.equal(outcome.budgetExhausted, true);
    assert.equal(outcome.finalizedDays, 1);
    assert.equal(outcome.deferredDays, 3);
  });

  it("skips today when no heartbeat arrived since its last computation", async () => {
    const { pool, calls } = recordingPool({
      answer: (text, values) => {
        if (text === CLASSPILOT_USAGE_ROLLUP_SETTINGS_SQL) return [{ retention_hours: "720" }];
        if (text === CLASSPILOT_USAGE_ROLLUP_LAST_COMPUTED_SQL) return [{ processed_through: new Date("2026-09-15T15:00:04Z"), is_final: values?.[1] === "2026-09-14" }];
        if (text === CLASSPILOT_USAGE_ROLLUP_CHANGED_SQL) return [{ changed: false }];
        return [];
      },
    });
    const done = markers();
    done.complete.add("school-a:2026-09-14");
    const outcome = await runClasspilotUsageRollup({
      pool,
      schools: [schools[0]!],
      now: new Date("2026-09-15T16:00:05Z"),
      deadline: new Date("2026-09-15T16:25:00Z"),
      markers: done,
      clock: () => new Date("2026-09-15T16:00:06Z"),
    });
    assert.equal(outcome.unchangedDays, 1);
    assert.equal(outcome.recomputedDays, 0);
    const probe = calls.find((call) => call.text === CLASSPILOT_USAGE_ROLLUP_CHANGED_SQL);
    assert.deepEqual(probe?.values, ["school-a", "2026-09-15 14:55:04", "2026-09-15 16:00:05"]);
  });

  it("isolates one school's failure", async () => {
    const failing = recordingPool({
      answer: (text, values) => {
        if (text === CLASSPILOT_USAGE_ROLLUP_SETTINGS_SQL && values?.[0] === "school-a") throw new Error("boom");
        return answer("720")(text);
      },
    });
    const errors: string[] = [];
    const outcome = await runClasspilotUsageRollup({
      pool: failing.pool,
      schools,
      now: new Date("2026-09-15T04:00:05Z"),
      deadline: new Date("2026-09-15T04:25:00Z"),
      markers: markers(),
      clock: () => new Date("2026-09-15T04:00:06Z"),
      onSchoolError: (_error, schoolId) => errors.push(schoolId),
    });
    assert.equal(outcome.failedSchools, 1);
    assert.equal(outcome.finalizedDays, 1);
    assert.deepEqual([...new Set(errors)], ["school-a"]);
  });

  it("refreshes from the actual cutoff when the prior school queued for twenty minutes", async () => {
    const { pool, calls } = recordingPool({ answer: (text, values) => {
      if (text === CLASSPILOT_USAGE_ROLLUP_SETTINGS_SQL) return [{ retention_hours: "720" }];
      if (text === CLASSPILOT_USAGE_ROLLUP_LAST_COMPUTED_SQL) return [{
        processed_through: new Date("2026-09-15T14:00:00Z"),
        computed_at: new Date("2026-09-15T14:20:00Z"),
        is_final: values?.[1] === "2026-09-14",
      }];
      if (text === CLASSPILOT_USAGE_ROLLUP_CHANGED_SQL) {
        // The only new heartbeat is at 14:10, after the 14:00 cutoff.
        return [{ changed: String(values?.[1]) <= "2026-09-15 14:10:00" }];
      }
      return [];
    } });
    const outcome = await runClasspilotUsageRollup({ pool, schools: [schools[0]!], now: new Date("2026-09-15T15:00:00Z"),
      deadline: new Date("2026-09-15T15:25:00Z"), markers: markers(), clock: () => new Date("2026-09-15T15:00:01Z") });
    assert.equal(outcome.recomputedDays, 1, "the 14:10 activity must trigger the next refresh");
    const probe = calls.find((call) => call.text === CLASSPILOT_USAGE_ROLLUP_CHANGED_SQL);
    assert.deepEqual(probe?.values, ["school-a", "2026-09-15 13:55:00", "2026-09-15 15:00:00"]);
    const completion = calls.find((call) => call.text === CLASSPILOT_USAGE_ROLLUP_COMPLETE_SQL);
    assert.equal(completion?.values?.[4], "2026-09-15T15:00:00.000Z");
  });
});

describe("scheduler wiring", () => {
  const scheduler = source("src/services/scheduler.ts");

  it("runs the budgeted rollup in the top-of-hour block, ahead of the :30 retention purge", () => {
    const hourly = between(scheduler, "async function runHeavyJobsSerially", "export function startScheduler");
    const daily = hourly.indexOf("await rollupDailyUsage();");
    const usage = hourly.indexOf("await rollupClasspilotUsage(heavyJobStartedAt);");
    const purge = hourly.indexOf("await purgeExpiredHeartbeats();");
    assert.ok(daily >= 0 && usage > daily && purge > usage);
    assert.match(hourly, /const heavyJobStartedAt = new Date\(\);\s+const currentHour = heavyJobStartedAt\.getUTCHours\(\);/);
  });

  it("does nothing while the mode is off and reports every run", () => {
    const job = between(scheduler, "async function rollupClasspilotUsage", "// ClassPilot - Heartbeat purge");
    assert.match(job, /^async function rollupClasspilotUsage\(heavyJobStartedAt: Date\) \{\s+if \(readClasspilotUsageRollupMode\(\) !== "on"\) return;/);
    assert.match(job, /pool: schedulerPool/);
    assert.match(job, /deadline = classpilotUsageRollupDeadline\(heavyJobStartedAt\)/);
    assert.match(job, /event: "classpilot_usage_rollup"/);
    assert.match(job, /classpilotUsageRollupMetricRecord/);
    const retention = between(scheduler, "async function purgeExpiredHeartbeats", "ClassPilot - Automatic class block scheduling");
    assert.match(retention, /\n  \}\n  lastHeartbeatPurgeFinishedAt = new Date\(\);\n\}\n/, "recorded after every school, success or not");
  });
});

describe("rollup metrics", () => {
  it("publish only nonzero failures and deferrals", () => {
    assert.equal(classpilotUsageRollupMetricRecord({ failedSchools: 0, deferredDays: 0 }, { environment: "test", timestamp: 1 }), null);
    const record = classpilotUsageRollupMetricRecord({ failedSchools: 2, deferredDays: 0 }, { environment: "production", timestamp: 7 });
    assert.deepEqual(record, {
      _aws: {
        Timestamp: 7,
        CloudWatchMetrics: [{
          Namespace: "SchoolPilot/ClassPilot",
          Dimensions: [["Environment"]],
          Metrics: [{ Name: "UsageRollupFailedSchools", Unit: "Count" }],
        }],
      },
      Environment: "production",
      UsageRollupFailedSchools: 2,
    });
  });
});
