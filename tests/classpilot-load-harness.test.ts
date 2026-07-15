import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import WebSocket, { WebSocketServer } from "ws";
import {
  classifyCommandSnapshotOwnership,
  observeCommandTargetStatuses,
  teacherSessionOwnerKey,
} from "../scripts/load/command-status-observer.mjs";

const script = fileURLToPath(new URL("../scripts/load/classpilot-load-test.mjs", import.meta.url));
let tempDir = "";
let manifestPath = "";
let commandBodiesPath = "";
let teacherAuthPath = "";

function cleanEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("LOAD_")) delete env[key];
  }
  return {
    ...env,
    NODE_ENV: "test",
    LOAD_TEST_ARTIFACT_ROOT: tempDir,
    ...overrides,
  };
}

function run(args: string[], env: NodeJS.ProcessEnv = cleanEnv()) {
  return spawnSync(process.execPath, [script, ...args], {
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
}

function runAsync(args: string[], env: NodeJS.ProcessEnv = cleanEnv(), timeoutMs = 10_000) {
  return new Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`load harness did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

function parseSummary(stdout: string) {
  const jsonStart = stdout.indexOf("{");
  assert.notEqual(jsonStart, -1, stdout);
  return JSON.parse(stdout.slice(jsonStart));
}

function readJsonLines(filePath: string) {
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function unsignedJwt(expSeconds: number) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url");
  return `${header}.${payload}.test-signature`;
}

function createLaunchArtifacts(options: {
  label: string;
  baseUrl: string;
  primaryDevices: 500 | 800 | 1000;
  targetsPerClass: 25 | 40;
}) {
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  const futureJwt = unsignedJwt(Math.floor(Date.now() / 1000) + 48 * 60 * 60);
  const manifest = Array.from({ length: 10 }, (_unused, index) => ({
    deviceId: `${options.label}-canary-device-${index + 1}`,
    studentId: `${options.label}-canary-student-${index + 1}`,
    schoolId: "school-2",
    classId: null as string | null,
    studentToken: futureJwt,
  }));
  const teacherAuth: Array<Record<string, unknown>> = [];
  const commands: Array<Record<string, unknown>> = [];
  const sessionTargets = new Map<string, string[]>();

  const classStudents = Array.from({ length: 20 }, (_unused, classIndex) =>
    Array.from({ length: 40 }, (__unused, index) => `${options.label}-student-${classIndex + 1}-${index + 1}`)
  );
  for (let classIndex = 0; classIndex < 20; classIndex += 1) {
    for (const studentId of classStudents[classIndex].slice(0, 25)) {
      manifest.push({
        deviceId: `${options.label}-device-${studentId}`,
        studentId,
        schoolId: "school-1",
        classId: `${options.label}-class-${classIndex + 1}`,
        studentToken: futureJwt,
      });
    }
  }
  if (options.primaryDevices >= 800) {
    for (let classIndex = 0; classIndex < 20; classIndex += 1) {
      for (const studentId of classStudents[classIndex].slice(25)) {
        manifest.push({
          deviceId: `${options.label}-device-${studentId}`,
          studentId,
          schoolId: "school-1",
          classId: `${options.label}-class-${classIndex + 1}`,
          studentToken: futureJwt,
        });
      }
    }
  }
  if (options.primaryDevices === 1000) {
    for (let index = 0; index < 200; index += 1) {
      manifest.push({
        deviceId: `${options.label}-burst-device-${index + 1}`,
        studentId: `${options.label}-burst-student-${index + 1}`,
        schoolId: "school-1",
        classId: null,
        studentToken: futureJwt,
      });
    }
  }

  for (let classIndex = 0; classIndex < 20; classIndex += 1) {
    const teachingSessionId = `${options.label}-session-${classIndex + 1}`;
    const allStudentIds = classStudents[classIndex];
    teacherAuth.push({
      teacherId: `${options.label}-teacher-${classIndex + 1}`,
      schoolId: "school-1",
      role: "teacher",
      teachingSessionId,
      teacherCookie: `schoolpilot.sid=${options.label}-cookie-secret-${classIndex + 1}`,
      csrfToken: `${options.label}-csrf-secret-${classIndex + 1}`,
      teacherToken: futureJwt,
      expiresAt,
      studentIds: allStudentIds,
    });
    commands.push({
      teachingSessionId,
      targetScope: "class",
      commandType: "open-tab",
      commandPayload: { url: "https://example.edu" },
    });
    sessionTargets.set(
      teachingSessionId,
      allStudentIds.slice(0, options.targetsPerClass).map((studentId) => `${options.label}-device-${studentId}`)
    );
  }

  assert.equal(manifest.length, options.primaryDevices + 10);
  const manifestPath = join(tempDir, `${options.label}-devices.private.json`);
  const commandsPath = join(tempDir, `${options.label}-commands.private.json`);
  const authPath = join(tempDir, `${options.label}-auth.private.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(commandsPath, JSON.stringify(commands));
  writeFileSync(authPath, JSON.stringify({
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    baseUrl: options.baseUrl,
    schoolId: "school-1",
    role: "school_admin",
    teacherCookie: `schoolpilot.sid=${options.label}-admin-cookie-secret`,
    csrfToken: `${options.label}-admin-csrf-secret`,
    teacherToken: futureJwt,
    expiresAt,
    deviceManifestExpiresAt: expiresAt,
    teacherAuth,
  }));
  return { manifest, teacherAuth, commands, sessionTargets, manifestPath, commandsPath, authPath };
}

describe("ClassPilot load harness safety", () => {
  it("records first command acknowledgement timing and rejects later status regression", () => {
    const entry = {
      requestStartedAt: 1_000,
      serverReceived: 0,
      serverCompleted: 0,
      serverReceivedWithin2s: 0,
      serverCompletedWithin5s: 0,
      serverReceivedAtByTarget: new Map(),
      serverCompletedAtByTarget: new Map(),
      serverTargetStatuses: new Map(),
      serverRegressedTargetIds: new Set(),
    };

    assert.equal(observeCommandTargetStatuses(entry, [{ id: "target-1", status: "completed" }], 1_400), 0);
    assert.equal(entry.serverReceived, 1);
    assert.equal(entry.serverCompleted, 1);
    assert.equal(entry.serverReceivedWithin2s, 1);
    assert.equal(entry.serverCompletedWithin5s, 1);

    assert.equal(observeCommandTargetStatuses(entry, [{ id: "target-1", status: "sent" }], 8_000), 1);
    assert.equal(entry.serverTargetStatuses.get("target-1"), "completed");
    assert.equal(entry.serverReceivedAtByTarget.get("target-1"), 400);
    assert.equal(entry.serverCompletedAtByTarget.get("target-1"), 400);
    assert.equal(observeCommandTargetStatuses(entry, [{ id: "target-1", status: "received" }], 9_000), 0);
  });

  it("keeps command status ordering scoped to the issuing teacher stream", () => {
    const owner = { actorId: "teacher-1", teachingSessionId: "session-1" };
    const other = { actorId: "teacher-2", teachingSessionId: "session-2" };
    const command = { teacherId: "teacher-1", teachingSessionId: "session-1" };
    const knownOwnerKeys = new Set([
      teacherSessionOwnerKey(owner.actorId, owner.teachingSessionId),
      teacherSessionOwnerKey(other.actorId, other.teachingSessionId),
    ]);
    const entry = {
      requestStartedAt: 1_000,
      serverReceived: 0,
      serverCompleted: 0,
      serverReceivedWithin2s: 0,
      serverCompletedWithin5s: 0,
      serverReceivedAtByTarget: new Map(),
      serverCompletedAtByTarget: new Map(),
      serverTargetStatuses: new Map(),
      serverRegressedTargetIds: new Set(),
    };

    assert.equal(classifyCommandSnapshotOwnership(command, owner, knownOwnerKeys), "owned");
    assert.equal(observeCommandTargetStatuses(entry, [{ id: "target-1", status: "completed" }], 1_400), 0);
    assert.equal(classifyCommandSnapshotOwnership(command, other, knownOwnerKeys), "other");
    // A valid but older snapshot on another teacher connection is not part of
    // the issuing teacher's ordered stream and must not be merged into it.
    assert.equal(entry.serverTargetStatuses.get("target-1"), "completed");
    assert.equal(observeCommandTargetStatuses(entry, [{ id: "target-1", status: "received" }], 1_500), 1);
    assert.equal(classifyCommandSnapshotOwnership({ teacherId: "teacher-1" }, owner, knownOwnerKeys), "invalid");
    assert.equal(classifyCommandSnapshotOwnership(
      { teacherId: "teacher-1", teachingSessionId: "session-2" },
      owner,
      knownOwnerKeys
    ), "invalid");
    assert.equal(
      classifyCommandSnapshotOwnership(command, { actorId: "admin-1" }, knownOwnerKeys),
      "other"
    );
  });
  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), "schoolpilot-load-test-"));
    manifestPath = join(tempDir, "devices.json");
    writeFileSync(manifestPath, JSON.stringify([{
      deviceId: "device-1",
      studentToken: "student-secret-sentinel",
      schoolId: "school-1",
    }]));
    commandBodiesPath = join(tempDir, "load-command-bodies.private.json");
    writeFileSync(commandBodiesPath, JSON.stringify([
      {
        teachingSessionId: "session-1",
        targetScope: "class",
        commandType: "open-tab",
        commandPayload: { url: "https://example.edu/one" },
      },
      {
        teachingSessionId: "session-2",
        targetScope: "class",
        commandType: "open-tab",
        commandPayload: { url: "https://example.edu/two" },
      },
    ]));
    teacherAuthPath = join(tempDir, "load-auth.private.json");
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    writeFileSync(teacherAuthPath, JSON.stringify({
      schemaVersion: 1,
      expiresAt,
      teacherAuth: Array.from({ length: 20 }, (_unused, index) => ({
        teacherId: `teacher-${index + 1}`,
        teachingSessionId: `session-${index + 1}`,
        schoolId: "school-1",
        role: "teacher",
        teacherCookie: `schoolpilot.sid=cookie-secret-sentinel-${index + 1}`,
        csrfToken: `csrf-secret-sentinel-${index + 1}`,
        teacherToken: `teacher-secret-sentinel-${index + 1}`,
        expiresAt,
      })),
    }));
  });

  after(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("validates bounded fixtures without credentials or network traffic", () => {
    const result = run(["--validate-fixtures"]);
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.deepEqual(summary.fixtureBytes, { standard: 40 * 1024, burst: 50 * 1024 });
    assert.equal(summary.boundedLatencyBuckets, 12);
    assert.deepEqual(summary.boundedExactCommandLatency, {
      exact: true,
      method: "nearest-rank",
      capacity: 5,
      observedCount: 5,
      retainedCount: 5,
      droppedCount: 0,
      thresholdMs: 1000,
      errors: 0,
      p95Ms: 1506,
      maxMs: 1506,
      aboveThresholdCount: 2,
      aboveThresholdPercent: 40,
    });
    assert.equal(summary.rollingWindowSlots, 300);
  });

  it("advertises the production cookie and implemented dashboard/history paths", () => {
    const result = run(["--help"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /schoolpilot\.sid=<session-cookie>/);
    assert.match(result.stdout, /\/api\/students-aggregated,\/api\/classpilot\/heartbeats\/\{deviceId\}/);
    assert.match(result.stdout, /%LOCALAPPDATA%\\SchoolPilot\\load-gates\\load-devices\.private\.json/);
    assert.match(result.stdout, /LOAD_TEACHER_AUTH_FILE=%LOCALAPPDATA%\\SchoolPilot\\load-gates\\load-auth\.private\.json/);
    assert.doesNotMatch(result.stdout, /connect\.sid|coverage\/overview|classpilot\/students-aggregated/);
  });

  it("fails closed when the target or manifest is missing", () => {
    const result = run([]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /LOAD_BASE_URL and LOAD_DEVICE_MANIFEST are required/);

    const insecureRemote = run([], cleanEnv({
      LOAD_BASE_URL: "http://example.com",
      LOAD_DEVICE_MANIFEST: manifestPath,
      LOAD_ALLOW_INSECURE_HTTP: "true",
    }));
    assert.notEqual(insecureRemote.status, 0);
    assert.match(insecureRemote.stderr, /Non-local LOAD_BASE_URL must use HTTPS/);
  });

  it("reports malformed manifests without echoing credential fragments", () => {
    const malformedManifestPath = join(tempDir, "malformed-devices.json");
    writeFileSync(
      malformedManifestPath,
      '[{"deviceId":"device-1","studentToken":"student-secret-fragment"'
    );
    const result = run([], cleanEnv({
      LOAD_BASE_URL: "http://localhost:4000",
      LOAD_DEVICE_MANIFEST: malformedManifestPath,
    }));
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /LOAD_DEVICE_MANIFEST must contain valid JSON/);
    assert.doesNotMatch(output, /student-secret-fragment/);
  });

  it("reports malformed command files without echoing session fragments", () => {
    const malformedCommandPath = join(tempDir, "malformed-command-bodies.private.json");
    writeFileSync(
      malformedCommandPath,
      '[{"teachingSessionId":"session-secret-fragment","targetScope":"class"'
    );
    const result = run([], cleanEnv({
      LOAD_BASE_URL: "http://localhost:4000",
      LOAD_DEVICE_MANIFEST: manifestPath,
      LOAD_COMMAND_ENDPOINT: "/api/classpilot/commands",
      LOAD_COMMAND_BODIES_FILE: malformedCommandPath,
    }));
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /LOAD_COMMAND_BODIES_FILE must contain a valid JSON array/);
    assert.doesNotMatch(output, /session-secret-fragment|student-secret-sentinel/);
  });

  it("requires teacher authentication for configured dashboard traffic without printing device tokens", () => {
    const result = run([], cleanEnv({
      LOAD_BASE_URL: "http://localhost:4000",
      LOAD_DEVICE_MANIFEST: manifestPath,
      LOAD_TEACHER_PATHS: "/api/students-aggregated",
    }));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /LOAD_TEACHER_COOKIE or LOAD_TEACHER_TOKEN is required/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /student-secret-sentinel/);
  });

  it("rejects the stale connect.sid cookie name without printing the cookie", () => {
    const result = run([], cleanEnv({
      LOAD_BASE_URL: "http://localhost:4000",
      LOAD_DEVICE_MANIFEST: manifestPath,
      LOAD_TEACHER_COOKIE: "connect.sid=cookie-secret-sentinel",
      LOAD_TEACHER_PATHS: "/api/students-aggregated",
    }));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must include the schoolpilot\.sid session cookie/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /cookie-secret-sentinel|student-secret-sentinel/);
  });

  it("rejects absolute dashboard URLs and repository artifact paths", () => {
    const invalidDashboard = run([], cleanEnv({
      LOAD_BASE_URL: "http://localhost:4000",
      LOAD_DEVICE_MANIFEST: manifestPath,
      LOAD_TEACHER_COOKIE: "schoolpilot.sid=cookie-secret-sentinel",
      LOAD_TEACHER_PATHS: "https://example.edu/api/students-aggregated",
    }));
    assert.notEqual(invalidDashboard.status, 0);
    assert.match(invalidDashboard.stderr, /origin-relative paths beginning with one slash/);

    const repositoryArtifact = run([], cleanEnv({
      LOAD_BASE_URL: "http://localhost:4000",
      LOAD_DEVICE_MANIFEST: manifestPath,
      LOAD_EXTERNAL_SUMMARY_PATH: join(dirname(script), "forbidden-summary.json"),
    }));
    assert.notEqual(repositoryArtifact.status, 0);
    assert.match(repositoryArtifact.stderr, /LOAD_EXTERNAL_SUMMARY_PATH must be outside this repository/);

    const repositoryManifest = run([], cleanEnv({
      LOAD_BASE_URL: "http://localhost:4000",
      LOAD_DEVICE_MANIFEST: script,
    }));
    assert.notEqual(repositoryManifest.status, 0);
    assert.match(repositoryManifest.stderr, /LOAD_DEVICE_MANIFEST must be a file under/);
    assert.doesNotMatch(
      `${invalidDashboard.stdout}\n${invalidDashboard.stderr}\n${repositoryArtifact.stdout}\n${repositoryArtifact.stderr}\n${repositoryManifest.stderr}`,
      /cookie-secret-sentinel|student-secret-sentinel/
    );
  });

  it("rejects screenshot paths that would bypass the dedicated cold-cache warmup", () => {
    const result = run([], cleanEnv({
      LOAD_BASE_URL: "http://localhost:4000",
      LOAD_DEVICE_MANIFEST: manifestPath,
      LOAD_TEACHER_PATHS: "/api/classpilot/device/screenshot/{deviceId}",
    }));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must use LOAD_SCREENSHOT_GET_PATH_TEMPLATE/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /student-secret-sentinel/);
  });

  it("reports unenforced diagnostic thresholds as not evaluated", () => {
    const result = run([], cleanEnv({
      LOAD_BASE_URL: "http://localhost:4000",
      LOAD_DEVICE_MANIFEST: manifestPath,
      LOAD_DURATION_SECONDS: "1",
      LOAD_COMMAND_SETTLE_MS: "0",
      LOAD_REQUEST_TIMEOUT_MS: "100",
    }));
    assert.equal(result.status, 0, result.stderr);
    const jsonStart = result.stdout.indexOf("{");
    assert.notEqual(jsonStart, -1, result.stdout);
    const summary = JSON.parse(result.stdout.slice(jsonStart));
    assert.equal(summary.thresholds.enforced, false);
    assert.equal(summary.thresholds.passed, null);
    assert.equal(summary.externalAcceptance.passed, null);
  });

  it("atomically replaces an external summary and writes redacted JSONL progress", () => {
    const summaryPath = join(tempDir, "atomic-summary.json");
    const progressPath = join(tempDir, "atomic-progress.jsonl");
    writeFileSync(summaryPath, "stale-partial-content");
    const result = run([], cleanEnv({
      LOAD_BASE_URL: "http://127.0.0.1:1",
      LOAD_DEVICE_MANIFEST: manifestPath,
      LOAD_DURATION_SECONDS: "1",
      LOAD_COMMAND_SETTLE_MS: "0",
      LOAD_REQUEST_TIMEOUT_MS: "100",
      LOAD_TEACHER_COOKIE: "schoolpilot.sid=cookie-secret-sentinel",
      LOAD_CSRF_TOKEN: "csrf-secret-sentinel",
      LOAD_TEACHER_PATHS: "/api/students-aggregated,/api/classpilot/heartbeats/{deviceId}",
      LOAD_STAGE: "focused-artifact-test",
      LOAD_RUN_ID: "supervised-focused-artifact-test",
      LOAD_EXTERNAL_SUMMARY_PATH: summaryPath,
      LOAD_EXTERNAL_PROGRESS_PATH: progressPath,
    }));
    assert.equal(result.status, 0, result.stderr);

    const stdoutSummary = parseSummary(result.stdout);
    const externalSummary = JSON.parse(readFileSync(summaryPath, "utf8"));
    assert.deepEqual(externalSummary, stdoutSummary);
    assert.equal(externalSummary.runId, "supervised-focused-artifact-test");
    assert.equal(externalSummary.stage, "focused-artifact-test");
    assert.equal(externalSummary.artifacts.externalSummaryWritten, true);
    assert.equal(externalSummary.fatalGate, null);

    const progress = readJsonLines(progressPath);
    assert.equal(progress[0].type, "progress");
    assert.equal(progress[0].event, "start");
    assert.equal(progress.at(-1).event, "final");
    assert.equal(progress.at(-1).runId, externalSummary.runId);
    assert.equal(progress.at(-1).stage, "focused-artifact-test");
    assert.ok(progress.at(-1).cumulativeCounters);
    assert.ok(progress.at(-1).counterDeltas);
    assert.ok(progress.at(-1).latency);
    assert.deepEqual(
      readdirSync(tempDir).filter((name) => name.startsWith(".atomic-summary.json.") && name.endsWith(".tmp")),
      []
    );

    const evidence = `${result.stdout}\n${result.stderr}\n${readFileSync(summaryPath, "utf8")}\n${readFileSync(progressPath, "utf8")}`;
    assert.doesNotMatch(evidence, /student-secret-sentinel|cookie-secret-sentinel|csrf-secret-sentinel/);

    const invalidRunId = run([], cleanEnv({
      LOAD_BASE_URL: "http://127.0.0.1:1",
      LOAD_DEVICE_MANIFEST: manifestPath,
      LOAD_RUN_ID: "../not-contained",
    }));
    assert.notEqual(invalidRunId.status, 0);
    assert.match(invalidRunId.stderr, /LOAD_RUN_ID must be a filename-safe/);
  });

  it("requires CSRF for session-authenticated command POSTs without printing the cookie", () => {
    const result = run([], cleanEnv({
      LOAD_BASE_URL: "http://localhost:4000",
      LOAD_DEVICE_MANIFEST: manifestPath,
      LOAD_TEACHER_COOKIE: "schoolpilot.sid=cookie-secret-sentinel",
      LOAD_COMMAND_ENDPOINT: "/api/classpilot/commands",
      LOAD_COMMAND_BODY: JSON.stringify({
        teachingSessionId: "session-1",
        targetScope: "class",
        commandType: "open-tab",
        commandPayload: { url: "https://example.edu" },
      }),
    }));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cookie-authenticated command actor requires a CSRF token/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /cookie-secret-sentinel|student-secret-sentinel/);
  });

  it("defaults enforced runs to the fail-closed launch profile", () => {
    const result = run([], cleanEnv({
      LOAD_BASE_URL: "http://localhost:4000",
      LOAD_DEVICE_MANIFEST: manifestPath,
      LOAD_ENFORCE_THRESHOLDS: "true",
    }));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Launch gate requires LOAD_TEACHER_AUTH_FILE/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /student-secret-sentinel/);
  });

  it("requires both external artifacts for an enforced launch profile", () => {
    const launchAuthPath = join(tempDir, "launch-auth.private.json");
    const launchAuth = JSON.parse(readFileSync(teacherAuthPath, "utf8"));
    writeFileSync(launchAuthPath, JSON.stringify({
      ...launchAuth,
      schemaVersion: 2,
      baseUrl: "http://localhost:4000",
      schoolId: "school-1",
      deviceManifestExpiresAt: launchAuth.expiresAt,
    }));
    const result = run([], cleanEnv({
      LOAD_BASE_URL: "http://localhost:4000",
      LOAD_DEVICE_MANIFEST: manifestPath,
      LOAD_ENFORCE_THRESHOLDS: "true",
      LOAD_TEACHER_AUTH_FILE: launchAuthPath,
    }));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires LOAD_EXTERNAL_SUMMARY_PATH and LOAD_EXTERNAL_PROGRESS_PATH/);
    assert.doesNotMatch(
      `${result.stdout}\n${result.stderr}`,
      /student-secret-sentinel|cookie-secret-sentinel|csrf-secret-sentinel|teacher-secret-sentinel/
    );
  });

  it("rejects a command file with fewer unique classes than the enforced contract", () => {
    const result = run([], cleanEnv({
      LOAD_BASE_URL: "http://localhost:4000",
      LOAD_DEVICE_MANIFEST: manifestPath,
      LOAD_ENFORCE_THRESHOLDS: "true",
      LOAD_EXPECTED_CLASS_BODIES: "3",
      LOAD_COMMAND_ENDPOINT: "/api/classpilot/commands",
      LOAD_COMMAND_BODIES_FILE: commandBodiesPath,
    }));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires at least 3 unique teachingSessionId command bodies/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /student-secret-sentinel|session-1|session-2/);
  });

  it("preflights every exact launch stage and exposes its final acceptance contract without traffic", () => {
    const stages = [
      { label: "preflight-500", primary: 500 as const, duration: 1_800, bytes: 40 * 1024, targets: 25 as const },
      { label: "preflight-800", primary: 800 as const, duration: 5_400, bytes: 40 * 1024, targets: 40 as const },
      { label: "preflight-burst", primary: 1000 as const, duration: 600, bytes: 50 * 1024, targets: 40 as const },
      { label: "preflight-endurance", primary: 800 as const, duration: 28_800, bytes: 40 * 1024, targets: 40 as const },
    ];
    for (const stage of stages) {
      const artifacts = createLaunchArtifacts({
        label: stage.label,
        baseUrl: "http://localhost:4000",
        primaryDevices: stage.primary,
        targetsPerClass: stage.targets,
      });
      const result = run(["--validate-config"], cleanEnv({
        LOAD_BASE_URL: "http://localhost:4000",
        LOAD_DEVICE_MANIFEST: artifacts.manifestPath,
        LOAD_DEVICE_COUNT: String(stage.primary + 10),
        LOAD_DURATION_SECONDS: String(stage.duration),
        LOAD_SCREENSHOT_PROFILE: stage.bytes === 50 * 1024 ? "burst" : "standard",
        LOAD_ENFORCE_THRESHOLDS: "true",
        LOAD_GATE_PROFILE: "launch",
        LOAD_TEACHER_AUTH_FILE: artifacts.authPath,
        LOAD_TEACHER_PATHS: "/api/students-aggregated,/api/classpilot/heartbeats/{deviceId}",
        LOAD_SCREENSHOT_GET_PATH_TEMPLATE: "/api/classpilot/device/screenshot/{deviceId}",
        LOAD_COMMAND_ENDPOINT: "/api/classpilot/commands",
        LOAD_COMMAND_BODIES_FILE: artifacts.commandsPath,
        LOAD_EXPECTED_TARGETS_PER_CLASS: String(stage.targets),
        LOAD_FORCE_RECONNECT_AT_SECONDS: "120",
        LOAD_RUN_ID: `${stage.label}-supervised-run`,
        LOAD_EXTERNAL_SUMMARY_PATH: join(tempDir, `${stage.label}-summary.json`),
        LOAD_EXTERNAL_PROGRESS_PATH: join(tempDir, `${stage.label}-progress.jsonl`),
      }));
      assert.equal(result.status, 0, result.stderr);
      const preflight = JSON.parse(result.stdout);
      assert.equal(preflight.ok, true);
      assert.equal(preflight.mode, "preflight-only");
      assert.equal(preflight.trafficStarted, false);
      assert.equal(preflight.runId, `${stage.label}-supervised-run`);
      assert.equal(preflight.gateProfile, "launch");
      assert.equal(preflight.thresholdsEnforced, true);
      assert.equal(preflight.networkFamily, "IPv4");
      assert.deepEqual(preflight.launchContract, {
        totalSockets: stage.primary + 10,
        primaryDevices: stage.primary,
        canaryDevices: 10,
        durationSeconds: stage.duration,
        screenshotBytes: stage.bytes,
        expectedClassBodies: 20,
        expectedTargetsPerClass: stage.targets,
        teacherActors: 20,
        teacherTileCohorts: 20,
        teacherTileAssignments: Math.min(stage.primary, 800),
      });
      assert.equal(preflight.finalAcceptanceContract.authenticatedDeviceSockets, stage.primary + 10);
      assert.equal(preflight.finalAcceptanceContract.authenticatedTeacherSockets, 20);
      assert.equal(preflight.finalAcceptanceContract.outstandingReconnects, 0);
      assert.equal(preflight.finalAcceptanceContract.commandTargets, stage.targets * 20);
      assert.equal(preflight.finalAcceptanceContract.tenantIsolationProbes, 20);
      assert.deepEqual(preflight.trafficShaping, {
        teacherStaticPollSpreadMs: 5_000,
        teacherTemplatePollSpreadMs: 30_000,
        screenshotGetSpreadMs: 30_000,
        teacherTileCohortWarmupMs: 45_000,
        screenshotCohortWarmupMs: 45_000,
        teacherWebSocketStartupSpreadMs: 5_000,
        isolationProbeSpreadMs: 5_000,
      });
      assert.doesNotMatch(result.stdout, new RegExp(`${stage.label}-(?:cookie|csrf|student|device)`));
    }
  });

  it("rejects mixed teacher schools and an auth artifact school mismatch during preflight", () => {
    const baseUrl = "http://localhost:4000";
    const baseEnv = (artifacts: ReturnType<typeof createLaunchArtifacts>) => cleanEnv({
      LOAD_BASE_URL: baseUrl,
      LOAD_DEVICE_MANIFEST: artifacts.manifestPath,
      LOAD_DEVICE_COUNT: "510",
      LOAD_DURATION_SECONDS: "1800",
      LOAD_ENFORCE_THRESHOLDS: "true",
      LOAD_GATE_PROFILE: "launch",
      LOAD_TEACHER_AUTH_FILE: artifacts.authPath,
      LOAD_TEACHER_PATHS: "/api/students-aggregated,/api/classpilot/heartbeats/{deviceId}",
      LOAD_SCREENSHOT_GET_PATH_TEMPLATE: "/api/classpilot/device/screenshot/{deviceId}",
      LOAD_COMMAND_ENDPOINT: "/api/classpilot/commands",
      LOAD_COMMAND_BODIES_FILE: artifacts.commandsPath,
      LOAD_EXPECTED_TARGETS_PER_CLASS: "25",
      LOAD_FORCE_RECONNECT_AT_SECONDS: "120",
      LOAD_EXTERNAL_SUMMARY_PATH: join(tempDir, "membership-preflight-summary.json"),
      LOAD_EXTERNAL_PROGRESS_PATH: join(tempDir, "membership-preflight-progress.jsonl"),
    });

    const mixed = createLaunchArtifacts({
      label: "mixed-membership",
      baseUrl,
      primaryDevices: 500,
      targetsPerClass: 25,
    });
    const mixedAuth = JSON.parse(readFileSync(mixed.authPath, "utf8"));
    mixedAuth.teacherAuth[1].schoolId = "school-2";
    writeFileSync(mixed.authPath, JSON.stringify(mixedAuth));
    const mixedResult = run(["--validate-config"], baseEnv(mixed));
    assert.notEqual(mixedResult.status, 0);
    assert.match(mixedResult.stderr, /must belong to one synthetic primary school/);

    const mismatched = createLaunchArtifacts({
      label: "artifact-mismatch",
      baseUrl,
      primaryDevices: 500,
      targetsPerClass: 25,
    });
    const mismatchedAuth = JSON.parse(readFileSync(mismatched.authPath, "utf8"));
    mismatchedAuth.schoolId = "school-2";
    writeFileSync(mismatched.authPath, JSON.stringify(mismatchedAuth));
    const mismatchResult = run(["--validate-config"], baseEnv(mismatched));
    assert.notEqual(mismatchResult.status, 0);
    assert.match(mismatchResult.stderr, /artifact schoolId does not match its teacher entries/);
    assert.doesNotMatch(
      `${mixedResult.stdout}\n${mixedResult.stderr}\n${mismatchResult.stdout}\n${mismatchResult.stderr}`,
      /cookie-secret|csrf-secret|test-signature/
    );
  });

  it("passes the exact enforced 500-stage launch contract through a real loopback workload", async () => {
    let artifacts: ReturnType<typeof createLaunchArtifacts> | null = null;
    const studentSockets = new Map<string, WebSocket>();
    const teacherSockets = new Set<WebSocket>();
    const commandStates = new Map<string, {
      targets: string[];
      statuses: Map<string, string>;
      teacherId: string;
      teachingSessionId: string;
    }>();
    const schoolHeaders: Array<{ path: string; schoolId: string; cookie: string }> = [];
    const httpUserAgents: string[] = [];
    const websocketUserAgents: string[] = [];
    const heartbeatCohortRequests: Array<{ cookie: string; at: number }> = [];
    const screenshotCohortRequests: Array<{ deviceId: string; at: number }> = [];
    const tileInFlightByClass = new Map<string, number>();
    const tilePeakInFlightByClass = new Map<string, number>();
    let commandSequence = 0;
    let receivedAcks = 0;
    let completedAcks = 0;
    let studentAuthentications = 0;
    let teacherAuthentications = 0;
    let studentKeepalivePings = 0;
    let teacherKeepalivePings = 0;
    let dropKeepalivePongs = false;
    let injectedTransient502 = false;
    let injectOverbroadSameSchoolTarget = false;
    let injectOverbroadAggregatedResponse = false;

    const server = createServer((request, response) => {
      const url = request.url || "/";
      const userAgent = String(request.headers["user-agent"] || "");
      httpUserAgents.push(userAgent);
      if (!userAgent.includes("SchoolPilot-ClassPilot-LoadGate/1.0")) {
        response.writeHead(403, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "missing load-gate user agent" }));
        return;
      }
      const isTeacherRequest =
        url === "/api/students-aggregated" ||
        url.startsWith("/api/classpilot/heartbeats/") ||
        url.startsWith("/api/classpilot/device/screenshot/") ||
        url === "/api/classpilot/commands";
      if (isTeacherRequest) {
        schoolHeaders.push({
          path: url,
          schoolId: String(request.headers["x-school-id"] || ""),
          cookie: String(request.headers.cookie || ""),
        });
      }
      const sendJson = (status: number, value: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      const sendHeldTileJson = (classId: string, status: number, value: unknown) => {
        const inFlight = (tileInFlightByClass.get(classId) || 0) + 1;
        tileInFlightByClass.set(classId, inFlight);
        tilePeakInFlightByClass.set(
          classId,
          Math.max(tilePeakInFlightByClass.get(classId) || 0, inFlight)
        );
        // Keep the complete 50-request class cohort in flight long enough for
        // a contended shared CI runner to accept every socket. The production
        // contract remains the stricter >=45 concurrent requests; only this
        // loopback fixture's artificial response hold is lengthened.
        setTimeout(() => {
          tileInFlightByClass.set(classId, Math.max(0, (tileInFlightByClass.get(classId) || 1) - 1));
          sendJson(status, value);
        }, 500);
      };
      if (request.method === "POST" && url === "/api/classpilot/commands") {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => {
          assert.ok(artifacts);
          const parsed = JSON.parse(body);
          const teachingSessionId = String(parsed.teachingSessionId || "");
          const expectedTargets = artifacts.sessionTargets.get(teachingSessionId) || [];
          const teacher = artifacts.teacherAuth.find((entry) => entry.teachingSessionId === teachingSessionId);
          assert.ok(teacher);
          const unexpectedTarget = injectOverbroadSameSchoolTarget
            ? artifacts.manifest.find((entry) =>
                entry.schoolId === "school-1" && !expectedTargets.includes(entry.deviceId)
              )?.deviceId
            : null;
          const targets = unexpectedTarget ? [...expectedTargets, unexpectedTarget] : expectedTargets;
          const commandId = `loopback-command-${++commandSequence}`;
          commandStates.set(commandId, {
            targets,
            statuses: new Map(targets.map((deviceId) => [deviceId, "sent"])),
            teacherId: String(teacher.teacherId),
            teachingSessionId,
          });
          // The malicious case deliberately under-reports the extra same-school
          // recipient so the harness must validate actual device delivery, not
          // merely trust the server's summary count.
          sendJson(200, { command: { id: commandId }, summary: { sent: expectedTargets.length } });
          const dispatch = (attempt = 0) => {
            const missing = targets.filter((deviceId) => studentSockets.get(deviceId)?.readyState !== WebSocket.OPEN);
            if (missing.length > 0 && attempt < 80) {
              setTimeout(() => dispatch(attempt + 1), 25);
              return;
            }
            for (const deviceId of targets) {
              studentSockets.get(deviceId)?.send(JSON.stringify({
                type: "remote-control",
                commandId,
                command: { commandId },
              }));
            }
          };
          setImmediate(() => dispatch());
        });
        return;
      }
      if (request.method === "POST" && (
        url === "/api/classpilot/device/heartbeat" ||
        url === "/api/classpilot/device/screenshot"
      )) {
        request.resume();
        request.on("end", () => sendJson(200, { ok: true }));
        return;
      }
      if (url === "/api/students-aggregated") {
        assert.ok(artifacts);
        const cookie = String(request.headers.cookie || "");
        const teacherIndex = Number(cookie.match(/launch-cookie-secret-(\d+)/)?.[1] || 0) - 1;
        const teacher = artifacts.teacherAuth[teacherIndex] as { studentIds?: string[] } | undefined;
        const studentIds = [...(teacher?.studentIds || [])];
        if (injectOverbroadAggregatedResponse) {
          const foreignClassStudent = artifacts.manifest.find((entry) =>
            entry.schoolId === "school-1" && !studentIds.includes(entry.studentId)
          )?.studentId;
          if (foreignClassStudent) studentIds.push(foreignClassStudent);
        }
        sendJson(200, studentIds.map((studentId) => ({ studentId })));
        return;
      }
      if (url.startsWith("/api/classpilot/heartbeats/")) {
        const deviceId = decodeURIComponent(url.split("/").at(-1) || "");
        if (!deviceId.includes("canary-device")) {
          heartbeatCohortRequests.push({ cookie: String(request.headers.cookie || ""), at: Date.now() });
        }
        if (deviceId.includes("canary-device")) sendJson(404, { error: "Not found" });
        else {
          const teacherIndex = Number(String(request.headers.cookie || "").match(/launch-cookie-secret-(\d+)/)?.[1] || 0);
          sendHeldTileJson(`launch-class-${teacherIndex}`, 200, { heartbeats: [{ deviceId }] });
        }
        return;
      }
      if (url.startsWith("/api/classpilot/device/screenshot/")) {
        if (!String(request.headers.authorization || "").startsWith("Bearer ")) {
          sendJson(401, { error: "screenshot bearer required" });
          return;
        }
        const deviceId = decodeURIComponent(url.split("/").at(-1) || "");
        if (!deviceId.includes("canary-device")) {
          screenshotCohortRequests.push({ deviceId, at: Date.now() });
        }
        if (deviceId.includes("canary-device")) sendJson(404, { error: "Not found" });
        else {
          if (!injectedTransient502) {
            injectedTransient502 = true;
            response.writeHead(502, { "content-type": "text/html" });
            response.end("<html><body>transient origin failure</body></html>");
            return;
          }
          assert.ok(artifacts);
          const classId = artifacts.manifest.find((entry) => entry.deviceId === deviceId)?.classId;
          assert.ok(classId);
          sendHeldTileJson(classId, 200, { screenshot: "data:image/jpeg;base64,/9j/2Q==", timestamp: Date.now() });
        }
        return;
      }
      sendJson(200, {});
    });
    const webSockets = new WebSocketServer({
      server,
      path: "/ws",
      verifyClient: ({ req }) => {
        const userAgent = String(req.headers["user-agent"] || "");
        websocketUserAgents.push(userAgent);
        return userAgent.includes("SchoolPilot-ClassPilot-LoadGate/1.0");
      },
    });
    const broadcastCommandState = (commandId: string) => {
      const state = commandStates.get(commandId);
      if (!state) return;
      const payload = JSON.stringify({
        type: "classpilot-command-update",
        commandId,
        command: {
          id: commandId,
          teacherId: state.teacherId,
          teachingSessionId: state.teachingSessionId,
          targets: state.targets.map((deviceId) => ({
            id: `${commandId}:${deviceId}`,
            status: state.statuses.get(deviceId),
          })),
        },
      });
      for (const teacher of teacherSockets) {
        if (teacher.readyState === WebSocket.OPEN) teacher.send(payload);
      }
    };
    webSockets.on("connection", (socket) => {
      let authenticatedDeviceId = "";
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === "auth" && message.role === "student") {
          authenticatedDeviceId = String(message.deviceId || "");
          studentSockets.set(authenticatedDeviceId, socket);
          studentAuthentications += 1;
          socket.send(JSON.stringify({ type: "auth-success", role: "student" }));
          return;
        }
        if (message.type === "auth" && message.role === "teacher") {
          teacherSockets.add(socket);
          teacherAuthentications += 1;
          socket.send(JSON.stringify({ type: "auth-success", role: "teacher" }));
          return;
        }
        if (message.type === "ping") {
          if (authenticatedDeviceId) studentKeepalivePings += 1;
          else if (teacherSockets.has(socket)) teacherKeepalivePings += 1;
          if (!dropKeepalivePongs) socket.send(JSON.stringify({ type: "pong" }));
          return;
        }
        if (message.type === "command-ack") {
          const commandId = String(message.commandId || "");
          const state = commandStates.get(commandId);
          if (!state || !authenticatedDeviceId || !state.statuses.has(authenticatedDeviceId)) return;
          if (message.status === "received") {
            state.statuses.set(authenticatedDeviceId, "received");
            receivedAcks += 1;
          } else if (message.status === "completed") {
            state.statuses.set(authenticatedDeviceId, "completed");
            completedAcks += 1;
          }
          broadcastCommandState(commandId);
        }
      });
      socket.on("close", () => {
        if (authenticatedDeviceId && studentSockets.get(authenticatedDeviceId) === socket) {
          studentSockets.delete(authenticatedDeviceId);
        }
        teacherSockets.delete(socket);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    artifacts = createLaunchArtifacts({
      label: "launch",
      baseUrl,
      primaryDevices: 500,
      targetsPerClass: 25,
    });
    const summaryPath = join(tempDir, "launch-summary.json");
    const progressPath = join(tempDir, "launch-progress.jsonl");
    try {
      const result = await runAsync([], cleanEnv({
        LOAD_BASE_URL: baseUrl,
        LOAD_DEVICE_MANIFEST: artifacts.manifestPath,
        LOAD_DEVICE_COUNT: "510",
        LOAD_DURATION_SECONDS: String(30 * 60),
        LOAD_COMMAND_SETTLE_MS: "0",
        LOAD_REQUEST_TIMEOUT_MS: "5000",
        LOAD_SHUTDOWN_GRACE_MS: "5000",
        LOAD_WS_AUTH_TIMEOUT_MS: "10000",
        LOAD_ENFORCE_THRESHOLDS: "true",
        LOAD_GATE_PROFILE: "launch",
        LOAD_TEACHER_AUTH_FILE: artifacts.authPath,
        LOAD_TEACHER_PATHS: "/api/students-aggregated,/api/classpilot/heartbeats/{deviceId}",
        LOAD_SCREENSHOT_GET_PATH_TEMPLATE: "/api/classpilot/device/screenshot/{deviceId}",
        LOAD_COMMAND_ENDPOINT: "/api/classpilot/commands",
        LOAD_COMMAND_BODIES_FILE: artifacts.commandsPath,
        LOAD_COMMAND_WARMUP_MS: "600000",
        LOAD_EXPECTED_TARGETS_PER_CLASS: "25",
        LOAD_FORCE_RECONNECT_AT_SECONDS: "1200",
        LOAD_EXTERNAL_SUMMARY_PATH: summaryPath,
        LOAD_EXTERNAL_PROGRESS_PATH: progressPath,
        LOAD_TEST_ACCELERATED_RUNTIME_MS: "15000",
        LOAD_TEST_LATENCY_THRESHOLD_MULTIPLIER: "4",
        LOAD_TEST_PROGRESS_INTERVAL_MS: "500",
        LOAD_TEST_REQUEST_STAGGER_MS: "6000",
      }), 35_000);
      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
      const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
      assert.equal(summary.thresholds.passed, true, JSON.stringify(summary.thresholds.failures));
      assert.equal(summary.run.completedConfiguredDuration, true);
      assert.equal(summary.run.acceleratedLoopbackTest, true);
      assert.equal(summary.commands.deliveryWithin2sPercent, 100);
      assert.equal(summary.commands.completedAckWithin5sPercent, 100);
      assert.equal(summary.commands.serverCompletedPercent, 100);
      assert.equal(summary.commands.requestLatency.exact, true);
      assert.equal(summary.commands.requestLatency.observedCount, commandSequence);
      assert.equal(summary.commands.requestLatency.retainedCount, commandSequence);
      assert.equal(summary.commands.requestLatency.droppedCount, 0);
      assert.equal(summary.commands.requestLatency.observedCount, summary.kinds.command.count);
      assert.equal(summary.counters.http5xx, 1);
      assert.equal(summary.counters.responseParseErrors, 0);
      assert.equal(summary.counters.commandServerStatusRegressions, 0);
      assert.equal(summary.counters.forcedReconnectRequested, 510);
      assert.equal(summary.counters.forcedReconnectCompleted, 510);
      assert.equal(summary.websocket.finalPreShutdown.deviceAuthenticated, 510);
      assert.equal(summary.websocket.finalPreShutdown.teacherAuthenticated, 20);
      assert.equal(summary.websocket.finalPreShutdown.outstandingReconnects, 0);
      assert.equal(summary.counters.tenantIsolationProbePassed, 20);
      assert.ok(summary.teacherEndpoints["GET /api/students-aggregated"].p95 <= 1000);
      assert.ok(summary.teacherEndpoints["GET /api/classpilot/heartbeats/{deviceId}"].p95 <= 1000);
      assert.ok(summary.teacherEndpoints["GET /api/classpilot/device/screenshot/{deviceId}"].p95 <= 750);
      assert.equal(commandSequence, 20);
      assert.equal(receivedAcks, 500);
      assert.equal(completedAcks, 500);
      assert.ok(studentAuthentications >= 1020);
      assert.equal(teacherAuthentications, 20);
      assert.ok(studentKeepalivePings >= 510);
      assert.ok(teacherKeepalivePings >= 20);
      assert.equal(summary.websocket.keepalive.deviceIntervalMs, 25_000);
      assert.equal(summary.websocket.keepalive.teacherIntervalMs, 20_000);
      assert.ok(summary.counters.wsKeepalivePingsSent >= studentKeepalivePings);
      assert.ok(summary.counters.wsKeepalivePingsSent - studentKeepalivePings <= 510);
      assert.ok(summary.counters.wsKeepalivePongsReceived > 0);
      assert.ok(studentKeepalivePings - summary.counters.wsKeepalivePongsReceived <= 510);
      assert.ok(summary.counters.teacherWsKeepalivePingsSent >= teacherKeepalivePings);
      assert.ok(summary.counters.teacherWsKeepalivePingsSent - teacherKeepalivePings <= 20);
      assert.ok(summary.counters.teacherWsKeepalivePongsReceived > 0);
      assert.ok(teacherKeepalivePings - summary.counters.teacherWsKeepalivePongsReceived <= 20);
      assert.ok(schoolHeaders.length > 1000);
      assert.ok(httpUserAgents.length > 1000);
      assert.ok(httpUserAgents.every((value) => value.includes("Mozilla/5.0") && value.includes("SchoolPilot-ClassPilot-LoadGate/1.0")));
      assert.ok(websocketUserAgents.length >= 1040);
      assert.ok(websocketUserAgents.every((value) => value.includes("Mozilla/5.0") && value.includes("SchoolPilot-ClassPilot-LoadGate/1.0")));
      const heartbeatByTeacher = new Map<string, number[]>();
      for (const entry of heartbeatCohortRequests) {
        const values = heartbeatByTeacher.get(entry.cookie) || [];
        values.push(entry.at);
        heartbeatByTeacher.set(entry.cookie, values);
      }
      assert.equal(heartbeatByTeacher.size, 20);
      for (const values of heartbeatByTeacher.values()) {
        assert.equal(values.length, 25);
        assert.ok(Math.max(...values) - Math.min(...values) < 1_000, "one teacher's 25 tile requests must remain a cohort burst");
      }
      const cohortStarts = [...heartbeatByTeacher.values()].map((values) => Math.min(...values)).sort((a, b) => a - b);
      assert.ok(cohortStarts.at(-1)! - cohortStarts[0] >= 4_000, "independent teacher cohorts must be staggered across the configured window");
      assert.ok(artifacts);
      const classByDeviceId = new Map(artifacts.manifest.map((entry) => [entry.deviceId, entry.classId]));
      const combinedTileReadsByClass = new Map<string, number[]>();
      for (const entry of heartbeatCohortRequests) {
        const teacherIndex = Number(entry.cookie.match(/launch-cookie-secret-(\d+)/)?.[1] || 0);
        const classId = `launch-class-${teacherIndex}`;
        const values = combinedTileReadsByClass.get(classId) || [];
        values.push(entry.at);
        combinedTileReadsByClass.set(classId, values);
      }
      for (const entry of screenshotCohortRequests) {
        const classId = classByDeviceId.get(entry.deviceId);
        if (!classId) continue;
        const values = combinedTileReadsByClass.get(classId) || [];
        values.push(entry.at);
        combinedTileReadsByClass.set(classId, values);
      }
      assert.equal(combinedTileReadsByClass.size, 20);
      for (const values of combinedTileReadsByClass.values()) {
        assert.equal(values.length, 50);
        assert.ok(
          Math.max(...values) - Math.min(...values) < 1_000,
          "one teacher's 25 history and 25 screenshot reads must remain one combined tile burst"
        );
      }
      assert.equal(tilePeakInFlightByClass.size, 20);
      for (const peak of tilePeakInFlightByClass.values()) {
        assert.ok(
          peak >= 45,
          `combined history and screenshot cohort must reach at least 45 in-flight requests; observed ${peak}`
        );
      }
      assert.ok(schoolHeaders.every((entry) => entry.schoolId === "school-1"));
      assert.equal(new Set(schoolHeaders.filter((entry) => entry.path === "/api/students-aggregated").map((entry) => entry.cookie)).size, 20);
      const commandHeaders = schoolHeaders.filter((entry) => entry.path === "/api/classpilot/commands");
      assert.equal(commandHeaders.length, 20);
      assert.equal(new Set(commandHeaders.map((entry) => entry.cookie)).size, 20);
      const probeHeaders = schoolHeaders.filter((entry) => entry.path.includes("launch-canary-device"));
      assert.equal(probeHeaders.length, 20);
      assert.ok(probeHeaders.every((entry) => entry.schoolId === "school-1"));
      const progress = readJsonLines(progressPath);
      assert.equal(progress[0].event, "start");
      assert.ok(progress.some((record) => record.event === "minute"));
      assert.equal(progress.at(-1).event, "final");
      assert.ok(progress.at(-1).latency.teacherEndpoints["GET /api/students-aggregated"]);
      assert.equal(progress.at(-1).commands.requestLatency.exact, true);
      assert.equal(progress.at(-1).commands.requestLatency.observedCount, commandSequence);
      assert.doesNotMatch(
        `${result.stdout}\n${result.stderr}\n${readFileSync(summaryPath, "utf8")}\n${readFileSync(progressPath, "utf8")}`,
        /launch-cookie-secret|launch-csrf-secret|test-signature/
      );

      dropKeepalivePongs = true;
      const keepaliveSummaryPath = join(tempDir, "launch-keepalive-summary.json");
      const keepaliveProgressPath = join(tempDir, "launch-keepalive-progress.jsonl");
      const missingPongs = await runAsync([], cleanEnv({
        LOAD_BASE_URL: baseUrl,
        LOAD_DEVICE_MANIFEST: artifacts.manifestPath,
        LOAD_DEVICE_COUNT: "510",
        LOAD_DURATION_SECONDS: String(30 * 60),
        LOAD_COMMAND_SETTLE_MS: "0",
        LOAD_REQUEST_TIMEOUT_MS: "5000",
        LOAD_SHUTDOWN_GRACE_MS: "5000",
        LOAD_WS_AUTH_TIMEOUT_MS: "10000",
        LOAD_ENFORCE_THRESHOLDS: "true",
        LOAD_GATE_PROFILE: "launch",
        LOAD_TEACHER_AUTH_FILE: artifacts.authPath,
        LOAD_TEACHER_PATHS: "/api/students-aggregated,/api/classpilot/heartbeats/{deviceId}",
        LOAD_SCREENSHOT_GET_PATH_TEMPLATE: "/api/classpilot/device/screenshot/{deviceId}",
        LOAD_COMMAND_ENDPOINT: "/api/classpilot/commands",
        LOAD_COMMAND_BODIES_FILE: artifacts.commandsPath,
        LOAD_COMMAND_WARMUP_MS: "600000",
        LOAD_EXPECTED_TARGETS_PER_CLASS: "25",
        LOAD_FORCE_RECONNECT_AT_SECONDS: "1200",
        LOAD_RUN_ID: "missing-keepalive-pongs-test",
        LOAD_EXTERNAL_SUMMARY_PATH: keepaliveSummaryPath,
        LOAD_EXTERNAL_PROGRESS_PATH: keepaliveProgressPath,
        LOAD_TEST_ACCELERATED_RUNTIME_MS: "8000",
        LOAD_TEST_LATENCY_THRESHOLD_MULTIPLIER: "4",
        LOAD_TEST_PROGRESS_INTERVAL_MS: "500",
        LOAD_TEST_REQUEST_STAGGER_MS: "3000",
      }), 20_000);
      assert.notEqual(missingPongs.status, 0, missingPongs.stdout);
      const keepaliveSummary = JSON.parse(readFileSync(keepaliveSummaryPath, "utf8"));
      assert.equal(keepaliveSummary.thresholds.passed, false);
      assert.ok(keepaliveSummary.counters.wsKeepalivePingsSent > 0);
      assert.equal(keepaliveSummary.counters.wsKeepalivePongsReceived, 0);
      assert.ok(keepaliveSummary.counters.teacherWsKeepalivePingsSent > 0);
      assert.equal(keepaliveSummary.counters.teacherWsKeepalivePongsReceived, 0);
      assert.ok(keepaliveSummary.thresholds.failures.includes(
        "device WebSocket keepalive emitted no verified JSON ping/pong exchange"
      ));
      assert.ok(keepaliveSummary.thresholds.failures.includes(
        "teacher WebSocket keepalive emitted no verified JSON ping/pong exchange"
      ));
      dropKeepalivePongs = false;

      injectOverbroadAggregatedResponse = true;
      const dashboardSummaryPath = join(tempDir, "launch-dashboard-scope-summary.json");
      const dashboardProgressPath = join(tempDir, "launch-dashboard-scope-progress.jsonl");
      const dashboardScopeViolation = await runAsync([], cleanEnv({
        LOAD_BASE_URL: baseUrl,
        LOAD_DEVICE_MANIFEST: artifacts.manifestPath,
        LOAD_DEVICE_COUNT: "510",
        LOAD_DURATION_SECONDS: String(30 * 60),
        LOAD_COMMAND_SETTLE_MS: "0",
        LOAD_REQUEST_TIMEOUT_MS: "5000",
        LOAD_SHUTDOWN_GRACE_MS: "5000",
        LOAD_WS_AUTH_TIMEOUT_MS: "10000",
        LOAD_ENFORCE_THRESHOLDS: "true",
        LOAD_GATE_PROFILE: "launch",
        LOAD_TEACHER_AUTH_FILE: artifacts.authPath,
        LOAD_TEACHER_PATHS: "/api/students-aggregated,/api/classpilot/heartbeats/{deviceId}",
        LOAD_SCREENSHOT_GET_PATH_TEMPLATE: "/api/classpilot/device/screenshot/{deviceId}",
        LOAD_COMMAND_ENDPOINT: "/api/classpilot/commands",
        LOAD_COMMAND_BODIES_FILE: artifacts.commandsPath,
        LOAD_COMMAND_WARMUP_MS: "600000",
        LOAD_EXPECTED_TARGETS_PER_CLASS: "25",
        LOAD_FORCE_RECONNECT_AT_SECONDS: "1200",
        LOAD_RUN_ID: "same-school-overbroad-dashboard-test",
        LOAD_EXTERNAL_SUMMARY_PATH: dashboardSummaryPath,
        LOAD_EXTERNAL_PROGRESS_PATH: dashboardProgressPath,
        LOAD_TEST_ACCELERATED_RUNTIME_MS: "15000",
        LOAD_TEST_LATENCY_THRESHOLD_MULTIPLIER: "4",
        LOAD_TEST_PROGRESS_INTERVAL_MS: "500",
        LOAD_TEST_REQUEST_STAGGER_MS: "6000",
      }), 15_000);
      assert.notEqual(dashboardScopeViolation.status, 0, dashboardScopeViolation.stdout);
      const dashboardSummary = JSON.parse(readFileSync(dashboardSummaryPath, "utf8"));
      assert.equal(dashboardSummary.thresholds.passed, false);
      assert.ok(dashboardSummary.fatalGate.reasonCodes.includes("invalid-teacher-response"));
      assert.ok(dashboardSummary.counters.teacherResponseValidationErrors > 0);
      assert.doesNotMatch(
        `${dashboardScopeViolation.stdout}\n${dashboardScopeViolation.stderr}\n${readFileSync(dashboardSummaryPath, "utf8")}\n${readFileSync(dashboardProgressPath, "utf8")}`,
        /launch-cookie-secret|launch-csrf-secret|test-signature/
      );
      injectOverbroadAggregatedResponse = false;

      injectOverbroadSameSchoolTarget = true;
      const scopeSummaryPath = join(tempDir, "launch-scope-summary.json");
      const scopeProgressPath = join(tempDir, "launch-scope-progress.jsonl");
      const scopeViolation = await runAsync([], cleanEnv({
        LOAD_BASE_URL: baseUrl,
        LOAD_DEVICE_MANIFEST: artifacts.manifestPath,
        LOAD_DEVICE_COUNT: "510",
        LOAD_DURATION_SECONDS: String(30 * 60),
        LOAD_COMMAND_SETTLE_MS: "0",
        LOAD_REQUEST_TIMEOUT_MS: "5000",
        LOAD_SHUTDOWN_GRACE_MS: "5000",
        LOAD_WS_AUTH_TIMEOUT_MS: "10000",
        LOAD_ENFORCE_THRESHOLDS: "true",
        LOAD_GATE_PROFILE: "launch",
        LOAD_TEACHER_AUTH_FILE: artifacts.authPath,
        LOAD_TEACHER_PATHS: "/api/students-aggregated,/api/classpilot/heartbeats/{deviceId}",
        LOAD_SCREENSHOT_GET_PATH_TEMPLATE: "/api/classpilot/device/screenshot/{deviceId}",
        LOAD_COMMAND_ENDPOINT: "/api/classpilot/commands",
        LOAD_COMMAND_BODIES_FILE: artifacts.commandsPath,
        LOAD_COMMAND_WARMUP_MS: "600000",
        LOAD_EXPECTED_TARGETS_PER_CLASS: "25",
        LOAD_FORCE_RECONNECT_AT_SECONDS: "1200",
        LOAD_RUN_ID: "same-school-overbroad-command-test",
        LOAD_EXTERNAL_SUMMARY_PATH: scopeSummaryPath,
        LOAD_EXTERNAL_PROGRESS_PATH: scopeProgressPath,
        LOAD_TEST_ACCELERATED_RUNTIME_MS: "15000",
        LOAD_TEST_LATENCY_THRESHOLD_MULTIPLIER: "4",
        LOAD_TEST_PROGRESS_INTERVAL_MS: "500",
        LOAD_TEST_REQUEST_STAGGER_MS: "6000",
      }), 25_000);
      assert.notEqual(scopeViolation.status, 0, scopeViolation.stdout);
      const scopeSummary = JSON.parse(readFileSync(scopeSummaryPath, "utf8"));
      assert.equal(scopeSummary.thresholds.passed, false);
      assert.ok(scopeSummary.fatalGate.reasonCodes.includes("command-target-scope"));
      assert.ok(scopeSummary.counters.commandUnexpectedTargetDeliveries > 0);
      assert.doesNotMatch(
        `${scopeViolation.stdout}\n${scopeViolation.stderr}\n${readFileSync(scopeSummaryPath, "utf8")}\n${readFileSync(scopeProgressPath, "utf8")}`,
        /launch-cookie-secret|launch-csrf-secret|test-signature/
      );
    } finally {
      for (const client of webSockets.clients) client.terminate();
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("rejects expired private device and teacher auth artifacts", () => {
    const expiredManifestPath = join(tempDir, "expired-devices.private.json");
    writeFileSync(expiredManifestPath, JSON.stringify([{
      deviceId: "expired-device",
      studentToken: unsignedJwt(Math.floor(Date.now() / 1000) - 60),
      schoolId: "school-1",
    }]));
    const expiredManifest = run([], cleanEnv({
      LOAD_BASE_URL: "http://localhost:4000",
      LOAD_DEVICE_MANIFEST: expiredManifestPath,
      LOAD_DURATION_SECONDS: "1",
    }));
    assert.notEqual(expiredManifest.status, 0);
    assert.match(expiredManifest.stderr, /expired or expires before the run can finish/);

    const expiredAuthPath = join(tempDir, "expired-auth.private.json");
    writeFileSync(expiredAuthPath, JSON.stringify({
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      teacherAuth: [{
        teacherId: "expired-teacher",
        schoolId: "school-1",
        teacherCookie: "schoolpilot.sid=expired-cookie-secret",
        teacherToken: "expired-token-secret",
      }],
    }));
    const expiredAuth = run([], cleanEnv({
      LOAD_BASE_URL: "http://localhost:4000",
      LOAD_DEVICE_MANIFEST: manifestPath,
      LOAD_DURATION_SECONDS: "1",
      LOAD_TEACHER_AUTH_FILE: expiredAuthPath,
      LOAD_TEACHER_PATHS: "/api/students-aggregated",
    }));
    assert.notEqual(expiredAuth.status, 0);
    assert.match(expiredAuth.stderr, /expired or expires before the run can finish/);
    assert.doesNotMatch(`${expiredAuth.stdout}\n${expiredAuth.stderr}`, /expired-cookie-secret|expired-token-secret/);
  });

  it("uses 20 distinct teacher auth sessions across staggered polling cohorts and staff WebSockets", async () => {
    const cookies = new Set<string>();
    const server = createServer((request, response) => {
      if (request.url === "/api/students-aggregated") cookies.add(String(request.headers.cookie || ""));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(request.url === "/api/students-aggregated"
        ? [{ studentId: "primary-student-1" }]
        : {}));
    });
    const webSockets = new WebSocketServer({ server, path: "/ws" });
    webSockets.on("connection", (socket) => {
      socket.once("message", (raw) => {
        const auth = JSON.parse(raw.toString());
        socket.send(JSON.stringify({ type: "auth-success", role: auth.role }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    try {
      const result = await runAsync([], cleanEnv({
        LOAD_BASE_URL: `http://127.0.0.1:${address.port}`,
        LOAD_DEVICE_MANIFEST: manifestPath,
        LOAD_DURATION_SECONDS: "10",
        LOAD_TEST_ACCELERATED_RUNTIME_MS: "2000",
        LOAD_COMMAND_SETTLE_MS: "0",
        LOAD_REQUEST_TIMEOUT_MS: "500",
        LOAD_SHUTDOWN_GRACE_MS: "500",
        LOAD_TEACHER_AUTH_FILE: teacherAuthPath,
        LOAD_TEACHER_PATHS: "/api/students-aggregated",
      }), 5_000);
      assert.equal(result.status, 0, result.stderr);
      const summary = parseSummary(result.stdout);
      assert.equal(cookies.size, 20);
      assert.equal(summary.counters.teacherWsAuthenticated, 20);
      assert.equal(summary.counters.crossSchoolHttpResponses, 0);
      assert.ok(summary.counters.tenantValidatedResponses >= 20);
    } finally {
      for (const client of webSockets.clients) client.terminate();
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("does not assign a partial device subset to unrelated roster-scoped teachers", () => {
    const baseUrl = "https://school-pilot.net";
    const artifacts = createLaunchArtifacts({
      label: "partial-roster",
      baseUrl,
      primaryDevices: 500,
      targetsPerClass: 25,
    });
    const result = run(["--validate-config"], cleanEnv({
      LOAD_BASE_URL: baseUrl,
      LOAD_DEVICE_MANIFEST: artifacts.manifestPath,
      LOAD_DEVICE_COUNT: "20",
      LOAD_DURATION_SECONDS: "180",
      LOAD_ENFORCE_THRESHOLDS: "true",
      LOAD_GATE_PROFILE: "partial",
      LOAD_TEACHER_AUTH_FILE: artifacts.authPath,
      LOAD_TEACHER_PATHS: "/api/students-aggregated,/api/classpilot/heartbeats/{deviceId}",
      LOAD_SCREENSHOT_GET_PATH_TEMPLATE: "/api/classpilot/device/screenshot/{deviceId}",
      LOAD_FORCE_RECONNECT_AT_SECONDS: "120",
    }));

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const preflight = JSON.parse(result.stdout);
    assert.equal(preflight.launchContract.totalSockets, 20);
    assert.equal(preflight.launchContract.primaryDevices, 10);
    assert.equal(preflight.launchContract.canaryDevices, 10);
    assert.equal(preflight.launchContract.teacherActors, 20);
    assert.equal(preflight.launchContract.teacherTileCohorts, 1);
    assert.equal(preflight.launchContract.teacherTileAssignments, 10);
  });

  it("runs a partial roster with only the represented teacher's tile cohort", async () => {
    let artifacts: ReturnType<typeof createLaunchArtifacts> | null = null;
    const historyRequests: Array<{ cookie: string; deviceId: string }> = [];
    const screenshotDeviceIds = new Set<string>();
    const server = createServer((request, response) => {
      const sendJson = (status: number, value: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      const url = request.url || "/";
      if (request.method === "POST") {
        request.resume();
        request.on("end", () => sendJson(200, { ok: true }));
        return;
      }
      if (url === "/api/students-aggregated") {
        assert.ok(artifacts);
        const teacherIndex = Number(
          String(request.headers.cookie || "").match(/partial-runtime-cookie-secret-(\d+)/)?.[1] || 0
        ) - 1;
        const teacher = artifacts.teacherAuth[teacherIndex] as { studentIds?: string[] } | undefined;
        sendJson(200, (teacher?.studentIds || []).map((studentId) => ({ studentId })));
        return;
      }
      if (url.startsWith("/api/classpilot/heartbeats/")) {
        const deviceId = decodeURIComponent(url.split("/").at(-1) || "");
        const cookie = String(request.headers.cookie || "");
        historyRequests.push({ cookie, deviceId });
        if (!cookie.includes("partial-runtime-cookie-secret-1")) {
          sendJson(404, { error: "Not found" });
          return;
        }
        sendJson(200, { heartbeats: [{ deviceId }] });
        return;
      }
      if (url.startsWith("/api/classpilot/device/screenshot/")) {
        const deviceId = decodeURIComponent(url.split("/").at(-1) || "");
        screenshotDeviceIds.add(deviceId);
        sendJson(200, { screenshot: "data:image/jpeg;base64,/9j/2Q==", timestamp: Date.now() });
        return;
      }
      sendJson(200, {});
    });
    const webSockets = new WebSocketServer({ server, path: "/ws" });
    webSockets.on("connection", (socket) => socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "auth") {
        socket.send(JSON.stringify({ type: "auth-success", role: message.role }));
      } else if (message.type === "ping") {
        socket.send(JSON.stringify({ type: "pong" }));
      }
    }));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    artifacts = createLaunchArtifacts({
      label: "partial-runtime",
      baseUrl,
      primaryDevices: 500,
      targetsPerClass: 25,
    });
    try {
      const result = await runAsync([], cleanEnv({
        LOAD_BASE_URL: baseUrl,
        LOAD_DEVICE_MANIFEST: artifacts.manifestPath,
        LOAD_DEVICE_COUNT: "20",
        LOAD_DURATION_SECONDS: "180",
        LOAD_TEST_ACCELERATED_RUNTIME_MS: "3000",
        LOAD_TEST_LATENCY_THRESHOLD_MULTIPLIER: "4",
        LOAD_TEST_REQUEST_STAGGER_MS: "1000",
        LOAD_COMMAND_SETTLE_MS: "0",
        LOAD_REQUEST_TIMEOUT_MS: "1000",
        LOAD_SHUTDOWN_GRACE_MS: "1000",
        LOAD_ENFORCE_THRESHOLDS: "true",
        LOAD_GATE_PROFILE: "partial",
        LOAD_TEACHER_AUTH_FILE: artifacts.authPath,
        LOAD_TEACHER_PATHS: "/api/students-aggregated,/api/classpilot/heartbeats/{deviceId}",
        LOAD_SCREENSHOT_GET_PATH_TEMPLATE: "/api/classpilot/device/screenshot/{deviceId}",
        LOAD_TEACHER_HISTORY_WARMUP_MS: "30000",
        LOAD_SCREENSHOT_GET_WARMUP_MS: "30000",
      }), 10_000);

      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
      const summary = parseSummary(result.stdout);
      assert.ok(historyRequests.length > 0);
      assert.ok(historyRequests.every((entry) => entry.cookie.includes("partial-runtime-cookie-secret-1")));
      assert.equal(new Set(historyRequests.map((entry) => entry.deviceId)).size, 10);
      assert.equal(screenshotDeviceIds.size, 10);
      assert.equal(summary.counters.http4xx, 0);
      assert.equal(summary.screenshotRetrieval.successPercent, 100);
    } finally {
      for (const client of webSockets.clients) client.terminate();
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("retains round-robin cohorts for legacy devices with no ownership mapping", () => {
    const result = run(["--validate-config"], cleanEnv({
      LOAD_BASE_URL: "http://localhost:4000",
      LOAD_DEVICE_MANIFEST: manifestPath,
      LOAD_TEACHER_AUTH_FILE: teacherAuthPath,
      LOAD_TEACHER_PATHS: "/api/classpilot/heartbeats/{deviceId}",
    }));

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const preflight = JSON.parse(result.stdout);
    assert.equal(preflight.launchContract.teacherActors, 20);
    assert.equal(preflight.launchContract.teacherTileCohorts, 1);
    assert.equal(preflight.launchContract.teacherTileAssignments, 1);
  });

  it("forces both HTTP and WebSocket workload connections onto IPv4", async () => {
    const remoteAddresses: string[] = [];
    const server = createServer((request, response) => {
      remoteAddresses.push(String(request.socket.remoteAddress || ""));
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      });
    });
    const webSockets = new WebSocketServer({ server, path: "/ws" });
    webSockets.on("connection", (socket, request) => {
      remoteAddresses.push(String(request.socket.remoteAddress || ""));
      socket.once("message", () => {
        socket.send(JSON.stringify({ type: "auth-success", role: "student" }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "::", resolve);
    });
    const address = server.address() as AddressInfo;
    try {
      const result = await runAsync([], cleanEnv({
        LOAD_BASE_URL: `http://localhost:${address.port}`,
        LOAD_DEVICE_MANIFEST: manifestPath,
        LOAD_DURATION_SECONDS: "1",
        LOAD_COMMAND_SETTLE_MS: "0",
        LOAD_REQUEST_TIMEOUT_MS: "500",
        LOAD_SHUTDOWN_GRACE_MS: "500",
      }), 5_000);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(remoteAddresses.length >= 3);
      assert.ok(remoteAddresses.every((value) => value === "127.0.0.1" || value === "::ffff:127.0.0.1"));
    } finally {
      for (const client of webSockets.clients) client.terminate();
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("counts unfinished shutdown requests once and fails the run without denominator distortion", async () => {
    const server = createServer(() => { /* deliberately never finish any request */ });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const summaryPath = join(tempDir, "unfinished-summary.json");
    const progressPath = join(tempDir, "unfinished-progress.jsonl");
    try {
      const result = await runAsync([], cleanEnv({
        LOAD_BASE_URL: `http://127.0.0.1:${address.port}`,
        LOAD_DEVICE_MANIFEST: manifestPath,
        LOAD_DURATION_SECONDS: "1",
        LOAD_COMMAND_SETTLE_MS: "0",
        LOAD_REQUEST_TIMEOUT_MS: "5000",
        LOAD_SHUTDOWN_GRACE_MS: "100",
        LOAD_EXTERNAL_SUMMARY_PATH: summaryPath,
        LOAD_EXTERNAL_PROGRESS_PATH: progressPath,
      }), 5_000);
      assert.notEqual(result.status, 0, result.stderr);
      const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
      assert.ok(summary.counters.unfinishedHttpRequests > 0);
      assert.equal(summary.counters.httpErrors, summary.counters.unfinishedHttpRequests);
      assert.equal(summary.counters.httpTotal, summary.counters.unfinishedHttpRequests);
      assert.equal(summary.rates.networkErrorPercent, 100);
      assert.equal(summary.thresholds.passed, false);
      assert.ok(summary.fatalGate.reasonCodes.includes("unfinished-http-requests"));
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("enforces an independent 99% screenshot GET success gate", async () => {
    const server = createServer((request, response) => {
      const screenshotGet = request.method === "GET" && request.url?.startsWith("/api/classpilot/device/screenshot/");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(screenshotGet ? JSON.stringify({ ok: true }) : "{}");
    });
    const webSockets = new WebSocketServer({ server, path: "/ws" });
    webSockets.on("connection", (socket) => socket.once("message", () => {
      socket.send(JSON.stringify({ type: "auth-success", role: "student" }));
    }));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    try {
      const result = await runAsync([], cleanEnv({
        LOAD_BASE_URL: `http://127.0.0.1:${address.port}`,
        LOAD_DEVICE_MANIFEST: manifestPath,
        LOAD_DURATION_SECONDS: "1",
        LOAD_COMMAND_SETTLE_MS: "0",
        LOAD_REQUEST_TIMEOUT_MS: "500",
        LOAD_SHUTDOWN_GRACE_MS: "500",
        LOAD_ENFORCE_THRESHOLDS: "true",
        LOAD_GATE_PROFILE: "partial",
        LOAD_TEACHER_COOKIE: "schoolpilot.sid=screenshot-cookie-secret",
        LOAD_SCREENSHOT_GET_PATH_TEMPLATE: "/api/classpilot/device/screenshot/{deviceId}",
        LOAD_SCREENSHOT_GET_WARMUP_MS: "0",
        LOAD_SCREENSHOT_GET_INTERVAL_MS: "100",
      }), 5_000);
      assert.notEqual(result.status, 0);
      const summary = parseSummary(result.stdout);
      assert.ok(summary.screenshotRetrieval.attempts > 0);
      assert.equal(summary.screenshotRetrieval.successPercent, 0);
      assert.ok(summary.thresholds.failures.includes("fewer than 99% of screenshot GET attempts returned a successful screenshot"));
    } finally {
      for (const client of webSockets.clients) client.terminate();
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("fails fast on empty or structurally invalid aggregated and history 200 responses", async () => {
    const scenarios = [
      {
        label: "aggregated",
        path: "/api/students-aggregated",
        invalidBody: { students: [] },
        endpoint: "GET /api/students-aggregated",
      },
      {
        label: "history",
        path: "/api/classpilot/heartbeats/{deviceId}",
        invalidBody: { heartbeats: [] },
        endpoint: "GET /api/classpilot/heartbeats/{deviceId}",
      },
    ];
    for (const scenario of scenarios) {
      const server = createServer((request, response) => {
        const isTarget = scenario.label === "aggregated"
          ? request.url === "/api/students-aggregated"
          : request.url === "/api/classpilot/heartbeats/device-1";
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(isTarget ? scenario.invalidBody : {}));
      });
      const webSockets = new WebSocketServer({ server, path: "/ws" });
      webSockets.on("connection", (socket) => socket.once("message", (raw) => {
        const auth = JSON.parse(raw.toString());
        socket.send(JSON.stringify({ type: "auth-success", role: auth.role }));
      }));
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address() as AddressInfo;
      const summaryPath = join(tempDir, `invalid-${scenario.label}-summary.json`);
      const progressPath = join(tempDir, `invalid-${scenario.label}-progress.jsonl`);
      try {
        const result = await runAsync([], cleanEnv({
          LOAD_BASE_URL: `http://127.0.0.1:${address.port}`,
          LOAD_DEVICE_MANIFEST: manifestPath,
          LOAD_DURATION_SECONDS: "30",
          LOAD_COMMAND_SETTLE_MS: "0",
          LOAD_REQUEST_TIMEOUT_MS: "500",
          LOAD_SHUTDOWN_GRACE_MS: "500",
          LOAD_TEACHER_COOKIE: `schoolpilot.sid=invalid-${scenario.label}-cookie-secret`,
          LOAD_TEACHER_TOKEN: `invalid-${scenario.label}-token-secret`,
          LOAD_TEACHER_SCHOOL_ID: "school-1",
          LOAD_TEACHER_PATHS: scenario.path,
          LOAD_TEACHER_HISTORY_WARMUP_MS: "0",
          LOAD_EXTERNAL_SUMMARY_PATH: summaryPath,
          LOAD_EXTERNAL_PROGRESS_PATH: progressPath,
        }), 5_000);
        assert.notEqual(result.status, 0);
        const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
        assert.equal(summary.counters.teacherResponseValidationErrors, 1);
        assert.ok(summary.fatalGate.reasonCodes.includes("invalid-teacher-response"));
        assert.equal(summary.fatalGate.kind, scenario.endpoint);
        assert.ok(summary.teacherEndpoints[scenario.endpoint].count >= 1);
        assert.doesNotMatch(JSON.stringify(summary.teacherEndpoints), /device-1/);
      } finally {
        for (const client of webSockets.clients) client.terminate();
        await new Promise<void>((resolve) => webSockets.close(() => resolve()));
        server.closeAllConnections?.();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    }
  });

  it("enforces exact command latency and teacher latency independently for each redacted endpoint class", async () => {
    const server = createServer((request, response) => {
      const send = () => {
        response.writeHead(200, { "content-type": "application/json" });
        if (request.url === "/api/students-aggregated") {
          response.end(JSON.stringify([{ studentId: "primary-student-1" }]));
        } else if (request.url === "/api/classpilot/heartbeats/device-1") {
          response.end(JSON.stringify({ heartbeats: [{ deviceId: "device-1" }] }));
        } else if (request.url === "/api/classpilot/commands") {
          response.end(JSON.stringify({ command: { id: "slow-command-1" }, summary: { sent: 0 } }));
        } else {
          response.end("{}");
        }
      };
      if (request.url === "/api/classpilot/heartbeats/device-1" || request.url === "/api/classpilot/commands") {
        request.resume();
        setTimeout(send, 1_100);
      }
      else send();
    });
    const webSockets = new WebSocketServer({ server, path: "/ws" });
    webSockets.on("connection", (socket) => socket.once("message", (raw) => {
      const auth = JSON.parse(raw.toString());
      socket.send(JSON.stringify({ type: "auth-success", role: auth.role }));
    }));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    try {
      const result = await runAsync([], cleanEnv({
        LOAD_BASE_URL: `http://127.0.0.1:${address.port}`,
        LOAD_DEVICE_MANIFEST: manifestPath,
        LOAD_DURATION_SECONDS: "2",
        LOAD_COMMAND_SETTLE_MS: "0",
        LOAD_REQUEST_TIMEOUT_MS: "5000",
        LOAD_SHUTDOWN_GRACE_MS: "500",
        LOAD_ENFORCE_THRESHOLDS: "true",
        LOAD_GATE_PROFILE: "partial",
        LOAD_TEACHER_COOKIE: "schoolpilot.sid=endpoint-latency-cookie-secret",
        LOAD_CSRF_TOKEN: "endpoint-latency-csrf-secret",
        LOAD_TEACHER_TOKEN: "endpoint-latency-token-secret",
        LOAD_TEACHER_SCHOOL_ID: "school-1",
        LOAD_TEACHER_PATHS: "/api/students-aggregated,/api/classpilot/heartbeats/{deviceId}",
        LOAD_TEACHER_INTERVAL_MS: "100",
        LOAD_TEACHER_HISTORY_WARMUP_MS: "0",
        LOAD_COMMAND_ENDPOINT: "/api/classpilot/commands",
        LOAD_COMMAND_BODY: JSON.stringify({
          teachingSessionId: "session-1",
          targetScope: "class",
          commandType: "lock-screen",
          commandPayload: {},
        }),
        LOAD_COMMAND_WARMUP_MS: "0",
        LOAD_COMMAND_INTERVAL_MS: "5000",
      }), 6_000);
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /\{/, result.stderr);
      const summary = parseSummary(result.stdout);
      assert.ok(summary.kinds.teacher.p95 <= 1000);
      assert.ok(summary.teacherEndpoints["GET /api/students-aggregated"].p95 <= 1000);
      assert.ok(summary.teacherEndpoints["GET /api/classpilot/heartbeats/{deviceId}"].p95 > 1000);
      assert.ok(summary.thresholds.failures.includes("GET /api/classpilot/heartbeats/{deviceId} p95 exceeds 1000ms"));
      assert.equal(summary.commands.requestLatency.exact, true);
      assert.equal(summary.commands.requestLatency.observedCount, 1);
      assert.ok(summary.commands.requestLatency.p95Ms > 1000);
      assert.equal(summary.commands.requestLatency.errors, 0);
      assert.ok(summary.kinds.command.p95 >= summary.commands.requestLatency.p95Ms);
      assert.equal(summary.commands.requestLatency.aboveThresholdCount, 1);
      assert.ok(summary.thresholds.failures.includes("teacher command p95 exceeds 1000ms"));
      assert.ok(summary.thresholds.failures.includes("POST /api/classpilot/commands p95 exceeds 1000ms"));
      assert.doesNotMatch(JSON.stringify(summary.teacherEndpoints), /device-1/);
    } finally {
      for (const client of webSockets.clients) client.terminate();
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("fails closed when bounded exact command latency evidence overflows", async () => {
    let commandSequence = 0;
    const server = createServer((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(request.url === "/api/classpilot/commands"
        ? { command: { id: `overflow-command-${++commandSequence}` }, summary: { sent: 0 } }
        : {}));
    });
    const webSockets = new WebSocketServer({ server, path: "/ws" });
    webSockets.on("connection", (socket) => socket.once("message", (raw) => {
      const auth = JSON.parse(raw.toString());
      socket.send(JSON.stringify({ type: "auth-success", role: auth.role }));
    }));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    try {
      const result = await runAsync([], cleanEnv({
        LOAD_BASE_URL: `http://127.0.0.1:${address.port}`,
        LOAD_DEVICE_MANIFEST: manifestPath,
        LOAD_DURATION_SECONDS: "2",
        LOAD_COMMAND_SETTLE_MS: "0",
        LOAD_REQUEST_TIMEOUT_MS: "1000",
        LOAD_SHUTDOWN_GRACE_MS: "500",
        LOAD_ENFORCE_THRESHOLDS: "true",
        LOAD_GATE_PROFILE: "partial",
        LOAD_TEACHER_COOKIE: "schoolpilot.sid=overflow-cookie-secret",
        LOAD_CSRF_TOKEN: "overflow-csrf-secret",
        LOAD_TEACHER_TOKEN: "overflow-token-secret",
        LOAD_TEACHER_SCHOOL_ID: "school-1",
        LOAD_COMMAND_ENDPOINT: "/api/classpilot/commands",
        LOAD_COMMAND_BODY: JSON.stringify({
          teachingSessionId: "session-1",
          targetScope: "class",
          commandType: "lock-screen",
          commandPayload: {},
        }),
        LOAD_COMMAND_WARMUP_MS: "0",
        LOAD_COMMAND_INTERVAL_MS: "100",
        LOAD_MAX_TRACKED_COMMANDS: "1",
      }), 6_000);
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /\{/, result.stderr);
      const summary = parseSummary(result.stdout);
      assert.ok(commandSequence > 1);
      assert.equal(summary.commands.requestLatency.exact, false);
      assert.equal(summary.commands.requestLatency.retainedCount, 1);
      assert.ok(summary.commands.requestLatency.droppedCount > 0);
      assert.equal(summary.commands.requestLatency.p95Ms, null);
      assert.equal(summary.commands.requestLatency.aboveThresholdCount, null);
      assert.ok(summary.thresholds.failures.includes("exact teacher command latency sampling overflowed its bounded capacity"));
    } finally {
      for (const client of webSockets.clients) client.terminate();
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("fails fast when aggregated data exposes a known non-owned canary identifier without schoolId", async () => {
    const isolationManifestPath = join(tempDir, "http-isolation-devices.private.json");
    writeFileSync(isolationManifestPath, JSON.stringify([
      {
        deviceId: "primary-device-isolation",
        studentId: "primary-student-isolation",
        studentToken: "primary-isolation-secret",
        schoolId: "school-1",
      },
      {
        deviceId: "canary-device-isolation",
        studentId: "canary-student-isolation",
        studentToken: "canary-isolation-secret",
        schoolId: "school-2",
      },
    ]));
    const server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(request.url === "/api/students-aggregated"
        ? [{ studentId: "canary-student-isolation" }]
        : {}));
    });
    const webSockets = new WebSocketServer({ server, path: "/ws" });
    webSockets.on("connection", (socket) => socket.once("message", (raw) => {
      const auth = JSON.parse(raw.toString());
      socket.send(JSON.stringify({ type: "auth-success", role: auth.role }));
    }));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const summaryPath = join(tempDir, "http-isolation-summary.json");
    const progressPath = join(tempDir, "http-isolation-progress.jsonl");
    try {
      const result = await runAsync([], cleanEnv({
        LOAD_BASE_URL: `http://127.0.0.1:${address.port}`,
        LOAD_DEVICE_MANIFEST: isolationManifestPath,
        LOAD_DURATION_SECONDS: "30",
        LOAD_COMMAND_SETTLE_MS: "0",
        LOAD_REQUEST_TIMEOUT_MS: "500",
        LOAD_SHUTDOWN_GRACE_MS: "500",
        LOAD_TEACHER_COOKIE: "schoolpilot.sid=isolation-cookie-secret",
        LOAD_TEACHER_TOKEN: "isolation-token-secret",
        LOAD_TEACHER_SCHOOL_ID: "school-1",
        LOAD_TEACHER_PATHS: "/api/students-aggregated",
        LOAD_EXTERNAL_SUMMARY_PATH: summaryPath,
        LOAD_EXTERNAL_PROGRESS_PATH: progressPath,
      }), 5_000);
      assert.notEqual(result.status, 0);
      const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
      assert.equal(summary.counters.crossSchoolHttpResponses, 1);
      assert.ok(summary.fatalGate.reasonCodes.includes("cross-school-http-response"));
      assert.equal(summary.fatalGate.reason, "known-non-owned-identifier");
      assert.ok(summary.run.actualTrafficSeconds < 30);
    } finally {
      for (const client of webSockets.clients) client.terminate();
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("executes real history and screenshot negative probes for known canary devices", async () => {
    const probeManifestPath = join(tempDir, "probe-devices.private.json");
    writeFileSync(probeManifestPath, JSON.stringify([
      {
        deviceId: "probe-primary-device",
        studentId: "probe-primary-student",
        studentToken: "probe-primary-secret",
        schoolId: "school-1",
      },
      {
        deviceId: "probe-canary-device",
        studentId: "probe-canary-student",
        studentToken: "probe-canary-secret",
        schoolId: "school-2",
      },
    ]));
    const probedPaths: string[] = [];
    const server = createServer((request, response) => {
      const isCanaryProbe = request.method === "GET" && (
        request.url === "/api/classpilot/heartbeats/probe-canary-device" ||
        request.url === "/api/classpilot/device/screenshot/probe-canary-device"
      );
      if (isCanaryProbe) probedPaths.push(String(request.url));
      response.writeHead(isCanaryProbe ? 404 : 200, { "content-type": "application/json" });
      response.end(isCanaryProbe ? JSON.stringify({ error: "Not found" }) : "{}");
    });
    const webSockets = new WebSocketServer({ server, path: "/ws" });
    webSockets.on("connection", (socket) => socket.once("message", (raw) => {
      const auth = JSON.parse(raw.toString());
      socket.send(JSON.stringify({ type: "auth-success", role: auth.role }));
    }));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    try {
      const result = await runAsync([], cleanEnv({
        LOAD_BASE_URL: `http://127.0.0.1:${address.port}`,
        LOAD_DEVICE_MANIFEST: probeManifestPath,
        LOAD_DURATION_SECONDS: "10",
        LOAD_TEST_ACCELERATED_RUNTIME_MS: "2000",
        LOAD_COMMAND_SETTLE_MS: "0",
        LOAD_REQUEST_TIMEOUT_MS: "500",
        LOAD_SHUTDOWN_GRACE_MS: "500",
        LOAD_TEACHER_COOKIE: "schoolpilot.sid=probe-cookie-secret",
        LOAD_TEACHER_TOKEN: "probe-teacher-token-secret",
        LOAD_TEACHER_SCHOOL_ID: "school-1",
        LOAD_TEST_ENABLE_ISOLATION_PROBES: "true",
      }), 5_000);
      assert.equal(result.status, 0, result.stderr);
      const summary = parseSummary(result.stdout);
      assert.deepEqual(new Set(probedPaths), new Set([
        "/api/classpilot/heartbeats/probe-canary-device",
        "/api/classpilot/device/screenshot/probe-canary-device",
      ]));
      assert.equal(summary.counters.tenantIsolationProbeAttempts, 2);
      assert.equal(summary.counters.tenantIsolationProbePassed, 2);
      assert.equal(summary.counters.tenantIsolationProbeFailed, 0);
      assert.equal(summary.counters.http4xx, 0);
      assert.equal(summary.statusCodes["404"], undefined);
    } finally {
      for (const client of webSockets.clients) client.terminate();
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("distinguishes unavailable isolation probes from confirmed cross-school access", async () => {
    const probeManifestPath = join(tempDir, "probe-failure-devices.private.json");
    writeFileSync(probeManifestPath, JSON.stringify([
      {
        deviceId: "probe-failure-primary-device",
        studentId: "probe-failure-primary-student",
        studentToken: "probe-failure-primary-secret",
        schoolId: "school-1",
      },
      {
        deviceId: "probe-failure-canary-device",
        studentId: "probe-failure-canary-student",
        studentToken: "probe-failure-canary-secret",
        schoolId: "school-2",
      },
    ]));

    const runProbeCase = async (probeStatus: number, label: string) => {
      let requestCount = 0;
      const server = createServer((request, response) => {
        requestCount += 1;
        const isCanaryProbe = request.method === "GET" && (
          request.url === "/api/classpilot/heartbeats/probe-failure-canary-device" ||
          request.url === "/api/classpilot/device/screenshot/probe-failure-canary-device"
        );
        response.writeHead(isCanaryProbe ? probeStatus : 200, { "content-type": "application/json" });
        response.end(JSON.stringify(isCanaryProbe
          ? { error: "probe result", deviceId: "probe-failure-canary-device" }
          : {}));
      });
      const webSockets = new WebSocketServer({ server, path: "/ws" });
      webSockets.on("connection", (socket) => socket.once("message", (raw) => {
        const auth = JSON.parse(raw.toString());
        socket.send(JSON.stringify({ type: "auth-success", role: auth.role }));
      }));
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address() as AddressInfo;
      const summaryPath = join(tempDir, `${label}-probe-summary.json`);
      const readyPath = join(tempDir, `${label}-probe-harness-ready.json`);
      const startGatePath = join(tempDir, `${label}-probe-harness-start.json`);
      const runId = `${label}-probe-start-gate`;
      let child: ReturnType<typeof spawn> | null = null;
      try {
        const env = cleanEnv({
          LOAD_BASE_URL: `http://127.0.0.1:${address.port}`,
          LOAD_DEVICE_MANIFEST: probeManifestPath,
          LOAD_DURATION_SECONDS: "10",
          LOAD_TEST_ACCELERATED_RUNTIME_MS: "2000",
          LOAD_TEST_REQUEST_STAGGER_MS: "100",
          LOAD_COMMAND_SETTLE_MS: "0",
          LOAD_REQUEST_TIMEOUT_MS: "500",
          LOAD_SHUTDOWN_GRACE_MS: "500",
          LOAD_TEACHER_COOKIE: "schoolpilot.sid=probe-failure-cookie-secret",
          LOAD_TEACHER_TOKEN: "probe-failure-teacher-token-secret",
          LOAD_TEACHER_SCHOOL_ID: "school-1",
          LOAD_TEACHER_INTERVAL_MS: "100",
          LOAD_TEST_ENABLE_ISOLATION_PROBES: "true",
          LOAD_EXTERNAL_SUMMARY_PATH: summaryPath,
          LOAD_RUN_ID: runId,
          LOAD_SUPERVISOR_READY_PATH: readyPath,
          LOAD_SUPERVISOR_START_GATE_PATH: startGatePath,
          LOAD_SUPERVISOR_START_GATE_TIMEOUT_MS: "5000",
        });
        child = spawn(process.execPath, [script], { env });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        const completed = new Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
          child?.once("error", reject);
          child?.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
        });

        const readyDeadline = Date.now() + 2_000;
        while (!existsSync(readyPath) && Date.now() < readyDeadline) {
          assert.equal(child.exitCode, null, `${label} probe harness exited before monitor startup: ${stderr}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(existsSync(readyPath), `${label} probe harness did not reach the supervisor start gate`);
        const ready = JSON.parse(readFileSync(readyPath, "utf8"));
        assert.equal(ready.runId, runId);
        assert.equal(ready.harnessProcessId, child.pid);
        assert.equal(ready.trafficStarted, false);

        // Give an immediate fatal response enough time to arrive if any HTTP or
        // WebSocket traffic could escape before the monitor releases the gate.
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.equal(child.exitCode, null, `${label} probe harness exited before monitor startup: ${stderr}`);
        assert.equal(requestCount, 0, `${label} probe emitted HTTP traffic before monitor startup`);
        assert.equal(existsSync(summaryPath), false, `${label} probe wrote a terminal summary before monitor startup`);

        writeFileSync(startGatePath, JSON.stringify({
          schemaVersion: 1,
          type: "load_supervisor_start",
          runId,
          harnessProcessId: child.pid,
          monitorProcessId: process.pid,
          releasedAt: new Date().toISOString(),
        }));
        const result = await Promise.race([
          completed,
          new Promise<never>((_resolve, reject) => setTimeout(
            () => reject(new Error(`${label} probe harness did not exit after supervisor release`)),
            5_000
          )),
        ]);
        return { result, summary: JSON.parse(readFileSync(summaryPath, "utf8")) };
      } finally {
        if (child && child.exitCode === null) child.kill();
        for (const client of webSockets.clients) client.terminate();
        await new Promise<void>((resolve) => webSockets.close(() => resolve()));
        server.closeAllConnections?.();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    };

    const unavailable = await runProbeCase(500, "unavailable");
    assert.notEqual(unavailable.result.status, 0);
    assert.ok(unavailable.summary.fatalGate.reasonCodes.includes("tenant-isolation-probe-unavailable"));
    assert.equal(unavailable.summary.fatalGate.reason, "http-500");
    assert.ok(unavailable.summary.counters.tenantIsolationProbeAttempts >= 1);
    assert.ok(unavailable.summary.counters.tenantIsolationProbeAttempts <= 2);
    assert.equal(unavailable.summary.counters.tenantIsolationProbePassed, 0);
    assert.equal(
      unavailable.summary.counters.tenantIsolationProbeFailed,
      unavailable.summary.counters.tenantIsolationProbeAttempts
    );
    assert.equal(
      unavailable.summary.counters.tenantIsolationProbeIndeterminate,
      unavailable.summary.counters.tenantIsolationProbeAttempts
    );
    assert.equal(unavailable.summary.counters.crossSchoolHttpResponses, 0);
    assert.notEqual(unavailable.summary.run.shutdownReason, "duration");

    const exposed = await runProbeCase(200, "exposed");
    assert.notEqual(exposed.result.status, 0);
    assert.ok(exposed.summary.fatalGate.reasonCodes.includes("cross-school-http-response"));
    assert.equal(exposed.summary.fatalGate.reason, "foreign-resource-access-succeeded");
    assert.ok(exposed.summary.counters.crossSchoolHttpResponses >= 1);
    assert.equal(exposed.summary.counters.tenantIsolationProbeIndeterminate, 0);
    assert.notEqual(exposed.summary.run.shutdownReason, "duration");

    for (const rejectedStatus of [401, 403]) {
      const rejected = await runProbeCase(rejectedStatus, `rejected-${rejectedStatus}`);
      assert.equal(rejected.result.status, 0, rejected.result.stderr);
      assert.equal(rejected.summary.fatalGate, null);
      assert.equal(rejected.summary.counters.tenantIsolationProbePassed, 0);
      assert.equal(
        rejected.summary.counters.tenantIsolationProbeFailed,
        rejected.summary.counters.tenantIsolationProbeAttempts
      );
      assert.equal(rejected.summary.counters.tenantIsolationProbeIndeterminate, 0);
      assert.equal(rejected.summary.counters.http4xx, 0);
      assert.equal(rejected.summary.statusCodes[String(rejectedStatus)], undefined);
      assert.equal(rejected.summary.run.shutdownReason, "duration");
    }
  });

  it("rejects an enforced run with an outstanding reconnect or unauthenticated final socket", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    const webSockets = new WebSocketServer({ server, path: "/ws" });
    let studentConnections = 0;
    webSockets.on("connection", (socket) => socket.once("message", (raw) => {
      const auth = JSON.parse(raw.toString());
      if (auth.role !== "student") return;
      studentConnections += 1;
      if (studentConnections === 1) {
        socket.send(JSON.stringify({ type: "auth-success", role: "student" }));
        setTimeout(() => socket.close(1012, "force outstanding reconnect"), 100);
      }
    }));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    try {
      const result = await runAsync([], cleanEnv({
        LOAD_BASE_URL: `http://127.0.0.1:${address.port}`,
        LOAD_DEVICE_MANIFEST: manifestPath,
        LOAD_DURATION_SECONDS: "1",
        LOAD_COMMAND_SETTLE_MS: "0",
        LOAD_REQUEST_TIMEOUT_MS: "500",
        LOAD_SHUTDOWN_GRACE_MS: "500",
        LOAD_WS_AUTH_TIMEOUT_MS: "1000",
        LOAD_ENFORCE_THRESHOLDS: "true",
        LOAD_GATE_PROFILE: "partial",
      }), 5_000);
      assert.notEqual(result.status, 0);
      const summary = parseSummary(result.stdout);
      assert.equal(summary.websocket.finalPreShutdown.deviceAuthenticated, 0);
      assert.equal(summary.websocket.finalPreShutdown.outstandingReconnects, 1);
      assert.ok(summary.thresholds.failures.some((failure: string) => failure.includes("outstanding at final pre-shutdown")));
      assert.ok(summary.thresholds.failures.some((failure: string) => failure.includes("device sockets were authenticated at final pre-shutdown")));
    } finally {
      for (const client of webSockets.clients) client.terminate();
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("cannot publish a passed summary after final progress evidence fails", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    const webSockets = new WebSocketServer({ server, path: "/ws" });
    webSockets.on("connection", (socket) => socket.once("message", () => {
      socket.send(JSON.stringify({ type: "auth-success", role: "student" }));
    }));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const summaryPath = join(tempDir, "progress-integrity-summary.json");
    const progressPath = join(tempDir, "progress-integrity-progress.jsonl");
    try {
      const result = await runAsync([], cleanEnv({
        LOAD_BASE_URL: `http://127.0.0.1:${address.port}`,
        LOAD_DEVICE_MANIFEST: manifestPath,
        LOAD_DURATION_SECONDS: "1",
        LOAD_COMMAND_SETTLE_MS: "0",
        LOAD_REQUEST_TIMEOUT_MS: "500",
        LOAD_SHUTDOWN_GRACE_MS: "500",
        LOAD_ENFORCE_THRESHOLDS: "true",
        LOAD_GATE_PROFILE: "partial",
        LOAD_EXTERNAL_SUMMARY_PATH: summaryPath,
        LOAD_EXTERNAL_PROGRESS_PATH: progressPath,
        LOAD_TEST_FAIL_FINAL_PROGRESS: "true",
      }), 5_000);
      assert.notEqual(result.status, 0);
      const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
      assert.equal(summary.thresholds.passed, false);
      assert.equal(summary.artifacts.externalProgressFinalized, false);
      assert.ok(summary.fatalGate.reasonCodes.includes("progress-output-error"));
      assert.ok(summary.thresholds.failures.some((failure: string) => failure.includes("progress-output-error")));
    } finally {
      for (const client of webSockets.clients) client.terminate();
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("stops immediately and flushes fatal evidence on valid redirects and 4xx responses", async () => {
    for (const status of [302, 401, 403, 404, 429]) {
      const server = createServer((_request, response) => {
        response.writeHead(status, { "content-type": "application/json", connection: "close" });
        response.end(JSON.stringify({ error: "deliberately rejected" }));
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address() as AddressInfo;
      const summaryPath = join(tempDir, `fatal-${status}-summary.json`);
      const progressPath = join(tempDir, `fatal-${status}-progress.jsonl`);
      try {
        const result = await runAsync([], cleanEnv({
          LOAD_BASE_URL: `http://127.0.0.1:${address.port}`,
          LOAD_DEVICE_MANIFEST: manifestPath,
          LOAD_DURATION_SECONDS: "30",
          LOAD_COMMAND_SETTLE_MS: "0",
          LOAD_REQUEST_TIMEOUT_MS: "500",
          LOAD_SHUTDOWN_GRACE_MS: "500",
          LOAD_STAGE: `fatal-${status}-test`,
          LOAD_EXTERNAL_SUMMARY_PATH: summaryPath,
          LOAD_EXTERNAL_PROGRESS_PATH: progressPath,
        }), 5_000);
        assert.notEqual(result.status, 0, result.stderr);
        const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
        assert.equal(summary.run.shutdownReason, `fatal-valid-http-${status}`);
        assert.ok(summary.run.actualTrafficSeconds < 30);
        assert.ok(summary.fatalGate.reasonCodes.includes(`valid-http-${status}`));
        assert.ok(Number(summary.statusCodes[String(status)] || 0) >= 1);

        const progress = readJsonLines(progressPath);
        const fatal = progress.find((record) => record.type === "fatal_gate");
        assert.ok(fatal, readFileSync(progressPath, "utf8"));
        assert.equal(fatal.stage, `fatal-${status}-test`);
        assert.ok(fatal.fatalGate.reasonCodes.includes(`valid-http-${status}`));
        assert.equal(progress.at(-1).event, "final");

        const evidence = `${result.stdout}\n${result.stderr}\n${readFileSync(summaryPath, "utf8")}\n${readFileSync(progressPath, "utf8")}`;
        assert.doesNotMatch(evidence, /student-secret-sentinel/);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
      }
    }
  });

  it("stops immediately and flushes fatal evidence on cross-school command delivery", async () => {
    const canaryManifestPath = join(tempDir, "cross-school-devices.json");
    writeFileSync(canaryManifestPath, JSON.stringify([{
      deviceId: "canary-device-1",
      studentToken: "cross-school-student-secret-sentinel",
      schoolId: "school-2",
    }]));
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    const webSockets = new WebSocketServer({ server, path: "/ws" });
    webSockets.on("connection", (socket) => {
      socket.once("message", (raw) => {
        const auth = JSON.parse(raw.toString());
        socket.send(JSON.stringify({ type: "auth-success", role: auth.role }));
        if (auth.role === "student") {
          setImmediate(() => socket.send(JSON.stringify({
            type: "remote-control",
            commandId: "cross-school-command",
            command: { commandId: "cross-school-command" },
          })));
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const summaryPath = join(tempDir, "cross-school-summary.json");
    const progressPath = join(tempDir, "cross-school-progress.jsonl");
    try {
      const result = await runAsync([], cleanEnv({
        LOAD_BASE_URL: `http://127.0.0.1:${address.port}`,
        LOAD_DEVICE_MANIFEST: canaryManifestPath,
        LOAD_DURATION_SECONDS: "30",
        LOAD_COMMAND_SETTLE_MS: "0",
        LOAD_REQUEST_TIMEOUT_MS: "500",
        LOAD_SHUTDOWN_GRACE_MS: "500",
        LOAD_TEACHER_TOKEN: "teacher-secret-sentinel",
        LOAD_TEACHER_SCHOOL_ID: "school-1",
        LOAD_STAGE: "cross-school-fatal-test",
        LOAD_EXTERNAL_SUMMARY_PATH: summaryPath,
        LOAD_EXTERNAL_PROGRESS_PATH: progressPath,
      }), 5_000);
      assert.notEqual(result.status, 0, result.stderr);
      const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
      assert.equal(summary.run.shutdownReason, "fatal-cross-school-delivery");
      assert.equal(summary.counters.crossSchoolCommandDeliveries, 1);
      assert.ok(summary.fatalGate.reasonCodes.includes("cross-school-delivery"));
      const progress = readJsonLines(progressPath);
      const fatal = progress.find((record) => record.type === "fatal_gate");
      assert.ok(fatal, readFileSync(progressPath, "utf8"));
      assert.ok(fatal.fatalGate.reasonCodes.includes("cross-school-delivery"));
      assert.equal(progress.at(-1).event, "final");
      const evidence = `${result.stdout}\n${result.stderr}\n${readFileSync(summaryPath, "utf8")}\n${readFileSync(progressPath, "utf8")}`;
      assert.doesNotMatch(evidence, /cross-school-student-secret-sentinel|teacher-secret-sentinel/);
    } finally {
      for (const client of webSockets.clients) client.terminate();
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});
