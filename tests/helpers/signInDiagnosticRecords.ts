import assert from "node:assert/strict";
import type { TestContext } from "node:test";

/** A student sign-in diagnostic record as emitted; every field is kept, four are typed. */
export type StudentSignInDiagnosticRecord = {
  event: string;
  reason: string;
  diagnosticId: string;
  httpStatus: number | null;
  [field: string]: unknown;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTANCE_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|unknown)$/i;
const RELEASE = /^(?:[0-9a-f]{40}|unknown)$/i;

/** Intercept console.log and keep every emitted student sign-in diagnostic record. */
export function captureStudentSignInRecords(t: TestContext): StudentSignInDiagnosticRecord[] {
  const records: StudentSignInDiagnosticRecord[] = [];
  t.mock.method(console, "log", (line: unknown) => {
    if (typeof line !== "string" || !line.startsWith("{")) return;
    const record = JSON.parse(line) as StudentSignInDiagnosticRecord;
    if (typeof record.reason === "string") records.push(record);
  });
  return records;
}

/**
 * Prove that each volatile field has its strict shape, then replace it with a fixed
 * placeholder. A random identifier (a UUID, a release SHA) can contain any digit run,
 * including a private test value such as a PIN, so a privacy assertion over the serialized
 * records must not run over them. A leaked value cannot hide in a field that was just
 * proven to be a UUID, an ISO timestamp, an integer, or a release SHA, so the assertion
 * over the normalized records is at least as strong as one over the raw records.
 */
export function normalizeVolatileFields(
  records: readonly StudentSignInDiagnosticRecord[],
): StudentSignInDiagnosticRecord[] {
  return records.map((record, index) => {
    const label = `record ${index}`;
    assert.match(String(record.diagnosticId), UUID, `${label}: diagnosticId must be a UUID`);
    assert.match(String(record.InstanceId), INSTANCE_ID, `${label}: InstanceId must be a UUID or unknown`);
    assert.match(String(record.Release), RELEASE, `${label}: Release must be a 40-hex SHA or unknown`);
    const timestamp = record.timestampUtc;
    assert.ok(
      typeof timestamp === "string" && new Date(timestamp).toISOString() === timestamp,
      `${label}: timestampUtc must be an ISO-8601 UTC timestamp`,
    );
    const elapsed = record.elapsedMs;
    assert.ok(
      elapsed === null || (typeof elapsed === "number" && Number.isInteger(elapsed) && elapsed >= 0),
      `${label}: elapsedMs must be null or a non-negative integer`,
    );
    return {
      ...record,
      diagnosticId: "<diagnostic-id>",
      InstanceId: "<instance-id>",
      Release: "<release>",
      timestampUtc: "<timestamp-utc>",
      elapsedMs: elapsed === null ? null : 0,
    };
  });
}
