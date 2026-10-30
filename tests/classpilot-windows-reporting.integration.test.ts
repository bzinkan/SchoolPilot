import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../src/schema/index.js";
import { getWindowsReportObservations, getWindowsReportSessions } from "../src/services/classpilotWindowsReporting.js";
import { mergeWindowsDailyUsage, readSetBasedDailyUsageCandidate, readWindowsDailyUsageCandidate,
  upsertSetBasedDailyUsage } from "../src/services/classpilotDailyUsageRollup.js";
import { calculateHeartbeatCoverage } from "../src/services/classpilotHeartbeatCoverage.js";
import { CLASSPILOT_USAGE_ROLLUP_INSERT_SQL } from "../src/services/classpilotUsageRollup.js";

// Transaction-local SQL fixtures exercise the production statements without
// migrating, weakening, or changing the canonical shared tenant/RLS fixtures.
test("Windows report SQL bounds metadata and authentication, and daily SQL unions Chrome/Edge", async () => {
  const connectionString = process.env.DATABASE_URL;
  assert.ok(connectionString, "An explicit local test database is required");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(connectionString).hostname));
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL timezone='America/Los_Angeles';
      CREATE TEMP TABLE heartbeats(student_id text, school_id text, timestamp timestamp, active_tab_url text) ON COMMIT DROP;
      CREATE TEMP TABLE classpilot_windows_browser_events(id text, school_id text, student_id text,
        observed_at timestamptz, usage_ends_at timestamptz, active_tab_url text, browser_focused boolean,
        teaching_session_id text, supervision_context_id text, classification jsonb, browser_id text DEFAULT 'chrome') ON COMMIT DROP;
      CREATE INDEX ON classpilot_windows_browser_events(school_id,student_id,observed_at);
      CREATE TEMP TABLE classpilot_windows_guards(id text,school_id text,student_id text,created_at timestamptz,
        ended_at timestamptz,expires_at timestamptz,absolute_expires_at timestamptz) ON COMMIT DROP;
      CREATE TEMP TABLE classpilot_windows_browsers(id text,school_id text,guard_id text,student_id text,
        created_at timestamptz,ended_at timestamptz,last_seen_at timestamptz) ON COMMIT DROP;
      CREATE TEMP TABLE daily_usage(school_id text,student_id text,date text,total_seconds int,heartbeat_count int,
        top_domains jsonb,first_seen timestamp,last_seen timestamp,computed_at timestamptz,UNIQUE(student_id,date)) ON COMMIT DROP;
      INSERT INTO heartbeats VALUES ('legacy','school','2026-10-28 12:00:00','https://legacy.example/'),
        ('legacy','school','2026-10-28 12:00:00','https://legacy.example/');
      INSERT INTO classpilot_windows_browser_events(id,school_id,student_id,observed_at,usage_ends_at,active_tab_url,browser_focused,teaching_session_id,supervision_context_id,classification) VALUES
        ('chrome','school','windows','2026-10-28T12:00:00Z','2026-10-28T12:00:10Z','https://chrome.example/',true,'class',null,'{"category":"educational"}'),
        ('edge','school','windows','2026-10-28T12:00:05Z','2026-10-28T12:00:07Z','https://edge.example/',true,'class',null,null),
        ('unfocused','school','windows','2026-10-28T12:00:20Z','2026-10-28T12:00:20Z','https://ignored.example/',false,'class',null,null),
        ('supervision','school','windows','2026-10-28T12:00:30Z','2026-10-28T12:00:34Z','https://supervision.example/',true,null,'room',null),
        ('unclassed','school','windows','2026-10-28T12:00:40Z','2026-10-28T12:00:45Z','https://home.example/',true,null,null,null),
        ('another-class','school','windows','2026-10-28T12:00:50Z','2026-10-28T12:00:54Z','https://another.example/',true,'another-class',null,null),
        ('other','other','windows','2026-10-28T12:00:00Z','2026-10-28T12:00:10Z','https://private.example/',true,'class',null,null),
        ('boundary','school','boundary','2026-10-28T23:59:58Z','2026-10-29T00:00:08Z','https://boundary.example/',true,null,null,null),
        ('next-day','school','boundary','2026-10-29T00:00:00Z','2026-10-29T00:00:10Z','https://tomorrow.example/',true,null,null,null);
      INSERT INTO classpilot_windows_guards VALUES
        ('guard','school','windows','2026-10-28T11:59:00Z',null,'2026-10-28T12:01:00Z','2026-10-28T20:00:00Z'),
        ('boundaryguard','school','boundary','2026-10-28T23:59:00Z',null,'2026-10-29T00:01:00Z','2026-10-29T07:59:00Z'),
        ('otherguard','other','windows','2026-10-28T11:59:00Z',null,'2026-10-28T12:05:00Z','2026-10-28T20:00:00Z');
      INSERT INTO classpilot_windows_browsers VALUES
        ('chrome','school','guard','windows','2026-10-28T12:00:00Z','2026-10-28T12:00:12Z','2026-10-28T12:00:05Z'),
        ('edge','school','guard','windows','2026-10-28T12:00:05Z',null,'2026-10-28T12:00:15Z'),
        ('boundary','school','boundaryguard','boundary','2026-10-28T23:59:00Z',null,'2026-10-29T00:00:00Z'),
        ('other','other','otherguard','windows','2026-10-28T12:00:00Z',null,'2026-10-28T12:00:15Z');
      UPDATE classpilot_windows_browser_events SET browser_id='edge' WHERE id IN ('edge','supervision','unclassed','another-class');
      UPDATE classpilot_windows_browser_events SET browser_id='boundary' WHERE student_id='boundary';
      UPDATE classpilot_windows_browser_events SET browser_id='other' WHERE school_id='other';`);
    const database = drizzle(client, { schema });
    const start = new Date("2026-10-28T12:00:00Z"), end = new Date("2026-10-28T12:01:00Z");
    const observations = await getWindowsReportObservations(database, "school", ["windows"], start, end, { teachingSessionId: "class" });
    assert.deepEqual(observations.map(row => row.id), ["chrome", "edge", "unclassed"],
      "frozen class reports include context-null full-mode activity but exclude other class/supervision ownership");
    assert.equal(observations[0]?.aiCategory, "educational");
    assert.equal(observations[0]?.observationSource, "windows_browser");
    const supervised = await getWindowsReportObservations(database, "school", ["windows"], start, end, { supervisionContextId: "room" });
    assert.deepEqual(supervised.map(row => row.id), ["supervision"]);
    const sessions = await getWindowsReportSessions(database, "school", ["windows"], start, end);
    assert.equal(sessions.length, 2);
    assert.equal(sessions.find(row => row.id === "chrome")?.endedAt.toISOString(), "2026-10-28T12:00:12.000Z");
    assert.equal(sessions.find(row => row.id === "edge")?.endedAt.toISOString(), "2026-10-28T12:01:00.000Z");
    const coverage = calculateHeartbeatCoverage({ windowStart: start, windowEnd: end,
      authenticatedIntervals: sessions.map(row => ({ start: row.startedAt, end: row.endedAt })),
      heartbeats: observations.map(row => ({ timestamp: row.timestamp, usageEndsAt: row.usageEndsAt, url: row.activeTabUrl })) });
    assert.equal(coverage.eligibleSeconds, 60);
    assert.equal(coverage.observedSeconds, 15);
    const options = { schoolId: "school", date: "2026-10-28", dayStartUtc: new Date("2026-10-28T00:00:00Z"), dayEndUtc: new Date("2026-10-29T00:00:00Z") };
    const candidate = await readSetBasedDailyUsageCandidate(client, options);
    assert.equal(candidate.find(row => row.studentId === "legacy")?.totalSeconds, 20, "unchanged legacy count × 10");
    assert.equal(candidate.find(row => row.studentId === "windows")?.totalSeconds, 23, "Chrome/Edge overlap once plus supervision/unclassed/other-class time");
    assert.equal(candidate.find(row => row.studentId === "windows")?.heartbeatCount, 5);
    assert.equal(candidate.find(row => row.studentId === "windows")?.topDomains.find(row => row.domain === "chrome.example")?.seconds, 8);
    assert.equal(candidate.find(row => row.studentId === "windows")?.topDomains.find(row => row.domain === "edge.example")?.seconds, 2);
    assert.equal(candidate.find(row => row.studentId === "boundary")?.totalSeconds, 2, "day boundary clips the interval");
    const windows = await readWindowsDailyUsageCandidate(client, options);
    const legacy = candidate.filter(row => row.studentId === "legacy");
    assert.deepEqual(mergeWindowsDailyUsage(legacy, windows).sort((a,b) => a.studentId.localeCompare(b.studentId)), candidate);
    await upsertSetBasedDailyUsage(client, options);
    await upsertSetBasedDailyUsage(client, options);
    const persisted = await client.query("SELECT student_id,total_seconds FROM daily_usage ORDER BY student_id");
    assert.deepEqual(persisted.rows, [{ student_id: "boundary", total_seconds: 2 }, { student_id: "legacy", total_seconds: 20 }, { student_id: "windows", total_seconds: 23 }]);

    const at = (seconds: number) => new Date(start.getTime() + seconds * 1000);
    async function windowsObservation(student: string, options: {
      observed?: number; ends?: number; browserStart?: number; browserEnd?: number;
      guardStart?: number; guardEnd?: number; expires?: number; absolute?: number;
    } = {}) {
      await client.query("INSERT INTO classpilot_windows_guards VALUES($1,'school',$1,$2,$3,$4,$5)",
        [student, at(options.guardStart ?? 0), options.guardEnd == null ? null : at(options.guardEnd), at(options.expires ?? 60), at(options.absolute ?? 60)]);
      await client.query("INSERT INTO classpilot_windows_browsers VALUES($1,'school',$1,$1,$2,$3,$2)",
        [student, at(options.browserStart ?? 0), options.browserEnd == null ? null : at(options.browserEnd)]);
      await client.query(`INSERT INTO classpilot_windows_browser_events
        (id,school_id,student_id,browser_id,observed_at,usage_ends_at,active_tab_url,browser_focused)
        VALUES($1,'school',$1,$1,$2,$3,'https://windows-handoff.example/',true)`,
      [student, at(options.observed ?? 0), at(options.ends ?? 10)]);
    }
    await windowsObservation("legacy-to-windows", { observed: 5, ends: 15 });
    await windowsObservation("windows-to-legacy", { guardEnd: 4 });
    await windowsObservation("covered", { observed: 5, ends: 8 });
    await windowsObservation("legacy-mid-window");
    await windowsObservation("browser-ended", { browserEnd: 4 });
    await windowsObservation("guard-ended", { guardEnd: 6 });
    await windowsObservation("guard-expired", { expires: 7 });
    await windowsObservation("absolute-expired", { absolute: 8 });
    await windowsObservation("before-browser", { browserStart: 2 });
    await windowsObservation("before-guard", { guardStart: 2 });
    await windowsObservation("already-expired", { observed: 5, ends: 15, expires: 5 });
    // A later/sibling browser can keep aggregate report eligibility alive. It
    // must never extend the closed browser's own final observation.
    await client.query(`INSERT INTO classpilot_windows_browsers VALUES
      ('sibling','school','browser-ended','browser-ended',$1,null,$1)`, [at(0)]);
    await client.query(`INSERT INTO heartbeats(student_id,school_id,timestamp,active_tab_url) VALUES
      ('legacy-to-windows','school',$1,'https://legacy-handoff.example/'),
      ('windows-to-legacy','school',$2,'https://legacy-handoff.example/'),
      ('covered','school',$1,'https://legacy-handoff.example/'),
      ('covered','school',$1,'https://legacy-handoff.example/'),
      ('legacy-mid-window','school',$3,'https://legacy-handoff.example/'),
      ('guard-ended','other',$1,'https://foreign.example/')`,
    ["2026-10-28 12:00:00", "2026-10-28 12:00:04", "2026-10-28 12:00:03"]);

    const mixed = await readSetBasedDailyUsageCandidate(client, options);
    const expectedMixed: Record<string, number> = { "legacy-to-windows": 15, "windows-to-legacy": 14,
      covered: 20, "legacy-mid-window": 13, "browser-ended": 4, "guard-ended": 6,
      "guard-expired": 7, "absolute-expired": 8 };
    for (const [student, seconds] of Object.entries(expectedMixed)) {
      const row = mixed.find(value => value.studentId === student);
      assert.equal(row?.totalSeconds, seconds, `${student}: count only live, uncovered Windows time`);
      assert.equal(row?.topDomains.reduce((sum, domain) => sum + domain.seconds, 0), seconds);
    }
    assert.equal(mixed.find(row => row.studentId === "covered")?.heartbeatCount, 3,
      "count genuine observations even when all Windows seconds overlap legacy slots");
    assert.equal(mixed.find(row => row.studentId === "legacy")?.totalSeconds, 20, "legacy duplicates remain unchanged");
    const additionalWindows = await readWindowsDailyUsageCandidate(client, options);
    for (const [student, seconds] of Object.entries({ "legacy-to-windows": 5, "windows-to-legacy": 4,
      covered: 0, "legacy-mid-window": 3 }))
      assert.equal(additionalWindows.find(row => row.studentId === student)?.totalSeconds, seconds,
        `legacy scheduler merge receives only uncovered Windows seconds: ${student}`);
    await upsertSetBasedDailyUsage(client, options);
    await upsertSetBasedDailyUsage(client, options);
    const mixedPersisted = await client.query("SELECT student_id,total_seconds FROM daily_usage");
    for (const [student, seconds] of Object.entries(expectedMixed))
      assert.equal(mixedPersisted.rows.find(row => row.student_id === student)?.total_seconds, seconds, `idempotent mixed upsert: ${student}`);
    for (const student of ["before-browser", "before-guard", "already-expired"])
      assert.equal(mixed.some(row => row.studentId === student), false, `${student}: no authorized observation`);

    const clipped = await getWindowsReportObservations(database, "school", Object.keys(expectedMixed), start, end);
    for (const [student, seconds] of Object.entries({ "windows-to-legacy": 4, "browser-ended": 4,
      "guard-ended": 6, "guard-expired": 7, "absolute-expired": 8 }))
      assert.equal(clipped.find(row => row.studentId === student)?.usageEndsAt.getTime(), at(seconds).getTime(), student);
    const siblingSessions = await getWindowsReportSessions(database, "school", ["browser-ended"], start, end);
    const siblingCoverage = calculateHeartbeatCoverage({ windowStart: start, windowEnd: end,
      authenticatedIntervals: siblingSessions.map(row => ({ start: row.startedAt, end: row.endedAt })),
      heartbeats: clipped.filter(row => row.studentId === "browser-ended").map(row => ({
        timestamp: row.timestamp, usageEndsAt: row.usageEndsAt, url: row.activeTabUrl })) });
    assert.equal(siblingCoverage.eligibleSeconds, 60);
    assert.equal(siblingCoverage.observedSeconds, 4, "live sibling cannot revive the closed source tail");

    // Exercise the production Monitored Browser Time SELECT against these same
    // handoffs; this metric retains its existing 15-second legacy attribution.
    await client.query(`ALTER TABLE heartbeats ADD COLUMN id text;
      ALTER TABLE heartbeats ADD COLUMN ai_category text;
      ALTER TABLE heartbeats ADD COLUMN teacher_intent_source text;
      UPDATE heartbeats SET id=ctid::text;
      CREATE TEMP TABLE students(id text,school_id text) ON COMMIT DROP;
      INSERT INTO students SELECT DISTINCT student_id,school_id FROM classpilot_windows_browser_events;
      INSERT INTO students VALUES ('legacy','school');
      CREATE TEMP TABLE classpilot_ai_decisions(heartbeat_id text,category text,teacher_intent_source text,created_at timestamp,id text,school_id text) ON COMMIT DROP;
      CREATE TEMP TABLE teaching_sessions(id text,start_time timestamp,end_time timestamp,scheduled_end_at timestamptz,manual_expires_at timestamptz,school_id text) ON COMMIT DROP;
      CREATE TEMP TABLE classpilot_session_students(student_id text,group_id text,teaching_session_id text,captured_at timestamptz,school_id text) ON COMMIT DROP;
      CREATE TEMP TABLE groups(id text,school_id text) ON COMMIT DROP;`);
    const marker = CLASSPILOT_USAGE_ROLLUP_INSERT_SQL.indexOf(",\nexisting_grains AS ");
    assert.ok(marker > 0, "production rollup read phase is present");
    const grains = await client.query(CLASSPILOT_USAGE_ROLLUP_INSERT_SQL.slice(0, marker)
      + " SELECT $4::date AS day, student_id,sum(seconds)::int AS seconds FROM grains GROUP BY student_id",
    ["school", "2026-10-28 00:00:00", "2026-10-29 00:00:00", "2026-10-28", "[]"]);
    for (const [student, seconds] of Object.entries({ "legacy-to-windows": 15, "windows-to-legacy": 19,
      "browser-ended": 4, "guard-ended": 6, "guard-expired": 7, "absolute-expired": 8 }))
      assert.equal(grains.rows.find(row => row.student_id === student)?.seconds, seconds, `Monitored Browser Time: ${student}`);
    for (const student of ["before-browser", "before-guard", "already-expired"])
      assert.equal(grains.rows.some(row => row.student_id === student), false);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
