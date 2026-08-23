import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMonitorEvent } from "../src/services/errorMonitor.js";
import { safeErrorMetadata } from "../src/util/safeLogging.js";
import { readFileSync } from "node:fs";

test("operational error metadata excludes messages, stacks, URLs, and identifiers", () => {
  const error = Object.assign(
    new Error("Student Name student@example.org https://school.example/path?token=secret"),
    { code: "ECONNRESET", deviceId: "device-123" }
  );
  const metadata = safeErrorMetadata(error);
  assert.deepEqual(metadata, { errorType: "Error", errorCode: "ECONNRESET" });
  assert.doesNotMatch(JSON.stringify(metadata), /Student Name|student@example|school\.example|device-123|secret/);
});

test("untrusted error codes are not emitted", () => {
  const metadata = safeErrorMetadata({
    name: "Student Name",
    code: "device=device-123 token=secret",
  });
  assert.deepEqual(metadata, { errorType: "Error" });
});

test("error monitoring drops tenant and user identifiers from operational correlation", () => {
  const event = normalizeMonitorEvent("api_error", new Error("request failed"), {
    requestId: "request-correlation-only",
    schoolId: "school-123",
    userId: "user-123",
    studentId: "student-123",
    deviceId: "device-123",
    job: "api_request",
  });
  assert.equal(event.correlation.requestId, "request-correlation-only");
  assert.equal(Object.hasOwn(event.correlation, "schoolId"), false);
  assert.equal(Object.hasOwn(event.correlation, "userId"), false);
  assert.deepEqual(event.context, { job: "api_request" });
});

test("student-removal and directory diagnostics contain counts and correlation only", () => {
  for (const file of [
    "../src/routes/compat.ts",
    "../src/routes/students.ts",
    "../src/routes/classpilot/monitoring.ts",
    "../src/routes/google/directory.ts",
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const match of source.matchAll(/console\.(?:warn|error|info|log)\([\s\S]{0,500}?\);/g)) {
      const statement = match[0];
      if (!/Student Removal|googleDirectory/.test(statement)) continue;
      assert.doesNotMatch(
        statement,
        /\b(?:schoolId|studentId|deviceId|queriedDomain|orgUnitPath)\s*[,}:]/
      );
    }
  }
});

test("TURN raw logs are parsed locally but never forwarded to CloudWatch Logs", () => {
  const userData = readFileSync(
    new URL("../infra/modules/turn/user-data.sh.tftpl", import.meta.url),
    "utf8"
  );
  const terraform = readFileSync(
    new URL("../infra/modules/turn/main.tf", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(userData, /logs_collected|log_group_name|log_stream_name/);
  assert.doesNotMatch(terraform, /aws_cloudwatch_log_group|aws_cloudwatch_log_metric_filter/);
});
