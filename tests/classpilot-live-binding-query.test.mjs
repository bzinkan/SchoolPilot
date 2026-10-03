import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import { devices, studentSessions } from "../src/schema/classpilot.ts";
import { students } from "../src/schema/students.ts";
import { currentStudentSessionAuthorityPredicate } from "../src/services/classpilotStudentSessionAuthority.ts";

// Execute the actual private storage helper without importing its database pool.
const source = readFileSync(new URL("../src/services/storage.ts", import.meta.url), "utf8");
const body = source.slice(source.indexOf("async function hasExactClasspilotTelemetryBinding("),
  source.indexOf("export type ClasspilotScreenshotAuthorityClaim"));
const javascript = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const checkBinding = new Function("sql", "and", "eq", "studentSessions", "students", "devices",
  "currentStudentSessionAuthorityPredicate", `${javascript}; return hasExactClasspilotTelemetryBinding;`)(
  sql, and, eq, studentSessions, students, devices, currentStudentSessionAuthorityPredicate);
const dialect = new PgDialect();
const database = drizzle.mock();
const binding = { schoolId: "synthetic-school", studentId: "synthetic-student",
  studentSessionId: "synthetic-session", deviceId: "synthetic-device" };

const previousQuery = () => database.select({ id: studentSessions.id }).from(studentSessions)
  .innerJoin(students, and(eq(students.id, studentSessions.studentId), eq(students.schoolId, binding.schoolId), eq(students.status, "active")))
  .innerJoin(devices, and(eq(devices.deviceId, studentSessions.deviceId), eq(devices.schoolId, binding.schoolId)))
  .where(and(eq(studentSessions.id, binding.studentSessionId), eq(studentSessions.studentId, binding.studentId),
    eq(studentSessions.deviceId, binding.deviceId), currentStudentSessionAuthorityPredicate()))
  .limit(1).for("share").toSQL();
const normalize = text => text.toLowerCase().replace(/\s+/g, " ").replace(/\s*([(),])\s*/g, "$1").trim();

test("live-binding query preserves exact generated SQL, parameter order and all joined-row locks", async t => {
  let actual;
  assert.equal(await checkBinding(binding, { execute: async query => {
    actual = dialect.sqlToQuery(query);
    return { rows: [{ id: binding.studentSessionId }] };
  } }), true);
  const previous = previousQuery();
  assert.equal(normalize(actual.sql), normalize(previous.sql));
  assert.deepEqual(actual.params, previous.params);
  assert.match(actual.sql, /clock_timestamp\(\)/);
  assert.match(actual.sql, /LIMIT\s+\$\d+\s+FOR SHARE\s*$/);
  assert.doesNotMatch(actual.sql, /FOR SHARE OF/);
  t.diagnostic(JSON.stringify({ previousSql: previous.sql, currentSql: actual.sql,
    parameters: actual.params, fixtureOnly: true, sqlAndParameterEquivalence: true }));
});

test("live-binding raw result still rejects a missing exact binding", async () => {
  let queries = 0;
  assert.equal(await checkBinding(binding, { execute: async () => { queries++; return { rows: [] }; } }), false);
  assert.equal(queries, 1);
});
