import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import {
  CLASSPILOT_USAGE_ROLLUP_INSERT_SQL,
  CLASSPILOT_USAGE_ROLLUP_LOCK_SQL,
  classpilotUsageRollupDay,
  rollupClasspilotUsageDay,
} from "../src/services/classpilotUsageRollup.js";
import { utcTimestampForSql } from "../src/util/schoolTime.js";

// Independent pre-optimization SQL from exact b112, also used by the native
// EXPLAIN baseline. Do not derive this oracle from the new map implementation.
const reference = readFileSync(new URL("./fixtures/classpilot-usage-rollup-b112.sql", import.meta.url), "utf8").replace(/\r\n/g, "\n");
assert.equal(createHash("sha256").update(reference).digest("hex"), "87f1493e4ba33b760288e375f91b1574878c798458eb92b18c17f2cb5b2fabb2");
const columns = "school_id,usage_date,student_id,class_id,session_id,domain,classification,seconds,heartbeat_count";
function grains(statement: string) {
  const marker = ",\ninserted AS (\n  INSERT INTO classpilot_usage_rollups (";
  const index = statement.indexOf(marker);
  assert.ok(index > 0);
  return statement.slice(0, index) + "\nSELECT $1::text AS school_id,$4::date AS usage_date,grains.* FROM grains";
}
const day = classpilotUsageRollupDay("2026-09-20", "America/New_York");
// Preserve subsecond fixture values; the general SQL helper intentionally
// truncates to seconds and cannot express dedup ordering or zero-second grains.
const at = (seconds: number) => new Date(day.dayStartUtc.getTime() + seconds * 1000).toISOString().replace("T", " ").replace("Z", "");
const schools: string[] = [randomUUID(), randomUUID()];
const students: string[] = [randomUUID(), randomUUID(), randomUUID()];
const teacher = randomUUID(), group = randomUUID(), session = randomUUID();
let admin: pg.Pool, worker: pg.Pool;
let restricted = false;

type Observation = { student: number; seconds: number; url: string | null; category: string | null; intent?: string | null; id?: string };
async function seed(observations: Observation[]) {
  await admin.query("DELETE FROM classpilot_ai_decisions WHERE school_id=ANY($1::text[])", [schools]);
  await admin.query("DELETE FROM heartbeats WHERE school_id=ANY($1::text[])", [schools]);
  await admin.query("DELETE FROM classpilot_usage_rollups WHERE school_id=ANY($1::text[])", [schools]);
  await admin.query("DELETE FROM classpilot_usage_rollup_days WHERE school_id=ANY($1::text[])", [schools]);
  const data = observations.map((row) => ({ id: row.id ?? randomUUID(), school_id: schools[row.student === 2 ? 1 : 0], student_id: students[row.student], device_id: `domain-map-${row.student}`, timestamp: at(row.seconds), url: row.url, category: row.category, intent: row.intent ?? null }));
  await admin.query(`INSERT INTO heartbeats(id,school_id,student_id,device_id,timestamp,active_tab_title,active_tab_url,ai_category,teacher_intent_source)
    SELECT id,school_id,student_id,device_id,timestamp::timestamp,'synthetic',url,category,intent
    FROM jsonb_to_recordset($1::jsonb) AS x(id text,school_id text,student_id text,device_id text,timestamp text,url text,category text,intent text)`, [JSON.stringify(data)]);
}

async function compare(exclusions: Array<{ studentId: string; start: string; end: string }> = []) {
  const client = await worker.connect();
  try {
    await client.query("BEGIN");
    await client.query(CLASSPILOT_USAGE_ROLLUP_LOCK_SQL, [schools[0]]);
    const params = [schools[0], at(0), utcTimestampForSql(day.dayEndUtc), day.date, JSON.stringify(exclusions)];
    await client.query("CREATE TEMP TABLE old_grains ON COMMIT DROP AS " + grains(reference), params);
    await client.query("CREATE TEMP TABLE new_grains ON COMMIT DROP AS " + grains(CLASSPILOT_USAGE_ROLLUP_INSERT_SQL), params);
    const difference = (await client.query(`SELECT
      (SELECT COUNT(*)::int FROM (SELECT ${columns} FROM old_grains EXCEPT ALL SELECT ${columns} FROM new_grains) old_only) AS old_only,
      (SELECT COUNT(*)::int FROM (SELECT ${columns} FROM new_grains EXCEPT ALL SELECT ${columns} FROM old_grains) new_only) AS new_only`)).rows[0];
    assert.deepEqual(difference, { old_only: 0, new_only: 0 });
    const rows = (await client.query<{ school_id: string; usage_date: string; student_id: string; class_id: string | null; session_id: string | null; domain: string; classification: string; seconds: number; heartbeat_count: number }>(
      "SELECT school_id,usage_date::text,student_id,class_id,session_id,domain,classification,seconds,heartbeat_count FROM new_grains ORDER BY student_id,domain,classification",
    )).rows;
    assert.ok(rows.every(row => row.school_id === schools[0] && row.usage_date === day.date && students.slice(0, 2).includes(row.student_id)));
    return rows;
  } finally { try { await client.query("ROLLBACK"); } finally { client.release(); } }
}

before(async () => {
  const url = process.env.DATABASE_URL;
  assert.ok(url && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname), "Local native fixture required");
  const adminUrl = process.env.ADMIN_DATABASE_URL ?? url;
  const appTarget = new URL(url), adminTarget = new URL(adminUrl);
  for (const target of [appTarget, adminTarget]) {
    assert.ok(["postgres:", "postgresql:"].includes(target.protocol));
    assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname));
    assert.equal(target.search, "");assert.equal(target.hash, "");
  }
  assert.deepEqual([adminTarget.hostname, adminTarget.port || "5432", adminTarget.pathname], [appTarget.hostname, appTarget.port || "5432", appTarget.pathname], "Admin and worker must target the same owned local database");
  admin = new pg.Pool({ connectionString: adminUrl, options: "-c app.is_super=on", max: 2 });
  worker = new pg.Pool({ connectionString: url, options: "-c app.is_super=on", max: 5, connectionTimeoutMillis: 10000, statement_timeout: 60000 });
  const role = (await worker.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
  restricted = !role.rolsuper && !role.rolbypassrls;
  if (process.env.RLS_TEST_ROLE === "true") {
    assert.equal(restricted, true);
    const posture = (await worker.query("SELECT COUNT(*)::int AS count FROM pg_class WHERE relname=ANY($1::text[]) AND relrowsecurity AND relforcerowsecurity AND relowner<>(SELECT oid FROM pg_roles WHERE rolname=current_user)", [["heartbeats", "students", "classpilot_ai_decisions", "classpilot_session_students", "teaching_sessions", "groups", "classpilot_usage_rollups", "classpilot_usage_rollup_days"]])).rows[0];
    assert.equal(posture.count, 8);
  }
  await admin.query("INSERT INTO schools(id,name,status,is_active,school_timezone) SELECT id,'domain-map fixture','active',true,'America/New_York' FROM unnest($1::text[]) id", [schools]);
  for (const [index, id] of students.entries()) await admin.query("INSERT INTO students(id,school_id,first_name,last_name,status) VALUES($1,$2,'Domain','Fixture','active')", [id, schools[index === 2 ? 1 : 0]]);
  await admin.query("INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'Domain','Teacher')", [teacher, `domain-${teacher}@example.test`]);
  await admin.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,'teacher','active')", [schools[0], teacher]);
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO groups(id,school_id,teacher_id,name,group_type) VALUES($1,$2,$3,'Domain class','admin_class')", [group, schools[0], teacher]);
    await client.query("INSERT INTO group_teachers(group_id,teacher_id,role) VALUES($1,$2,'primary')", [group, teacher]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  await admin.query("INSERT INTO teaching_sessions(id,group_id,teacher_id,school_id,start_time,end_time) VALUES($1,$2,$3,$4,$5::timestamp,$6::timestamp)", [session, group, teacher, schools[0], at(3600), at(7200)]);
  await admin.query("INSERT INTO classpilot_session_students(school_id,teaching_session_id,group_id,student_id,captured_at) VALUES($1,$2,$3,$4,$5::timestamptz)", [schools[0], session, group, students[0], new Date(day.dayStartUtc.getTime() + 3600000).toISOString()]);
});

after(async () => {
  // These uniquely identified fixture records may be retained by lifecycle
  // contracts; the owned native database is removed by the external runner.
  await Promise.all([worker?.end(), admin?.end()]);
});

describe("rollup exact-URL domain map against b112 SQL", () => {
  it("preserves repeated-URL categories, cross-student/class scope and zero-second grains", async () => {
    const observations: Observation[] = [];
    for (const student of [0, 1, 2]) for (let n = 0; n < 160; n++) observations.push({ student, seconds: 3600 + n * 10, url: `https://www.lesson-${n % 8}.example.test/path`, category: n % 3 === 0 ? "educational" : "non-educational", intent: student === 1 ? "flight_path" : null });
    observations.push({ student: 0, seconds: 86400 - 0.001, url: "https://zero.example.test/", category: "educational" });
    await seed(observations);
    const rows = await compare();
    assert.equal(rows.reduce((sum, row) => sum + row.heartbeat_count, 0), 321);
    assert.ok(rows.some(row => row.domain === "zero.example.test" && row.seconds === 0 && row.heartbeat_count === 1));
    assert.ok(rows.some(row => row.student_id === students[0] && row.class_id === group && row.session_id === session));
    assert.ok(rows.filter(row => row.student_id === students[1]).every(row => row.class_id === null && row.classification === "educational"));
    assert.ok(rows.some(row => row.student_id === students[0] && row.classification === "non-educational"));
  });

  it("preserves all-distinct raw URLs, including distinct paths with the same clipped domain", async () => {
    const observations: Observation[] = [];
    for (const student of [0, 1]) for (let n = 0; n < 240; n++) observations.push({ student, seconds: 4000 + n * 10, url: n < 120 ? `https://unique-${n}.example.test/path` : `https://${"a".repeat(270)}.example.test/path-${n}`, category: n % 2 ? "non-educational" : "educational" });
    await seed(observations);
    const rows = await compare();
    assert.equal(rows.reduce((sum, row) => sum + row.heartbeat_count, 0), 480);
    assert.ok(rows.some(row => row.domain === "a".repeat(253) && row.heartbeat_count === 60));
  });

  it("preserves null, empty, non-http, Unicode, case, userinfo, ports and malformed hosts", async () => {
    const urls = [null, "", "chrome://settings", "about:blank", "ftp://host.test", "https://", "http:///path", "http://:8080/path", "http://@/", "HTTP://WWW.Example.TEST/path?x=1", "https://user:pass@WWW.Example.test:443/path", "http://user@other@host.test:80/", "https://[::1]:443/a", "https://www.example.test.", "https://éxample.test/路径", "https://I.EXAMPLE.test", "https://example.test\\path", " https://example.test", "https://example.test\n/path", "https://example.test/?x=1", "https://example.test/?x=2", "https://example.test/#fragment", "https://www.example.test", "https://example.test:", "https://user@", "https:/broken", "https:////broken"];
    await seed(urls.flatMap((url, index) => [0, 1].map(student => ({ student, seconds: 8000 + index * 10, url, category: index % 3 === 0 ? null : "non-educational", intent: student === 1 ? "flight_path" : null }))));
    const rows = await compare();
    assert.equal(rows.reduce((sum, row) => sum + row.heartbeat_count, 0), urls.length * 2);
    assert.ok(rows.some(row => row.domain === ""));
    assert.ok(rows.some(row => row.domain === "example.test"));
    assert.ok(rows.filter(row => row.student_id === students[1]).every(row => row.classification !== "non-educational"));
  });

  it("preserves deduplication, newest AI ties/future decisions and exact exclusion boundaries", async () => {
    const selected = randomUUID();
    await seed([
      { student: 0, seconds: 3600.1, url: "https://www.shared.test/", category: "educational", id: selected },
      { student: 0, seconds: 3600.8, url: "https://duplicate.test/", category: "non-educational" },
      { student: 0, seconds: 3610, url: "https://www.shared.test/", category: "non-educational" },
      { student: 0, seconds: 3620, url: "https://www.shared.test/", category: "non-educational", intent: "flight_path" },
      { student: 0, seconds: 3630, url: "https://www.shared.test/", category: "non-educational" },
      { student: 1, seconds: 3610, url: "https://www.shared.test/", category: "educational" },
      { student: 2, seconds: 3600, url: "https://foreign.test/", category: "educational" },
    ]);
    for (const [suffix, createdAt, category] of [["a", at(86410), "educational"], ["z", at(86410), "non-educational"], ["old", at(-1), "educational"]]) await admin.query("INSERT INTO classpilot_ai_decisions(id,school_id,student_id,heartbeat_id,category,created_at) VALUES($1,$2,$3,$4,$5,$6::timestamp)", [`${selected}-${suffix}`, schools[0], students[0], selected, category, createdAt]);
    const rows = await compare([{ studentId: "", start: at(3615), end: at(3620) }, { studentId: students[0]!, start: at(3630), end: at(3640) }]);
    assert.equal(rows.reduce((sum, row) => sum + row.heartbeat_count, 0), 4);
    assert.ok(rows.some(row => row.student_id === students[0] && row.classification === "non-educational"));
    assert.ok(rows.every(row => row.domain === "shared.test"));
  });

  it("keeps restricted tenant isolation and actual atomic writer/coverage behavior", async () => {
    await seed([{ student: 0, seconds: 4000, url: "https://current.test/", category: "educational" }, { student: 2, seconds: 4000, url: "https://foreign.test/", category: "educational" }]);
    await compare();
    const actual = await rollupClasspilotUsageDay(worker, { schoolId: schools[0]!, day, windowEndUtc: day.dayEndUtc, exclusions: [] });
    assert.deepEqual(actual, { rowCount: 1, seconds: 15, heartbeatCount: 1 });
    const coverage = (await admin.query("SELECT processed_through,is_final FROM classpilot_usage_rollup_days WHERE school_id=$1 AND usage_date=$2::date", [schools[0], day.date])).rows[0];
    assert.equal(new Date(coverage.processed_through).getTime(), day.dayEndUtc.getTime());assert.equal(coverage.is_final, true);
    assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM classpilot_usage_rollups WHERE school_id=$1", [schools[1]])).rows[0].count, 0);
    if (restricted) {
      const client = await worker.connect();
      try { await client.query("BEGIN");await client.query("SELECT set_config('app.school_id',$1,true),set_config('app.is_super','off',true)", [schools[1]]);assert.equal((await client.query(grains(CLASSPILOT_USAGE_ROLLUP_INSERT_SQL), [schools[0], at(0), utcTimestampForSql(day.dayEndUtc), day.date, "[]"])).rowCount, 0); }
      finally { try { await client.query("ROLLBACK"); } finally { client.release(); } }
    }
  });
});
