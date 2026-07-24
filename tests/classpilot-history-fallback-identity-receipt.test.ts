import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  buildClasspilotHistoryFallbackIdentityReceipt,
} from "../scripts/write-classpilot-history-fallback-identity-receipt.mjs";

const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

function eventsDocument(
  queryIdentifier = "-9223372036854775808",
  trackIoTiming = true
) {
  const labels = [
    "teacher.live",
    "teacher.history",
    "co_teacher.live",
    "co_teacher.history",
    "office_staff.live",
    "office_staff.history",
  ];
  const report = {
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
      trackIoTiming,
    },
  };
  const lifecycle = {
    version: "transactional-plan-scenarios-v1",
    seededRows: {
      groupTeachers: 1,
      teachingSessions: 1,
      supervisionContexts: 1,
      supervisionStudents: 40,
      total: 43,
    },
    rollback: { attempted: true, completed: true },
    residue: { checked: true, count: 0, passed: true },
  };
  return {
    events: [
      { message: JSON.stringify(lifecycle) },
      { message: JSON.stringify(report) },
    ],
  };
}

const options = {
  eventsDocument: eventsDocument(),
  applicationGitSha: "d".repeat(40),
  deployedImageDigest: `sha256:${"e".repeat(64)}`,
  activeApiTaskDefinitionArn:
    "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:21",
  activeWorkerTaskDefinitionArn:
    "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:34",
  databaseResourceId: "db-JX7QF42WY7FRQANX2J3PK5QHZE",
  engineVersion: "16.4",
  expectedQueryIdentifierSha256: sha256("-9223372036854775808"),
  createdAtUtc: "2026-07-21T20:15:30.123Z",
};

describe("ClassPilot history fallback identity receipt", () => {
  it("binds the raw signed identifier to the exact release and active revisions", () => {
    const receipt = buildClasspilotHistoryFallbackIdentityReceipt(options);
    assert.deepEqual(receipt, {
      schemaVersion: 1,
      type: "history_fallback_query_identity_receipt",
      identityVersion: "history-fallback-queryid-v1",
      queryIdentifier: "-9223372036854775808",
      queryIdentifierSha256: options.expectedQueryIdentifierSha256,
      compiledSqlSha256: "a".repeat(64),
      parameterTypeSignatureSha256: "b".repeat(64),
      engineVersion: "16.4",
      schemaIdentitySha256: "c".repeat(64),
      trackIoTiming: true,
      databaseResourceId: options.databaseResourceId,
      applicationGitSha: options.applicationGitSha,
      deployedImageDigest: options.deployedImageDigest,
      activeApiTaskDefinitionArn: options.activeApiTaskDefinitionArn,
      activeWorkerTaskDefinitionArn: options.activeWorkerTaskDefinitionArn,
      createdAtUtc: options.createdAtUtc,
    });
  });

  it("fails closed on receipt tampering or pre/post identity drift", () => {
    for (const mutation of [
      { expectedQueryIdentifierSha256: "f".repeat(64) },
      { engineVersion: "16.5" },
      {
        eventsDocument: eventsDocument("-9223372036854775808", false),
      },
      { databaseResourceId: "not-an-rds-resource" },
      { deployedImageDigest: "latest" },
      {
        activeWorkerTaskDefinitionArn:
          "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api:34",
      },
    ]) {
      assert.throws(() =>
        buildClasspilotHistoryFallbackIdentityReceipt({
          ...options,
          ...mutation,
        })
      );
    }
  });

  it("keeps the raw identifier out of an ordinary sanitized projection", () => {
    const receipt = buildClasspilotHistoryFallbackIdentityReceipt(options);
    const sanitized = {
      identityVersion: receipt.identityVersion,
      queryIdentifierSha256: receipt.queryIdentifierSha256,
      compiledSqlSha256: receipt.compiledSqlSha256,
      parameterTypeSignatureSha256: receipt.parameterTypeSignatureSha256,
      schemaIdentitySha256: receipt.schemaIdentitySha256,
    };
    assert.equal(JSON.stringify(sanitized).includes(receipt.queryIdentifier), false);
  });
});
