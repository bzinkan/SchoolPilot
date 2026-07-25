import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  admitClasspilotTileAuthorizationPlanRehearsalAttempt,
  buildClasspilotTileAuthorizationPlanRehearsalReceipt,
  consumeClasspilotTileAuthorizationPlanRehearsalReceipt,
  hashClasspilotTileAuthorizationPlanExecutionAuthority,
  inspectClasspilotTileAuthorizationPlanRehearsalReceipt,
  REHEARSAL_ATTEMPT_FILENAME,
  REHEARSAL_CONSUMPTION_FILENAME,
  REHEARSAL_LIFECYCLE_EVIDENCE_FILENAME,
  REHEARSAL_PLAN_REPORT_FILENAME,
  REHEARSAL_PREFLIGHT_EVIDENCE_FILENAME,
  REHEARSAL_RECEIPT_FILENAME,
  REHEARSAL_TERMINAL_FILENAME,
  resolveClasspilotTileAuthorizationPlanExecutionAuthority,
  terminalClasspilotTileAuthorizationPlanRehearsalAttempt,
  writeClasspilotTileAuthorizationPlanRehearsalReceipt,
} from "../scripts/manage-classpilot-tile-auth-plan-rehearsal-receipt.mjs";
import {
  extractClasspilotTileAuthorizationPlanFailure,
} from "../scripts/extract-classpilot-tile-auth-plan-failure.mjs";
import {
  validateClasspilotTileAuthorizationPlanPreflightEvidence,
} from "../scripts/validate-classpilot-tile-auth-plan-preflight-evidence.mjs";
import {
  validateClasspilotTileAuthorizationPlanEvidence,
} from "../scripts/validate-classpilot-tile-auth-plan-evidence.mjs";

const previousEnvironment = {
  NODE_ENV: process.env.NODE_ENV,
  CLP_LOAD_FIXTURE_TEST_MODE: process.env.CLP_LOAD_FIXTURE_TEST_MODE,
  CLP_LOAD_GATES_TEST_ROOT: process.env.CLP_LOAD_GATES_TEST_ROOT,
  CLP_TILE_AUTH_PLAN_REHEARSAL_TEST_EXECUTION_AUTHORITY_SHA256:
    process.env.CLP_TILE_AUTH_PLAN_REHEARSAL_TEST_EXECUTION_AUTHORITY_SHA256,
};
const temporaryRoots: string[] = [];
const testExecutionAuthoritySha256 = "4".repeat(64);

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function sha(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function validLifecycle(insertedSessionPairs = 80) {
  return {
    version: "transactional-plan-scenarios-v2",
    requiredSessionPairs: 80,
    reusedActiveSessionPairs: 80 - insertedSessionPairs,
    insertedSessionPairs,
    seededRows: {
      groupTeachers: 1,
      teachingSessions: 1,
      supervisionContexts: 1,
      supervisionStudents: 40,
      studentSessions: insertedSessionPairs,
      total: 43 + insertedSessionPairs,
    },
    rollback: { attempted: true, completed: true },
    residue: { checked: true, count: 0, passed: true },
  };
}

function validReport() {
  const labels = [
    "teacher.live",
    "teacher.history",
    "co_teacher.live",
    "co_teacher.history",
    "office_staff.live",
    "office_staff.history",
  ];
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
      queryIdentifierSha256: sha(queryIdentifier),
      compiledSqlSha256: "a".repeat(64),
      parameterTypeSignatureSha256: "b".repeat(64),
      engineVersion: "16.4",
      schemaIdentitySha256: "c".repeat(64),
      trackIoTiming: true,
    },
  };
}

function validPreflight(reusedActiveSessionPairs = 0) {
  return {
    version: "classpilot-tile-auth-plan-base-preflight-v1",
    status: "passed",
    eligibleBases: 1,
    requiredSessionPairs: 80,
    reusedActiveSessionPairs,
    missingSessionPairs: 80 - reusedActiveSessionPairs,
    conflictingSessionPairs: 0,
  };
}

function events(...messages: unknown[]) {
  return {
    events: [
      { message: "startup noise" },
      ...messages.map((message) => ({ message: JSON.stringify(message) })),
    ],
  };
}

function writeJson(filePath: string, value: unknown) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function rehashReceiptCompanion(
  runRoot: string,
  companionFilename: string,
  receiptHashKey: string,
  companion: unknown
) {
  const companionPath = path.join(runRoot, companionFilename);
  writeJson(companionPath, companion);
  const receiptPath = path.join(
    runRoot,
    "classpilot-tile-auth-plan-rehearsal.private.json"
  );
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  receipt[receiptHashKey] = sha(fs.readFileSync(companionPath, "utf8"));
  writeJson(receiptPath, receipt);
  return {
    receiptPath,
    receiptSha256: sha(fs.readFileSync(receiptPath, "utf8")),
  };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sp-tile-rehearsal-"));
  temporaryRoots.push(root);
  process.env.NODE_ENV = "test";
  process.env.CLP_LOAD_FIXTURE_TEST_MODE = "1";
  process.env.CLP_LOAD_GATES_TEST_ROOT = root;
  process.env.CLP_TILE_AUTH_PLAN_REHEARSAL_TEST_EXECUTION_AUTHORITY_SHA256 =
    testExecutionAuthoritySha256;
  const applicationGitSha = "d".repeat(40);
  const activeApiTaskDefinitionArn =
    "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:20";
  const activeWorkerTaskDefinitionArn =
    "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:30";
  const options = {
    applicationGitSha,
    imageDigest: `sha256:${"e".repeat(64)}`,
    candidateApiTaskDefinitionArn:
      "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:21",
    candidateApiTaskDefinitionSha256: "1".repeat(64),
    candidateWorkerTaskDefinitionArn:
      "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:31",
    candidateWorkerTaskDefinitionSha256: "2".repeat(64),
    activeApiTaskDefinitionArn,
    activeWorkerTaskDefinitionArn,
    networkConfigurationSha256: "3".repeat(64),
    preflightEventsDocument: events(validPreflight()),
    planEventsDocument: events(validLifecycle(), validReport()),
    createdAtUtc: "2026-07-24T16:00:00.000Z",
  };
  const expected = {
    expectedApplicationGitSha: applicationGitSha,
    expectedActiveApiTaskDefinitionArn: activeApiTaskDefinitionArn,
    expectedActiveWorkerTaskDefinitionArn: activeWorkerTaskDefinitionArn,
    expectedNetworkConfigurationSha256: "3".repeat(64),
    nowUtc: "2026-07-24T16:30:00.000Z",
    expectedReceiptSha256: "",
  };
  return { root, options, expected };
}

function sealPassedReceipt(
  root: string,
  options: ReturnType<typeof fixture>["options"],
  expected: ReturnType<typeof fixture>["expected"],
  directoryName = "run"
) {
  const admission =
    admitClasspilotTileAuthorizationPlanRehearsalAttempt({
      applicationGitSha: options.applicationGitSha,
      admittedAtUtc: "2026-07-24T15:59:00.000Z",
    });
  const receipt =
    buildClasspilotTileAuthorizationPlanRehearsalReceipt(options);
  const written = writeClasspilotTileAuthorizationPlanRehearsalReceipt(
    path.join(root, directoryName),
    receipt,
    {
      preflight: validPreflight(),
      report: validateClasspilotTileAuthorizationPlanEvidence(
        options.planEventsDocument
      ),
      lifecycle: validLifecycle(),
    }
  );
  terminalClasspilotTileAuthorizationPlanRehearsalAttempt({
    applicationGitSha: options.applicationGitSha,
    expectedAdmissionSha256: admission.sha256,
    outcome: "passed",
    receiptPath: written.path,
    receiptSha256: written.sha256,
    terminalAtUtc: "2026-07-24T16:01:00.000Z",
  });
  expected.expectedReceiptSha256 = written.sha256;
  return { admission, written };
}

function consumeInChildProcess(
  receiptPath: string,
  expected: Record<string, string>
) {
  const managerUrl = new URL(
    "../scripts/manage-classpilot-tile-auth-plan-rehearsal-receipt.mjs",
    import.meta.url
  ).href;
  const expectedBase64 = Buffer.from(JSON.stringify(expected), "utf8").toString(
    "base64"
  );
  const source = `
    import { consumeClasspilotTileAuthorizationPlanRehearsalReceipt } from ${JSON.stringify(managerUrl)};
    const expected = JSON.parse(Buffer.from(process.env.EXPECTED_RECEIPT_INPUT, "base64").toString("utf8"));
    try {
      consumeClasspilotTileAuthorizationPlanRehearsalReceipt(process.env.RECEIPT_PATH, expected);
      process.exit(0);
    } catch {
      process.exit(1);
    }
  `;
  return new Promise<number>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", source],
      {
        env: {
          ...process.env,
          EXPECTED_RECEIPT_INPUT: expectedBase64,
          RECEIPT_PATH: receiptPath,
        },
        stdio: "ignore",
      }
    );
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? -1));
  });
}

describe("ClassPilot tile authorization candidate rehearsal evidence", () => {
  it("hashes normalized machine and user identity without persisting either", () => {
    const first = hashClasspilotTileAuthorizationPlanExecutionAuthority({
      machineGuid: "01234567-89ab-cdef-0123-456789abcdef",
      userSid: "S-1-5-21-100-200-300-400",
    });
    const second = hashClasspilotTileAuthorizationPlanExecutionAuthority({
      machineGuid: "01234567-89AB-CDEF-0123-456789ABCDEF",
      userSid: "s-1-5-21-100-200-300-400",
    });
    assert.equal(first, second);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(first, /01234567|S-1-5-21/);
  });

  it("permits deterministic authority injection only in the isolated test mode", () => {
    const isolatedRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "sp-tile-rehearsal-authority-")
    );
    temporaryRoots.push(isolatedRoot);
    process.env.CLP_LOAD_GATES_TEST_ROOT = isolatedRoot;
    process.env.CLP_TILE_AUTH_PLAN_REHEARSAL_TEST_EXECUTION_AUTHORITY_SHA256 =
      testExecutionAuthoritySha256;
    process.env.NODE_ENV = "production";
    process.env.CLP_LOAD_FIXTURE_TEST_MODE = "1";
    assert.throws(() =>
      resolveClasspilotTileAuthorizationPlanExecutionAuthority()
    );
    process.env.NODE_ENV = "test";
    process.env.CLP_LOAD_FIXTURE_TEST_MODE = "0";
    assert.throws(() =>
      resolveClasspilotTileAuthorizationPlanExecutionAuthority()
    );
    process.env.CLP_LOAD_FIXTURE_TEST_MODE = "1";
    assert.equal(
      resolveClasspilotTileAuthorizationPlanExecutionAuthority(),
      testExecutionAuthoritySha256
    );
    process.env.CLP_LOAD_GATES_TEST_ROOT = os.tmpdir();
    assert.throws(() =>
      resolveClasspilotTileAuthorizationPlanExecutionAuthority()
    );
    process.env.CLP_LOAD_GATES_TEST_ROOT = path.join(
      os.homedir(),
      "SchoolPilot",
      "load-gates"
    );
    assert.throws(() =>
      resolveClasspilotTileAuthorizationPlanExecutionAuthority()
    );
  });

  it("validates the exact read-only base-preflight aggregate", () => {
    assert.deepEqual(
      validateClasspilotTileAuthorizationPlanPreflightEvidence(
        events(validPreflight())
      ),
      validPreflight()
    );
    for (const invalid of [
      { ...validPreflight(), eligibleBases: 2 },
      { ...validPreflight(), conflictingSessionPairs: 1 },
      { ...validPreflight(), missingSessionPairs: 79 },
      { ...validPreflight(), studentId: "forbidden" },
    ]) {
      assert.throws(() =>
        validateClasspilotTileAuthorizationPlanPreflightEvidence(events(invalid))
      );
    }
  });

  it("surfaces exactly one allowlisted failure without labels or identifiers", () => {
    assert.equal(
      extractClasspilotTileAuthorizationPlanFailure(events({
        status: "failed",
        failureCode: "representative_scenario_missing",
        labels: ["teacher.live"],
        studentId: "must-not-escape",
      })),
      "representative_scenario_missing"
    );
    assert.equal(
      extractClasspilotTileAuthorizationPlanFailure(events(
        {
          status: "failed",
          scenarios: [{ label: "teacher.live", passed: false }],
        },
        {
          status: "failed",
          failureCode: "plan_threshold_failed",
        }
      )),
      "plan_threshold_failed"
    );
    assert.throws(() =>
      extractClasspilotTileAuthorizationPlanFailure(events({
        status: "failed",
        failureCode: "unreviewed_failure",
      }))
    );
    assert.throws(() =>
      extractClasspilotTileAuthorizationPlanFailure(events(
        { status: "failed", failureCode: "database_operation_failed" },
        { status: "failed", failureCode: "database_operation_failed" }
      ))
    );
  });

  it("rejects legacy v1 and 43-only lifecycle evidence from receipts", () => {
    for (const lifecycle of [
      {
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
      },
      {
        version: "transactional-plan-scenarios-v2",
        seededRows: {
          groupTeachers: 1,
          teachingSessions: 1,
          supervisionContexts: 1,
          supervisionStudents: 40,
          total: 43,
        },
        rollback: { attempted: true, completed: true },
        residue: { checked: true, count: 0, passed: true },
      },
    ]) {
      const { options } = fixture();
      options.planEventsDocument = events(lifecycle, validReport());
      assert.throws(() =>
        buildClasspilotTileAuthorizationPlanRehearsalReceipt(options)
      );
    }
  });

  it("atomically admits one rehearsal attempt per SHA and seals one terminal", () => {
    const { root, options } = fixture();
    const admission =
      admitClasspilotTileAuthorizationPlanRehearsalAttempt({
        applicationGitSha: options.applicationGitSha,
        admittedAtUtc: "2026-07-24T16:00:00.000Z",
      });
    const expectedAttemptPath = path.join(
      root,
      "tile-auth-rehearsals",
      options.applicationGitSha,
      REHEARSAL_ATTEMPT_FILENAME
    );
    assert.equal(admission.path, expectedAttemptPath);
    assert.equal(fs.existsSync(expectedAttemptPath), true);
    assert.throws(() =>
      admitClasspilotTileAuthorizationPlanRehearsalAttempt({
        applicationGitSha: options.applicationGitSha,
        admittedAtUtc: "2026-07-24T16:00:01.000Z",
      })
    );

    const terminal =
      terminalClasspilotTileAuthorizationPlanRehearsalAttempt({
        applicationGitSha: options.applicationGitSha,
        expectedAdmissionSha256: admission.sha256,
        outcome: "failed",
        terminalAtUtc: "2026-07-24T16:01:00.000Z",
      });
    assert.equal(terminal.status, "failed");
    assert.equal(
      terminal.path,
      path.join(
        root,
        "tile-auth-rehearsals",
        options.applicationGitSha,
        REHEARSAL_TERMINAL_FILENAME
      )
    );
    assert.equal(terminal.receiptSha256, null);
    assert.throws(() =>
      terminalClasspilotTileAuthorizationPlanRehearsalAttempt({
        applicationGitSha: options.applicationGitSha,
        expectedAdmissionSha256: admission.sha256,
        outcome: "failed",
        terminalAtUtc: "2026-07-24T16:02:00.000Z",
      })
    );
    assert.throws(() =>
      admitClasspilotTileAuthorizationPlanRehearsalAttempt({
        applicationGitSha: options.applicationGitSha,
        admittedAtUtc: "2026-07-24T16:03:00.000Z",
      })
    );

    if (process.platform !== "win32") {
      assert.equal(fs.statSync(path.dirname(admission.path)).mode & 0o777, 0o700);
      assert.equal(fs.statSync(admission.path).mode & 0o777, 0o600);
      assert.equal(fs.statSync(terminal.path).mode & 0o777, 0o600);
    }
  });

  it("fails closed on mismatched, backdated, or unbound terminal evidence", () => {
    const { root, options } = fixture();
    const admission =
      admitClasspilotTileAuthorizationPlanRehearsalAttempt({
        applicationGitSha: options.applicationGitSha,
        admittedAtUtc: "2026-07-24T16:00:00.000Z",
      });
    for (const invalid of [
      {
        expectedAdmissionSha256: "f".repeat(64),
        outcome: "failed",
        terminalAtUtc: "2026-07-24T16:01:00.000Z",
      },
      {
        expectedAdmissionSha256: admission.sha256,
        outcome: "failed",
        terminalAtUtc: "2026-07-24T15:59:59.999Z",
      },
      {
        expectedAdmissionSha256: admission.sha256,
        outcome: "passed",
        terminalAtUtc: "2026-07-24T16:01:00.000Z",
      },
      {
        expectedAdmissionSha256: admission.sha256,
        outcome: "failed",
        receiptPath: "forbidden",
        receiptSha256: "e".repeat(64),
        terminalAtUtc: "2026-07-24T16:01:00.000Z",
      },
    ]) {
      assert.throws(() =>
        terminalClasspilotTileAuthorizationPlanRehearsalAttempt({
          applicationGitSha: options.applicationGitSha,
          ...invalid,
        })
      );
      assert.equal(
        fs.existsSync(
          path.join(
            root,
            "tile-auth-rehearsals",
            options.applicationGitSha,
            REHEARSAL_TERMINAL_FILENAME
          )
        ),
        false
      );
    }
  });

  it("seals reviewable evidence, enforces 60 minutes, and consumes once", () => {
    const { root, options, expected } = fixture();
    const admission =
      admitClasspilotTileAuthorizationPlanRehearsalAttempt({
        applicationGitSha: options.applicationGitSha,
        admittedAtUtc: "2026-07-24T15:59:00.000Z",
      });
    const receipt = buildClasspilotTileAuthorizationPlanRehearsalReceipt(options);
    const preflight =
      validateClasspilotTileAuthorizationPlanPreflightEvidence(
        options.preflightEventsDocument
      );
    const report = validateClasspilotTileAuthorizationPlanEvidence(
      options.planEventsDocument
    );
    const lifecycle = validLifecycle();
    const written = writeClasspilotTileAuthorizationPlanRehearsalReceipt(
      path.join(root, "run"),
      receipt,
      { preflight, report, lifecycle }
    );
    expected.expectedReceiptSha256 = written.sha256;
    const terminal =
      terminalClasspilotTileAuthorizationPlanRehearsalAttempt({
        applicationGitSha: options.applicationGitSha,
        expectedAdmissionSha256: admission.sha256,
        outcome: "passed",
        receiptPath: written.path,
        receiptSha256: written.sha256,
        terminalAtUtc: "2026-07-24T16:01:00.000Z",
      });
    assert.equal(terminal.receiptSha256, written.sha256);
    assert.equal(terminal.status, "passed");
    for (const artifactPath of [
      admission.path,
      written.path,
      terminal.path,
    ]) {
      const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
      assert.equal(
        artifact.executionAuthoritySha256,
        testExecutionAuthoritySha256
      );
      assert.equal(
        JSON.stringify(artifact).includes("01234567-89ab-cdef"),
        false
      );
      assert.equal(JSON.stringify(artifact).includes("S-1-5-21"), false);
    }

    for (const filename of [
      REHEARSAL_PREFLIGHT_EVIDENCE_FILENAME,
      REHEARSAL_PLAN_REPORT_FILENAME,
      REHEARSAL_LIFECYCLE_EVIDENCE_FILENAME,
    ]) {
      assert.equal(fs.existsSync(path.join(root, "run", filename)), true);
    }
    assert.equal(
      fs.readFileSync(
        path.join(root, "run", REHEARSAL_PLAN_REPORT_FILENAME),
        "utf8"
      ).includes("-9223372036854775808"),
      false
    );
    const inspected =
      inspectClasspilotTileAuthorizationPlanRehearsalReceipt(
        written.path,
        expected
      );
    assert.equal(inspected.receiptSha256, written.sha256);
    const consumed =
      consumeClasspilotTileAuthorizationPlanRehearsalReceipt(
        written.path,
        expected
      );
    assert.equal(consumed.receiptSha256, written.sha256);
    const canonicalConsumptionPath = path.join(
      root,
      "tile-auth-rehearsals",
      options.applicationGitSha,
      REHEARSAL_CONSUMPTION_FILENAME
    );
    assert.equal(
      fs.existsSync(canonicalConsumptionPath),
      true
    );
    assert.equal(
      JSON.parse(fs.readFileSync(canonicalConsumptionPath, "utf8"))
        .consumedAtUtc,
      expected.nowUtc
    );
    assert.equal(
      fs.existsSync(path.join(root, "run", REHEARSAL_CONSUMPTION_FILENAME)),
      false
    );
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(canonicalConsumptionPath).mode & 0o777, 0o600);
    }
    assert.throws(() =>
      consumeClasspilotTileAuthorizationPlanRehearsalReceipt(
        written.path,
        expected
      )
    );
  });

  it("rejects byte-identical copied receipts after canonical consumption", () => {
    const { root, options, expected } = fixture();
    const { admission, written } = sealPassedReceipt(
      root,
      options,
      expected
    );
    const copiedRoot = path.join(root, "copied-run");
    fs.cpSync(path.dirname(written.path), copiedRoot, { recursive: true });
    const copiedReceiptPath = path.join(
      copiedRoot,
      REHEARSAL_RECEIPT_FILENAME
    );
    assert.deepEqual(
      fs.readFileSync(copiedReceiptPath),
      fs.readFileSync(written.path)
    );

    consumeClasspilotTileAuthorizationPlanRehearsalReceipt(
      copiedReceiptPath,
      expected
    );

    const attemptRoot = path.join(
      root,
      "tile-auth-rehearsals",
      options.applicationGitSha
    );
    const canonicalConsumptionPath = path.join(
      attemptRoot,
      REHEARSAL_CONSUMPTION_FILENAME
    );
    const marker = JSON.parse(
      fs.readFileSync(canonicalConsumptionPath, "utf8")
    );
    assert.equal(
      marker.executionAuthoritySha256,
      testExecutionAuthoritySha256
    );
    assert.equal(marker.receiptSha256, written.sha256);
    assert.equal(marker.rehearsalAdmissionSha256, admission.sha256);
    assert.equal(
      marker.rehearsalTerminalSha256,
      sha(fs.readFileSync(path.join(attemptRoot, REHEARSAL_TERMINAL_FILENAME)))
    );
    assert.equal(
      fs.existsSync(path.join(copiedRoot, REHEARSAL_CONSUMPTION_FILENAME)),
      false
    );
    assert.throws(() =>
      inspectClasspilotTileAuthorizationPlanRehearsalReceipt(
        written.path,
        expected
      )
    );
    assert.throws(() =>
      consumeClasspilotTileAuthorizationPlanRehearsalReceipt(
        written.path,
        expected
      )
    );
  });

  it("rejects a copied complete receipt tree under a different authority", () => {
    const { root, options, expected } = fixture();
    const { written } = sealPassedReceipt(root, options, expected);
    const copiedRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "sp-tile-rehearsal-copied-host-")
    );
    temporaryRoots.push(copiedRoot);
    fs.cpSync(root, copiedRoot, { recursive: true });
    const relativeReceiptPath = path.relative(root, written.path);
    process.env.CLP_LOAD_GATES_TEST_ROOT = copiedRoot;
    process.env.CLP_TILE_AUTH_PLAN_REHEARSAL_TEST_EXECUTION_AUTHORITY_SHA256 =
      "5".repeat(64);

    const copiedReceiptPath = path.join(copiedRoot, relativeReceiptPath);
    assert.throws(() =>
      inspectClasspilotTileAuthorizationPlanRehearsalReceipt(
        copiedReceiptPath,
        expected
      )
    );
    assert.throws(() =>
      consumeClasspilotTileAuthorizationPlanRehearsalReceipt(
        copiedReceiptPath,
        expected
      )
    );
    assert.equal(
      fs.existsSync(
        path.join(
          copiedRoot,
          "tile-auth-rehearsals",
          options.applicationGitSha,
          REHEARSAL_CONSUMPTION_FILENAME
        )
      ),
      false
    );
  });

  it("rejects preliminary expiry before reserving the canonical marker", () => {
    const { root, options, expected } = fixture();
    const { written } = sealPassedReceipt(root, options, expected);
    const phases: string[] = [];
    const boundaryExpected: typeof expected & {
      consumedAtUtc: string;
      testConsumptionHook?: (phase: string) => void;
    } = {
      ...expected,
      nowUtc: "2026-07-24T16:59:59.999Z",
      consumedAtUtc: "2026-07-24T17:00:00.000Z",
    };
    boundaryExpected.testConsumptionHook = (phase) => {
      phases.push(phase);
    };
    assert.doesNotThrow(() =>
      inspectClasspilotTileAuthorizationPlanRehearsalReceipt(
        written.path,
        boundaryExpected
      )
    );
    assert.throws(() =>
      consumeClasspilotTileAuthorizationPlanRehearsalReceipt(
        written.path,
        boundaryExpected
      )
    );
    assert.deepEqual(phases, ["before-preliminary-timestamp"]);
    assert.equal(
      fs.existsSync(
        path.join(
          root,
          "tile-auth-rehearsals",
          options.applicationGitSha,
          REHEARSAL_CONSUMPTION_FILENAME
        )
      ),
      false
    );
  });

  it("leaves a tombstone when suspension crosses expiry after reservation", () => {
    const { root, options, expected } = fixture();
    const { written } = sealPassedReceipt(root, options, expected);
    const phases: string[] = [];
    const boundaryExpected: typeof expected & {
      consumedAtUtc: string;
      testConsumptionHook?: (phase: string) => void;
    } = {
      ...expected,
      nowUtc: "2026-07-24T16:59:59.999Z",
      consumedAtUtc: "2026-07-24T16:59:59.999Z",
    };
    boundaryExpected.testConsumptionHook = (phase) => {
      phases.push(phase);
      if (phase === "before-final-post-reservation-timestamp") {
        boundaryExpected.consumedAtUtc = "2026-07-24T17:00:00.000Z";
      }
    };

    assert.throws(() =>
      consumeClasspilotTileAuthorizationPlanRehearsalReceipt(
        written.path,
        boundaryExpected
      )
    );
    assert.deepEqual(phases, [
      "before-preliminary-timestamp",
      "before-final-post-reservation-timestamp",
    ]);
    const canonicalConsumptionPath = path.join(
      root,
      "tile-auth-rehearsals",
      options.applicationGitSha,
      REHEARSAL_CONSUMPTION_FILENAME
    );
    assert.equal(fs.existsSync(canonicalConsumptionPath), true);
    assert.equal(fs.statSync(canonicalConsumptionPath).size, 0);
    assert.throws(() =>
      inspectClasspilotTileAuthorizationPlanRehearsalReceipt(
        written.path,
        expected
      )
    );
    assert.throws(() =>
      consumeClasspilotTileAuthorizationPlanRehearsalReceipt(
        written.path,
        expected
      )
    );
  });

  it("keeps a failed post-reservation marker permanently consumed", () => {
    const { root, options, expected } = fixture();
    const { written } = sealPassedReceipt(root, options, expected);
    const phases: string[] = [];
    const faultExpected: typeof expected & {
      testConsumptionHook?: (phase: string) => void;
    } = {
      ...expected,
      testConsumptionHook: (phase) => {
        phases.push(phase);
        if (phase === "before-marker-write") {
          throw new Error("must-not-escape");
        }
      },
    };

    assert.throws(
      () =>
        consumeClasspilotTileAuthorizationPlanRehearsalReceipt(
          written.path,
          faultExpected
        ),
      /classpilot_tile_auth_plan_rehearsal_consumption_commit_failed/
    );
    assert.deepEqual(phases, [
      "before-preliminary-timestamp",
      "before-final-post-reservation-timestamp",
      "before-marker-write",
    ]);
    const canonicalConsumptionPath = path.join(
      root,
      "tile-auth-rehearsals",
      options.applicationGitSha,
      REHEARSAL_CONSUMPTION_FILENAME
    );
    assert.equal(fs.existsSync(canonicalConsumptionPath), true);
    assert.equal(fs.statSync(canonicalConsumptionPath).size, 0);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(canonicalConsumptionPath).mode & 0o777, 0o600);
    }
    assert.throws(() =>
      inspectClasspilotTileAuthorizationPlanRehearsalReceipt(
        written.path,
        expected
      )
    );
    assert.throws(() =>
      consumeClasspilotTileAuthorizationPlanRehearsalReceipt(
        written.path,
        expected
      )
    );
  });

  it("atomically permits only one concurrent consumer across receipt copies", async () => {
    const { root, options, expected } = fixture();
    const { written } = sealPassedReceipt(root, options, expected);
    const copiedRoot = path.join(root, "concurrent-copy");
    fs.cpSync(path.dirname(written.path), copiedRoot, { recursive: true });
    const copiedReceiptPath = path.join(
      copiedRoot,
      REHEARSAL_RECEIPT_FILENAME
    );

    const exitCodes = await Promise.all([
      consumeInChildProcess(written.path, expected),
      consumeInChildProcess(copiedReceiptPath, expected),
    ]);
    assert.deepEqual(exitCodes.sort(), [0, 1]);
    assert.equal(
      fs.existsSync(
        path.join(
          root,
          "tile-auth-rehearsals",
          options.applicationGitSha,
          REHEARSAL_CONSUMPTION_FILENAME
        )
      ),
      true
    );
    for (const receiptPath of [written.path, copiedReceiptPath]) {
      assert.throws(() =>
        inspectClasspilotTileAuthorizationPlanRehearsalReceipt(
          receiptPath,
          expected
        )
      );
    }
  });

  it("requires the immutable passed terminal before inspect or consume", () => {
    const { root, options, expected } = fixture();
    const admission =
      admitClasspilotTileAuthorizationPlanRehearsalAttempt({
        applicationGitSha: options.applicationGitSha,
        admittedAtUtc: "2026-07-24T15:59:00.000Z",
      });
    const receipt =
      buildClasspilotTileAuthorizationPlanRehearsalReceipt(options);
    const written = writeClasspilotTileAuthorizationPlanRehearsalReceipt(
      path.join(root, "run"),
      receipt,
      {
        preflight: validPreflight(),
        report: validateClasspilotTileAuthorizationPlanEvidence(
          options.planEventsDocument
        ),
        lifecycle: validLifecycle(),
      }
    );
    expected.expectedReceiptSha256 = written.sha256;
    assert.throws(() =>
      inspectClasspilotTileAuthorizationPlanRehearsalReceipt(
        written.path,
        expected
      )
    );
    assert.throws(() =>
      consumeClasspilotTileAuthorizationPlanRehearsalReceipt(
        written.path,
        expected
      )
    );

    terminalClasspilotTileAuthorizationPlanRehearsalAttempt({
      applicationGitSha: options.applicationGitSha,
      expectedAdmissionSha256: admission.sha256,
      outcome: "failed",
      terminalAtUtc: "2026-07-24T16:01:00.000Z",
    });
    assert.throws(() =>
      inspectClasspilotTileAuthorizationPlanRehearsalReceipt(
        written.path,
        expected
      )
    );
    assert.throws(() =>
      consumeClasspilotTileAuthorizationPlanRehearsalReceipt(
        written.path,
        expected
      )
    );
    assert.throws(() =>
      terminalClasspilotTileAuthorizationPlanRehearsalAttempt({
        applicationGitSha: options.applicationGitSha,
        expectedAdmissionSha256: admission.sha256,
        outcome: "passed",
        receiptPath: written.path,
        receiptSha256: written.sha256,
        terminalAtUtc: "2026-07-24T16:02:00.000Z",
      })
    );
  });

  it("rejects valid or malformed companion substitution before writing", () => {
    for (const mutation of [
      "preflight",
      "report",
      "lifecycle",
      "report-schema",
    ]) {
      const { root, options } = fixture();
      const receipt =
        buildClasspilotTileAuthorizationPlanRehearsalReceipt(options);
      const report = validateClasspilotTileAuthorizationPlanEvidence(
        options.planEventsDocument
      );
      const evidence = {
        preflight: validPreflight(),
        report,
        lifecycle: validLifecycle(),
      };
      if (mutation === "preflight") {
        evidence.preflight = validPreflight(1);
      } else if (mutation === "report") {
        evidence.report = {
          ...report,
          scenarios: report.scenarios.map((scenario, index) =>
            index === 0
              ? { ...scenario, p95Ms: scenario.p95Ms + 0.5 }
              : scenario
          ),
        };
      } else if (mutation === "lifecycle") {
        evidence.lifecycle = validLifecycle(79);
      } else {
        evidence.report = { ...report, unexpected: "not-reviewed" };
      }
      const runRoot = path.join(root, `substitution-${mutation}`);
      assert.throws(() =>
        writeClasspilotTileAuthorizationPlanRehearsalReceipt(
          runRoot,
          receipt,
          evidence
        )
      );
      assert.equal(
        fs.existsSync(
          path.join(
            runRoot,
            "classpilot-tile-auth-plan-rehearsal.private.json"
          )
        ),
        false
      );
    }
  });

  it("rejects rehashed report schema, identity, and lifecycle tampering", () => {
    const { root, options, expected } = fixture();
    const receipt =
      buildClasspilotTileAuthorizationPlanRehearsalReceipt(options);
    const baselineRoot = path.join(root, "tamper-baseline");
    writeClasspilotTileAuthorizationPlanRehearsalReceipt(
      baselineRoot,
      receipt,
      {
        preflight: validPreflight(),
        report: validateClasspilotTileAuthorizationPlanEvidence(
          options.planEventsDocument
        ),
        lifecycle: validLifecycle(),
      }
    );

    for (const mutation of ["report-schema", "identity", "lifecycle"]) {
      const runRoot = path.join(root, `tamper-${mutation}`);
      fs.cpSync(baselineRoot, runRoot, { recursive: true });
      let rewritten;
      if (mutation === "lifecycle") {
        const lifecycle = validLifecycle(79);
        lifecycle.seededRows.studentSessions = 80;
        lifecycle.seededRows.total = 123;
        rewritten = rehashReceiptCompanion(
          runRoot,
          REHEARSAL_LIFECYCLE_EVIDENCE_FILENAME,
          "lifecycleEvidenceSha256",
          lifecycle
        );
      } else {
        const reportPath = path.join(
          runRoot,
          REHEARSAL_PLAN_REPORT_FILENAME
        );
        const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
        if (mutation === "report-schema") {
          report.unexpected = "not-reviewed";
        } else {
          report.historyFallbackSqlIdentity.compiledSqlSha256 =
            "f".repeat(64);
        }
        rewritten = rehashReceiptCompanion(
          runRoot,
          REHEARSAL_PLAN_REPORT_FILENAME,
          "sanitizedPlanReportSha256",
          report
        );
      }
      const tamperedExpected = {
        ...expected,
        expectedReceiptSha256: rewritten.receiptSha256,
      };
      assert.throws(() =>
        inspectClasspilotTileAuthorizationPlanRehearsalReceipt(
          rewritten.receiptPath,
          tamperedExpected
        )
      );
      assert.throws(() =>
        consumeClasspilotTileAuthorizationPlanRehearsalReceipt(
          rewritten.receiptPath,
          tamperedExpected
        )
      );
    }
  });

  it("rejects tampering, drift, expiry, and companion evidence changes", () => {
    for (const mutation of ["hash", "baseline", "expiry", "companion"]) {
      const { root, options, expected } = fixture();
      const admission =
        admitClasspilotTileAuthorizationPlanRehearsalAttempt({
          applicationGitSha: options.applicationGitSha,
          admittedAtUtc: "2026-07-24T15:59:00.000Z",
        });
      const receipt = buildClasspilotTileAuthorizationPlanRehearsalReceipt(options);
      const written = writeClasspilotTileAuthorizationPlanRehearsalReceipt(
        path.join(root, "run"),
        receipt,
        {
          preflight: validPreflight(),
          report: validateClasspilotTileAuthorizationPlanEvidence(
            options.planEventsDocument
          ),
          lifecycle: validLifecycle(),
        }
      );
      terminalClasspilotTileAuthorizationPlanRehearsalAttempt({
        applicationGitSha: options.applicationGitSha,
        expectedAdmissionSha256: admission.sha256,
        outcome: "passed",
        receiptPath: written.path,
        receiptSha256: written.sha256,
        terminalAtUtc: "2026-07-24T16:01:00.000Z",
      });
      expected.expectedReceiptSha256 =
        mutation === "hash" ? "f".repeat(64) : written.sha256;
      if (mutation === "baseline") {
        expected.expectedActiveApiTaskDefinitionArn =
          "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:99";
      } else if (mutation === "expiry") {
        expected.nowUtc = "2026-07-24T17:00:00.000Z";
      } else if (mutation === "companion") {
        fs.appendFileSync(
          path.join(root, "run", REHEARSAL_PLAN_REPORT_FILENAME),
          " "
        );
      }
      assert.throws(() =>
        inspectClasspilotTileAuthorizationPlanRehearsalReceipt(
          written.path,
          expected
        )
      );
    }
  });
});
