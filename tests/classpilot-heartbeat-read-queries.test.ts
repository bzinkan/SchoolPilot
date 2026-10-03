import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql, fillPlaceholders } from "drizzle-orm";
import { heartbeatSchoolQuery, heartbeatLicenseQuery, heartbeatSessionQuery, heartbeatControlQuery, heartbeatCandidateQuery } from "../src/services/classpilotHeartbeatReadQueries.js";

test("five canonical SELECTs retain independently captured 0e427 SQL and ordered encoded parameters", () => {
  const golden = JSON.parse(readFileSync(new URL("./fixtures/classpilot-heartbeat-read-queries-0e427.json", import.meta.url), "utf8"));
  const builders = { locked_school: heartbeatSchoolQuery, locked_license: heartbeatLicenseQuery,
    screenshot_session: heartbeatSessionQuery, screenshot_control: heartbeatControlQuery, screenshot_candidate: heartbeatCandidateQuery };
  const dialect = new PgDialect();
  const database = drizzle.mock();
  const placeholders = { schoolId: sql.placeholder("schoolId"), studentId: sql.placeholder("studentId"),
    studentSessionId: sql.placeholder("studentSessionId"), deviceId: sql.placeholder("deviceId"), teachingSessionId: sql.placeholder("teachingSessionId") };
  for (const [label, builder] of Object.entries(builders)) {
    const query = builder(database, golden.values).toSQL();
    assert.deepEqual(query, golden.shapes[label], label);
    const compiled = dialect.sqlToQuery(builder(database, placeholders).getSQL());
    assert.equal(compiled.sql, query.sql);
    assert.deepEqual(fillPlaceholders(compiled.params, golden.values), query.params);
  }
});
