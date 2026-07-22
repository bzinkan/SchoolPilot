import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  extractClasspilotTileAuthorizationPlanIdentity,
  validateClasspilotTileAuthorizationPlanEvidence,
} from "../scripts/validate-classpilot-tile-auth-plan-evidence.mjs";

const labels = [
  "teacher.live",
  "teacher.history",
  "co_teacher.live",
  "co_teacher.history",
  "office_staff.live",
  "office_staff.history",
];

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validReport() {
  const queryIdentifier = "-9223372036854775808";
  return {
    status: "passed",
    precheck: { invalidTeachingSessionSchools: 0 },
    samples: 20,
    warmups: 2,
    cohortSize: 40,
    thresholds: {
      p95Ms: 50,
      maxMs: 100,
      tempReadBlocks: 0,
      tempWrittenBlocks: 0,
      subPlanNodes: 0,
      windowAggNodes: 0,
      heartbeatSequentialScanNodes: 0,
      maxHeartbeatRows: 400,
      perPairIndexLimit: true,
    },
    scenarios: labels.map((label, index) => ({
      label,
      cohortSize: 40,
      samples: 20,
      p95Ms: 10 + index,
      maxMs: 20 + index,
      tempReadBlocks: 0,
      tempWrittenBlocks: 0,
      subPlanNodes: 0,
      passed: true,
    })),
    historyFallback: {
      label: "history_fallback",
      cohortSize: 40,
      historyLimit: 10,
      samples: 20,
      p95Ms: 18,
      maxMs: 24,
      tempReadBlocks: 0,
      tempWrittenBlocks: 0,
      subPlanNodes: 0,
      windowAggNodes: 0,
      heartbeatSequentialScanNodes: 0,
      maxReturnedRows: 400,
      perPairIndexLimit: true,
      passed: true,
    },
    historyFallbackSqlIdentity: {
      version: "history-fallback-queryid-v1",
      queryIdentifier,
      queryIdentifierSha256: sha256(queryIdentifier),
      compiledSqlSha256: "a".repeat(64),
      parameterTypeSignatureSha256: "b".repeat(64),
      engineVersion: "16.4",
      schemaIdentitySha256: "c".repeat(64),
      trackIoTiming: true,
    },
  };
}

function events(report = validReport()) {
  return {
    events: [
      { message: "startup noise" },
      { message: JSON.stringify(report) },
    ],
  };
}

describe("ClassPilot tile authorization plan identity evidence", () => {
  it("returns sanitized evidence while the reviewed extractor returns the raw signed identifier", () => {
    const report = validReport();
    const sanitized = validateClasspilotTileAuthorizationPlanEvidence(
      events(report)
    );
    assert.deepEqual(sanitized.historyFallbackSqlIdentity, {
      version: "history-fallback-queryid-v1",
      queryIdentifierSha256:
        report.historyFallbackSqlIdentity.queryIdentifierSha256,
      compiledSqlSha256: "a".repeat(64),
      parameterTypeSignatureSha256: "b".repeat(64),
      engineVersion: "16.4",
      schemaIdentitySha256: "c".repeat(64),
      trackIoTiming: true,
    });
    assert.equal(
      JSON.stringify(sanitized).includes(
        report.historyFallbackSqlIdentity.queryIdentifier
      ),
      false
    );
    assert.deepEqual(
      extractClasspilotTileAuthorizationPlanIdentity(events(report)),
      report.historyFallbackSqlIdentity
    );
  });

  it("rejects missing, malformed, zero, out-of-range, ambiguous, or tampered identity evidence", () => {
    const cases = [
      { ...validReport(), historyFallbackSqlIdentity: undefined },
      {
        ...validReport(),
        historyFallbackSqlIdentity: {
          ...validReport().historyFallbackSqlIdentity,
          queryIdentifier: "0",
          queryIdentifierSha256: sha256("0"),
        },
      },
      {
        ...validReport(),
        historyFallbackSqlIdentity: {
          ...validReport().historyFallbackSqlIdentity,
          queryIdentifier: "01",
          queryIdentifierSha256: sha256("01"),
        },
      },
      {
        ...validReport(),
        historyFallbackSqlIdentity: {
          ...validReport().historyFallbackSqlIdentity,
          queryIdentifier: "9223372036854775808",
          queryIdentifierSha256: sha256("9223372036854775808"),
        },
      },
      {
        ...validReport(),
        historyFallbackSqlIdentity: {
          ...validReport().historyFallbackSqlIdentity,
          queryIdentifierSha256: "d".repeat(64),
        },
      },
      {
        ...validReport(),
        historyFallbackSqlIdentity: {
          ...validReport().historyFallbackSqlIdentity,
          rawSql: "SELECT secret",
        },
      },
      {
        ...validReport(),
        historyFallbackSqlIdentity: {
          ...validReport().historyFallbackSqlIdentity,
          trackIoTiming: false,
        },
      },
    ];
    for (const report of cases) {
      assert.throws(() =>
        validateClasspilotTileAuthorizationPlanEvidence(events(report))
      );
      assert.throws(() =>
        extractClasspilotTileAuthorizationPlanIdentity(events(report))
      );
    }
  });

  it("does not release the raw identity when another plan gate fails", () => {
    const report = validReport();
    report.scenarios[0].p95Ms = 50.001;
    assert.throws(() =>
      extractClasspilotTileAuthorizationPlanIdentity(events(report))
    );
  });
});
