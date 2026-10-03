import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { CLASSPILOT_HEARTBEAT_SCREENSHOT_EVIDENCE_SQL } from "../src/db/classpilotHeartbeatScreenshotEvidenceDefinition.js";
import { canonicalHeartbeatScreenshotFunctionSql } from "./helpers/classpilot-heartbeat-screenshot-sql.js";
import { heartbeatScreenshotEvidenceQuery } from "../src/services/classpilotHeartbeatScreenshotEvidence.js";
import { heartbeatTelemetryOwnerQuery } from "../src/services/classpilotHeartbeatReadQueries.js";

test("installed screenshot SQL is the independently reviewed native body and current canonical four statements", () => {
  // Recorded before production extraction: measured prototype04, with only the
  // agreed versioned function name substituted. Never update this on policy drift.
  assert.equal(createHash("sha256").update(CLASSPILOT_HEARTBEAT_SCREENSHOT_EVIDENCE_SQL).digest("hex"),
    "10a2bf7377afc98c1d4a9f9a54afba740a97ab408dcb3df7bbb5dd019c964e76");
  assert.equal(canonicalHeartbeatScreenshotFunctionSql(), CLASSPILOT_HEARTBEAT_SCREENSHOT_EVIDENCE_SQL);
});

test("function call binds fresh tuple values in exact school/student/session/device order", () => {
  const database = drizzle.mock();
  const values = { schoolId: "school'雪", studentId: "student", studentSessionId: "session", deviceId: "device" };
  const compiled = heartbeatScreenshotEvidenceQuery(database, values).toSQL();
  assert.deepEqual(compiled.params, Object.values(values));
  assert.match(compiled.sql, /public\.classpilot_heartbeat_screenshot_evidence_v1\(/);
  assert.match(compiled.sql, /\$1::text, \$2::text,/);
  assert.match(compiled.sql, /\$3::text, \$4::text/);
  assert.doesNotMatch(compiled.sql, /school'雪/);
});

test("canonical owner retains transaction clock for screenshot and fresh clock only for owned inbox", () => {
  const dialect = new PgDialect();
  const current = dialect.sqlToQuery(heartbeatTelemetryOwnerQuery("school", "student", "current"));
  const transaction = dialect.sqlToQuery(heartbeatTelemetryOwnerQuery("school", "student", "transaction"));
  assert.deepEqual(current.params, transaction.params);
  assert.equal(current.sql.replaceAll("clock_timestamp()", "now()"), transaction.sql);
  assert.equal((current.sql.match(/clock_timestamp\(\)/g) ?? []).length, 2);
  assert.doesNotMatch(transaction.sql, /clock_timestamp|ORDER BY|LIMIT/i);
  const placeholders = dialect.sqlToQuery(heartbeatTelemetryOwnerQuery(sql.placeholder("schoolId"), sql.placeholder("studentId"), "transaction"));
  assert.equal(placeholders.sql, transaction.sql);
});
