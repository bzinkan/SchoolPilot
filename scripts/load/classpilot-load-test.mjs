#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const JPEG_1X1 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/ASP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/ISP/2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z";
const LATENCY_BUCKETS_MS = [25, 50, 100, 200, 300, 500, 750, 1_000, 2_000, 5_000, 10_000, Infinity];
const MAX_RESPONSE_CAPTURE_BYTES = 5 * 1024 * 1024;
const REPOSITORY_ROOT = fs.realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
// Low-level Node HTTP and ws clients do not add a User-Agent. Real managed
// Chromebooks always send one, and AWSManagedRulesCommonRuleSet correctly
// blocks requests that omit it. Keep a fixed browser-compatible value so the
// synthetic gate exercises the same WAF path as the extension.
const LOAD_GATE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 SchoolPilot-ClassPilot-LoadGate/1.0";
const ipv4HttpAgent = new http.Agent({ keepAlive: true, family: 4 });
const ipv4HttpsAgent = new https.Agent({ keepAlive: true, family: 4 });

function ipv4Request(urlValue, { method, headers, body, signal }) {
  const url = new URL(urlValue);
  const transport = url.protocol === "https:" ? https : http;
  const agent = url.protocol === "https:" ? ipv4HttpsAgent : ipv4HttpAgent;
  return new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method,
      headers,
      agent,
      family: 4,
      signal,
    }, (response) => {
      const status = response.statusCode || 0;
      resolve({
        status,
        ok: status >= 200 && status < 300,
        body: response,
      });
    });
    req.once("error", reject);
    req.end(body);
  });
}

function usage() {
  console.log(`
ClassPilot load test

Credential-free validation:
  npm run load:classpilot -- --validate-fixtures

Configuration-only preflight (loads private artifacts but starts no traffic):
  npm run load:classpilot -- --validate-config

Required:
  LOAD_BASE_URL=https://staging.school-pilot.net
  LOAD_DEVICE_MANIFEST=%LOCALAPPDATA%\\SchoolPilot\\load-gates\\load-devices.private.json

Device manifest format (never printed by this script):
  [
    { "deviceId": "device-1", "studentToken": "jwt", "studentId": "optional", "schoolId": "optional" }
  ]

Core workload options:
  LOAD_DEVICE_COUNT=500
  LOAD_DURATION_SECONDS=300
  LOAD_HEARTBEAT_INTERVAL_MS=10000
  LOAD_SCREENSHOT_INTERVAL_MS=30000
  LOAD_SCREENSHOT_PROFILE=standard       # standard=40 KiB, burst=50 KiB
  LOAD_SCREENSHOT_BYTES=40960            # optional exact override
  LOAD_REQUEST_TIMEOUT_MS=15000

Teacher/dashboard options:
  LOAD_TEACHER_COOKIE='schoolpilot.sid=<session-cookie>' # preferred browser-realistic HTTP auth
  LOAD_CSRF_TOKEN=<csrf-token>                       # required with cookie for command POST
  LOAD_TEACHER_TOKEN=<jwt>                           # required for staff WebSocket auth
  LOAD_TEACHER_AUTH_FILE=%LOCALAPPDATA%\\SchoolPilot\\load-gates\\load-auth.private.json
  LOAD_TEACHER_PATHS=/api/students-aggregated,/api/classpilot/heartbeats/{deviceId}
  LOAD_DASHBOARD_PATHS=<additional comma-separated paths>
  LOAD_TEACHER_INTERVAL_MS=5000
  LOAD_TEACHER_TEMPLATE_INTERVAL_MS=30000
  LOAD_TEACHER_HISTORY_WARMUP_MS=25000 # initial heartbeat jitter plus request timeout
  LOAD_TEACHER_TEMPLATE_DEVICE_COUNT=0 # 0=all primary-school tiles (launch default)
  LOAD_SCREENSHOT_GET_PATH_TEMPLATE=/api/classpilot/device/screenshot/{deviceId}
  LOAD_SCREENSHOT_GET_INTERVAL_MS=30000
  LOAD_SCREENSHOT_GET_WARMUP_MS=45000 # wait for the staggered initial uploads

WebSocket and command validation:
  LOAD_TEACHER_SCHOOL_ID=<school-id>      # enables teacher WS ACK observation
  LOAD_TEACHER_ROLE=teacher
  LOAD_FORCE_RECONNECT_AT_SECONDS=120     # 0 disables forced reconnect
  LOAD_FORCE_RECONNECT_STAGGER_MS=30000
  LOAD_COMMAND_ENDPOINT=/api/classpilot/commands
  LOAD_COMMAND_BODY='{"teachingSessionId":"...","targetScope":"class","commandType":"open-tab","commandPayload":{"url":"https://example.edu"}}'
  LOAD_COMMAND_BODIES_FILE=%LOCALAPPDATA%\\SchoolPilot\\load-gates\\load-command-bodies.private.json
  LOAD_EXPECTED_CLASS_BODIES=20
  LOAD_EXPECTED_TARGETS_PER_CLASS=40
  LOAD_COMMAND_WARMUP_MS=30000
  LOAD_COMMAND_INTERVAL_MS=30000
  LOAD_COMMAND_SETTLE_MS=5000
  LOAD_MAX_TRACKED_COMMANDS=2000

Safety/gates:
  LOAD_ENFORCE_THRESHOLDS=true
  LOAD_GATE_PROFILE=launch              # launch requires every documented traffic input
  LOAD_EXPECTED_CANARY_DEVICES=10
  LOAD_WAF_DEVICE_LIMIT=100000
  LOAD_WAF_GENERAL_LIMIT=50000
  LOAD_SHARED_IP_LABEL=single-generator-egress
  LOAD_STAGE=500
  LOAD_RUN_ID=<supervisor-bound rollout id>
  LOAD_EXTERNAL_SUMMARY_PATH=<absolute path outside this repository>
  LOAD_EXTERNAL_PROGRESS_PATH=<absolute JSONL path outside this repository>

Template paths may contain {deviceId} or {studentId}. All HTTP and WebSocket
connections are forced onto IPv4 and originate from this one generator; the
summary reports the rolling five-minute request count that a shared school
egress IP would present to WAF.
`);
}

function makeJpegFixture(targetBytes) {
  const source = Buffer.from(JPEG_1X1, "base64");
  const extraBytes = targetBytes - source.length;
  if (extraBytes < 4 || extraBytes > 65_537) {
    throw new Error(`JPEG fixture size must be between ${source.length + 4} and ${source.length + 65_537} bytes`);
  }
  if (source.at(-2) !== 0xff || source.at(-1) !== 0xd9) {
    throw new Error("Base JPEG fixture is missing its end marker");
  }

  // Insert a legal JPEG comment segment immediately before EOI. This keeps the
  // fixture decodable while matching the wire size of real Chromebook captures.
  const segmentPayloadBytes = extraBytes - 4;
  const commentSegment = Buffer.alloc(extraBytes, 0x4c);
  commentSegment[0] = 0xff;
  commentSegment[1] = 0xfe;
  commentSegment.writeUInt16BE(segmentPayloadBytes + 2, 2);
  const jpeg = Buffer.concat([source.subarray(0, -2), commentSegment, source.subarray(-2)]);
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}

class LatencyHistogram {
  constructor() {
    this.counts = new Array(LATENCY_BUCKETS_MS.length).fill(0);
    this.count = 0;
    this.sum = 0;
    this.max = 0;
    this.errors = 0;
  }

  observe(latencyMs, failed = false) {
    const value = Math.max(0, Math.round(latencyMs));
    this.count += 1;
    this.sum += value;
    this.max = Math.max(this.max, value);
    if (failed) this.errors += 1;
    const index = LATENCY_BUCKETS_MS.findIndex((bound) => value <= bound);
    this.counts[index === -1 ? this.counts.length - 1 : index] += 1;
  }

  percentile(percent) {
    if (this.count === 0) return 0;
    const target = Math.ceil((percent / 100) * this.count);
    let cumulative = 0;
    for (let index = 0; index < this.counts.length; index += 1) {
      cumulative += this.counts[index];
      if (cumulative >= target) {
        const bound = LATENCY_BUCKETS_MS[index];
        return Number.isFinite(bound) ? bound : this.max;
      }
    }
    return this.max;
  }

  summary() {
    return {
      count: this.count,
      p50: this.percentile(50),
      p95: this.percentile(95),
      p99: this.percentile(99),
      max: this.max,
      mean: this.count === 0 ? 0 : Number((this.sum / this.count).toFixed(1)),
      errors: this.errors,
    };
  }
}

class RollingWindowCounter {
  constructor(windowSeconds) {
    this.windowSeconds = windowSeconds;
    this.counts = new Array(windowSeconds).fill(0);
    this.seconds = new Array(windowSeconds).fill(-1);
    this.lastSecond = -1;
    this.rolling = 0;
    this.peak = 0;
  }

  add(nowMs = Date.now()) {
    const second = Math.floor(nowMs / 1000);
    if (this.lastSecond !== -1 && second - this.lastSecond >= this.windowSeconds) {
      this.counts.fill(0);
      this.seconds.fill(-1);
      this.rolling = 0;
    } else if (this.lastSecond !== -1) {
      for (let cursor = this.lastSecond + 1; cursor <= second; cursor += 1) {
        const index = cursor % this.windowSeconds;
        if (this.seconds[index] !== cursor) {
          this.rolling -= this.counts[index];
          this.counts[index] = 0;
          this.seconds[index] = cursor;
        }
      }
    }
    const index = second % this.windowSeconds;
    if (this.seconds[index] !== second) {
      this.rolling -= this.counts[index];
      this.counts[index] = 0;
      this.seconds[index] = second;
    }
    this.counts[index] += 1;
    this.rolling += 1;
    this.lastSecond = Math.max(this.lastSecond, second);
    this.peak = Math.max(this.peak, this.rolling);
  }
}

function validateFixtures() {
  const standard = makeJpegFixture(40 * 1024);
  const burst = makeJpegFixture(50 * 1024);
  const decoded = [standard, burst].map((fixture) => Buffer.from(fixture.split(",", 2)[1], "base64"));
  for (const jpeg of decoded) {
    if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg.at(-2) !== 0xff || jpeg.at(-1) !== 0xd9) {
      throw new Error("Generated JPEG fixture failed marker validation");
    }
  }
  const histogram = new LatencyHistogram();
  for (let value = 1; value <= 10_000; value += 1) histogram.observe(value);
  const rolling = new RollingWindowCounter(300);
  for (let value = 0; value < 1_000; value += 1) rolling.add(1_000_000 + value);
  console.log(JSON.stringify({
    ok: true,
    fixtureBytes: { standard: decoded[0].length, burst: decoded[1].length },
    boundedLatencyBuckets: histogram.counts.length,
    rollingWindowSlots: rolling.counts.length,
  }, null, 2));
}

if (process.argv.includes("--help")) {
  usage();
  process.exit(0);
}
if (process.argv.includes("--validate-fixtures")) {
  validateFixtures();
  process.exit(0);
}

function intEnv(name, fallback, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
  throw new Error(`${name} must be true or false`);
}

function csvEnv(name) {
  return (process.env[name] || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function validateRelativePath(path, name) {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || /[\r\n]/.test(path)) {
    throw new Error(`${name} entries must be origin-relative paths beginning with one slash`);
  }
  return path;
}

function isWithinDirectory(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function resolvePrivateArtifactRoot() {
  const testOverride = process.env.NODE_ENV === "test"
    ? process.env.LOAD_TEST_ARTIFACT_ROOT?.trim()
    : "";
  const localAppData = process.env.LOCALAPPDATA?.trim() || "";
  const rawRoot = testOverride || (localAppData ? path.join(localAppData, "SchoolPilot", "load-gates") : "");
  if (!rawRoot || !path.isAbsolute(rawRoot)) {
    throw new Error("Private load artifacts require %LOCALAPPDATA%\\SchoolPilot\\load-gates");
  }
  let root;
  try {
    root = fs.realpathSync(rawRoot);
  } catch {
    throw new Error("Private load artifact directory does not exist; run the fixture preparer first");
  }
  if (!fs.statSync(root).isDirectory() || isWithinDirectory(REPOSITORY_ROOT, root)) {
    throw new Error("Private load artifact directory must be outside this repository");
  }
  return root;
}

function validatePrivateArtifactFile(rawValue, name, artifactRoot) {
  const raw = rawValue?.trim() || "";
  if (!raw || !path.isAbsolute(raw)) {
    throw new Error(`${name} must be an absolute file path under %LOCALAPPDATA%\\SchoolPilot\\load-gates`);
  }
  let resolved;
  try {
    resolved = fs.realpathSync(raw);
  } catch {
    throw new Error(`Unable to read ${name}`);
  }
  if (!fs.statSync(resolved).isFile() || !isWithinDirectory(artifactRoot, resolved)) {
    throw new Error(`${name} must be a file under %LOCALAPPDATA%\\SchoolPilot\\load-gates`);
  }
  return resolved;
}

function decodeJwtExpiry(token) {
  const segments = typeof token === "string" ? token.split(".") : [];
  if (segments.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
    return Number.isFinite(payload?.exp) ? payload.exp * 1_000 : null;
  } catch {
    return null;
  }
}

function parseExpiry(value, label) {
  const timestamp = typeof value === "number" ? value : Date.parse(String(value || ""));
  if (!Number.isFinite(timestamp)) throw new Error(`${label} must contain a valid expiresAt timestamp`);
  return timestamp;
}

function validateExternalOutputPath(rawValue, name) {
  const raw = rawValue?.trim() || "";
  if (!raw) return "";
  if (!path.isAbsolute(raw)) {
    throw new Error(`${name} must be an absolute path outside this repository`);
  }

  const requested = path.resolve(raw);
  let parent;
  try {
    parent = fs.realpathSync(path.dirname(requested));
  } catch {
    throw new Error(`${name} parent directory must already exist`);
  }
  if (!fs.statSync(parent).isDirectory()) {
    throw new Error(`${name} parent must be a directory`);
  }

  const candidate = path.join(parent, path.basename(requested));
  let effectiveCandidate = candidate;
  if (fs.existsSync(candidate)) {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) throw new Error(`${name} must identify a file`);
    effectiveCandidate = fs.realpathSync(candidate);
  }
  if (isWithinDirectory(REPOSITORY_ROOT, effectiveCandidate)) {
    throw new Error(`${name} must be outside this repository`);
  }
  return candidate;
}

function writeAtomicJson(outputPath, value) {
  if (!outputPath) return;
  const temporaryPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, outputPath);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* best-effort cleanup */ }
    }
    try { fs.rmSync(temporaryPath, { force: true }); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("LOAD_COMMAND_BODY must be valid JSON");
  }
}

const baseUrl = (process.env.LOAD_BASE_URL || "").replace(/\/$/, "");
const manifestPathValue = process.env.LOAD_DEVICE_MANIFEST || "";
if (!baseUrl || !manifestPathValue) {
  usage();
  throw new Error("LOAD_BASE_URL and LOAD_DEVICE_MANIFEST are required");
}

let targetUrl;
try {
  targetUrl = new URL(baseUrl);
} catch {
  throw new Error("LOAD_BASE_URL must be a valid HTTP or HTTPS URL");
}
if (!["http:", "https:"].includes(targetUrl.protocol)) throw new Error("LOAD_BASE_URL must use HTTP or HTTPS");
if (targetUrl.username || targetUrl.password) throw new Error("LOAD_BASE_URL must not contain credentials");
if (targetUrl.pathname !== "/" || targetUrl.search || targetUrl.hash) {
  throw new Error("LOAD_BASE_URL must contain only the target origin, without a path, query, or fragment");
}
if (targetUrl.protocol === "http:" && !["localhost", "127.0.0.1", "::1"].includes(targetUrl.hostname)) {
  throw new Error("Non-local LOAD_BASE_URL must use HTTPS; insecure overrides are not supported");
}
const privateArtifactRoot = resolvePrivateArtifactRoot();
const manifestPath = validatePrivateArtifactFile(
  manifestPathValue,
  "LOAD_DEVICE_MANIFEST",
  privateArtifactRoot
);
const externalSummaryPath = validateExternalOutputPath(
  process.env.LOAD_EXTERNAL_SUMMARY_PATH,
  "LOAD_EXTERNAL_SUMMARY_PATH"
);
const externalProgressPath = validateExternalOutputPath(
  process.env.LOAD_EXTERNAL_PROGRESS_PATH,
  "LOAD_EXTERNAL_PROGRESS_PATH"
);
if (externalSummaryPath && externalProgressPath && externalSummaryPath === externalProgressPath) {
  throw new Error("LOAD_EXTERNAL_SUMMARY_PATH and LOAD_EXTERNAL_PROGRESS_PATH must be different files");
}

let manifestText;
try {
  manifestText = fs.readFileSync(manifestPath, "utf8");
} catch {
  throw new Error("Unable to read LOAD_DEVICE_MANIFEST");
}
let manifest;
try {
  manifest = JSON.parse(manifestText);
} catch {
  throw new Error("LOAD_DEVICE_MANIFEST must contain valid JSON");
}
if (!Array.isArray(manifest) || manifest.length === 0) {
  throw new Error("LOAD_DEVICE_MANIFEST must contain a non-empty JSON array");
}
const normalizedManifest = manifest.map((entry, index) => {
  const deviceId = typeof entry?.deviceId === "string" ? entry.deviceId.trim() : "";
  const studentToken = typeof entry?.studentToken === "string" ? entry.studentToken.trim() : "";
  if (!deviceId || !studentToken) {
    throw new Error(`LOAD_DEVICE_MANIFEST entry ${index + 1} requires non-empty deviceId and studentToken`);
  }
  return {
    deviceId,
    studentToken,
    studentId: typeof entry.studentId === "string" && entry.studentId.trim() ? entry.studentId.trim() : null,
    schoolId: typeof entry.schoolId === "string" && entry.schoolId.trim() ? entry.schoolId.trim() : null,
    classId: typeof entry.classId === "string" && entry.classId.trim() ? entry.classId.trim() : null,
    teacherId: typeof entry.teacherId === "string" && entry.teacherId.trim() ? entry.teacherId.trim() : null,
  };
});
const duplicateIds = normalizedManifest.filter((entry, index) =>
  normalizedManifest.findIndex((candidate) => candidate.deviceId === entry.deviceId) !== index
);
if (duplicateIds.length > 0) throw new Error("LOAD_DEVICE_MANIFEST contains duplicate deviceId values");

const requestedDeviceCount = intEnv("LOAD_DEVICE_COUNT", normalizedManifest.length, 1, 100_000);
if (requestedDeviceCount > normalizedManifest.length) {
  throw new Error(`LOAD_DEVICE_COUNT=${requestedDeviceCount} exceeds the ${normalizedManifest.length} manifest entries`);
}
const devices = normalizedManifest.slice(0, requestedDeviceCount);
const durationMs = intEnv("LOAD_DURATION_SECONDS", 300, 1, 24 * 60 * 60) * 1000;
const acceleratedRuntimeValue = process.env.LOAD_TEST_ACCELERATED_RUNTIME_MS?.trim() || "";
if (acceleratedRuntimeValue && process.env.NODE_ENV !== "test") {
  throw new Error("LOAD_TEST_ACCELERATED_RUNTIME_MS is available only under NODE_ENV=test");
}
if (acceleratedRuntimeValue && !["localhost", "127.0.0.1", "::1"].includes(targetUrl.hostname)) {
  throw new Error("LOAD_TEST_ACCELERATED_RUNTIME_MS is restricted to loopback targets");
}
const acceleratedRuntimeMs = acceleratedRuntimeValue
  ? intEnv("LOAD_TEST_ACCELERATED_RUNTIME_MS", 0, 2_000, 120_000)
  : 0;
const testLatencyMultiplierValue = process.env.LOAD_TEST_LATENCY_THRESHOLD_MULTIPLIER?.trim() || "";
if (testLatencyMultiplierValue && (!acceleratedRuntimeMs || process.env.NODE_ENV !== "test")) {
  throw new Error("LOAD_TEST_LATENCY_THRESHOLD_MULTIPLIER requires loopback accelerated test mode");
}
const testLatencyThresholdMultiplier = testLatencyMultiplierValue
  ? intEnv("LOAD_TEST_LATENCY_THRESHOLD_MULTIPLIER", 1, 1, 10)
  : 1;
const runtimeDurationMs = acceleratedRuntimeMs || durationMs;
const runtimeTimingScale = acceleratedRuntimeMs ? acceleratedRuntimeMs / durationMs : 1;
const progressIntervalValue = process.env.LOAD_TEST_PROGRESS_INTERVAL_MS?.trim() || "";
if (progressIntervalValue && (!acceleratedRuntimeMs || process.env.NODE_ENV !== "test")) {
  throw new Error("LOAD_TEST_PROGRESS_INTERVAL_MS requires loopback accelerated test mode");
}
const progressIntervalMs = progressIntervalValue
  ? intEnv("LOAD_TEST_PROGRESS_INTERVAL_MS", 60_000, 100, 60_000)
  : 60_000;
const requestStaggerValue = process.env.LOAD_TEST_REQUEST_STAGGER_MS?.trim() || "";
if (requestStaggerValue && !acceleratedRuntimeMs) {
  throw new Error("LOAD_TEST_REQUEST_STAGGER_MS requires loopback accelerated test mode");
}
const acceleratedRequestStaggerMs = requestStaggerValue
  ? intEnv("LOAD_TEST_REQUEST_STAGGER_MS", 0, 100, 10_000)
  : 0;
const heartbeatIntervalMs = intEnv("LOAD_HEARTBEAT_INTERVAL_MS", 10_000, 100, 60 * 60 * 1000);
const screenshotIntervalMs = intEnv("LOAD_SCREENSHOT_INTERVAL_MS", 30_000, 100, 60 * 60 * 1000);
const teacherIntervalMs = intEnv("LOAD_TEACHER_INTERVAL_MS", 5_000, 100, 60 * 60 * 1000);
const teacherTemplateIntervalMs = intEnv("LOAD_TEACHER_TEMPLATE_INTERVAL_MS", 30_000, 100, 60 * 60 * 1000);
const teacherTemplateDeviceCount = intEnv("LOAD_TEACHER_TEMPLATE_DEVICE_COUNT", 0, 0, 10_000);
const screenshotGetIntervalMs = intEnv("LOAD_SCREENSHOT_GET_INTERVAL_MS", 30_000, 100, 60 * 60 * 1000);
const commandIntervalMs = intEnv("LOAD_COMMAND_INTERVAL_MS", 30_000, 100, 60 * 60 * 1000);
const commandWarmupMs = intEnv("LOAD_COMMAND_WARMUP_MS", 30_000, 0, 10 * 60 * 1000);
const commandSettleMs = intEnv("LOAD_COMMAND_SETTLE_MS", 5_000, 0, 60_000);
const requestTimeoutMs = intEnv("LOAD_REQUEST_TIMEOUT_MS", 15_000, 100, 120_000);
const teacherHistoryWarmupMs = intEnv(
  "LOAD_TEACHER_HISTORY_WARMUP_MS",
  heartbeatIntervalMs + requestTimeoutMs,
  0,
  60 * 60 * 1000
);
const screenshotGetWarmupMs = intEnv(
  "LOAD_SCREENSHOT_GET_WARMUP_MS",
  screenshotIntervalMs + requestTimeoutMs,
  0,
  60 * 60 * 1000
);
const forceReconnectAtMs = intEnv("LOAD_FORCE_RECONNECT_AT_SECONDS", 0, 0, 24 * 60 * 60) * 1000;
const forceReconnectStaggerMs = intEnv("LOAD_FORCE_RECONNECT_STAGGER_MS", 30_000, 0, 5 * 60 * 1000);
const wsAuthTimeoutMs = intEnv("LOAD_WS_AUTH_TIMEOUT_MS", 15_000, 1_000, 60_000);
const maxTrackedCommands = intEnv("LOAD_MAX_TRACKED_COMMANDS", 2_000, 1, 100_000);
const expectedCanaryDevices = intEnv("LOAD_EXPECTED_CANARY_DEVICES", 10, 0, 10_000);
const wafDeviceLimit = intEnv("LOAD_WAF_DEVICE_LIMIT", 100_000, 1, 2_000_000_000);
const wafGeneralLimit = intEnv("LOAD_WAF_GENERAL_LIMIT", 50_000, 1, 2_000_000_000);
const shutdownGraceMs = intEnv("LOAD_SHUTDOWN_GRACE_MS", 15_000, 100, 120_000);
const requiredArtifactValidityUntil = Date.now() + durationMs + commandSettleMs + shutdownGraceMs;
for (const [index, device] of devices.entries()) {
  const expiresAt = decodeJwtExpiry(device.studentToken);
  if (expiresAt !== null && expiresAt <= requiredArtifactValidityUntil) {
    throw new Error(`LOAD_DEVICE_MANIFEST entry ${index + 1} is expired or expires before the run can finish`);
  }
}
if (forceReconnectAtMs && forceReconnectAtMs + forceReconnectStaggerMs + 30_000 > durationMs) {
  throw new Error("Forced reconnect validation requires LOAD_DURATION_SECONDS to extend at least 30s beyond reconnect time plus stagger");
}
const screenshotProfile = (process.env.LOAD_SCREENSHOT_PROFILE || "standard").toLowerCase();
if (!["standard", "burst"].includes(screenshotProfile)) {
  throw new Error("LOAD_SCREENSHOT_PROFILE must be standard or burst");
}
const screenshotBytes = intEnv(
  "LOAD_SCREENSHOT_BYTES",
  screenshotProfile === "burst" ? 50 * 1024 : 40 * 1024,
  1_024,
  64 * 1024
);
const screenshotFixture = makeJpegFixture(screenshotBytes);
const teacherAuthFileValue = process.env.LOAD_TEACHER_AUTH_FILE?.trim() || "";
const envTeacherSchoolId = process.env.LOAD_TEACHER_SCHOOL_ID?.trim() || "";
const envTeacherRole = process.env.LOAD_TEACHER_ROLE?.trim() || "teacher";

function normalizeTeacherAuth(raw, index, defaultExpiry = null) {
  const cookie = String(raw?.teacherCookie ?? raw?.cookie ?? "").trim();
  const csrf = String(raw?.csrfToken ?? raw?.csrf ?? "").trim();
  const token = String(raw?.teacherToken ?? raw?.token ?? "").trim();
  const schoolId = String(raw?.schoolId ?? envTeacherSchoolId).trim();
  const role = String(raw?.role ?? envTeacherRole).trim();
  const actorId = String(raw?.teacherId ?? raw?.userId ?? raw?.actorId ?? "").trim();
  const teachingSessionId = String(raw?.teachingSessionId ?? raw?.sessionId ?? "").trim();
  const classId = String(raw?.classId ?? raw?.groupId ?? "").trim();
  if (/[\r\n]/.test(cookie) || /[\r\n]/.test(csrf) || /[\r\n]/.test(token)) {
    throw new Error(`Teacher auth entry ${index + 1} contains a line break`);
  }
  if (/[\r\n]/.test(schoolId)) throw new Error(`Teacher auth entry ${index + 1} has an invalid schoolId`);
  if (cookie && !/(?:^|;\s*)schoolpilot\.sid=[^;]+/.test(cookie)) {
    throw new Error(`Teacher auth entry ${index + 1} must include the schoolpilot.sid session cookie`);
  }
  if (!["teacher", "school_admin", "super_admin"].includes(role)) {
    throw new Error(`Teacher auth entry ${index + 1} has an unsupported role`);
  }
  if (!cookie && !token) throw new Error(`Teacher auth entry ${index + 1} requires cookie or bearer authentication`);

  const expiryValue = raw?.expiresAt ?? defaultExpiry;
  const expiresAt = expiryValue === undefined || expiryValue === null || expiryValue === ""
    ? null
    : parseExpiry(expiryValue, `Teacher auth entry ${index + 1}`);
  if (expiresAt !== null && expiresAt <= requiredArtifactValidityUntil) {
    throw new Error(`Teacher auth entry ${index + 1} is expired or expires before the run can finish`);
  }
  const jwtExpiry = token ? decodeJwtExpiry(token) : null;
  if (jwtExpiry !== null && jwtExpiry <= requiredArtifactValidityUntil) {
    throw new Error(`Teacher auth entry ${index + 1} bearer token is expired or expires before the run can finish`);
  }

  return {
    actorId,
    teachingSessionId,
    classId,
    cookie,
    csrf,
    token,
    schoolId,
    role,
    expiresAt,
    studentIds: new Set(Array.isArray(raw?.studentIds) ? raw.studentIds.map(String) : []),
    deviceIds: new Set(Array.isArray(raw?.deviceIds) ? raw.deviceIds.map(String) : []),
  };
}

let teacherAuthInputs = [];
let teacherAuthArtifactMeta = null;
if (teacherAuthFileValue) {
  const teacherAuthPath = validatePrivateArtifactFile(
    teacherAuthFileValue,
    "LOAD_TEACHER_AUTH_FILE",
    privateArtifactRoot
  );
  let authArtifact;
  try {
    authArtifact = JSON.parse(fs.readFileSync(teacherAuthPath, "utf8"));
  } catch {
    throw new Error("LOAD_TEACHER_AUTH_FILE must contain valid JSON");
  }
  if (authArtifact && !Array.isArray(authArtifact) && typeof authArtifact === "object") {
    const artifactBaseUrl = String(authArtifact.baseUrl || "").replace(/\/$/, "");
    if (artifactBaseUrl && artifactBaseUrl !== baseUrl) {
      throw new Error("LOAD_TEACHER_AUTH_FILE was issued for a different LOAD_BASE_URL");
    }
    const deviceManifestExpiresAt = authArtifact.deviceManifestExpiresAt
      ? parseExpiry(authArtifact.deviceManifestExpiresAt, "LOAD_TEACHER_AUTH_FILE deviceManifestExpiresAt")
      : null;
    const artifactExpiresAt = authArtifact.expiresAt
      ? parseExpiry(authArtifact.expiresAt, "LOAD_TEACHER_AUTH_FILE expiresAt")
      : null;
    if (artifactExpiresAt !== null && artifactExpiresAt <= requiredArtifactValidityUntil) {
      throw new Error("Teacher auth artifact is expired or expires before the run can finish");
    }
    if (deviceManifestExpiresAt !== null && deviceManifestExpiresAt <= requiredArtifactValidityUntil) {
      throw new Error("Device manifest artifact is expired or expires before the run can finish");
    }
    teacherAuthArtifactMeta = {
      schemaVersion: Number(authArtifact.schemaVersion || 0),
      baseUrl: artifactBaseUrl,
      schoolId: String(authArtifact.schoolId || "").trim(),
      expiresAt: artifactExpiresAt,
      deviceManifestExpiresAt,
    };
  }
  const entries = Array.isArray(authArtifact)
    ? authArtifact
    : Array.isArray(authArtifact?.teacherAuth)
      ? authArtifact.teacherAuth
      : Array.isArray(authArtifact?.teachers)
        ? authArtifact.teachers
        : [authArtifact];
  if (entries.length === 0) throw new Error("LOAD_TEACHER_AUTH_FILE must contain at least one teacher auth entry");
  teacherAuthInputs = entries.map((entry, index) => normalizeTeacherAuth(entry, index, authArtifact?.expiresAt));
} else {
  const cookie = process.env.LOAD_TEACHER_COOKIE?.trim() || "";
  const csrf = process.env.LOAD_CSRF_TOKEN?.trim() || "";
  const token = process.env.LOAD_TEACHER_TOKEN?.trim() || "";
  if (cookie || token) {
    teacherAuthInputs = [normalizeTeacherAuth({
      teacherCookie: cookie,
      csrfToken: csrf,
      teacherToken: token,
      schoolId: envTeacherSchoolId,
      role: envTeacherRole,
    }, 0)];
  }
}
const hasTeacherHttpAuth = teacherAuthInputs.some((auth) => Boolean(auth.cookie || auth.token));
const authSchoolIds = new Set(teacherAuthInputs.map((auth) => auth.schoolId).filter(Boolean));
if (authSchoolIds.size > 1) throw new Error("Teacher auth entries must belong to one synthetic primary school");
const teacherSchoolId = envTeacherSchoolId || [...authSchoolIds][0] || "";
if (envTeacherSchoolId && authSchoolIds.size === 1 && !authSchoolIds.has(envTeacherSchoolId)) {
  throw new Error("LOAD_TEACHER_SCHOOL_ID does not match the teacher auth artifact");
}
const nonOwnedDeviceIds = new Set(
  teacherSchoolId
    ? devices.filter((device) => device.schoolId && device.schoolId !== teacherSchoolId).map((device) => device.deviceId)
    : []
);
const nonOwnedStudentIds = new Set(
  teacherSchoolId
    ? devices
      .filter((device) => device.schoolId && device.schoolId !== teacherSchoolId && device.studentId)
      .map((device) => device.studentId)
    : []
);
const nonOwnedIdentifiers = [...nonOwnedDeviceIds, ...nonOwnedStudentIds];
const privateResponseIdentifiers = new Set(
  devices.flatMap((device) => [device.deviceId, device.studentId].filter(Boolean))
);

function redactedEndpointClass(rawPath) {
  const pathname = rawPath.split("?", 1)[0];
  if (pathname === "/api/students-aggregated") return "GET /api/students-aggregated";
  if (/^\/api\/classpilot\/heartbeats\/[^/]+$/.test(pathname)) {
    return "GET /api/classpilot/heartbeats/{deviceId}";
  }
  if (/^\/api\/classpilot\/device\/screenshot\/[^/]+$/.test(pathname)) {
    return "GET /api/classpilot/device/screenshot/{deviceId}";
  }
  if (pathname === "/api/classpilot/commands") return "POST /api/classpilot/commands";
  const redacted = pathname.split("/").map((segment) => {
    let decoded = segment;
    try { decoded = decodeURIComponent(segment); } catch { /* keep the encoded segment */ }
    if (
      privateResponseIdentifiers.has(decoded) ||
      /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(decoded) ||
      decoded.length > 32
    ) return "{id}";
    return segment;
  }).join("/");
  return `GET ${redacted}`.slice(0, 160);
}

function containsKnownNonOwnedIdentifier(value) {
  if (typeof value !== "string") return false;
  if (nonOwnedDeviceIds.has(value) || nonOwnedStudentIds.has(value)) return true;
  if (value.length > 4_096) return false;
  return nonOwnedIdentifiers.some((identifier) => identifier.length >= 8 && value.includes(identifier));
}
const teacherPaths = [...new Set([...csvEnv("LOAD_TEACHER_PATHS"), ...csvEnv("LOAD_DASHBOARD_PATHS")])]
  .map((path) => validateRelativePath(path, "teacher path"));
if (teacherPaths.some((path) => path.toLowerCase().includes("screenshot"))) {
  throw new Error("Screenshot GET polling must use LOAD_SCREENSHOT_GET_PATH_TEMPLATE so cold-cache warmup is enforced");
}
const screenshotGetTemplate = process.env.LOAD_SCREENSHOT_GET_PATH_TEMPLATE?.trim() || "";
if (screenshotGetTemplate) {
  validateRelativePath(screenshotGetTemplate, "LOAD_SCREENSHOT_GET_PATH_TEMPLATE");
  if (!screenshotGetTemplate.includes("{deviceId}")) {
    throw new Error("LOAD_SCREENSHOT_GET_PATH_TEMPLATE must contain {deviceId}");
  }
}
const hasTeacherTemplatePaths = teacherPaths.some((path) =>
  path.includes("{deviceId}") || path.includes("{studentId}")
);
// StudentTile mounts its history and screenshot queries together. Once the
// initial screenshot POST window is safely warm, align both 30-second poll
// phases so each teacher cohort exercises the browser's combined tile burst.
const teacherTileCohortWarmupMs = hasTeacherTemplatePaths && screenshotGetTemplate
  ? Math.max(teacherHistoryWarmupMs, screenshotGetWarmupMs)
  : teacherHistoryWarmupMs;
const screenshotCohortWarmupMs = hasTeacherTemplatePaths
  ? teacherTileCohortWarmupMs
  : screenshotGetWarmupMs;
const commandEndpoint = process.env.LOAD_COMMAND_ENDPOINT?.trim() || "";
if (commandEndpoint) validateRelativePath(commandEndpoint, "LOAD_COMMAND_ENDPOINT");
const configuredTeacherEndpointClasses = new Set([
  ...teacherPaths.map(redactedEndpointClass),
  ...(screenshotGetTemplate ? [redactedEndpointClass(screenshotGetTemplate)] : []),
  ...(commandEndpoint ? [redactedEndpointClass(commandEndpoint)] : []),
]);
const enforceThresholds = boolEnv("LOAD_ENFORCE_THRESHOLDS");
const gateProfile = (process.env.LOAD_GATE_PROFILE || (enforceThresholds ? "launch" : "partial")).toLowerCase();
if (!["launch", "partial"].includes(gateProfile)) {
  throw new Error("LOAD_GATE_PROFILE must be launch or partial");
}
const isLaunchGate = enforceThresholds && gateProfile === "launch";
const commandBodyValue = process.env.LOAD_COMMAND_BODY?.trim() || "";
const commandBodiesFile = process.env.LOAD_COMMAND_BODIES_FILE?.trim() || "";
if (commandBodyValue && commandBodiesFile) {
  throw new Error("Configure LOAD_COMMAND_BODY or LOAD_COMMAND_BODIES_FILE, not both");
}
let commandBodies = [];
if (commandBodiesFile) {
  const commandBodiesPath = validatePrivateArtifactFile(
    commandBodiesFile,
    "LOAD_COMMAND_BODIES_FILE",
    privateArtifactRoot
  );
  let commandBodiesText;
  try {
    commandBodiesText = fs.readFileSync(commandBodiesPath, "utf8");
  } catch {
    throw new Error("Unable to read LOAD_COMMAND_BODIES_FILE");
  }
  try {
    const parsed = JSON.parse(commandBodiesText);
    if (!Array.isArray(parsed)) throw new Error("top-level value must be an array");
    commandBodies = parsed;
  } catch {
    throw new Error("LOAD_COMMAND_BODIES_FILE must contain a valid JSON array");
  }
} else if (commandBodyValue) {
  commandBodies = [safeJson(commandBodyValue)];
}
for (const [index, body] of commandBodies.entries()) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`Command body ${index + 1} must be a JSON object`);
  }
  if (typeof body.teachingSessionId !== "string" || !body.teachingSessionId.trim()) {
    throw new Error(`Command body ${index + 1} requires teachingSessionId`);
  }
  if (typeof body.commandType !== "string" || !body.commandType.trim()) {
    throw new Error(`Command body ${index + 1} requires commandType`);
  }
}
const expectedClassBodies = intEnv("LOAD_EXPECTED_CLASS_BODIES", isLaunchGate ? 20 : 1, 1, 1_000);
const expectedTargetsPerClass = intEnv("LOAD_EXPECTED_TARGETS_PER_CLASS", isLaunchGate ? 40 : 1, 1, 100_000);
const commandSessionCount = new Set(commandBodies.map((body) => body.teachingSessionId.trim())).size;
if (isLaunchGate && commandBodies.length > 0) {
  if (commandSessionCount < expectedClassBodies) {
    throw new Error(`Launch gate requires at least ${expectedClassBodies} unique teachingSessionId command bodies`);
  }
  if (commandBodies.some((body) => body.targetScope !== "class")) {
    throw new Error("Launch gate command bodies must use targetScope=class");
  }
}
if ((teacherPaths.length > 0 || screenshotGetTemplate || commandEndpoint || commandBodies.length > 0) && !hasTeacherHttpAuth) {
  throw new Error("LOAD_TEACHER_COOKIE or LOAD_TEACHER_TOKEN is required for teacher/dashboard HTTP traffic");
}
if (teacherSchoolId && teacherAuthInputs.length > 0 && teacherAuthInputs.some((auth) => !auth.token)) {
  throw new Error("Every teacher auth entry requires a bearer token when staff WebSocket validation is enabled");
}
if ((commandEndpoint && commandBodies.length === 0) || (!commandEndpoint && commandBodies.length > 0)) {
  throw new Error("LOAD_COMMAND_ENDPOINT and a command body/file must be configured together");
}
if (commandEndpoint && teacherAuthInputs.some((auth) => auth.cookie && !auth.csrf)) {
  throw new Error("Every cookie-authenticated command actor requires a CSRF token");
}
if (isLaunchGate) {
  const hasDashboardPath = teacherPaths.some((path) =>
    !path.includes("screenshot") && !path.includes("{deviceId}") && !path.includes("{studentId}")
  );
  const hasHistoryPath = teacherPaths.some((path) =>
    !path.includes("screenshot") && (path.includes("{deviceId}") || path.includes("{studentId}"))
  );
  const hasDeviceHistoryPath = teacherPaths.some((path) =>
    !path.includes("screenshot") && path.includes("{deviceId}")
  );
  if (!teacherAuthFileValue) {
    throw new Error("Launch gate requires LOAD_TEACHER_AUTH_FILE with 20 distinct synthetic teacher sessions");
  }
  if (
    teacherAuthArtifactMeta?.schemaVersion !== 2 ||
    !teacherAuthArtifactMeta.baseUrl ||
    !teacherAuthArtifactMeta.schoolId ||
    !teacherAuthArtifactMeta.expiresAt ||
    !teacherAuthArtifactMeta.deviceManifestExpiresAt
  ) {
    throw new Error("Launch gate requires the schemaVersion 2 teacher auth artifact with target and expiry metadata");
  }
  if (teacherAuthArtifactMeta.schoolId !== teacherSchoolId) {
    throw new Error("Launch gate teacher auth artifact schoolId does not match its teacher entries");
  }
  if (teacherAuthInputs.some((auth) => !auth.cookie || !auth.csrf || !auth.token || !auth.schoolId || !auth.expiresAt)) {
    throw new Error("Launch gate teacher auth entries require cookie, CSRF, bearer token, schoolId, and expiresAt");
  }
  if (!teacherSchoolId) {
    throw new Error("Launch gate teacher auth entries require one primary schoolId");
  }
  if (!externalSummaryPath || !externalProgressPath) {
    throw new Error("Launch gate requires LOAD_EXTERNAL_SUMMARY_PATH and LOAD_EXTERNAL_PROGRESS_PATH outside this repository");
  }
  if (!hasDashboardPath || !hasHistoryPath) {
    throw new Error("Launch gate requires both dashboard and per-device/per-student history paths");
  }
  if (!hasDeviceHistoryPath) {
    const primaryDevices = devices.filter((device) => device.schoolId === teacherSchoolId);
    const primaryStudentsWithIds = primaryDevices.filter((device) => Boolean(device.studentId)).length;
    const requiredStudentIds = teacherTemplateDeviceCount === 0
      ? primaryDevices.length
      : Math.min(teacherTemplateDeviceCount, primaryDevices.length);
    if (primaryStudentsWithIds < requiredStudentIds) {
      throw new Error("Launch gate student history templates require studentId values in the selected primary manifest entries");
    }
  }
  if (!screenshotGetTemplate) {
    throw new Error("Launch gate requires LOAD_SCREENSHOT_GET_PATH_TEMPLATE");
  }
  if (!commandEndpoint || commandSessionCount < expectedClassBodies) {
    throw new Error(`Launch gate requires a command endpoint and ${expectedClassBodies} unique class-session bodies`);
  }
  if (!commandBodiesFile) {
    throw new Error("Launch gate requires LOAD_COMMAND_BODIES_FILE under the private load-gates directory");
  }
  if (teacherAuthInputs.length !== 20) {
    throw new Error("Launch gate requires exactly 20 teacher auth entries");
  }
  if (teacherAuthInputs.some((auth) => auth.role !== "teacher" || auth.studentIds.size !== 40)) {
    throw new Error("Launch gate requires 20 teacher actors each mapped to exactly 40 class students");
  }
  const distinctTeacherIds = new Set(teacherAuthInputs.map((auth) => auth.actorId).filter(Boolean));
  const authSessionIds = new Set(teacherAuthInputs.map((auth) => auth.teachingSessionId).filter(Boolean));
  const mappedStudentIds = teacherAuthInputs.flatMap((auth) => [...auth.studentIds]);
  if (distinctTeacherIds.size !== 20 || authSessionIds.size !== 20) {
    throw new Error("Launch gate requires 20 distinct teacherId and teachingSessionId auth mappings");
  }
  if (new Set(mappedStudentIds).size !== 800) {
    throw new Error("Launch gate teacher auth mappings must cover 800 disjoint class students");
  }
  if (commandBodies.some((body) => !authSessionIds.has(body.teachingSessionId.trim()))) {
    throw new Error("Every launch command body must map to its teacher auth teachingSessionId");
  }
  if (devices.some((device) => !device.schoolId)) {
    throw new Error("Launch gate requires schoolId on every selected device manifest entry");
  }
  const configuredCanaries = devices.filter((device) => device.schoolId !== teacherSchoolId).length;
  const configuredPrimaryDevices = devices.filter((device) => device.schoolId === teacherSchoolId).length;
  const canarySchoolIds = new Set(
    devices.filter((device) => device.schoolId !== teacherSchoolId).map((device) => device.schoolId)
  );
  const expectedDurationSeconds = configuredPrimaryDevices === 500
    ? 30 * 60
    : configuredPrimaryDevices === 800
      ? (durationMs === 8 * 60 * 60 * 1000 ? 8 * 60 * 60 : 90 * 60)
      : configuredPrimaryDevices === 1_000
        ? 10 * 60
        : 0;
  const expectedStageTargets = configuredPrimaryDevices === 500 ? 25 : 40;
  const expectedScreenshotBytes = configuredPrimaryDevices === 1_000 ? 50 * 1024 : 40 * 1024;

  if (!expectedDurationSeconds || ![510, 810, 1_010].includes(devices.length)) {
    throw new Error("Launch gate requires exactly 500, 800, or 1,000 primary devices plus 10 canaries");
  }
  if (configuredCanaries !== 10 || expectedCanaryDevices !== 10 || canarySchoolIds.size !== 1) {
    throw new Error("Launch gate requires exactly 10 devices from one declared second-school canary");
  }
  if (devices.slice(0, 10).some((device) => device.schoolId === teacherSchoolId)) {
    throw new Error("Launch gate requires the first 10 selected manifest entries to be the second-school canaries");
  }
  if (expectedClassBodies !== 20 || commandBodies.length !== 20 || commandSessionCount !== 20) {
    throw new Error("Launch gate requires exactly 20 unique class-session command bodies");
  }
  if (expectedTargetsPerClass !== expectedStageTargets) {
    throw new Error(`Launch gate requires LOAD_EXPECTED_TARGETS_PER_CLASS=${expectedStageTargets} for this stage`);
  }
  if (durationMs !== expectedDurationSeconds * 1000) {
    throw new Error(`Launch gate requires LOAD_DURATION_SECONDS=${expectedDurationSeconds} for this stage`);
  }
  if (
    heartbeatIntervalMs !== 10_000 ||
    screenshotIntervalMs !== 30_000 ||
    teacherIntervalMs !== 5_000 ||
    teacherTemplateIntervalMs !== 30_000 ||
    screenshotGetIntervalMs !== 30_000
  ) {
    throw new Error("Launch gate requires the documented 10s heartbeat, 5s dashboard, and 30s screenshot/history intervals");
  }
  if (teacherTemplateDeviceCount !== 0) {
    throw new Error("Launch gate requires LOAD_TEACHER_TEMPLATE_DEVICE_COUNT=0 so every primary tile is exercised");
  }
  if (teacherHistoryWarmupMs < heartbeatIntervalMs + requestTimeoutMs) {
    throw new Error("Launch gate teacher history warmup must cover initial heartbeat jitter plus request timeout");
  }
  if (screenshotGetWarmupMs < screenshotIntervalMs + requestTimeoutMs) {
    throw new Error("Launch gate screenshot GET warmup must cover the initial upload stagger plus request timeout");
  }
  if (wafDeviceLimit !== 100_000 || wafGeneralLimit !== 50_000) {
    throw new Error("Launch gate WAF limits must remain 100000 device-ingest and 50000 general API requests/5m");
  }
  if (screenshotBytes !== expectedScreenshotBytes) {
    throw new Error(`Launch gate requires ${expectedScreenshotBytes} decoded screenshot bytes for this stage`);
  }
  if (forceReconnectAtMs === 0) {
    throw new Error("Launch gate requires LOAD_FORCE_RECONNECT_AT_SECONDS so every device exercises reconnect recovery");
  }
  const requiredCommandTargets = expectedClassBodies * expectedTargetsPerClass;
  if (requiredCommandTargets > configuredPrimaryDevices) {
    throw new Error(`Launch gate command contract requires ${requiredCommandTargets} primary targets but only ${configuredPrimaryDevices} are selected`);
  }
  const classMappedDevices = devices
    .filter((entry) => entry.schoolId === teacherSchoolId)
    .slice(0, Math.min(800, configuredPrimaryDevices));
  for (const device of classMappedDevices) {
    const owners = teacherAuthInputs.filter((auth) => deviceBelongsToTeacherAuth(device, auth));
    if (owners.length !== 1) {
      throw new Error("Launch gate requires every selected primary device to map to exactly one teacher auth entry");
    }
  }
  for (const body of commandBodies) {
    const expectedDeviceIds = expectedCommandDeviceIds(body);
    if (!expectedDeviceIds || expectedDeviceIds.size !== expectedTargetsPerClass) {
      throw new Error("Each launch command body must map to exactly the reviewed selected-device class cohort");
    }
  }
  if (devices.some((device) => decodeJwtExpiry(device.studentToken) === null)) {
    throw new Error("Launch gate requires exp-bearing device tokens so artifact expiry can be verified");
  }
}
const sharedIpLabel = process.env.LOAD_SHARED_IP_LABEL?.trim() || "single-generator-egress";
const stage = process.env.LOAD_STAGE?.trim() || `devices-${devices.length}-${Math.round(durationMs / 1000)}s`;
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(stage)) {
  throw new Error("LOAD_STAGE must be 1-128 letters, numbers, dots, underscores, or hyphens");
}
const wsUrl = `${baseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:")}/ws`;

const intervals = new Set();
const timeouts = new Set();
const sockets = new Set();
const inFlight = new Set();
const pendingRequests = new Map();
const histograms = new Map();
const teacherEndpointHistograms = new Map();
const fiveMinuteRequests = new RollingWindowCounter(300);
const fiveMinuteDeviceIngestRequests = new RollingWindowCounter(300);
const fiveMinuteGeneralApiRequests = new RollingWindowCounter(300);
const reconnectLatency = new LatencyHistogram();
const authenticatedDeviceIds = new Set();
const commandEntries = new Map();
const configuredRunId = process.env.LOAD_RUN_ID?.trim() || "";
if (configuredRunId && (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(configuredRunId) || configuredRunId.endsWith("."))) {
  throw new Error("LOAD_RUN_ID must be a filename-safe 1-128 character rollout identifier");
}
const runId = configuredRunId || randomUUID();
let stoppingTraffic = false;
let shutdownPromise = null;
let runStartedAt = Date.now();
let trafficStoppedAt = 0;
let activeCommandRequestStartedAt = 0;
let commandRequestInFlight = false;
let fatalGate = null;
let nextRequestId = 1;
let finalSocketGate = null;
let progressDescriptor = null;
let lastProgressAt = 0;
let lastProgressCounters = null;
let progressFinalized = !externalProgressPath;

const counters = {
  heartbeat: 0,
  screenshotPost: 0,
  screenshotGet: 0,
  screenshotGetSuccess: 0,
  teacher: 0,
  command: 0,
  httpTotal: 0,
  http2xx: 0,
  http3xx: 0,
  http4xx: 0,
  http5xx: 0,
  httpErrors: 0,
  unfinishedHttpRequests: 0,
  responseParseErrors: 0,
  responseBytes: 0,
  wafDeviceIngestRequests: 0,
  wafGeneralApiRequests: 0,
  wafOutsideApiRequests: 0,
  wsOpened: 0,
  wsAuthenticated: 0,
  wsAuthErrors: 0,
  wsUnexpectedClosed: 0,
  wsIntentionalClosed: 0,
  wsErrors: 0,
  wsReconnectRequested: 0,
  wsReconnectCompleted: 0,
  wsReconnectLate: 0,
  forcedReconnectRequested: 0,
  forcedReconnectCompleted: 0,
  forcedReconnectSkippedUnauthenticated: 0,
  teacherWsAuthenticated: 0,
  teacherWsAuthErrors: 0,
  teacherWsUnexpectedClosed: 0,
  teacherResponseValidationErrors: 0,
  tenantIsolationProbeAttempts: 0,
  tenantIsolationProbePassed: 0,
  tenantIsolationProbeFailed: 0,
  commandResponsesTracked: 0,
  commandResponsesInvalid: 0,
  commandMessagesReceived: 0,
  commandReceivedAcksSent: 0,
  commandCompletedAcksSent: 0,
  commandUpdatesObserved: 0,
  commandTrackingOverflow: 0,
  commandTargetCountMismatch: 0,
  commandUnexpectedTargetDeliveries: 0,
  commandDuplicateDeliveries: 0,
  crossSchoolCommandDeliveries: 0,
  crossSchoolHttpResponses: 0,
  tenantValidatedResponses: 0,
};
const statusCodes = Object.create(null);

function progressRecord(event) {
  const now = Date.now();
  const cumulativeCounters = {
    ...counters,
    status403: statusCodes[403] || 0,
    status429: statusCodes[429] || 0,
  };
  const counterDeltas = Object.fromEntries(
    Object.entries(cumulativeCounters).map(([name, value]) => [
      name,
      value - (lastProgressCounters?.[name] || 0),
    ])
  );
  const trackedCommands = [...commandEntries.values()].filter((entry) => entry.createdByHarness);
  return {
    schemaVersion: 1,
    type: event === "fatal" ? "fatal_gate" : "progress",
    event,
    runId,
    stage,
    timestamp: new Date(now).toISOString(),
    elapsedSeconds: Number((Math.max(0, now - runStartedAt) / 1000).toFixed(1)),
    deltaWindowSeconds: Number((Math.max(0, now - (lastProgressAt || runStartedAt)) / 1000).toFixed(1)),
    devices: devices.length,
    stoppingTraffic,
    cumulativeCounters,
    counterDeltas,
    statusCodes: { ...statusCodes },
    latency: {
      byKind: Object.fromEntries([...histograms.entries()].map(([kind, value]) => [kind, value.summary()])),
      teacherEndpoints: Object.fromEntries(
        [...teacherEndpointHistograms.entries()].map(([endpoint, value]) => [endpoint, value.summary()])
      ),
      reconnect: reconnectLatency.summary(),
    },
    websocket: {
      uniqueDevicesAuthenticated: authenticatedDeviceIds.size,
      currentlyAuthenticated: deviceStates.filter((state) => state.authenticated).length,
      authErrors: counters.wsAuthErrors,
      unexpectedCloses: counters.wsUnexpectedClosed,
      crossSchoolCommandDeliveries: counters.crossSchoolCommandDeliveries,
      teacherAuthenticated: counters.teacherWsAuthenticated,
      teacherCurrentlyAuthenticated: teacherSocketStates.filter((state) => state.authenticated).length,
      teacherUnexpectedCloses: counters.teacherWsUnexpectedClosed,
    },
    reconnect: {
      requested: counters.wsReconnectRequested,
      completed: counters.wsReconnectCompleted,
      late: counters.wsReconnectLate,
      forcedRequested: counters.forcedReconnectRequested,
      forcedCompleted: counters.forcedReconnectCompleted,
    },
    commands: {
      configuredBodies: commandBodies.length,
      tracked: trackedCommands.length,
      expectedTargets: trackedCommands.reduce((total, entry) => total + entry.expected, 0),
      messagesReceived: counters.commandMessagesReceived,
      completedAcksSent: counters.commandCompletedAcksSent,
      responseValidationErrors: counters.commandResponsesInvalid + counters.commandTrackingOverflow,
    },
    tenantIsolation: {
      knownNonOwnedDeviceIds: nonOwnedDeviceIds.size,
      knownNonOwnedStudentIds: nonOwnedStudentIds.size,
      probeAttempts: counters.tenantIsolationProbeAttempts,
      probePassed: counters.tenantIsolationProbePassed,
      probeFailed: counters.tenantIsolationProbeFailed,
      responseValidationErrors: counters.teacherResponseValidationErrors,
    },
    fatalGate: fatalGate ? { ...fatalGate, reasonCodes: [...fatalGate.reasonCodes] } : null,
  };
}

function appendProgress(event) {
  if (progressDescriptor === null) return;
  const record = progressRecord(event);
  const line = `${JSON.stringify(record)}\n`;
  fs.writeSync(progressDescriptor, line, null, "utf8");
  fs.fsyncSync(progressDescriptor);
  lastProgressAt = Date.parse(record.timestamp);
  lastProgressCounters = { ...record.cumulativeCounters };
}

function triggerFatalGate(reason, details = {}, writeProgress = true) {
  if (fatalGate) {
    if (!fatalGate.reasonCodes.includes(reason)) fatalGate.reasonCodes.push(reason);
    return;
  }
  fatalGate = {
    reasonCodes: [reason],
    observedAt: new Date().toISOString(),
    ...details,
  };
  process.exitCode = 1;
  stoppingTraffic = true;
  trafficStoppedAt ||= Date.now();
  if (writeProgress) {
    try { appendProgress("fatal"); } catch { /* final summary still records the fatal gate */ }
  }
  void shutdown(`fatal-${reason}`);
}

function appendProgressOrFail(event) {
  try {
    if (event === "final" && process.env.NODE_ENV === "test" && boolEnv("LOAD_TEST_FAIL_FINAL_PROGRESS")) {
      throw new Error("injected final progress failure");
    }
    appendProgress(event);
    return true;
  } catch {
    triggerFatalGate("progress-output-error", { source: "progress" }, false);
    return false;
  }
}

function later(callback, delayMs, { scale = true } = {}) {
  let timer;
  const effectiveDelayMs = scale && acceleratedRuntimeMs
    ? Math.max(1, Math.round(delayMs * runtimeTimingScale))
    : delayMs;
  timer = setTimeout(() => {
    timeouts.delete(timer);
    callback();
  }, effectiveDelayMs);
  timeouts.add(timer);
  return timer;
}

function cancelLater(timer) {
  if (!timer) return;
  clearTimeout(timer);
  timeouts.delete(timer);
}

function every(callback, intervalMs) {
  const timer = setInterval(callback, intervalMs);
  intervals.add(timer);
  return timer;
}

function workloadEvery(callback, intervalMs) {
  if (acceleratedRuntimeMs) return null;
  return every(callback, intervalMs);
}

function staggeredDelay(index, count, productionWindowMs) {
  if (count <= 1) return 0;
  const windowMs = acceleratedRequestStaggerMs || productionWindowMs;
  return Math.floor((index / count) * windowMs);
}

function scheduleStaggered(jobs, productionWindowMs, emit) {
  const scaleWithAcceleratedRuntime = !acceleratedRequestStaggerMs;
  jobs.forEach((job, index) => {
    const delayMs = staggeredDelay(index, jobs.length, productionWindowMs);
    if (delayMs > 0) later(() => emit(job), delayMs, { scale: scaleWithAcceleratedRuntime });
    else emit(job);
  });
}

function tracked(promise) {
  inFlight.add(promise);
  void promise.finally(() => inFlight.delete(promise));
  return promise;
}

function histogram(kind) {
  let value = histograms.get(kind);
  if (!value) {
    value = new LatencyHistogram();
    histograms.set(kind, value);
  }
  return value;
}

function teacherEndpointHistogram(endpointClass) {
  let value = teacherEndpointHistograms.get(endpointClass);
  if (!value) {
    value = new LatencyHistogram();
    teacherEndpointHistograms.set(endpointClass, value);
  }
  return value;
}

async function drainResponse(response, capture) {
  if (!response.body) return { text: "", bytes: 0, truncated: false };
  const chunks = [];
  let capturedBytes = 0;
  let bytes = 0;
  let truncated = false;
  const consume = (value) => {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
    bytes += value.byteLength;
    if (!capture || capturedBytes >= MAX_RESPONSE_CAPTURE_BYTES) {
      if (capture) truncated = true;
      return;
    }
    const remaining = MAX_RESPONSE_CAPTURE_BYTES - capturedBytes;
    const slice = buffer.byteLength <= remaining ? buffer : buffer.subarray(0, remaining);
    chunks.push(Buffer.from(slice));
    capturedBytes += slice.byteLength;
    if (slice.byteLength < buffer.byteLength) truncated = true;
  };
  if (typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      consume(value);
    }
  } else {
    for await (const value of response.body) consume(value);
  }
  return { text: capture ? Buffer.concat(chunks).toString("utf8") : "", bytes, truncated };
}

function observeHttp(record, status, error, responseBytes = 0) {
  if (!record.countWorkload) {
    if (!record.probeObserved) {
      record.probeObserved = true;
      if (!error && status === record.probeExpectedStatus) {
        counters.tenantIsolationProbePassed += 1;
      } else {
        counters.tenantIsolationProbeFailed += 1;
        triggerFatalGate("tenant-isolation-probe-failed", { kind: "tenant-isolation-probe" });
      }
    }
    return;
  }
  const latencyMs = Date.now() - record.startedAt;
  const failed = Boolean(error) || status >= 400 || status === 0;
  histogram(record.kind).observe(latencyMs, failed);
  if (record.endpointClass) teacherEndpointHistogram(record.endpointClass).observe(latencyMs, failed);
  counters.responseBytes += responseBytes;
  if (status >= 200 && status < 300) counters.http2xx += 1;
  else if (status >= 300 && status < 400) counters.http3xx += 1;
  else if (status >= 400 && status < 500) counters.http4xx += 1;
  else if (status >= 500) counters.http5xx += 1;
  if (status > 0) statusCodes[status] = (statusCodes[status] || 0) + 1;
  if (error) counters.httpErrors += 1;
}

function responseIsolationViolation(value, expectedSchoolId) {
  if (!value || typeof value !== "object" || !expectedSchoolId) return null;
  const stack = [value];
  const seen = new Set();
  let visited = 0;
  while (stack.length > 0 && visited < 100_000) {
    const current = stack.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    visited += 1;
    if (Array.isArray(current)) {
      for (const child of current) {
        if (containsKnownNonOwnedIdentifier(child)) {
          return "known-non-owned-identifier";
        }
        if (child && typeof child === "object") stack.push(child);
      }
      continue;
    }
    for (const [key, child] of Object.entries(current)) {
      const normalizedKey = key.replaceAll("_", "").toLowerCase();
      if (normalizedKey === "schoolid" && typeof child === "string" && child !== expectedSchoolId) {
        return "foreign-school-id";
      }
      if (containsKnownNonOwnedIdentifier(child)) {
        return "known-non-owned-identifier";
      }
      if (child && typeof child === "object") stack.push(child);
    }
  }
  return null;
}

function teacherResponseValidationError(endpointClass, json, expectedDeviceId, expectedStudentIds) {
  if (endpointClass === "GET /api/students-aggregated") {
    if (!Array.isArray(json) || json.length === 0) return "aggregated-empty-or-not-array";
    if (json.some((student) => !student || typeof student !== "object" || typeof student.studentId !== "string" || !student.studentId)) {
      return "aggregated-invalid-student";
    }
    if (expectedStudentIds?.size > 0) {
      const actualStudentIds = json.map((student) => student.studentId);
      const actualUniqueIds = new Set(actualStudentIds);
      if (
        actualUniqueIds.size !== actualStudentIds.length ||
        actualUniqueIds.size !== expectedStudentIds.size ||
        actualStudentIds.some((studentId) => !expectedStudentIds.has(studentId))
      ) {
        return "aggregated-class-scope-mismatch";
      }
    }
    return null;
  }
  if (endpointClass === "GET /api/classpilot/heartbeats/{deviceId}") {
    if (!json || typeof json !== "object" || !Array.isArray(json.heartbeats) || json.heartbeats.length === 0) {
      return "history-empty-or-invalid";
    }
    if (json.heartbeats.some((heartbeat) =>
      !heartbeat ||
      typeof heartbeat !== "object" ||
      (expectedDeviceId && heartbeat.deviceId !== expectedDeviceId)
    )) {
      return "history-invalid-heartbeat";
    }
  }
  return null;
}

function finalizePendingRequest(record, status, error, responseBytes = 0) {
  if (record.finalized) return false;
  record.finalized = true;
  pendingRequests.delete(record.id);
  observeHttp(record, status, error, responseBytes);
  return true;
}

async function request(path, {
  method = "GET",
  token = "",
  cookie = "",
  csrf = "",
  body,
  kind,
  parseJson = false,
  expectedSchoolId = "",
  schoolIdHeader = "",
  endpointClass = "",
  countWorkload = true,
  probeExpectedStatus = null,
  expectedDeviceId = "",
  expectedStudentIds = null,
}) {
  const startedAt = Date.now();
  if (countWorkload) counters.httpTotal += 1;
  else counters.tenantIsolationProbeAttempts += 1;
  fiveMinuteRequests.add(startedAt);
  const pathname = path.split("?", 1)[0];
  const isDeviceIngest = method === "POST" && /^\/api\/(?:classpilot\/)?device\/(?:heartbeat|screenshot)$/.test(pathname);
  if (isDeviceIngest) {
    counters.wafDeviceIngestRequests += 1;
    fiveMinuteDeviceIngestRequests.add(startedAt);
  } else if (pathname.startsWith("/api/")) {
    counters.wafGeneralApiRequests += 1;
    fiveMinuteGeneralApiRequests.add(startedAt);
  } else {
    counters.wafOutsideApiRequests += 1;
  }
  let status = 0;
  const controller = new AbortController();
  const record = {
    id: nextRequestId++,
    kind,
    startedAt,
    controller,
    finalized: false,
    countWorkload,
    probeExpectedStatus,
    probeObserved: false,
    endpointClass,
    expectedDeviceId,
    expectedStudentIds,
  };
  pendingRequests.set(record.id, record);
  const requestTimeout = setTimeout(() => controller.abort(new Error("request timeout")), requestTimeoutMs);
  requestTimeout.unref?.();
  try {
    const headers = { "user-agent": LOAD_GATE_USER_AGENT };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    if (cookie) headers.cookie = cookie;
    if (csrf) headers["x-csrf-token"] = csrf;
    if (schoolIdHeader) headers["x-school-id"] = schoolIdHeader;
    const response = await ipv4Request(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    status = response.status;
    if (countWorkload && (status === 403 || status === 429)) {
      triggerFatalGate(`valid-http-${status}`, { status, kind });
    }
    const inspectJson = parseJson || Boolean(expectedSchoolId) || kind === "screenshotGet" || Boolean(endpointClass);
    const drained = await drainResponse(response, inspectJson);
    let json = null;
    if (inspectJson && drained.text) {
      if (drained.truncated) {
        counters.responseParseErrors += 1;
      } else {
        try {
          json = JSON.parse(drained.text);
        } catch {
          counters.responseParseErrors += 1;
        }
      }
    }
    finalizePendingRequest(record, status, null, drained.bytes);
    if (
      kind === "screenshotGet" &&
      response.ok &&
      typeof json?.screenshot === "string" &&
      json.screenshot.startsWith("data:image/jpeg;base64,")
    ) {
      counters.screenshotGetSuccess += 1;
    }
    if (expectedSchoolId && json !== null) {
      counters.tenantValidatedResponses += 1;
      const isolationViolation = responseIsolationViolation(json, expectedSchoolId);
      if (isolationViolation) {
        counters.crossSchoolHttpResponses += 1;
        triggerFatalGate("cross-school-http-response", { kind: "http-tenant-isolation", reason: isolationViolation });
      }
    }
    if (countWorkload && response.ok && endpointClass) {
      const validationError = teacherResponseValidationError(
        endpointClass,
        json,
        expectedDeviceId,
        expectedStudentIds
      );
      if (validationError) {
        counters.teacherResponseValidationErrors += 1;
        triggerFatalGate("invalid-teacher-response", { kind: endpointClass, reason: validationError });
      }
    }
    return { status, ok: response.ok, json };
  } catch (error) {
    finalizePendingRequest(record, status, error);
    return { status, ok: false, json: null };
  } finally {
    clearTimeout(requestTimeout);
  }
}

function issue(path, options) {
  return tracked(request(path, options));
}

function teacherHttpAuth(auth = teacherAuthInputs[0], { preferBearer = false } = {}) {
  if (!auth) return {};
  if (preferBearer && auth.token) {
    return { token: auth.token, expectedSchoolId: auth.schoolId, schoolIdHeader: auth.schoolId };
  }
  // When a cookie is provided, intentionally omit Bearer auth so the run
  // exercises browser session identity, CSRF, and session-keyed rate limiting.
  return auth.cookie
    ? { cookie: auth.cookie, csrf: auth.csrf, expectedSchoolId: auth.schoolId, schoolIdHeader: auth.schoolId }
    : { token: auth.token, expectedSchoolId: auth.schoolId, schoolIdHeader: auth.schoolId };
}

function teacherAuthForCommand(body, fallbackIndex = 0) {
  return teacherAuthInputs.find((auth) => auth.teachingSessionId === body.teachingSessionId) ||
    teacherAuthInputs[fallbackIndex % Math.max(1, teacherAuthInputs.length)];
}

function deviceBelongsToTeacherAuth(device, auth) {
  if (!auth) return false;
  return auth.deviceIds.has(device.deviceId) ||
    (device.studentId && auth.studentIds.has(device.studentId)) ||
    (device.teacherId && auth.actorId === device.teacherId) ||
    (device.classId && auth.classId === device.classId);
}

function expectedCommandDeviceIds(body) {
  const auth = teacherAuthInputs.find((candidate) => candidate.teachingSessionId === body.teachingSessionId);
  if (!auth) return null;
  return new Set(
    devices
      .filter((device) => device.schoolId === auth.schoolId && deviceBelongsToTeacherAuth(device, auth))
      .map((device) => device.deviceId)
  );
}

function getCommandEntry(commandId) {
  let entry = commandEntries.get(commandId);
  if (entry) return entry;
  if (commandEntries.size >= maxTrackedCommands) {
    counters.commandTrackingOverflow += 1;
    return null;
  }
  entry = {
    commandId,
    createdByHarness: false,
    classBodyIndex: null,
    requestStartedAt: activeCommandRequestStartedAt,
    expected: 0,
    messagesReceived: 0,
    messagesWithin2s: 0,
    receivedAcksSent: 0,
    completedAcksSent: 0,
    completedAcksWithin5s: 0,
    serverReceived: 0,
    serverCompleted: 0,
    serverReceivedWithin2s: 0,
    serverCompletedWithin5s: 0,
    deliveredDeviceIds: new Set(),
    expectedDeviceIds: null,
  };
  commandEntries.set(commandId, entry);
  return entry;
}

function heartbeatBody(device) {
  // Keep capacity tests on deterministic local classifications. Unknown hosts
  // would fan out to Anthropic at startup/cache expiry and distort both cost
  // and application latency under the synthetic burst.
  const domains = ["docs.google.com", "drive.google.com", "classroom.google.com"];
  const domain = domains[Math.floor(Math.random() * domains.length)];
  return {
    activeTabUrl: `https://${domain}/load/${encodeURIComponent(device.deviceId)}`,
    activeTabTitle: `Load ${domain}`,
    visibilityState: "visible",
    screenLocked: false,
    allOpenTabs: [],
    isScreenRecording: false,
    isScreenSharing: false,
    cameraActive: false,
    status: "active",
    extensionVersion: "load-test",
    chromeVersion: "load-test",
    screenshotHealth: {
      lastSuccessAt: new Date().toISOString(),
      attempts: 1,
      successes: 1,
      alarmActive: false,
    },
  };
}

function screenshotBody(device) {
  return {
    screenshot: screenshotFixture,
    tabTitle: `Load ${device.deviceId}`,
    tabUrl: `https://example.edu/load/${encodeURIComponent(device.deviceId)}`,
  };
}

function sendCommandAck(state, commandId, status) {
  if (state.socket?.readyState !== WebSocket.OPEN) return;
  try {
    state.socket.send(JSON.stringify({
      type: "command-ack",
      commandId,
      status,
      result: { source: "load-test" },
    }));
    const entry = getCommandEntry(commandId);
    if (status === "received") {
      counters.commandReceivedAcksSent += 1;
      if (entry) entry.receivedAcksSent += 1;
    } else {
      counters.commandCompletedAcksSent += 1;
      if (entry) {
        entry.completedAcksSent += 1;
        if (entry.requestStartedAt && Date.now() - entry.requestStartedAt <= 5_000) {
          entry.completedAcksWithin5s += 1;
        }
      }
    }
  } catch {
    counters.wsErrors += 1;
  }
}

function handleDeviceMessage(state, raw) {
  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    counters.wsErrors += 1;
    return;
  }
  if (message.type === "auth-success" && message.role === "student") {
    cancelLater(state.authTimer);
    state.authTimer = null;
    state.authenticated = true;
    state.reconnectAttempt = 0;
    counters.wsAuthenticated += 1;
    authenticatedDeviceIds.add(state.device.deviceId);
    if (state.reconnectStartedAt) {
      const elapsed = Date.now() - state.reconnectStartedAt;
      reconnectLatency.observe(elapsed, elapsed > 30_000);
      counters.wsReconnectCompleted += 1;
      if (elapsed > 30_000) counters.wsReconnectLate += 1;
      state.reconnectStartedAt = 0;
    }
    if (state.forcedReconnectStartedAt) {
      counters.forcedReconnectCompleted += 1;
      state.forcedReconnectStartedAt = 0;
    }
    return;
  }
  if (message.type === "auth-error") {
    counters.wsAuthErrors += 1;
    state.socket?.close();
    return;
  }
  if (message.type === "ping") {
    state.socket?.send(JSON.stringify({ type: "pong" }));
    return;
  }

  const commandId = String(message.commandId || message.command?.commandId || "").trim();
  if (!commandId || !["remote-control", "teacher-message"].includes(message.type)) return;
  if (teacherSchoolId && state.device.schoolId && state.device.schoolId !== teacherSchoolId) {
    counters.crossSchoolCommandDeliveries += 1;
    triggerFatalGate("cross-school-delivery", { kind: "websocket-command" });
    return;
  }
  counters.commandMessagesReceived += 1;
  const entry = getCommandEntry(commandId);
  if (entry) {
    if (entry.deliveredDeviceIds.has(state.device.deviceId)) {
      counters.commandDuplicateDeliveries += 1;
      triggerFatalGate("command-target-scope", { kind: "duplicate-command-delivery" });
      return;
    }
    entry.deliveredDeviceIds.add(state.device.deviceId);
    if (entry.expectedDeviceIds && !entry.expectedDeviceIds.has(state.device.deviceId)) {
      counters.commandUnexpectedTargetDeliveries += 1;
      triggerFatalGate("command-target-scope", { kind: "same-school-wrong-class-delivery" });
      return;
    }
    entry.messagesReceived += 1;
    if (entry.requestStartedAt && Date.now() - entry.requestStartedAt <= 2_000) {
      entry.messagesWithin2s += 1;
    }
  }
  sendCommandAck(state, commandId, "received");
  later(() => sendCommandAck(state, commandId, "completed"), 100);
}

function connectDevice(state) {
  if (stoppingTraffic) return;
  state.generation += 1;
  const generation = state.generation;
  const socket = new WebSocket(wsUrl, {
    perMessageDeflate: false,
    handshakeTimeout: requestTimeoutMs,
    family: 4,
    headers: { "user-agent": LOAD_GATE_USER_AGENT },
  });
  state.socket = socket;
  state.authenticated = false;
  sockets.add(socket);
  state.authTimer = later(() => {
    if (state.generation !== generation || state.authenticated || stoppingTraffic) return;
    counters.wsAuthErrors += 1;
    state.closeReason = "auth-timeout";
    socket.terminate();
  }, wsAuthTimeoutMs, { scale: false });

  socket.on("open", () => {
    if (state.generation !== generation) return;
    counters.wsOpened += 1;
    socket.send(JSON.stringify({
      type: "auth",
      role: "student",
      deviceId: state.device.deviceId,
      studentToken: state.device.studentToken,
    }));
  });
  socket.on("message", (raw) => {
    if (state.generation === generation) handleDeviceMessage(state, raw);
  });
  socket.on("error", () => {
    if (state.generation === generation) counters.wsErrors += 1;
  });
  socket.on("close", () => {
    sockets.delete(socket);
    cancelLater(state.authTimer);
    state.authTimer = null;
    if (state.generation !== generation) return;
    state.socket = null;
    state.authenticated = false;
    const reason = state.closeReason;
    state.closeReason = "";
    if (reason === "forced" || reason === "shutdown") counters.wsIntentionalClosed += 1;
    else counters.wsUnexpectedClosed += 1;
    if (stoppingTraffic || reason === "shutdown") return;

    if (!state.reconnectStartedAt) {
      state.reconnectStartedAt = Date.now();
      counters.wsReconnectRequested += 1;
    }
    state.reconnectAttempt += 1;
    const delayMs = reason === "forced" ? 50 : Math.min(10_000, 250 * (2 ** Math.min(state.reconnectAttempt, 6)));
    later(() => connectDevice(state), delayMs);
  });
}

const deviceStates = devices.map((device) => ({
  device,
  socket: null,
  authenticated: false,
  authTimer: null,
  generation: 0,
  reconnectAttempt: 0,
  reconnectStartedAt: 0,
  forcedReconnectStartedAt: 0,
  closeReason: "",
}));
const teacherSocketStates = teacherAuthInputs.map((auth) => ({
  auth,
  socket: null,
  authenticated: false,
}));

function startDeviceTraffic(state, index) {
  const heartbeatJitter = Math.floor((index / devices.length) * heartbeatIntervalMs);
  const screenshotJitter = Math.floor((index / devices.length) * screenshotIntervalMs);
  const acceleratedJitter = acceleratedRequestStaggerMs
    ? Math.floor((index / devices.length) * acceleratedRequestStaggerMs)
    : null;
  later(() => {
    if (stoppingTraffic) return;
    const send = () => {
      if (stoppingTraffic) return;
      counters.heartbeat += 1;
      void issue("/api/classpilot/device/heartbeat", {
        method: "POST",
        token: state.device.studentToken,
        body: heartbeatBody(state.device),
        kind: "heartbeat",
      });
    };
    send();
    workloadEvery(send, heartbeatIntervalMs);
  }, acceleratedJitter ?? heartbeatJitter, { scale: acceleratedJitter === null });
  later(() => {
    if (stoppingTraffic) return;
    const send = () => {
      if (stoppingTraffic) return;
      counters.screenshotPost += 1;
      void issue("/api/classpilot/device/screenshot", {
        method: "POST",
        token: state.device.studentToken,
        body: screenshotBody(state.device),
        kind: "screenshotPost",
      });
    };
    send();
    workloadEvery(send, screenshotIntervalMs);
  }, acceleratedJitter ?? screenshotJitter, { scale: acceleratedJitter === null });
  const socketJitter = acceleratedJitter === null ? Math.min(heartbeatJitter, 10_000) : acceleratedJitter;
  later(() => connectDevice(state), socketJitter, { scale: acceleratedJitter === null });
}

function devicesForTeacher(auth, authIndex) {
  const matchingDevices = devices.filter((device) =>
    !auth?.schoolId || !device.schoolId || device.schoolId === auth.schoolId
  );
  if (!auth) return matchingDevices;
  const explicit = matchingDevices.filter((device) =>
    auth.deviceIds.has(device.deviceId) ||
    (device.studentId && auth.studentIds.has(device.studentId)) ||
    (device.teacherId && auth.actorId === device.teacherId) ||
    (device.classId && auth.classId === device.classId)
  );
  if (explicit.length > 0 || teacherAuthInputs.length === 1) return explicit.length > 0 ? explicit : matchingDevices;
  return matchingDevices.filter((_device, index) => index % teacherAuthInputs.length === authIndex);
}

function expandTeacherPath(path, auth, authIndex) {
  if (!path.includes("{deviceId}") && !path.includes("{studentId}")) return [path];
  const matchingDevices = devicesForTeacher(auth, authIndex)
    .filter((device) => !path.includes("{studentId}") || Boolean(device.studentId));
  const selectedDevices = teacherTemplateDeviceCount === 0
    ? matchingDevices
    : matchingDevices.slice(0, teacherTemplateDeviceCount);
  return selectedDevices
    .map((device) => path
      .replaceAll("{deviceId}", encodeURIComponent(device.deviceId))
      .replaceAll("{studentId}", encodeURIComponent(device.studentId || "")))
    .filter((expanded) => !expanded.includes("{") && !expanded.includes("}"));
}

function startTeacherTraffic() {
  if (!hasTeacherHttpAuth || teacherPaths.length === 0) return;
  const staticPaths = teacherPaths.filter((path) => !path.includes("{deviceId}") && !path.includes("{studentId}"));
  const templatePaths = teacherPaths.filter((path) => path.includes("{deviceId}") || path.includes("{studentId}"));
  const poll = (paths, spreadWindowMs) => {
    if (stoppingTraffic) return;
    const cohorts = [];
    for (const [authIndex, auth] of teacherAuthInputs.entries()) {
      const jobs = [];
      for (const template of paths) {
        for (const path of expandTeacherPath(template, auth, authIndex)) {
          jobs.push({ auth, path });
        }
      }
      if (jobs.length > 0) cohorts.push(jobs);
    }
    scheduleStaggered(cohorts, spreadWindowMs, (jobs) => {
      // A real dashboard mounts/refetches one class's tiles together. Stagger
      // independent teacher cohorts, but preserve each class's browser burst
      // so the gate still exercises backend concurrency honestly.
      for (const job of jobs) {
        if (stoppingTraffic) return;
        counters.teacher += 1;
        const kind = job.path.includes("screenshot") ? "screenshotGet" : "teacher";
        if (kind === "screenshotGet") counters.screenshotGet += 1;
        const endpointClass = redactedEndpointClass(job.path);
        let expectedDeviceId = "";
        if (endpointClass === "GET /api/classpilot/heartbeats/{deviceId}") {
          const encodedDeviceId = job.path.split("?", 1)[0].split("/").at(-1) || "";
          try { expectedDeviceId = decodeURIComponent(encodedDeviceId); } catch { expectedDeviceId = ""; }
        }
        const expectedStudentIds = endpointClass === "GET /api/students-aggregated"
          ? job.auth.studentIds
          : null;
        void issue(job.path, {
          ...teacherHttpAuth(job.auth),
          kind,
          endpointClass,
          expectedDeviceId,
          expectedStudentIds,
        });
      }
    });
  };
  if (staticPaths.length > 0) {
    poll(staticPaths, teacherIntervalMs);
    workloadEvery(() => poll(staticPaths, teacherIntervalMs), teacherIntervalMs);
  }
  if (templatePaths.length > 0) {
    later(() => {
      if (stoppingTraffic) return;
      poll(templatePaths, teacherTemplateIntervalMs);
      workloadEvery(() => poll(templatePaths, teacherTemplateIntervalMs), teacherTemplateIntervalMs);
    }, teacherTileCohortWarmupMs);
  }
}

function startScreenshotPolling() {
  if (!hasTeacherHttpAuth || !screenshotGetTemplate) return;
  const poll = () => {
    if (stoppingTraffic) return;
    const cohorts = [];
    for (const [authIndex, auth] of teacherAuthInputs.entries()) {
      const jobs = [];
      for (const device of devicesForTeacher(auth, authIndex)) {
        jobs.push({ auth, device });
      }
      if (jobs.length > 0) cohorts.push(jobs);
    }
    scheduleStaggered(cohorts, screenshotGetIntervalMs, (jobs) => {
      for (const job of jobs) {
        if (stoppingTraffic) return;
        const path = screenshotGetTemplate.replaceAll("{deviceId}", encodeURIComponent(job.device.deviceId));
        counters.screenshotGet += 1;
        void issue(path, {
          // The production web API client sends its in-memory bearer for this
          // screenshot path. Cookie-only requests are rejected upstream even
          // though other teacher dashboard/history routes accept the session.
          ...teacherHttpAuth(job.auth, { preferBearer: true }),
          kind: "screenshotGet",
          endpointClass: redactedEndpointClass(path),
          expectedDeviceId: job.device.deviceId,
        });
      }
    });
  };
  // Initial screenshot uploads are staggered across one full POST interval.
  // Wait for that interval plus the request timeout so a cold Redis cache does
  // not turn expected pre-upload 404s into false launch-gate failures.
  later(() => {
    if (stoppingTraffic) return;
    poll();
    workloadEvery(poll, screenshotGetIntervalMs);
  }, screenshotCohortWarmupMs);
}

function startTenantIsolationProbes() {
  const testProbe = process.env.NODE_ENV === "test" && boolEnv("LOAD_TEST_ENABLE_ISOLATION_PROBES");
  if (testProbe && !["localhost", "127.0.0.1", "::1"].includes(targetUrl.hostname)) {
    throw new Error("LOAD_TEST_ENABLE_ISOLATION_PROBES is restricted to loopback targets");
  }
  if ((!isLaunchGate && !testProbe) || !teacherAuthInputs[0] || nonOwnedDeviceIds.size === 0) return;
  const auth = teacherAuthInputs[0];
  const probes = [];
  for (const deviceId of nonOwnedDeviceIds) {
    const encoded = encodeURIComponent(deviceId);
    for (const probePath of [
      `/api/classpilot/heartbeats/${encoded}`,
      `/api/classpilot/device/screenshot/${encoded}`,
    ]) {
      probes.push(probePath);
    }
  }
  scheduleStaggered(probes, teacherIntervalMs, (probePath) => {
    void issue(probePath, {
        ...teacherHttpAuth(auth, { preferBearer: probePath.includes("/device/screenshot/") }),
        kind: "tenantIsolationProbe",
        endpointClass: redactedEndpointClass(probePath),
        countWorkload: false,
        probeExpectedStatus: 404,
    });
  });
}

function startCommandTraffic() {
  if (!hasTeacherHttpAuth || !commandEndpoint || commandBodies.length === 0) return;
  let initialSweepComplete = false;
  let nextBodyIndex = 0;

  const sendOne = async (body, classBodyIndex) => {
    const requestStartedAt = Date.now();
    activeCommandRequestStartedAt = requestStartedAt;
    counters.command += 1;
    try {
      const response = await issue(commandEndpoint, {
        method: "POST",
        ...teacherHttpAuth(teacherAuthForCommand(body, classBodyIndex)),
        body,
        kind: "command",
        parseJson: true,
        endpointClass: redactedEndpointClass(commandEndpoint),
      });
      const commandId = String(response.json?.command?.id || "").trim();
      if (!response.ok || !commandId) {
        counters.commandResponsesInvalid += 1;
        return;
      }
      const entry = getCommandEntry(commandId);
      if (!entry) return;
      entry.createdByHarness = true;
      entry.classBodyIndex = classBodyIndex;
      entry.requestStartedAt ||= requestStartedAt;
      entry.expected = Math.max(0, Number(response.json?.summary?.sent || 0));
      entry.expectedDeviceIds = expectedCommandDeviceIds(body);
      if (isLaunchGate) {
        const expectedSetSize = entry.expectedDeviceIds?.size ?? -1;
        const wrongExistingTarget = [...entry.deliveredDeviceIds].some(
          (deviceId) => !entry.expectedDeviceIds?.has(deviceId)
        );
        if (entry.expected !== expectedTargetsPerClass || expectedSetSize !== expectedTargetsPerClass) {
          counters.commandTargetCountMismatch += 1;
          triggerFatalGate("command-target-scope", { kind: "command-target-count-mismatch" });
        } else if (wrongExistingTarget) {
          counters.commandUnexpectedTargetDeliveries += 1;
          triggerFatalGate("command-target-scope", { kind: "same-school-wrong-class-delivery" });
        }
      }
      counters.commandResponsesTracked += 1;
    } finally {
      if (activeCommandRequestStartedAt === requestStartedAt) activeCommandRequestStartedAt = 0;
    }
  };

  const sendCycle = async () => {
    if (stoppingTraffic || commandRequestInFlight) return;
    commandRequestInFlight = true;
    try {
      if (!initialSweepComplete) {
        for (let index = 0; index < commandBodies.length; index += 1) {
          if (stoppingTraffic) break;
          await sendOne(commandBodies[index], index);
        }
        initialSweepComplete = !stoppingTraffic;
        nextBodyIndex = 0;
      } else {
        const index = nextBodyIndex % commandBodies.length;
        await sendOne(commandBodies[index], index);
        nextBodyIndex = (index + 1) % commandBodies.length;
      }
    } finally {
      commandRequestInFlight = false;
    }
  };
  later(() => {
    if (stoppingTraffic) return;
    void sendCycle();
    workloadEvery(() => void sendCycle(), commandIntervalMs);
  }, commandWarmupMs);
}

function connectTeacherWebSocket(state) {
  const { auth } = state;
  if (!auth?.token || !auth.schoolId) return;
  const socket = new WebSocket(wsUrl, {
    perMessageDeflate: false,
    handshakeTimeout: requestTimeoutMs,
    family: 4,
    headers: { "user-agent": LOAD_GATE_USER_AGENT },
  });
  state.socket = socket;
  sockets.add(socket);
  socket.on("open", () => {
    socket.send(JSON.stringify({
      type: "auth",
      role: auth.role,
      userToken: auth.token,
      schoolId: auth.schoolId,
    }));
  });
  socket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      counters.wsErrors += 1;
      return;
    }
    if (message.type === "auth-success") {
      state.authenticated = true;
      counters.teacherWsAuthenticated += 1;
      return;
    }
    if (message.type === "auth-error") {
      counters.teacherWsAuthErrors += 1;
      return;
    }
    if (message.type !== "classpilot-command-update") return;
    const commandId = String(message.commandId || message.command?.id || "").trim();
    const entry = commandId ? getCommandEntry(commandId) : null;
    if (!entry) return;
    const targets = Array.isArray(message.command?.targets) ? message.command.targets : [];
    entry.serverReceived = Math.max(
      entry.serverReceived,
      targets.filter((target) => ["received", "completed"].includes(target.status)).length
    );
    entry.serverCompleted = Math.max(
      entry.serverCompleted,
      targets.filter((target) => target.status === "completed").length
    );
    const elapsed = entry.requestStartedAt ? Date.now() - entry.requestStartedAt : Infinity;
    if (elapsed <= 2_000) entry.serverReceivedWithin2s = Math.max(entry.serverReceivedWithin2s, entry.serverReceived);
    if (elapsed <= 5_000) entry.serverCompletedWithin5s = Math.max(entry.serverCompletedWithin5s, entry.serverCompleted);
    counters.commandUpdatesObserved += 1;
  });
  socket.on("error", () => { counters.wsErrors += 1; });
  socket.on("close", () => {
    sockets.delete(socket);
    if (!stoppingTraffic && state.authenticated) counters.teacherWsUnexpectedClosed += 1;
    state.authenticated = false;
    state.socket = null;
  });
}

function scheduleForcedReconnect() {
  if (!forceReconnectAtMs || forceReconnectAtMs >= durationMs) return;
  later(() => {
    if (stoppingTraffic) return;
    deviceStates.forEach((state, index) => {
      const jitter = devices.length <= 1 ? 0 : Math.floor((index / (devices.length - 1)) * forceReconnectStaggerMs);
      later(() => {
        if (stoppingTraffic || state.forcedReconnectStartedAt) return;
        // A reconnect gate is meaningful only after this exact socket has
        // authenticated. Do not let a device's first eventual auth masquerade
        // as recovery from an established session.
        if (!state.authenticated || state.socket?.readyState !== WebSocket.OPEN) {
          counters.forcedReconnectSkippedUnauthenticated += 1;
          return;
        }
        const now = Date.now();
        state.forcedReconnectStartedAt = now;
        if (!state.reconnectStartedAt) {
          state.reconnectStartedAt = now;
          counters.wsReconnectRequested += 1;
        }
        counters.forcedReconnectRequested += 1;
        state.closeReason = "forced";
        state.socket.close(4000, "load-test forced reconnect");
      }, jitter);
    });
  }, forceReconnectAtMs);
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator;
}

function captureFinalSocketGate() {
  const deviceReady = (state) => state.authenticated && state.socket?.readyState === WebSocket.OPEN;
  const teacherReady = (state) => state.authenticated && state.socket?.readyState === WebSocket.OPEN;
  const stateOutstanding = deviceStates.filter((state) =>
    Boolean(
      state.reconnectStartedAt ||
      state.forcedReconnectStartedAt ||
      (state.authenticated && !deviceReady(state))
    )
  ).length;
  const counterOutstanding = Math.max(
    0,
    counters.wsReconnectRequested - counters.wsReconnectCompleted,
    counters.forcedReconnectRequested - counters.forcedReconnectCompleted
  );
  finalSocketGate = {
    capturedAt: new Date().toISOString(),
    deviceAuthenticated: deviceStates.filter(deviceReady).length,
    selectedDevices: devices.length,
    outstandingReconnects: Math.max(stateOutstanding, counterOutstanding),
    teacherAuthenticated: teacherSocketStates.filter(teacherReady).length,
    selectedTeachers: teacherSocketStates.length,
  };
}

function summarize(shutdownReason) {
  const elapsedMs = Math.max(1, Date.now() - runStartedAt);
  const trafficElapsedMs = Math.max(1, (trafficStoppedAt || Date.now()) - runStartedAt);
  const modeledTrafficElapsedMs = acceleratedRuntimeMs && shutdownReason === "duration"
    ? durationMs
    : trafficElapsedMs;
  const completedConfiguredDuration = shutdownReason === "duration" && (
    acceleratedRuntimeMs
      ? trafficElapsedMs + 50 >= runtimeDurationMs
      : trafficElapsedMs >= durationMs
  );
  const kinds = Object.fromEntries([...histograms.entries()].map(([kind, value]) => [kind, value.summary()]));
  const teacherEndpoints = Object.fromEntries(
    [...teacherEndpointHistograms.entries()].map(([endpoint, value]) => [endpoint, value.summary()])
  );
  const harnessCommands = [...commandEntries.values()].filter((entry) => entry.createdByHarness);
  const exercisedClassBodies = new Set(
    harnessCommands
      .filter((entry) => entry.expected > 0 && Number.isInteger(entry.classBodyIndex))
      .map((entry) => entry.classBodyIndex)
  );
  const fullyTargetedClassBodies = new Set(
    harnessCommands
      .filter((entry) => entry.expected === expectedTargetsPerClass && Number.isInteger(entry.classBodyIndex))
      .map((entry) => entry.classBodyIndex)
  );
  const commandTotals = harnessCommands.reduce((totals, entry) => ({
    expected: totals.expected + entry.expected,
    messagesReceived: totals.messagesReceived + Math.min(entry.messagesReceived, entry.expected),
    messagesWithin2s: totals.messagesWithin2s + Math.min(entry.messagesWithin2s, entry.expected),
    receivedAcksSent: totals.receivedAcksSent + Math.min(entry.receivedAcksSent, entry.expected),
    completedAcksSent: totals.completedAcksSent + Math.min(entry.completedAcksSent, entry.expected),
    completedAcksWithin5s: totals.completedAcksWithin5s + Math.min(entry.completedAcksWithin5s, entry.expected),
    serverReceived: totals.serverReceived + Math.min(entry.serverReceived, entry.expected),
    serverCompleted: totals.serverCompleted + Math.min(entry.serverCompleted, entry.expected),
    serverReceivedWithin2s: totals.serverReceivedWithin2s + Math.min(entry.serverReceivedWithin2s, entry.expected),
    serverCompletedWithin5s: totals.serverCompletedWithin5s + Math.min(entry.serverCompletedWithin5s, entry.expected),
  }), {
    expected: 0,
    messagesReceived: 0,
    messagesWithin2s: 0,
    receivedAcksSent: 0,
    completedAcksSent: 0,
    completedAcksWithin5s: 0,
    serverReceived: 0,
    serverCompleted: 0,
    serverReceivedWithin2s: 0,
    serverCompletedWithin5s: 0,
  });
  const projectedFiveMinuteRequests = Math.round((counters.httpTotal / modeledTrafficElapsedMs) * 300_000);
  const projectedFiveMinuteDeviceRequests = Math.round((counters.wafDeviceIngestRequests / modeledTrafficElapsedMs) * 300_000);
  const projectedFiveMinuteGeneralRequests = Math.round((counters.wafGeneralApiRequests / modeledTrafficElapsedMs) * 300_000);
  const failures = [];
  const fiveXxRate = ratio(counters.http5xx, counters.httpTotal);
  const networkErrorRate = ratio(counters.httpErrors, counters.httpTotal);
  const unexpectedCloseRate = ratio(counters.wsUnexpectedClosed, Math.max(1, counters.wsAuthenticated));
  const undeclaredSchoolDevices = teacherSchoolId
    ? devices.filter((device) => !device.schoolId).length
    : 0;
  const canaryDevices = teacherSchoolId
    ? devices.filter((device) => device.schoolId && device.schoolId !== teacherSchoolId).length
    : 0;
  const heartbeatLatencyThresholdMs = 500 * testLatencyThresholdMultiplier;
  const screenshotLatencyThresholdMs = 750 * testLatencyThresholdMultiplier;
  const teacherLatencyThresholdMs = 1_000 * testLatencyThresholdMultiplier;

  if (enforceThresholds) {
    if (fatalGate) failures.push(`fatal gate triggered: ${fatalGate.reasonCodes.join(", ")}`);
    if (shutdownReason !== "duration") {
      failures.push(`run ended because of ${shutdownReason} before its configured duration completed`);
    }
    if (!completedConfiguredDuration) {
      failures.push(`traffic ran for ${Math.round(trafficElapsedMs / 1000)}s of the configured ${Math.round(durationMs / 1000)}s`);
    }
    if (counters.http4xx > 0) failures.push(`valid traffic received ${counters.http4xx} HTTP 4xx responses`);
    if (counters.http3xx > 0) failures.push(`valid traffic received ${counters.http3xx} unexpected redirects`);
    if (fiveXxRate >= 0.001) failures.push(`HTTP 5xx rate ${(fiveXxRate * 100).toFixed(3)}% is not below 0.1%`);
    if (networkErrorRate >= 0.001) failures.push(`network error rate ${(networkErrorRate * 100).toFixed(3)}% is not below 0.1%`);
    if (counters.unfinishedHttpRequests > 0) failures.push(`${counters.unfinishedHttpRequests} HTTP requests remained unfinished after shutdown grace`);
    if (counters.responseParseErrors > 0) failures.push(`${counters.responseParseErrors} inspected HTTP responses could not be parsed completely`);
    if (counters.teacherResponseValidationErrors > 0) failures.push(`${counters.teacherResponseValidationErrors} teacher responses were empty, structurally invalid, or outside the exact class scope`);
    if (!kinds.heartbeat?.count) failures.push("heartbeat traffic emitted no completed samples");
    else if (kinds.heartbeat.p95 > heartbeatLatencyThresholdMs) failures.push(`heartbeat p95 exceeds ${heartbeatLatencyThresholdMs}ms`);
    if (!kinds.screenshotPost?.count) failures.push("screenshot POST traffic emitted no completed samples");
    else if (kinds.screenshotPost.p95 > screenshotLatencyThresholdMs) failures.push(`screenshot POST p95 exceeds ${screenshotLatencyThresholdMs}ms`);
    const screenshotGetConfigured = Boolean(screenshotGetTemplate || teacherPaths.some((path) => path.includes("screenshot")));
    if (screenshotGetConfigured && !kinds.screenshotGet?.count) failures.push("configured screenshot GET traffic emitted no completed samples");
    else if (kinds.screenshotGet?.p95 > screenshotLatencyThresholdMs) failures.push(`screenshot GET p95 exceeds ${screenshotLatencyThresholdMs}ms`);
    if (screenshotGetConfigured && ratio(counters.screenshotGetSuccess, counters.screenshotGet) < 0.99) {
      failures.push("fewer than 99% of screenshot GET attempts returned a successful screenshot");
    }
    const dashboardConfigured = teacherPaths.some((path) => !path.includes("screenshot"));
    if (dashboardConfigured && !kinds.teacher?.count) failures.push("configured teacher/dashboard traffic emitted no completed samples");
    else if (kinds.teacher?.p95 > teacherLatencyThresholdMs) failures.push(`teacher/dashboard p95 exceeds ${teacherLatencyThresholdMs}ms`);
    if (commandEndpoint && !kinds.command?.count) failures.push("configured teacher command traffic emitted no completed samples");
    else if (kinds.command?.p95 > teacherLatencyThresholdMs) failures.push(`teacher command p95 exceeds ${teacherLatencyThresholdMs}ms`);
    for (const endpoint of configuredTeacherEndpointClasses) {
      const endpointSummary = teacherEndpoints[endpoint];
      if (!endpointSummary?.count) {
        failures.push(`${endpoint} emitted no completed samples`);
        continue;
      }
      const threshold = endpoint === "GET /api/classpilot/device/screenshot/{deviceId}"
        ? screenshotLatencyThresholdMs
        : teacherLatencyThresholdMs;
      if (endpointSummary.p95 > threshold) failures.push(`${endpoint} p95 exceeds ${threshold}ms`);
    }
    if (authenticatedDeviceIds.size !== devices.length) {
      failures.push(`only ${authenticatedDeviceIds.size}/${devices.length} devices received WebSocket auth-success`);
    }
    if (!finalSocketGate) {
      failures.push("final pre-shutdown WebSocket state was not captured");
    } else {
      if (finalSocketGate.deviceAuthenticated !== finalSocketGate.selectedDevices) {
        failures.push(`only ${finalSocketGate.deviceAuthenticated}/${finalSocketGate.selectedDevices} device sockets were authenticated at final pre-shutdown`);
      }
      if (finalSocketGate.outstandingReconnects !== 0) {
        failures.push(`${finalSocketGate.outstandingReconnects} WebSocket reconnects remained outstanding at final pre-shutdown`);
      }
      if (finalSocketGate.selectedTeachers > 0 && finalSocketGate.teacherAuthenticated !== finalSocketGate.selectedTeachers) {
        failures.push(`only ${finalSocketGate.teacherAuthenticated}/${finalSocketGate.selectedTeachers} teacher sockets were authenticated at final pre-shutdown`);
      }
    }
    if (counters.wsAuthErrors > 0) failures.push(`${counters.wsAuthErrors} device WebSocket authentications failed`);
    if (unexpectedCloseRate >= 0.001) failures.push("unexpected WebSocket close rate is not below 0.1%");
    if (counters.crossSchoolCommandDeliveries > 0) failures.push("a teacher command crossed the declared school boundary");
    if (counters.commandTargetCountMismatch > 0) failures.push("a class command targeted a count other than the exact reviewed class cohort");
    if (counters.commandUnexpectedTargetDeliveries > 0) failures.push("a class command reached a same-school device outside its reviewed class cohort");
    if (counters.commandDuplicateDeliveries > 0) failures.push("a class command was delivered more than once to the same device");
    if (counters.crossSchoolHttpResponses > 0) failures.push("a teacher HTTP response exposed a foreign school or known non-owned identifier");
    if (teacherSchoolId && undeclaredSchoolDevices > 0) failures.push(`${undeclaredSchoolDevices} devices lack schoolId, so tenant-canary validation is incomplete`);
    if (teacherSchoolId && canaryDevices < expectedCanaryDevices) failures.push(`tenant-canary validation requires at least ${expectedCanaryDevices} second-school devices`);
    if (isLaunchGate) {
      const expectedProbeCount = nonOwnedDeviceIds.size * 2;
      if (
        expectedProbeCount === 0 ||
        counters.tenantIsolationProbeAttempts !== expectedProbeCount ||
        counters.tenantIsolationProbePassed !== expectedProbeCount ||
        counters.tenantIsolationProbeFailed !== 0
      ) {
        failures.push(`tenant isolation probes passed ${counters.tenantIsolationProbePassed}/${expectedProbeCount}`);
      }
    }
    if (fiveMinuteDeviceIngestRequests.peak >= wafDeviceLimit || projectedFiveMinuteDeviceRequests >= wafDeviceLimit) {
      failures.push(`device-ingest WAF traffic meets/exceeds its ${wafDeviceLimit} requests/5m limit`);
    }
    if (fiveMinuteGeneralApiRequests.peak >= wafGeneralLimit || projectedFiveMinuteGeneralRequests >= wafGeneralLimit) {
      failures.push(`general API WAF traffic meets/exceeds its ${wafGeneralLimit} requests/5m limit`);
    }
    if (forceReconnectAtMs > 0) {
      if (counters.forcedReconnectRequested !== devices.length) {
        failures.push(`only ${counters.forcedReconnectRequested}/${devices.length} forced reconnects were requested`);
      }
      if (counters.forcedReconnectCompleted !== devices.length) {
        failures.push(`only ${counters.forcedReconnectCompleted}/${devices.length} forced reconnects completed`);
      }
    }
    if (counters.wsReconnectLate > 0 || reconnectLatency.percentile(95) > 30_000) {
      failures.push("one or more WebSocket reconnects exceeded 30 seconds");
    }
    if (commandEndpoint) {
      if (commandTotals.expected === 0) failures.push("command validation produced no sent targets");
      if (isLaunchGate && exercisedClassBodies.size < expectedClassBodies) {
        failures.push(`only ${exercisedClassBodies.size}/${expectedClassBodies} configured class bodies produced sent command targets`);
      }
      if (isLaunchGate && fullyTargetedClassBodies.size < expectedClassBodies) {
        failures.push(`only ${fullyTargetedClassBodies.size}/${expectedClassBodies} class bodies reached ${expectedTargetsPerClass} sent targets`);
      }
      if (ratio(commandTotals.messagesWithin2s, commandTotals.expected) < 0.99) failures.push("fewer than 99% of command targets received the WebSocket command within 2 seconds");
      if (ratio(commandTotals.completedAcksWithin5s, commandTotals.expected) < 0.99) failures.push("fewer than 99% of command targets sent completed ACKs within 5 seconds");
      if (counters.commandResponsesInvalid > 0 || counters.commandTrackingOverflow > 0) failures.push("one or more command responses could not be validated");
      if (teacherSchoolId) {
        if (counters.teacherWsAuthenticated !== teacherAuthInputs.length || counters.teacherWsAuthErrors > 0) {
          failures.push(`only ${counters.teacherWsAuthenticated}/${teacherAuthInputs.length} teacher WebSockets authenticated`);
        }
        if (counters.teacherWsUnexpectedClosed > 0) failures.push("one or more teacher WebSockets closed unexpectedly");
        if (ratio(commandTotals.serverReceivedWithin2s, commandTotals.expected) < 0.99) failures.push("server did not report received status within 2 seconds for 99% of command targets");
        if (ratio(commandTotals.serverCompletedWithin5s, commandTotals.expected) < 0.99) failures.push("server did not report completed status within 5 seconds for 99% of command targets");
      }
    }
  }
  if (fatalGate && !failures.some((failure) => failure.startsWith("fatal gate triggered:"))) {
    failures.unshift(`fatal gate triggered: ${fatalGate.reasonCodes.join(", ")}`);
  }

  const summary = {
    runId,
    stage,
    targetOrigin: baseUrl,
    devices: devices.length,
    declaredSecondSchoolCanaryDevices: canaryDevices,
    run: {
      shutdownReason,
      plannedTrafficSeconds: Number((durationMs / 1000).toFixed(1)),
      actualTrafficSeconds: Number((trafficElapsedMs / 1000).toFixed(1)),
      modeledTrafficSeconds: Number((modeledTrafficElapsedMs / 1000).toFixed(1)),
      totalElapsedSeconds: Number((elapsedMs / 1000).toFixed(1)),
      acceleratedLoopbackTest: Boolean(acceleratedRuntimeMs),
      testOnlyLatencyThresholdMultiplier: testLatencyThresholdMultiplier,
      completedConfiguredDuration,
    },
    screenshotFixture: { profile: screenshotProfile, decodedBytes: screenshotBytes },
    counters,
    statusCodes,
    rates: {
      http5xxPercent: Number((fiveXxRate * 100).toFixed(3)),
      networkErrorPercent: Number((networkErrorRate * 100).toFixed(3)),
      unexpectedWsClosePercent: Number((unexpectedCloseRate * 100).toFixed(3)),
    },
    kinds,
    teacherEndpoints,
    websocket: {
      uniqueDevicesAuthenticated: authenticatedDeviceIds.size,
      reconnectLatency: reconnectLatency.summary(),
      finalPreShutdown: finalSocketGate,
    },
    commands: {
      configuredClassBodies: commandBodies.length,
      uniqueConfiguredClassSessions: commandSessionCount,
      exercisedClassBodiesWithSentTargets: exercisedClassBodies.size,
      classBodiesMeetingExpectedTargets: fullyTargetedClassBodies.size,
      expectedTargetsPerClass,
      tracked: harnessCommands.length,
      ...commandTotals,
      deliveryPercent: Number((ratio(commandTotals.messagesReceived, commandTotals.expected) * 100).toFixed(2)),
      deliveryWithin2sPercent: Number((ratio(commandTotals.messagesWithin2s, commandTotals.expected) * 100).toFixed(2)),
      completedAckPercent: Number((ratio(commandTotals.completedAcksSent, commandTotals.expected) * 100).toFixed(2)),
      completedAckWithin5sPercent: Number((ratio(commandTotals.completedAcksWithin5s, commandTotals.expected) * 100).toFixed(2)),
      serverCompletedPercent: teacherSchoolId
        ? Number((ratio(commandTotals.serverCompleted, commandTotals.expected) * 100).toFixed(2))
        : null,
    },
    screenshotRetrieval: {
      attempts: counters.screenshotGet,
      successes: counters.screenshotGetSuccess,
      successPercent: Number((ratio(counters.screenshotGetSuccess, counters.screenshotGet) * 100).toFixed(2)),
    },
    sharedIpModel: {
      label: sharedIpLabel,
      assumption: "all generator traffic exits through one source IP; no forwarding headers are spoofed",
      combinedInformational: {
        rollingPeakRequests5m: fiveMinuteRequests.peak,
        projectedAverageRequests5m: projectedFiveMinuteRequests,
      },
      deviceIngestWafBucket: {
        limit: wafDeviceLimit,
        rollingPeakRequests5m: fiveMinuteDeviceIngestRequests.peak,
        projectedAverageRequests5m: projectedFiveMinuteDeviceRequests,
      },
      generalApiWafBucket: {
        limit: wafGeneralLimit,
        rollingPeakRequests5m: fiveMinuteGeneralApiRequests.peak,
        projectedAverageRequests5m: projectedFiveMinuteGeneralRequests,
      },
    },
    thresholds: {
      scope: "http-websocket-waf",
      enforced: enforceThresholds,
      profile: gateProfile,
      passed: fatalGate ? false : (enforceThresholds ? failures.length === 0 : null),
      failures,
    },
    externalAcceptance: {
      passed: null,
      status: "requires CloudWatch, AWS console/CLI, and rollout evidence outside this harness",
      required: [
        "ECS CPU, memory, autoscaling, restart, OOM, and ALB target-health gates",
        "RDS CPU, connections, pool exhaustion, rollup/purge duration, and storage-headroom gates",
        "Redis CPU, memory, free memory, evictions, rejected connections, screenshot hit rate, and snapshot gates",
        "NAT usage, service-cost bands, recurring-log absence, and deployment/rollback checks",
      ],
    },
    fatalGate: fatalGate ? { ...fatalGate, reasonCodes: [...fatalGate.reasonCodes] } : null,
    artifacts: {
      externalSummaryConfigured: Boolean(externalSummaryPath),
      externalSummaryWritten: Boolean(externalSummaryPath),
      externalProgressConfigured: Boolean(externalProgressPath),
      externalProgressFinalized: progressFinalized,
    },
  };
  if (externalSummaryPath) {
    try {
      writeAtomicJson(externalSummaryPath, summary);
    } catch {
      summary.artifacts.externalSummaryWritten = false;
      triggerFatalGate("summary-output-error", { source: "summary" }, false);
      summary.fatalGate = fatalGate ? { ...fatalGate, reasonCodes: [...fatalGate.reasonCodes] } : null;
      const failure = `fatal gate triggered: ${fatalGate.reasonCodes.join(", ")}`;
      if (!summary.thresholds.failures.some((entry) => entry.startsWith("fatal gate triggered:"))) {
        summary.thresholds.failures.unshift(failure);
      }
      summary.thresholds.passed = false;
    }
  }
  console.log(JSON.stringify(summary, null, 2));
  if (enforceThresholds && failures.length > 0) process.exitCode = 1;
  return summary;
}

async function shutdown(reason) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    stoppingTraffic = true;
    trafficStoppedAt ||= Date.now();
    for (const timer of intervals) clearInterval(timer);
    intervals.clear();

    // Keep sockets alive briefly so the last command response can deliver and
    // persist its received/completed ACKs before the final gate is calculated.
    if (reason === "duration" && commandSettleMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, commandSettleMs));
    }
    captureFinalSocketGate();

    for (const timer of timeouts) clearTimeout(timer);
    timeouts.clear();
    for (const state of deviceStates) {
      state.closeReason = "shutdown";
      state.socket?.close(1000, "load-test complete");
    }
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
    }

    const settleInFlight = Promise.allSettled([...inFlight]);
    let shutdownTimer;
    const shutdownTimeout = new Promise((resolve) => {
      shutdownTimer = setTimeout(resolve, shutdownGraceMs);
      shutdownTimer.unref?.();
    });
    try {
      await Promise.race([settleInFlight, shutdownTimeout]);
    } finally {
      clearTimeout(shutdownTimer);
    }
    if (pendingRequests.size > 0) {
      const unfinished = [...pendingRequests.values()];
      const unfinishedWorkload = unfinished.filter((record) => record.countWorkload).length;
      counters.unfinishedHttpRequests += unfinishedWorkload;
      for (const record of unfinished) {
        finalizePendingRequest(record, 0, new Error("unfinished at shutdown"));
        record.controller.abort(new Error("load test shutdown"));
      }
      if (unfinishedWorkload > 0) {
        triggerFatalGate("unfinished-http-requests", { count: unfinishedWorkload }, false);
      }
      await Promise.allSettled([...inFlight]);
    }
    try {
      const finalProgressWritten = appendProgressOrFail("final");
      if (progressDescriptor !== null) {
        try {
          fs.fsyncSync(progressDescriptor);
          fs.closeSync(progressDescriptor);
          progressDescriptor = null;
          progressFinalized = finalProgressWritten;
        } catch {
          progressFinalized = false;
          triggerFatalGate("progress-finalize-error", { source: "progress" }, false);
        }
      }
      summarize(reason);
    } finally {
      ipv4HttpAgent.destroy();
      ipv4HttpsAgent.destroy();
      if (progressDescriptor !== null) {
        try { fs.closeSync(progressDescriptor); } catch { /* already failed closed */ }
        progressDescriptor = null;
      }
    }
  })();
  return shutdownPromise;
}

const validateConfigOnly = process.argv.includes("--validate-config");
if (validateConfigOnly) {
  const primaryDevices = teacherSchoolId
    ? devices.filter((device) => device.schoolId === teacherSchoolId).length
    : devices.length;
  const canaryDevices = teacherSchoolId
    ? devices.filter((device) => device.schoolId && device.schoolId !== teacherSchoolId).length
    : 0;
  console.log(JSON.stringify({
    ok: true,
    mode: "preflight-only",
    trafficStarted: false,
    runId,
    gateProfile,
    thresholdsEnforced: enforceThresholds,
    networkFamily: "IPv4",
    launchContract: {
      totalSockets: devices.length,
      primaryDevices,
      canaryDevices,
      durationSeconds: durationMs / 1000,
      screenshotBytes,
      expectedClassBodies,
      expectedTargetsPerClass,
      teacherActors: teacherAuthInputs.length,
    },
    finalAcceptanceContract: {
      authenticatedDeviceSockets: devices.length,
      authenticatedTeacherSockets: teacherAuthInputs.length,
      outstandingReconnects: 0,
      commandTargets: expectedClassBodies * expectedTargetsPerClass,
      tenantIsolationProbes: nonOwnedDeviceIds.size * 2,
      requiredEndpointClasses: [...configuredTeacherEndpointClasses].sort(),
    },
    trafficShaping: {
      teacherStaticPollSpreadMs: teacherIntervalMs,
      teacherTemplatePollSpreadMs: teacherTemplateIntervalMs,
      screenshotGetSpreadMs: screenshotGetIntervalMs,
      teacherTileCohortWarmupMs,
      screenshotCohortWarmupMs,
      teacherWebSocketStartupSpreadMs: teacherIntervalMs,
      isolationProbeSpreadMs: teacherIntervalMs,
    },
  }, null, 2));
} else {
  progressDescriptor = externalProgressPath
    ? fs.openSync(externalProgressPath, "a", 0o600)
    : null;
  console.log(`Starting ClassPilot load test: ${devices.length} devices, ${screenshotBytes}B screenshots, ${Math.round(durationMs / 1000)}s`);
  runStartedAt = Date.now();
  appendProgressOrFail("start");
  if (!stoppingTraffic) {
    every(() => appendProgressOrFail("minute"), progressIntervalMs);
    deviceStates.forEach(startDeviceTraffic);
    startTeacherTraffic();
    startScreenshotPolling();
    startTenantIsolationProbes();
    scheduleStaggered(teacherSocketStates, teacherIntervalMs, connectTeacherWebSocket);
    startCommandTraffic();
    scheduleForcedReconnect();
    later(() => void shutdown("duration"), durationMs);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
