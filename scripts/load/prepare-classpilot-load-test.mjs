#!/usr/bin/env node

/**
 * Idempotently prepare the synthetic ClassPilot launch-load dataset by using
 * production HTTP APIs only. Secrets are accepted from this process' environment
 * and sensitive artifacts are written atomically to an ACL-restricted directory
 * outside the repository.
 *
 * Usage:
 *   node scripts/load/prepare-classpilot-load-test.mjs <provision|refresh|verify|deactivate|cleanup> \
 *     --config <absolute-external-json> --output <absolute-external-directory>
 *
 * Required process environment (never place these in the config file):
 *   CLP_SUPER_ADMIN_BEARER OR                         (all online operations)
 *   CLP_SUPER_ADMIN_EMAIL / CLP_SUPER_ADMIN_PASSWORD
 *   CLP_FIXTURE_ADMIN_PASSWORD                        (provision/refresh/verify/deactivate)
 *   CLP_FIXTURE_TEACHER_PASSWORD                      (provision and refresh)
 *   CLP_OPERATOR_ALIAS_CONFIRMED=<fixtureId>           (after receiving the primary alias probe)
 *   CLP_CANARY_ALIAS_CONFIRMED=<fixtureId>             (after receiving the canary alias probe)
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const FILES = Object.freeze({
  ownership: "fixture-ownership.private.json",
  state: "fixture-state.private.json",
  devices: "load-devices.private.json",
  commands: "load-command-bodies.private.json",
  auth: "load-auth.private.json",
  verification: "verification.private.json",
  prerequisites: "prerequisites.private.json",
  cleanup: "cleanup-result.private.json",
});

const COUNTS = Object.freeze({ teachers: 20, classes: 20, classSize: 40, primaryStudents: 1000, canaryStudents: 10 });
// ClassPilot PIN generation uses bcrypt cost 12 for every imported student.
// Keep each request well below CloudFront's 30-second origin-response ceiling
// on a 0.5-vCPU launch task; total provisioning throughput is unchanged because
// batches run sequentially.
const STUDENT_IMPORT_BATCH_SIZE = 10;
const SYNTHETIC_SCHOOL_MARKER = "[SYNTHETIC LOAD TEST - NON-BILLABLE]";
const OWNERSHIP_ACK = "TOOL_OWNED_MARKED_NON_BILLABLE_SYNTHETIC_TENANTS_ONLY";
const EMAIL_DELIVERY_ACK = "ALL_SYNTHETIC_EMAILS_ROUTE_PLUS_ALIASES_TO_OPERATOR_MAILBOX";
const HOLD_DAYS = 30;
const SECRET_FIELD = /(password|secret|token|enrollment.?key|cookie|csrf)/i;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isFixtureTestMode() {
  return process.env.NODE_ENV === "test"
    && process.env.CLP_LOAD_FIXTURE_TEST_MODE === "1"
    && Boolean(process.env.CLP_LOAD_GATES_TEST_ROOT)
    && isPathInside(path.resolve(process.env.CLP_LOAD_GATES_TEST_ROOT), path.resolve(os.tmpdir()));
}

export function configuredLoadGatesRoot(env = process.env) {
  if (env.CLP_LOAD_GATES_TEST_ROOT) {
    if (env.NODE_ENV !== "test" || env.CLP_LOAD_FIXTURE_TEST_MODE !== "1") {
      throw new SafeError("CLP_LOAD_GATES_TEST_ROOT requires NODE_ENV=test and CLP_LOAD_FIXTURE_TEST_MODE=1");
    }
    const testRoot = path.resolve(env.CLP_LOAD_GATES_TEST_ROOT);
    if (!isPathInside(testRoot, path.resolve(os.tmpdir()))) {
      throw new SafeError("CLP_LOAD_GATES_TEST_ROOT is permitted only under the operating-system temp directory");
    }
    return testRoot;
  }
  const localAppData = requiredString(env.LOCALAPPDATA, "LOCALAPPDATA");
  return path.resolve(localAppData, "SchoolPilot", "load-gates");
}

export class SafeError extends Error {
  constructor(message, code = "SAFE_ERROR") {
    super(message);
    this.name = "SafeError";
    this.code = code;
  }
}

export class HttpStatusError extends SafeError {
  constructor(method, route, status) {
    super(`HTTP ${status} from ${method} ${safeRouteLabel(route)}`, "HTTP_STATUS");
    this.status = status;
    this.method = method;
    this.route = safeRouteLabel(route);
  }
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new SafeError(`${label} is required`);
  return value.trim();
}

function safeRouteLabel(route) {
  const value = String(route || "");
  const query = value.indexOf("?");
  return query === -1 ? value : value.slice(0, query);
}

function normalizeComparablePath(value) {
  const resolved = path.resolve(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPathInside(child, parent) {
  const childPath = normalizeComparablePath(child);
  const parentPath = normalizeComparablePath(parent);
  return childPath === parentPath || childPath.startsWith(`${parentPath}${path.sep}`);
}

function prospectiveRealPath(target) {
  let cursor = path.resolve(target);
  const suffix = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  const realAncestor = fs.realpathSync(cursor);
  return path.join(realAncestor, ...suffix);
}

export function assertExternalPaths(
  configPath,
  outputPath,
  repoRoot = REPO_ROOT,
  loadGatesRoot = configuredLoadGatesRoot(),
) {
  if (!path.isAbsolute(configPath) || !path.isAbsolute(outputPath)) {
    throw new SafeError("--config and --output must both be absolute paths");
  }
  if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) {
    throw new SafeError("--config must identify an existing JSON file");
  }
  const realRepo = fs.realpathSync(repoRoot);
  const realConfig = fs.realpathSync(configPath);
  const prospectiveOutput = prospectiveRealPath(outputPath);
  const prospectiveLoadGatesRoot = prospectiveRealPath(loadGatesRoot);
  if (isPathInside(realConfig, realRepo) || isPathInside(prospectiveOutput, realRepo)) {
    throw new SafeError("Configuration and output paths must be outside the SchoolPilot repository");
  }
  if (!isPathInside(prospectiveOutput, prospectiveLoadGatesRoot)) {
    throw new SafeError("--output must be under %LOCALAPPDATA%\\SchoolPilot\\load-gates");
  }
  if (normalizeComparablePath(realConfig) === normalizeComparablePath(prospectiveOutput)) {
    throw new SafeError("--output must be a directory distinct from --config");
  }
  return {
    configPath: realConfig,
    outputPath: prospectiveOutput,
    loadGatesRoot: prospectiveLoadGatesRoot,
  };
}

function currentWindowsIdentity() {
  const result = spawnSync("whoami", [], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0 || !result.stdout.trim()) throw new SafeError("Could not determine the Windows identity for output ACLs");
  return result.stdout.trim();
}

function restrictAcl(target, directory) {
  if (process.platform === "win32") {
    const grant = `${currentWindowsIdentity()}:${directory ? "(OI)(CI)F" : "F"}`;
    const result = spawnSync("icacls", [target, "/inheritance:r", "/grant:r", grant], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0) throw new SafeError("Could not apply a private Windows ACL to an output artifact");
    return;
  }
  fs.chmodSync(target, directory ? 0o700 : 0o600);
}

export function preparePrivateOutputDirectory(outputPath, loadGatesRoot = configuredLoadGatesRoot()) {
  const prospectiveRoot = prospectiveRealPath(loadGatesRoot);
  const prospectiveOutput = prospectiveRealPath(outputPath);
  if (!isPathInside(prospectiveOutput, prospectiveRoot)) {
    throw new SafeError("Private load artifacts must stay under %LOCALAPPDATA%\\SchoolPilot\\load-gates");
  }
  fs.mkdirSync(prospectiveRoot, { recursive: true, mode: 0o700 });
  restrictAcl(fs.realpathSync(prospectiveRoot), true);
  fs.mkdirSync(outputPath, { recursive: true, mode: 0o700 });
  const real = fs.realpathSync(outputPath);
  if (isPathInside(real, fs.realpathSync(REPO_ROOT))) throw new SafeError("Resolved output directory is inside the repository");
  restrictAcl(real, true);
  return real;
}

export function writePrivateJson(outputDirectory, filename, value) {
  if (path.basename(filename) !== filename || !filename.endsWith(".json")) throw new SafeError("Invalid private artifact filename");
  const target = path.join(outputDirectory, filename);
  const temporary = path.join(outputDirectory, `.${filename}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`);
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, payload, { encoding: "utf8" });
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    restrictAcl(temporary, false);
    fs.renameSync(temporary, target);
    restrictAcl(target, false);
    return target;
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
    if (error instanceof SafeError) throw error;
    throw new SafeError("Could not atomically write a private output artifact");
  }
}

function readJsonFile(filename, label) {
  try {
    return JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch {
    throw new SafeError(`${label} must contain valid JSON`);
  }
}

function rejectSecretFields(value, trail = "config") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_FIELD.test(key)) throw new SafeError(`${trail} must not contain credential or token fields; use process environment variables`);
    rejectSecretFields(child, `${trail}.${key}`);
  }
}

function normalizeEmail(value, label) {
  const email = requiredString(value, label).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new SafeError(`${label} must be a valid email address`);
  return email;
}

function normalizeSchool(value, label, fixtureId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SafeError(`${label} is required`);
  const name = requiredString(value.name, `${label}.name`);
  const domain = requiredString(value.domain, `${label}.domain`).toLowerCase();
  const adminEmail = normalizeEmail(value.adminEmail, `${label}.adminEmail`);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw new SafeError(`${label}.domain is invalid`);
  if (adminEmail.split("@")[1] !== domain) throw new SafeError(`${label}.adminEmail must use ${label}.domain`);
  if (!name.includes(SYNTHETIC_SCHOOL_MARKER) || !name.toLowerCase().includes(fixtureId.toLowerCase())) {
    throw new SafeError(`${label}.name must include the literal non-billable synthetic marker and fixtureId`);
  }
  return { name, domain, adminEmail, id: value.id ? requiredString(value.id, `${label}.id`) : null };
}

export function validateConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SafeError("Config must be a JSON object");
  rejectSecretFields(raw);
  if (raw.version !== 1) throw new SafeError("Config version must be 1");
  const fixtureId = requiredString(raw.fixtureId, "fixtureId").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{2,40}$/.test(fixtureId)) throw new SafeError("fixtureId must be 3-41 lowercase letters, digits, or hyphens");
  if (raw.ownershipAcknowledgement !== OWNERSHIP_ACK) {
    throw new SafeError(`ownershipAcknowledgement must equal ${OWNERSHIP_ACK}`);
  }
  let baseUrl;
  try { baseUrl = new URL(requiredString(raw.baseUrl, "baseUrl")); } catch { throw new SafeError("baseUrl must be a valid URL"); }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(baseUrl.hostname);
  if (baseUrl.protocol !== "https:" && !(loopback && baseUrl.protocol === "http:")) {
    throw new SafeError("baseUrl must use HTTPS (HTTP is allowed only for a loopback test server)");
  }
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) throw new SafeError("baseUrl must not contain credentials, a query, or a fragment");
  baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, "");
  const primary = normalizeSchool(raw.schools?.primary, "schools.primary", fixtureId);
  const canary = normalizeSchool(raw.schools?.canary, "schools.canary", fixtureId);
  if (primary.name === canary.name) throw new SafeError("Primary and canary schools must use different names");
  if (raw.emailDeliveryAcknowledgement !== EMAIL_DELIVERY_ACK) {
    throw new SafeError(`emailDeliveryAcknowledgement must equal ${EMAIL_DELIVERY_ACK}`);
  }
  const operatorMailboxEmail = normalizeEmail(raw.operatorMailboxEmail, "operatorMailboxEmail");
  const [operatorMailboxLocalPart, operatorMailboxDomain] = operatorMailboxEmail.split("@");
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(operatorMailboxLocalPart)) {
    throw new SafeError("operatorMailboxEmail must name the base mailbox, not a plus alias");
  }
  if (operatorMailboxDomain !== primary.domain) {
    throw new SafeError("operatorMailboxEmail must use schools.primary.domain");
  }
  const operatorOwnedAdminEmail = normalizeEmail(raw.operatorOwnedAdminEmail, "operatorOwnedAdminEmail");
  if (operatorOwnedAdminEmail !== primary.adminEmail) throw new SafeError("operatorOwnedAdminEmail must equal schools.primary.adminEmail");
  if (primary.adminEmail === canary.adminEmail) throw new SafeError("Primary and canary schools must use different verified admin aliases");
  const plusAliasPrefix = `${operatorMailboxLocalPart}+`;
  for (const [label, email] of [["schools.primary.adminEmail", primary.adminEmail], ["schools.canary.adminEmail", canary.adminEmail]]) {
    if (!email.split("@")[0].startsWith(plusAliasPrefix)) {
      throw new SafeError(`${label} must be a plus alias of operatorMailboxEmail`);
    }
  }
  const aliases = {
    teacherPrefix: requiredString(raw.aliases?.teacherPrefix, "aliases.teacherPrefix").toLowerCase(),
    primaryStudentPrefix: requiredString(raw.aliases?.primaryStudentPrefix, "aliases.primaryStudentPrefix").toLowerCase(),
    canaryStudentPrefix: requiredString(raw.aliases?.canaryStudentPrefix, "aliases.canaryStudentPrefix").toLowerCase(),
  };
  for (const [key, value] of Object.entries(aliases)) {
    if (!/^[a-z0-9][a-z0-9._+-]{1,40}$/.test(value)) throw new SafeError(`aliases.${key} is not a safe email local-part prefix`);
    if (!value.startsWith(plusAliasPrefix)) throw new SafeError(`aliases.${key} must be a plus alias prefix of operatorMailboxEmail`);
  }
  let commandUrl;
  try { commandUrl = new URL(raw.commandUrl || "https://example.edu/schoolpilot-load-test"); } catch { throw new SafeError("commandUrl must be a valid URL"); }
  if (commandUrl.protocol !== "https:") throw new SafeError("commandUrl must use HTTPS");
  const registrationRequestsPerMinute = Number(raw.registrationRequestsPerMinute ?? 600);
  if (!Number.isInteger(registrationRequestsPerMinute) || registrationRequestsPerMinute < 60 || registrationRequestsPerMinute > 900) {
    throw new SafeError("registrationRequestsPerMinute must be an integer from 60 through 900");
  }
  return Object.freeze({
    version: 1,
    fixtureId,
    baseUrl: baseUrl.toString().replace(/\/$/, ""),
    ownershipAcknowledgement: OWNERSHIP_ACK,
    emailDeliveryAcknowledgement: EMAIL_DELIVERY_ACK,
    operatorMailboxEmail,
    operatorOwnedAdminEmail,
    allowSchoolCreation: raw.allowSchoolCreation === true,
    cleanupOwnedSchools: raw.cleanupOwnedSchools === true,
    schools: { primary, canary },
    aliases,
    commandUrl: commandUrl.toString(),
    registrationRequestsPerMinute,
    timezone: typeof raw.timezone === "string" && raw.timezone.trim() ? raw.timezone.trim() : "America/New_York",
  });
}

export function loadExternalConfig(configPath) {
  return validateConfig(readJsonFile(configPath, "Config"));
}

function numberedEmail(prefix, ordinal, width, domain) {
  return `${prefix}-${String(ordinal).padStart(width, "0")}@${domain}`;
}

export function buildFixtureBlueprint(config) {
  const teachers = Array.from({ length: COUNTS.teachers }, (_, index) => ({
    ordinal: index + 1,
    email: numberedEmail(config.aliases.teacherPrefix, index + 1, 2, config.schools.primary.domain),
    name: `${config.fixtureId} Load Teacher ${String(index + 1).padStart(2, "0")}`,
  }));
  const primaryStudents = Array.from({ length: COUNTS.primaryStudents }, (_, index) => ({
    ordinal: index + 1,
    email: numberedEmail(config.aliases.primaryStudentPrefix, index + 1, 4, config.schools.primary.domain),
    firstName: "Load",
    lastName: `Student ${String(index + 1).padStart(4, "0")}`,
    studentIdNumber: `${config.fixtureId.toUpperCase()}-P-${String(index + 1).padStart(4, "0")}`,
  }));
  const canaryStudents = Array.from({ length: COUNTS.canaryStudents }, (_, index) => ({
    ordinal: index + 1,
    email: numberedEmail(config.aliases.canaryStudentPrefix, index + 1, 3, config.schools.canary.domain),
    firstName: "Canary",
    lastName: `Student ${String(index + 1).padStart(3, "0")}`,
    studentIdNumber: `${config.fixtureId.toUpperCase()}-C-${String(index + 1).padStart(3, "0")}`,
  }));
  const classes = Array.from({ length: COUNTS.classes }, (_, index) => {
    const first = primaryStudents.slice(index * 25, index * 25 + 25);
    const secondStart = 500 + index * 15;
    const second = primaryStudents.slice(secondStart, secondStart + 15);
    return {
      ordinal: index + 1,
      name: `${config.fixtureId} Load Class ${String(index + 1).padStart(2, "0")}`,
      description: `synthetic-load-fixture:${config.fixtureId}:class:${String(index + 1).padStart(2, "0")}`,
      teacherEmail: teachers[index].email,
      studentEmails: [...first, ...second].map((student) => student.email),
    };
  });
  const primaryDevices = primaryStudents.map((student, index) => {
    const tranche = index < 500 ? "class-first-25" : index < 800 ? "class-remaining-15" : "burst-200";
    const classOrdinal = index < 500 ? Math.floor(index / 25) + 1 : index < 800 ? Math.floor((index - 500) / 15) + 1 : null;
    return {
      deviceId: `${config.fixtureId}-primary-${String(index + 1).padStart(4, "0")}`,
      schoolKey: "primary",
      studentEmail: student.email,
      studentOrdinal: student.ordinal,
      classOrdinal,
      cohort: tranche,
    };
  });
  const canaryDevices = canaryStudents.map((student, index) => ({
    deviceId: `${config.fixtureId}-canary-${String(index + 1).padStart(3, "0")}`,
    schoolKey: "canary",
    studentEmail: student.email,
    studentOrdinal: student.ordinal,
    classOrdinal: null,
    cohort: "second-school-canary-10",
  }));
  return {
    fixtureId: config.fixtureId,
    teachers,
    primaryStudents,
    canaryStudents,
    classes,
    devices: [...canaryDevices, ...primaryDevices.slice(0, 500), ...primaryDevices.slice(500, 800), ...primaryDevices.slice(800)],
  };
}

export function buildDryRunSummary(config) {
  const blueprint = buildFixtureBlueprint(config);
  return {
    dryRun: true,
    fixtureId: config.fixtureId,
    mutationsPerformed: 0,
    expected: {
      schools: 2,
      loadActors: { teachers: 20, commandAdmin: 1 },
      students: { primary: 1000, canary: 10, total: 1010, autoEnroll: false },
      classes: { count: 20, studentsEach: 40, disjoint: true, schedulesEnabled: false },
      deviceTokens: blueprint.devices.length,
      commandBodies: 20,
    },
    manifestOrder: [
      { cohort: "second-school-canary-10", start: 1, end: 10, count: 10 },
      { cohort: "class-first-25", start: 11, end: 510, count: 500 },
      { cohort: "class-remaining-15", start: 511, end: 810, count: 300 },
      { cohort: "burst-200", start: 811, end: 1010, count: 200 },
    ],
    requiredEnvironment: [
      "CLP_SUPER_ADMIN_BEARER OR (CLP_SUPER_ADMIN_EMAIL + CLP_SUPER_ADMIN_PASSWORD)", "CLP_FIXTURE_ADMIN_PASSWORD",
      "CLP_FIXTURE_TEACHER_PASSWORD", `CLP_OPERATOR_ALIAS_CONFIRMED=${config.fixtureId}`,
      `CLP_CANARY_ALIAS_CONFIRMED=${config.fixtureId}`,
    ],
  };
}

function headerValue(headers, name) {
  return headers?.get?.(name) ?? headers?.[name] ?? headers?.[name.toLowerCase()] ?? null;
}

function resetValueToDelayMs(raw, nowMs) {
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  if (numeric > 1_000_000_000) return Math.max(0, numeric * 1000 - nowMs);
  return numeric * 1000;
}

export function parseRateLimitDelayMs(headers, nowMs = Date.now(), remainingThreshold = 0) {
  const threshold = Number.isInteger(remainingThreshold) && remainingThreshold >= 0 ? remainingThreshold : 0;
  const isAtOrBelowThreshold = (value) => {
    if (value === null || value === undefined || String(value).trim() === "") return false;
    const numeric = Number(value);
    return Number.isInteger(numeric) && numeric >= 0 && numeric <= threshold;
  };
  const retryAfter = headerValue(headers, "retry-after");
  if (retryAfter) {
    const numeric = resetValueToDelayMs(retryAfter, nowMs);
    if (numeric !== null) return numeric;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - nowMs);
  }
  const combined = headerValue(headers, "ratelimit");
  if (combined) {
    const remaining = /(?:^|[;,\s])(?:remaining|r)\s*=\s*"?(\d+)/i.exec(combined)?.[1];
    const reset = /(?:^|[;,\s])(?:reset|t)\s*=\s*"?(\d+)/i.exec(combined)?.[1];
    if (isAtOrBelowThreshold(remaining) && reset) return resetValueToDelayMs(reset, nowMs);
  }
  const remaining = headerValue(headers, "ratelimit-remaining") ?? headerValue(headers, "x-ratelimit-remaining");
  const reset = headerValue(headers, "ratelimit-reset") ?? headerValue(headers, "x-ratelimit-reset");
  if (isAtOrBelowThreshold(remaining) && reset != null) return resetValueToDelayMs(reset, nowMs);
  return null;
}

class RateGate {
  constructor(sleepFn = sleep, now = () => Date.now(), remainingThreshold = 0) {
    this.sleepFn = sleepFn;
    this.now = now;
    this.remainingThreshold = remainingThreshold;
    this.notBefore = 0;
  }
  observe(headers) {
    const delay = parseRateLimitDelayMs(headers, this.now(), this.remainingThreshold);
    if (delay !== null) this.notBefore = Math.max(this.notBefore, this.now() + delay + 250);
  }
  async wait() {
    const delay = this.notBefore - this.now();
    if (delay > 0) await this.sleepFn(delay);
  }
}

class Pacer {
  constructor(requestsPerMinute, sleepFn = sleep, now = () => Date.now()) {
    this.interval = Math.ceil(60_000 / requestsPerMinute);
    this.sleepFn = sleepFn;
    this.now = now;
    this.next = 0;
  }
  async wait() {
    const delay = this.next - this.now();
    if (delay > 0) await this.sleepFn(delay);
    this.next = Math.max(this.next, this.now()) + this.interval;
  }
}

function runtimePacer(requestsPerMinute) {
  return isFixtureTestMode() ? { wait: async () => {} } : new Pacer(requestsPerMinute);
}

export class ApiClient {
  constructor(baseUrl, options = {}) {
    this.baseUrl = baseUrl;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.sleepFn = options.sleepFn || sleep;
    const now = options.now || (() => Date.now());
    this.rateGate = options.rateGate || new RateGate(this.sleepFn, now);
    this.loginRateGate = options.loginRateGate || new RateGate(this.sleepFn, now, 1);
    this.bearerSchoolIds = new Map();
  }

  bindBearerToSchool(bearer, schoolId) {
    if (typeof bearer !== "string" || !bearer || typeof schoolId !== "string" || !schoolId) {
      throw new SafeError("Cannot bind an invalid bearer token or school context");
    }
    this.bearerSchoolIds.set(bearer, schoolId);
  }

  async request(route, options = {}) {
    if (typeof route !== "string" || !route.startsWith("/") || route.startsWith("//") || route.includes("\\")) {
      throw new SafeError("API routes must be origin-relative paths");
    }
    const method = String(options.method || "GET").toUpperCase();
    const allowedStatuses = options.allowedStatuses || null;
    const maxAttempts = options.maxAttempts || 4;
    const rateGate = options.rateLimitScope === "login" ? this.loginRateGate : this.rateGate;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await rateGate.wait();
      if (options.pacer) await options.pacer.wait();
      const headers = { Accept: "application/json", "User-Agent": "SchoolPilot-ClassPilot-Load-Preparer/1" };
      if (options.body !== undefined) headers["Content-Type"] = "application/json";
      if (options.bearer) headers.Authorization = `Bearer ${options.bearer}`;
      if (options.cookie) headers.Cookie = options.cookie;
      const schoolId = options.schoolId || (options.bearer ? this.bearerSchoolIds.get(options.bearer) : null);
      if (schoolId) headers["X-School-ID"] = schoolId;
      for (const [key, value] of Object.entries(options.headers || {})) {
        if (key.toLowerCase() === "x-school-id" && schoolId && value !== schoolId) {
          throw new SafeError("Explicit X-School-ID conflicts with the verified bearer context");
        }
        headers[key] = value;
      }
      let response;
      try {
        response = await this.fetchImpl(new URL(route, this.baseUrl), {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          redirect: "error",
          signal: AbortSignal.timeout(options.timeoutMs || 30_000),
        });
      } catch {
        throw new SafeError(`Network request failed for ${method} ${safeRouteLabel(route)}`, "NETWORK_ERROR");
      }
      rateGate.observe(response.headers);
      if (response.status === 429 && attempt < maxAttempts) {
        const delay = parseRateLimitDelayMs(response.headers) ?? 60_000;
        if (delay > 30 * 60_000) throw new SafeError("Rate-limit reset exceeds the 30-minute safety ceiling", "RATE_LIMIT_WAIT");
        await this.sleepFn(delay + 250);
        continue;
      }
      const accepted = allowedStatuses ? allowedStatuses.includes(response.status) : response.ok;
      if (!accepted) throw new HttpStatusError(method, route, response.status);
      let data = null;
      if (response.status !== 204) {
        const text = await response.text();
        if (text) {
          try { data = JSON.parse(text); } catch { throw new SafeError(`Non-JSON response from ${method} ${safeRouteLabel(route)}`); }
        }
      }
      return { status: response.status, headers: response.headers, data };
    }
    throw new SafeError(`Rate-limited request did not complete for ${method} ${safeRouteLabel(route)}`);
  }
}

function envSecret(name, minimumLength = 1) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length < minimumLength) throw new SafeError(`${name} is required in the current process environment`);
  return value;
}

function nonEmptyEnvironmentValue(env, name) {
  const value = env[name];
  return typeof value === "string" && Boolean(value.trim());
}

export function superAdminAuthPrerequisiteReasons(env = process.env) {
  if (nonEmptyEnvironmentValue(env, "CLP_SUPER_ADMIN_BEARER")) return [];
  const reasons = [];
  if (!nonEmptyEnvironmentValue(env, "CLP_SUPER_ADMIN_EMAIL")) {
    reasons.push("CLP_SUPER_ADMIN_BEARER or CLP_SUPER_ADMIN_EMAIL is absent from the current process");
  }
  if (!nonEmptyEnvironmentValue(env, "CLP_SUPER_ADMIN_PASSWORD")) {
    reasons.push("CLP_SUPER_ADMIN_BEARER or CLP_SUPER_ADMIN_PASSWORD is absent from the current process");
  }
  return reasons;
}

function superAdminAuthFailure(message) {
  return new SafeError(message, "SUPER_ADMIN_AUTH");
}

function assertVerifiedSuperAdminIdentity(me, config) {
  const user = me?.data?.user;
  if (user?.isSuperAdmin !== true) {
    throw superAdminAuthFailure("The supplied super-admin authentication does not belong to a super administrator");
  }
  if (typeof user.id !== "string" || !user.id) {
    throw superAdminAuthFailure("The supplied super-admin authentication returned an invalid user identity");
  }
  const actualEmail = typeof user.email === "string" ? user.email.trim().toLowerCase() : "";
  if (actualEmail !== config.operatorMailboxEmail) {
    throw superAdminAuthFailure("The supplied super-admin authentication belongs to a different operator mailbox identity");
  }
}

/**
 * Resolve either a short-lived bearer obtained from the operator's normal
 * Google-backed session or the legacy email/password login. Both modes are
 * independently verified through /api/auth/me before any super-admin route is
 * used. The returned object intentionally contains only the in-memory bearer.
 */
export async function superAuthFromEnvironment(client, config, env = process.env) {
  const suppliedBearer = nonEmptyEnvironmentValue(env, "CLP_SUPER_ADMIN_BEARER")
    ? env.CLP_SUPER_ADMIN_BEARER
    : null;
  let bearer;
  if (suppliedBearer !== null) {
    if (suppliedBearer !== suppliedBearer.trim() || /\s/.test(suppliedBearer)) {
      throw superAdminAuthFailure("CLP_SUPER_ADMIN_BEARER must contain only the bearer token value without whitespace");
    }
    bearer = suppliedBearer;
  } else {
    const reasons = superAdminAuthPrerequisiteReasons(env);
    if (reasons.length) throw superAdminAuthFailure(reasons.join("; "));
    const email = normalizeEmail(env.CLP_SUPER_ADMIN_EMAIL, "CLP_SUPER_ADMIN_EMAIL");
    if (email !== config.operatorMailboxEmail) {
      throw superAdminAuthFailure("CLP_SUPER_ADMIN_EMAIL must exactly match operatorMailboxEmail");
    }
    const password = env.CLP_SUPER_ADMIN_PASSWORD;
    if (typeof password !== "string" || password.length < 8) {
      throw superAdminAuthFailure("CLP_SUPER_ADMIN_PASSWORD is required in the current process environment");
    }
    const auth = await login(client, email, password);
    bearer = auth.bearer;
  }
  const me = await client.request("/api/auth/me", { bearer });
  assertVerifiedSuperAdminIdentity(me, config);
  return { bearer };
}

function cookieFromHeaders(headers) {
  const values = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie")].filter(Boolean);
  for (const value of values) {
    const match = /(?:^|,\s*)(schoolpilot\.sid=[^;\s,]+)/i.exec(value);
    if (match) return match[1];
  }
  throw new SafeError("Login response did not issue the expected SchoolPilot session cookie");
}

function assertExactAuthMembership(memberships, expectedContext, source) {
  if (!Array.isArray(memberships) || memberships.length !== 1) {
    throw new SafeError(`${source} must expose exactly one active synthetic-school membership`);
  }
  const membership = memberships[0];
  if (
    membership?.schoolId !== expectedContext.schoolId
    || membership.role !== expectedContext.role
    || (membership.status !== undefined && membership.status !== "active")
    || (expectedContext.schoolName && membership.schoolName !== expectedContext.schoolName)
  ) {
    throw new SafeError(`${source} does not match the exact synthetic school and role`);
  }
  return membership;
}

export async function login(client, email, password, expectedContext = null) {
  const response = await client.request("/api/auth/login", {
    method: "POST",
    body: { email, password },
    rateLimitScope: "login",
  });
  const loginBearer = response.data?.token;
  if (typeof loginBearer !== "string" || !loginBearer) throw new SafeError("Login response did not include a bearer token");
  const cookie = cookieFromHeaders(response.headers);
  if (!expectedContext) {
    return { bearer: loginBearer, cookie, user: response.data?.user, memberships: response.data?.memberships || [] };
  }
  assertExactAuthMembership(response.data?.memberships, expectedContext, "Login response");
  const me = await client.request("/api/auth/me", { cookie, schoolId: expectedContext.schoolId });
  assertExactAuthMembership(me.data?.memberships, expectedContext, "Cookie session verification");
  if (!me.data?.user?.id || me.data.user.id !== response.data?.user?.id) {
    throw new SafeError("Cookie session verification returned a different user identity");
  }
  const bearer = me.data?.token;
  if (typeof bearer !== "string" || !bearer) throw new SafeError("Cookie session verification did not issue a bearer token");
  client.bindBearerToSchool(bearer, expectedContext.schoolId);
  return {
    bearer,
    cookie,
    user: me.data.user,
    memberships: me.data.memberships,
    schoolId: expectedContext.schoolId,
    role: expectedContext.role,
    sessionVerified: true,
  };
}

async function csrfForSession(client, auth) {
  if (!auth?.sessionVerified || !auth.schoolId) throw new SafeError("CSRF requires an exact verified school session");
  const response = await client.request("/api/auth/csrf", { cookie: auth.cookie, schoolId: auth.schoolId });
  const csrfToken = response.data?.csrfToken;
  if (typeof csrfToken !== "string" || !csrfToken) throw new SafeError("CSRF endpoint did not return a token");
  return csrfToken;
}

function decodeJwtExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return Number.isFinite(payload.exp) ? new Date(payload.exp * 1000).toISOString() : null;
  } catch { return null; }
}

function decodeJwtPayload(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

function requireArtifactCredential(value, label, options = {}) {
  const credential = typeof value === "string" ? value.trim() : "";
  if (!credential || /[\r\n]/.test(credential)) {
    throw new SafeError(`${label} is missing or malformed`);
  }
  if (options.cookie === true && !/(?:^|;\s*)schoolpilot\.sid=[^;\s]+/.test(credential)) {
    throw new SafeError(`${label} does not contain the SchoolPilot session cookie`);
  }
  return credential;
}

function requireFutureArtifactExpiry(value, label, nowMs) {
  const expiresAt = typeof value === "number" ? value : Date.parse(String(value || ""));
  if (!Number.isFinite(expiresAt)) throw new SafeError(`${label} is malformed`);
  if (expiresAt <= nowMs) throw new SafeError(`${label} is expired`);
  return expiresAt;
}

function assertArtifactJwtIdentity(token, expected, label, nowMs) {
  const payload = decodeJwtPayload(token);
  if (!payload || !Number.isFinite(payload.exp) || payload.exp * 1000 <= nowMs) {
    throw new SafeError(`${label} is expired or malformed`);
  }
  if (payload.userId !== expected.userId || String(payload.email || "").toLowerCase() !== expected.email) {
    throw new SafeError(`${label} does not match its exact fixture identity`);
  }
  return payload;
}

function exactStringSet(actual, expected) {
  return actual.size === expected.size && [...actual].every((value) => expected.has(value));
}

/**
 * Validate every locally persisted staff authentication artifact without
 * logging any credential. Signature/session validity is then proved by
 * runVerify through the supported /auth/me endpoint.
 */
export function validateAuthArtifactContract(artifact, config, state, nowMs = Date.now()) {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact) || artifact.schemaVersion !== 2) {
    throw new SafeError("Teacher auth artifact must use schemaVersion 2");
  }
  const primarySchool = state.schools?.primary;
  if (artifact.baseUrl !== config.baseUrl || artifact.schoolId !== primarySchool?.id) {
    throw new SafeError("Teacher auth artifact targets a different origin or primary school");
  }
  if (artifact.role !== "school_admin") {
    throw new SafeError("Teacher auth artifact command administrator must use the school_admin role contract");
  }

  const adminIdentity = {
    userId: state.admin?.userId,
    email: String(state.admin?.email || "").toLowerCase(),
  };
  if (!adminIdentity.userId || adminIdentity.email !== config.schools.primary.adminEmail) {
    throw new SafeError("Fixture state is missing the exact primary command administrator identity");
  }
  const commandAdmin = {
    cookie: requireArtifactCredential(artifact.teacherCookie, "Command administrator cookie", { cookie: true }),
    csrf: requireArtifactCredential(artifact.csrfToken, "Command administrator CSRF token"),
    token: requireArtifactCredential(artifact.teacherToken, "Command administrator bearer token"),
  };
  requireFutureArtifactExpiry(artifact.expiresAt, "Teacher auth artifact expiry", nowMs);
  requireFutureArtifactExpiry(artifact.deviceManifestExpiresAt, "Teacher auth artifact device-manifest expiry", nowMs);
  assertArtifactJwtIdentity(commandAdmin.token, adminIdentity, "Command administrator bearer token", nowMs);

  if (!Array.isArray(artifact.teacherAuth) || artifact.teacherAuth.length !== COUNTS.teachers) {
    throw new SafeError("Teacher auth artifact must contain exactly 20 teacher entries");
  }
  const stateTeachers = new Map((state.teachers || []).map((teacher) => [teacher.userId, teacher]));
  const stateSessionsByTeacher = new Map();
  for (const session of state.sessions || []) {
    if (!session?.teacherUserId || stateSessionsByTeacher.has(session.teacherUserId)) {
      throw new SafeError("Fixture state must map one exact live session to each synthetic teacher");
    }
    stateSessionsByTeacher.set(session.teacherUserId, session);
  }
  const seenTeacherIds = new Set();
  const seenSessionIds = new Set();
  const seenCookies = new Set();
  const seenTokens = new Set();
  const allMappedStudentIds = new Set();
  const validatedTeachers = [];

  for (const [index, entry] of artifact.teacherAuth.entries()) {
    const label = `Teacher auth entry ${index + 1}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new SafeError(`${label} is malformed`);
    }
    const teacher = stateTeachers.get(entry.teacherId);
    const session = teacher ? stateSessionsByTeacher.get(teacher.userId) : null;
    if (
      !teacher
      || entry.schoolId !== primarySchool.id
      || entry.role !== "teacher"
      || !session
      || session.teacherUserId !== teacher.userId
      || session.classId !== teacher.classId
      || entry.teachingSessionId !== session.sessionId
    ) {
      throw new SafeError(`${label} does not map to its exact teacher, class, session, and primary school`);
    }
    const cookie = requireArtifactCredential(entry.teacherCookie, `${label} cookie`, { cookie: true });
    const csrf = requireArtifactCredential(entry.csrfToken, `${label} CSRF token`);
    const token = requireArtifactCredential(entry.teacherToken, `${label} bearer token`);
    requireFutureArtifactExpiry(entry.expiresAt, `${label} expiry`, nowMs);
    assertArtifactJwtIdentity(token, {
      userId: teacher.userId,
      email: String(teacher.email || "").toLowerCase(),
    }, `${label} bearer token`, nowMs);

    const expectedStudentIds = new Set(
      state.devices
        .filter((device) => device.schoolKey === "primary" && device.classId === teacher.classId)
        .map((device) => device.studentId),
    );
    const actualStudentIds = new Set(Array.isArray(entry.studentIds) ? entry.studentIds.map(String) : []);
    if (
      expectedStudentIds.size !== COUNTS.classSize
      || actualStudentIds.size !== COUNTS.classSize
      || entry.studentIds.length !== COUNTS.classSize
      || !exactStringSet(actualStudentIds, expectedStudentIds)
    ) {
      throw new SafeError(`${label} does not contain the exact 40-student class mapping`);
    }
    if (
      seenTeacherIds.has(teacher.userId)
      || seenSessionIds.has(session.sessionId)
      || seenCookies.has(cookie)
      || seenTokens.has(token)
    ) {
      throw new SafeError("Teacher auth artifact contains a duplicate teacher identity, session, cookie, or token");
    }
    for (const studentId of actualStudentIds) {
      if (allMappedStudentIds.has(studentId)) {
        throw new SafeError("Teacher auth artifact class mappings are not disjoint");
      }
      allMappedStudentIds.add(studentId);
    }
    seenTeacherIds.add(teacher.userId);
    seenSessionIds.add(session.sessionId);
    seenCookies.add(cookie);
    seenTokens.add(token);
    validatedTeachers.push({ teacher, session, cookie, csrf, token });
  }
  if (
    seenTeacherIds.size !== COUNTS.teachers
    || seenSessionIds.size !== COUNTS.teachers
    || allMappedStudentIds.size !== COUNTS.teachers * COUNTS.classSize
  ) {
    throw new SafeError("Teacher auth artifact does not cover 20 unique teachers, sessions, and 800 disjoint students");
  }
  return { commandAdmin, teachers: validatedTeachers };
}

function chunk(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function assertSchoolIsNonBillable(school, label) {
  if (!school || typeof school !== "object") throw new SafeError(`${label} school response is missing`);
  if (school.stripeCustomerId || school.stripeSubscriptionId || school.billingEmail) {
    throw new SafeError(`${label} school is billing-linked; refusing to use it as a synthetic fixture`);
  }
}

function emptyOwnership(config) {
  return {
    schemaVersion: 2,
    fixtureId: config.fixtureId,
    baseUrl: config.baseUrl,
    ownershipAcknowledgement: config.ownershipAcknowledgement,
    updatedAt: new Date().toISOString(),
    schools: {},
    teachers: {},
    pendingCreateIntents: { schools: {}, teachers: {} },
  };
}

function validateOwnershipContract(value, config) {
  if (!value || value.schemaVersion !== 2 || value.fixtureId !== config.fixtureId || value.baseUrl !== config.baseUrl) {
    throw new SafeError("Fixture ownership ledger does not match the current config");
  }
  if (value.ownershipAcknowledgement !== OWNERSHIP_ACK) throw new SafeError("Fixture ownership ledger lacks the ownership acknowledgement");
  if (
    !value.schools || typeof value.schools !== "object"
    || !value.teachers || typeof value.teachers !== "object"
    || !value.pendingCreateIntents?.schools || typeof value.pendingCreateIntents.schools !== "object"
    || !value.pendingCreateIntents?.teachers || typeof value.pendingCreateIntents.teachers !== "object"
  ) {
    throw new SafeError("Fixture ownership ledger is malformed");
  }
  for (const [key, owned] of Object.entries(value.schools)) {
    const spec = config.schools[key];
    if (!spec || !owned?.id || owned.createdByTool !== true || owned.name !== spec.name || String(owned.domain || "").toLowerCase() !== spec.domain) {
      throw new SafeError("Fixture ownership ledger contains an unexpected school identity");
    }
  }
  for (const [role, intent] of Object.entries(value.pendingCreateIntents.schools)) {
    if (
      !config.schools[role]
      || !schoolIntentMatches(intent, config.schools[role])
      || (intent.schoolId !== undefined && (typeof intent.schoolId !== "string" || !intent.schoolId))
    ) {
      throw new SafeError("Fixture ownership ledger contains an invalid pending school create intent");
    }
  }
  const plannedTeacherByEmail = new Map(buildFixtureBlueprint(config).teachers.map((teacher) => [teacher.email, teacher]));
  for (const [email, intent] of Object.entries(value.pendingCreateIntents.teachers)) {
    const teacher = plannedTeacherByEmail.get(email);
    if (!teacher || intent?.email !== email || intent.name !== teacher.name || intent.role !== "teacher" || !intent.schoolId) {
      throw new SafeError("Fixture ownership ledger contains an invalid pending teacher create intent");
    }
  }
  return value;
}

function ownershipPath(outputDirectory) {
  return path.join(outputDirectory, FILES.ownership);
}

function readOwnership(outputDirectory, config) {
  const target = ownershipPath(outputDirectory);
  if (!fs.existsSync(target)) return emptyOwnership(config);
  return validateOwnershipContract(readJsonFile(target, "Fixture ownership ledger"), config);
}

function persistOwnership(outputDirectory, ownership) {
  ownership.updatedAt = new Date().toISOString();
  writePrivateJson(outputDirectory, FILES.ownership, ownership);
}

function recordOwnedSchool(outputDirectory, ownership, role, school, createdByTool) {
  const existing = ownership.schools[role];
  if (existing && (existing.id !== school.id || existing.name !== school.name || String(existing.domain).toLowerCase() !== String(school.domain).toLowerCase())) {
    throw new SafeError(`Durable ${role} school ownership conflicts with the discovered resource`);
  }
  ownership.schools[role] = {
    id: school.id,
    name: school.name,
    domain: String(school.domain).toLowerCase(),
    createdByTool: existing?.createdByTool === true || createdByTool === true,
    recordedAt: existing?.recordedAt || new Date().toISOString(),
    billingProtectionVerified: true,
  };
  if (!ownership.schools[role].createdByTool) throw new SafeError("Synthetic schools must be durably tool-owned");
  delete ownership.pendingCreateIntents.schools[role];
  persistOwnership(outputDirectory, ownership);
  return ownership.schools[role];
}

function recordOwnedTeacher(outputDirectory, ownership, teacher, entry) {
  const existing = ownership.teachers[teacher.email];
  if (existing && (existing.userId !== entry.userId || existing.membershipId !== entry.membershipId)) {
    throw new SafeError("Durable teacher ownership conflicts with the discovered identity");
  }
  ownership.teachers[teacher.email] = {
    email: teacher.email,
    name: teacher.name,
    userId: entry.userId,
    membershipId: entry.membershipId,
    recordedAt: existing?.recordedAt || new Date().toISOString(),
  };
  delete ownership.pendingCreateIntents.teachers[teacher.email];
  persistOwnership(outputDirectory, ownership);
}

function checkpointSchoolCreateIntent(outputDirectory, ownership, role, spec) {
  const current = ownership.pendingCreateIntents.schools[role];
  const intent = {
    role,
    name: spec.name,
    domain: spec.domain,
    adminEmail: spec.adminEmail,
    marker: SYNTHETIC_SCHOOL_MARKER,
    requestedAt: current?.requestedAt || new Date().toISOString(),
    ...(current?.schoolId ? { schoolId: current.schoolId } : {}),
  };
  if (current && (current.name !== intent.name || current.domain !== intent.domain || current.adminEmail !== intent.adminEmail)) {
    throw new SafeError(`Pending ${role} school creation intent conflicts with config`);
  }
  ownership.pendingCreateIntents.schools[role] = intent;
  persistOwnership(outputDirectory, ownership);
  return intent;
}

function checkpointTeacherCreateIntent(outputDirectory, ownership, teacher, schoolId) {
  const current = ownership.pendingCreateIntents.teachers[teacher.email];
  const intent = {
    email: teacher.email,
    name: teacher.name,
    schoolId,
    role: "teacher",
    requestedAt: current?.requestedAt || new Date().toISOString(),
  };
  if (current && (current.name !== intent.name || current.schoolId !== schoolId || current.role !== "teacher")) {
    throw new SafeError("Pending teacher creation intent conflicts with the exact fixture identity");
  }
  ownership.pendingCreateIntents.teachers[teacher.email] = intent;
  persistOwnership(outputDirectory, ownership);
  return intent;
}

function schoolIntentMatches(intent, spec) {
  return intent?.role && intent.name === spec.name && intent.domain === spec.domain
    && intent.adminEmail === spec.adminEmail && intent.marker === SYNTHETIC_SCHOOL_MARKER;
}

function bindSchoolCreateIntentToResource(outputDirectory, ownership, role, spec, schoolId) {
  const intent = ownership.pendingCreateIntents.schools[role];
  if (!schoolIntentMatches(intent, spec)) {
    throw new SafeError(`Cannot bind an invalid pending ${role} school create intent`);
  }
  if (typeof schoolId !== "string" || !schoolId) throw new SafeError("Cannot bind a pending school intent without an exact resource id");
  if (intent.schoolId && intent.schoolId !== schoolId) {
    throw new SafeError(`Pending ${role} school create intent is already bound to a different resource`);
  }
  intent.schoolId = schoolId;
  persistOwnership(outputDirectory, ownership);
  return intent;
}

function teacherIntentMatches(intent, teacher, schoolId) {
  return intent?.email === teacher.email && intent.name === teacher.name
    && intent.schoolId === schoolId && intent.role === "teacher";
}

function seedOwnershipFromState(ownership, state) {
  if (!state) return ownership;
  for (const role of ["primary", "canary"]) {
    const school = state.schools?.[role];
    if (!school?.id) continue;
    const current = ownership.schools[role];
    if (current && current.id !== school.id) throw new SafeError("Existing state and ownership ledger disagree on a school id");
    ownership.schools[role] = {
      id: school.id,
      name: school.name,
      domain: String(school.domain).toLowerCase(),
      createdByTool: current?.createdByTool === true || school.createdByTool === true,
      recordedAt: current?.recordedAt || state.generatedAt || new Date().toISOString(),
      billingProtectionVerified: true,
    };
    if (!ownership.schools[role].createdByTool) throw new SafeError("Fixture state contains a school that is not durably tool-owned");
  }
  for (const teacher of state.teachers || []) {
    const current = ownership.teachers[teacher.email];
    if (current && (current.userId !== teacher.userId || current.membershipId !== teacher.membershipId)) {
      throw new SafeError("Existing state and ownership ledger disagree on a teacher identity");
    }
    ownership.teachers[teacher.email] = {
      email: teacher.email,
      name: teacher.name,
      userId: teacher.userId,
      membershipId: teacher.membershipId,
      recordedAt: current?.recordedAt || state.generatedAt || new Date().toISOString(),
    };
  }
  return ownership;
}

function prerequisiteManifest(config, reasons) {
  return {
    schemaVersion: 1,
    status: "blocked",
    fixtureId: config.fixtureId,
    reasons,
    directDatabaseChangesPermitted: false,
    requiredEnvironment: {
      provisioning: [
        "CLP_SUPER_ADMIN_BEARER OR (CLP_SUPER_ADMIN_EMAIL + CLP_SUPER_ADMIN_PASSWORD)",
        "CLP_FIXTURE_ADMIN_PASSWORD",
        "CLP_FIXTURE_TEACHER_PASSWORD",
      ],
      emailDeliveryGates: {
        primary: `After receiving a test or welcome message at ${config.schools.primary.adminEmail}, set CLP_OPERATOR_ALIAS_CONFIRMED=${config.fixtureId} for that one process.`,
        canary: `After receiving a test or welcome message at ${config.schools.canary.adminEmail}, set CLP_CANARY_ALIAS_CONFIRMED=${config.fixtureId} for that one process.`,
      },
    },
    requiredSchools: Object.entries(config.schools).map(([role, school]) => ({
      role,
      expectedId: school.id,
      exactName: school.name,
      exactDomain: school.domain,
      adminEmail: school.adminEmail,
      status: "active",
      activeProduct: "CLASSPILOT",
      trackingHoursEnabled: false,
      autoEnrollStudents: false,
    })),
    safeResolution: config.allowSchoolCreation
      ? "Supply a super-admin bearer from the operator's normal sign-in session, or the matching email/password, through this process so the CLI can discover/create only these exact synthetic schools through /api/super-admin/schools."
      : "Set allowSchoolCreation=true for the initial tool-owned creation, or restore the matching private ownership ledger for an already tool-created fixture. Manually created schools are never adopted.",
  };
}

function failPrerequisite(outputDirectory, config, reasons) {
  writePrivateJson(outputDirectory, FILES.prerequisites, prerequisiteManifest(config, reasons));
  throw new SafeError(`Fixture prerequisites are incomplete; review ${FILES.prerequisites}`, "PREREQUISITE");
}

async function verifyBillingAndEnsureClassPilot(client, superAuth, school) {
  const detail = await client.request(`/api/super-admin/schools/${encodeURIComponent(school.id)}`, { bearer: superAuth.bearer });
  if (detail.data?.id !== school.id) {
    throw new SafeError("Synthetic school detail verification returned a different tenant");
  }
  assertSchoolIsNonBillable(detail.data, "Synthetic");
  const billing = await client.request(`/api/super-admin/schools/${encodeURIComponent(school.id)}/billing`, {
    bearer: superAuth.bearer,
  });
  assertNoStripeBilling(billing.data);
  const products = Array.isArray(detail.data?.products) ? detail.data.products : [];
  if (!products.includes("CLASSPILOT")) {
    await client.request(`/api/super-admin/schools/${encodeURIComponent(school.id)}/products`, {
      method: "POST", bearer: superAuth.bearer, body: { product: "CLASSPILOT" },
    });
  }
  return detail.data?.schoolHours || {};
}

async function disableTrackingAfterInventoryPreflight(client, superAuth, school, hours = {}) {
  await client.request(`/api/super-admin/schools/${encodeURIComponent(school.id)}`, {
    method: "PATCH",
    bearer: superAuth.bearer,
    body: {
      schoolHours: {
        enabled: false,
        startTime: hours.startTime || "08:00",
        endTime: hours.endTime || "15:00",
        timezone: hours.timezone || "America/New_York",
        days: hours.days || ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
        afterHoursMode: "off",
      },
    },
  });
}

export function assertNoStripeBilling(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || "billing" in payload || "school" in payload) {
    throw new SafeError("Synthetic school billing verification response is invalid");
  }
  if (payload.stripeCustomerId || payload.stripeSubscriptionId || payload.billingEmail) {
    throw new SafeError("A configured synthetic school has Stripe billing records and cannot be used for a non-billable load gate");
  }
  return true;
}

export function selectConfiguredSchool(schools, spec, role) {
  const all = Array.isArray(schools) ? schools : [];
  const exact = all.filter((school) => school?.name === spec.name
    && String(school?.domain || "").toLowerCase() === spec.domain);
  if (exact.length > 1) {
    throw new SafeError(`Multiple schools use the configured ${role} name and domain; refusing an ambiguous mutation`);
  }
  const school = exact[0] || null;
  if (spec.id && school && school.id !== spec.id) {
    throw new SafeError(`Configured ${role} school id does not match the exact name/domain resource`);
  }
  if (spec.id && !school) {
    const idMatch = all.find((candidate) => candidate?.id === spec.id);
    if (idMatch) throw new SafeError(`Configured ${role} school id belongs to a different name or domain`);
  }
  return school;
}

function assertCheckpointedSchoolRepairDetail(school, spec, role, requireAdmin) {
  if (
    !school
    || typeof school !== "object"
    || typeof school.id !== "string"
    || !school.id
    || school.name !== spec.name
    || String(school.domain || "").toLowerCase() !== spec.domain
    || school.status !== "active"
    || school.deletedAt
  ) {
    throw new SafeError(`Checkpointed ${role} school detail does not match the exact active create intent`);
  }
  assertSchoolIsNonBillable(school, `Checkpointed ${role}`);
  if (Number(school.maxStudents) !== (role === "primary" ? 1200 : 50)) {
    throw new SafeError(`Checkpointed ${role} school does not retain the requested synthetic capacity marker`);
  }
  if (
    !Array.isArray(school.admins)
    || !Array.isArray(school.teachers)
    || !Array.isArray(school.staff)
    || !Array.isArray(school.products)
    || Number(school.studentCount) !== 0
    || school.teachers.length !== 0
    || school.products.length !== 0
  ) {
    throw new SafeError(`Checkpointed ${role} school is not a pristine partially-created synthetic tenant`);
  }
  const expectedAdminEmail = spec.adminEmail;
  const exactAdmin = (entry) => entry?.role === "admin"
    && String(entry.email || "").toLowerCase() === expectedAdminEmail
    && typeof entry.id === "string" && entry.id
    && typeof entry.userId === "string" && entry.userId;
  if (school.admins.length > 1 || school.admins.some((entry) => !exactAdmin(entry))) {
    throw new SafeError(`Checkpointed ${role} school contains an unexpected admin identity`);
  }
  if (school.admins.length === 0) {
    if (school.staff.length !== 0 || requireAdmin) {
      throw new SafeError(`Checkpointed ${role} school does not contain exactly its configured fixture admin`);
    }
    return;
  }
  if (
    school.staff.length !== 1
    || !exactAdmin(school.staff[0])
    || school.staff[0].id !== school.admins[0].id
    || school.staff[0].userId !== school.admins[0].userId
  ) {
    throw new SafeError(`Checkpointed ${role} school staff inventory differs from its configured fixture admin`);
  }
}

async function repairCheckpointedSchool(client, superAuth, spec, role, adminPassword, outputDirectory, ownership, schoolId) {
  const detailRoute = `/api/super-admin/schools/${encodeURIComponent(schoolId)}`;
  let detail = await client.request(detailRoute, { bearer: superAuth.bearer });
  assertCheckpointedSchoolRepairDetail(detail.data, spec, role, false);
  const billing = await client.request(`${detailRoute}/billing`, { bearer: superAuth.bearer });
  assertNoStripeBilling(billing.data);

  // Persist the exact discovered id before any repair mutation. A subsequent
  // retry may resume only this resource; an arbitrary same-name replacement is
  // never eligible for adoption.
  bindSchoolCreateIntentToResource(outputDirectory, ownership, role, spec, schoolId);

  if (detail.data.admins.length === 0) {
    const created = await client.request(`${detailRoute}/admins`, {
      method: "POST",
      bearer: superAuth.bearer,
      body: {
        email: spec.adminEmail,
        firstName: role === "primary" ? "Load Fixture" : "Canary Fixture",
        lastName: "Admin",
        password: adminPassword,
      },
    });
    if (
      typeof created.data?.user?.id !== "string"
      || !created.data.user.id
      || String(created.data.user.email || "").toLowerCase() !== spec.adminEmail
    ) {
      throw new SafeError(`Checkpointed ${role} school admin repair returned an unexpected identity`);
    }
  }

  // The create route can fail after the school/admin writes but before its
  // settings upsert. PATCH is the supported idempotent path that guarantees the
  // missing settings row is created without direct database access.
  const patched = await client.request(detailRoute, {
    method: "PATCH",
    bearer: superAuth.bearer,
    body: {
      schoolHours: {
        enabled: false,
        startTime: "08:00",
        endTime: "15:00",
        timezone: "America/New_York",
        days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
        afterHoursMode: "off",
      },
    },
  });
  if (patched.data?.school?.id !== schoolId) {
    throw new SafeError(`Checkpointed ${role} school settings repair returned a different tenant`);
  }

  detail = await client.request(detailRoute, { bearer: superAuth.bearer });
  assertCheckpointedSchoolRepairDetail(detail.data, spec, role, true);
  if (detail.data.schoolHours?.enabled !== false) {
    throw new SafeError(`Checkpointed ${role} school settings repair did not disable tracking-hour enforcement`);
  }
  const billingAfter = await client.request(`${detailRoute}/billing`, { bearer: superAuth.bearer });
  assertNoStripeBilling(billingAfter.data);
  return detail.data;
}

async function discoverOrCreateSchool(client, superAuth, config, role, adminPassword, outputDirectory, ownership) {
  const spec = config.schools[role];
  const list = await client.request("/api/super-admin/schools?status=all", { bearer: superAuth.bearer });
  const all = Array.isArray(list.data?.schools) ? list.data.schools : [];
  let school = selectConfiguredSchool(all, spec, role);
  const durable = ownership.schools[role];
  const pendingIntent = ownership.pendingCreateIntents.schools[role];
  let createdByTool = false;
  if (school) {
    assertSchoolIsNonBillable(school, `Configured ${role}`);
    const durableMatch = durable?.createdByTool === true
      && durable.id === school.id && durable.name === spec.name && durable.domain === spec.domain;
    const crashReconciliationMatch = !durable && schoolIntentMatches(pendingIntent, spec)
      && (!pendingIntent.schoolId || pendingIntent.schoolId === school.id);
    if (!durableMatch && !crashReconciliationMatch) {
      throw new SafeError(`Refusing to adopt an existing ${role} school without exact durable tool ownership or a matching pending create intent`);
    }
    if (crashReconciliationMatch) {
      school = await repairCheckpointedSchool(
        client, superAuth, spec, role, adminPassword, outputDirectory, ownership, school.id,
      );
    }
    createdByTool = true;
  }
  if (!school) {
    if (durable) throw new SafeError(`Durably owned ${role} school is missing; refusing to recreate it`);
    if (pendingIntent?.schoolId) {
      throw new SafeError(`Checkpointed ${role} school resource is missing; refusing to create a replacement`);
    }
    if (spec.id) throw new SafeError(`Configured ${role} school id has no exact name/domain match; refusing creation`);
    if (!config.allowSchoolCreation) return null;
    checkpointSchoolCreateIntent(outputDirectory, ownership, role, spec);
    const response = await client.request("/api/super-admin/schools", {
      method: "POST",
      bearer: superAuth.bearer,
      body: {
        name: spec.name,
        domain: spec.domain,
        status: "active",
        billingEmail: null,
        maxStudents: role === "primary" ? 1200 : 50,
        adminEmail: spec.adminEmail,
        adminFirstName: role === "primary" ? "Load Fixture" : "Canary Fixture",
        adminLastName: "Admin",
        adminPassword,
      },
    });
    school = response.data?.school;
    createdByTool = true;
    assertSchoolIsNonBillable(school, `Created ${role}`);
  }
  if (!school?.id || school.name !== spec.name || String(school.domain).toLowerCase() !== spec.domain) {
    throw new SafeError(`Configured ${role} school identity does not match the discovered resource`);
  }
  if (spec.id && school.id !== spec.id) throw new SafeError(`Configured ${role} school id does not match the discovered resource`);
  if (school.status !== "active") throw new SafeError(`Configured ${role} synthetic school is not active`);
  const ownedSchool = recordOwnedSchool(outputDirectory, ownership, role, school, createdByTool);
  return {
    id: school.id,
    name: school.name,
    domain: school.domain,
    adminEmail: spec.adminEmail,
    createdByTool: ownedSchool.createdByTool,
    nonBillableVerifiedAt: new Date().toISOString(),
    billingProtectionVerified: true,
  };
}

async function ensureEnrollmentSafety(client, adminAuth) {
  let response = await client.request("/api/classpilot/enrollment-key", { bearer: adminAuth.bearer });
  if (response.data?.autoEnrollStudents !== false) {
    await client.request("/api/classpilot/auto-enroll", { method: "PATCH", bearer: adminAuth.bearer, body: { enabled: false } });
    response = await client.request("/api/classpilot/enrollment-key", { bearer: adminAuth.bearer });
  }
  let key = response.data?.key;
  let generatedByTool = false;
  if (typeof key !== "string" || !key) {
    const rotated = await client.request("/api/classpilot/enrollment-key/rotate", { method: "POST", bearer: adminAuth.bearer, body: {} });
    key = rotated.data?.key;
    generatedByTool = true;
  }
  if (typeof key !== "string" || !key) throw new SafeError("Synthetic school has no usable ClassPilot enrollment key");
  return { key, generatedByTool };
}

function staffDisplayName(entry) {
  return entry?.user?.displayName
    || [entry?.user?.firstName, entry?.user?.lastName].filter(Boolean).join(" ")
    || "";
}

function assertOwnedTeacherEntry(teacher, entry, ownership) {
  const owned = ownership.teachers[teacher.email];
  if (!owned || owned.userId !== entry?.userId || owned.membershipId !== entry?.membershipId) {
    throw new SafeError("An existing teacher alias is not present in the durable fixture ownership ledger");
  }
  if (owned.name !== teacher.name || staffDisplayName(entry) !== teacher.name) {
    throw new SafeError("An existing teacher alias lacks the exact fixture display-name marker");
  }
}

async function preflightDedicatedInventory(client, config, schools, authBySchool, blueprint, ownership) {
  const expectedStudents = { primary: blueprint.primaryStudents, canary: blueprint.canaryStudents };
  const expectedDeviceIds = {
    primary: new Set(blueprint.devices.filter((device) => device.schoolKey === "primary").map((device) => device.deviceId)),
    canary: new Set(blueprint.devices.filter((device) => device.schoolKey === "canary").map((device) => device.deviceId)),
  };
  const report = { verifiedAt: new Date().toISOString(), schools: {} };
  for (const schoolKey of ["primary", "canary"]) {
    const auth = authBySchool[schoolKey];
    const school = schools[schoolKey];
    if (!auth?.sessionVerified || auth.schoolId !== school.id) throw new SafeError("Inventory preflight lacks exact school context");
    const [staffResponse, studentsResponse, classesResponse, devicesResponse] = await Promise.all([
      client.request("/api/admin/users", { bearer: auth.bearer }),
      client.request("/api/students", { bearer: auth.bearer, timeoutMs: 60_000 }),
      client.request("/api/classpilot/admin/classes?status=all", { bearer: auth.bearer }),
      client.request("/api/classpilot/devices", { bearer: auth.bearer }),
    ]);
    const staff = Array.isArray(staffResponse.data?.users) ? staffResponse.data.users : [];
    const expectedAdminEmail = config.schools[schoolKey].adminEmail;
    const adminEntries = staff.filter((entry) => String(entry.user?.email || "").toLowerCase() === expectedAdminEmail);
    if (adminEntries.length !== 1 || !["admin", "school_admin"].includes(adminEntries[0]?.role)) {
      throw new SafeError(`Dedicated ${schoolKey} tenant must contain exactly its verified fixture admin`);
    }
    for (const entry of staff) {
      const email = String(entry.user?.email || "").toLowerCase();
      if (email === expectedAdminEmail) continue;
      const teacher = schoolKey === "primary" ? blueprint.teachers.find((candidate) => candidate.email === email) : null;
      if (!teacher || entry.role !== "teacher" || staffDisplayName(entry) !== teacher.name) {
        throw new SafeError(`Unexpected staff identity exists in the dedicated ${schoolKey} tenant before provisioning`);
      }
      const owned = ownership.teachers[email];
      const pending = ownership.pendingCreateIntents.teachers[email];
      const ownedMatch = owned?.userId === entry.userId && owned?.membershipId === entry.membershipId && owned.name === teacher.name;
      if (!ownedMatch && !teacherIntentMatches(pending, teacher, school.id)) {
        throw new SafeError("Existing teacher is not covered by durable ownership or an exact pending create intent");
      }
    }

    const plannedStudentByEmail = new Map(expectedStudents[schoolKey].map((student) => [student.email, student]));
    const students = Array.isArray(studentsResponse.data?.students) ? studentsResponse.data.students : [];
    for (const actual of students) {
      const expected = plannedStudentByEmail.get(String(actual.email || "").toLowerCase());
      if (!expected || actual.studentIdNumber !== expected.studentIdNumber
        || actual.firstName !== expected.firstName || actual.lastName !== expected.lastName) {
        throw new SafeError(`Unexpected or mismatched student exists in the dedicated ${schoolKey} tenant before provisioning`);
      }
    }

    const classes = Array.isArray(classesResponse.data?.classes) ? classesResponse.data.classes : [];
    const plannedClassByName = new Map((schoolKey === "primary" ? blueprint.classes : []).map((entry) => [entry.name, entry]));
    for (const actual of classes) {
      const expected = plannedClassByName.get(actual.name);
      if (!expected || actual.description !== expected.description || actual.status !== "active") {
        throw new SafeError(`Unexpected, unmarked, or inactive class exists in the dedicated ${schoolKey} tenant before provisioning`);
      }
    }

    const devices = Array.isArray(devicesResponse.data?.devices) ? devicesResponse.data.devices : [];
    for (const device of devices) {
      if (!expectedDeviceIds[schoolKey].has(device.deviceId) || device.schoolId !== school.id) {
        throw new SafeError(`Unexpected or cross-tenant device exists in the dedicated ${schoolKey} tenant before provisioning`);
      }
    }
    report.schools[schoolKey] = { staff: staff.length, students: students.length, classes: classes.length, devices: devices.length };
  }
  return report;
}

async function ensureTeachers(client, adminAuth, blueprint, teacherPassword, outputDirectory, ownership) {
  if (!adminAuth?.sessionVerified || !adminAuth.schoolId) throw new SafeError("Teacher provisioning requires an exact verified admin context");
  let response = await client.request("/api/admin/users", { bearer: adminAuth.bearer });
  let users = Array.isArray(response.data?.users) ? response.data.users : [];
  const byEmail = () => new Map(users.map((entry) => [String(entry.user?.email || "").toLowerCase(), entry]));
  for (const teacher of blueprint.teachers) {
    let existing = byEmail().get(teacher.email);
    if (existing && !ownership.teachers[teacher.email]) {
      const intent = ownership.pendingCreateIntents.teachers[teacher.email];
      if (!teacherIntentMatches(intent, teacher, adminAuth.schoolId)
        || staffDisplayName(existing) !== teacher.name
        || existing.role !== "teacher"
        || !existing.userId || !existing.membershipId) {
        throw new SafeError("Refusing to adopt an existing teacher without exact durable ownership or a matching pending create intent");
      }
      recordOwnedTeacher(outputDirectory, ownership, teacher, existing);
    }
    if (!existing) {
      if (ownership.teachers[teacher.email]) {
        throw new SafeError("A durably owned teacher is missing; refusing to recreate the identity");
      }
      checkpointTeacherCreateIntent(outputDirectory, ownership, teacher, adminAuth.schoolId);
      const created = await client.request("/api/admin/users", {
        method: "POST",
        bearer: adminAuth.bearer,
        body: { email: teacher.email, role: "teacher", name: teacher.name, password: teacherPassword },
      });
      const createdEntry = {
        user: created.data?.user,
        userId: created.data?.user?.id,
        membershipId: created.data?.membership?.id,
        role: created.data?.membership?.role,
      };
      if (!createdEntry.userId || !createdEntry.membershipId || staffDisplayName(createdEntry) !== teacher.name) {
        if (createdEntry.membershipId) {
          await client.request(`/api/admin/users/${encodeURIComponent(createdEntry.membershipId)}`, {
            method: "DELETE", bearer: adminAuth.bearer, allowedStatuses: [200, 404],
          });
        }
        throw new SafeError("Teacher creation adopted an identity without the exact fixture marker; the membership was removed");
      }
      try {
        recordOwnedTeacher(outputDirectory, ownership, teacher, createdEntry);
      } catch (error) {
        await client.request(`/api/admin/users/${encodeURIComponent(createdEntry.membershipId)}`, {
          method: "DELETE", bearer: adminAuth.bearer, allowedStatuses: [200, 404],
        });
        throw error;
      }
      response = await client.request("/api/admin/users", { bearer: adminAuth.bearer });
      users = Array.isArray(response.data?.users) ? response.data.users : [];
      existing = byEmail().get(teacher.email);
    }
    if (!existing?.membershipId || !existing?.userId) throw new SafeError("Teacher API did not return the expected synthetic membership");
    assertOwnedTeacherEntry(teacher, existing, ownership);
    if (existing.role !== "teacher") {
      await client.request(`/api/admin/users/${encodeURIComponent(existing.membershipId)}`, {
        method: "PATCH", bearer: adminAuth.bearer, body: { role: "teacher", name: teacher.name },
      });
    }
    // These aliases are fixture-owned. Resetting their password makes reruns
    // deterministic without persisting credentials in config or state.
    await client.request(`/api/admin/users/${encodeURIComponent(existing.membershipId)}/password`, {
      method: "POST", bearer: adminAuth.bearer, body: { newPassword: teacherPassword },
    });
  }
  response = await client.request("/api/admin/users", { bearer: adminAuth.bearer });
  users = Array.isArray(response.data?.users) ? response.data.users : [];
  const finalByEmail = new Map(users.map((entry) => [String(entry.user?.email || "").toLowerCase(), entry]));
  return blueprint.teachers.map((teacher) => {
    const entry = finalByEmail.get(teacher.email);
    if (!entry?.membershipId || !entry?.userId || entry.role !== "teacher") throw new SafeError("Synthetic teacher verification failed");
    assertOwnedTeacherEntry(teacher, entry, ownership);
    return { ...teacher, userId: entry.userId, membershipId: entry.membershipId };
  });
}

async function ensureStudents(client, adminAuth, plannedStudents) {
  let response = await client.request("/api/students", { bearer: adminAuth.bearer, timeoutMs: 60_000 });
  let existing = Array.isArray(response.data?.students) ? response.data.students : [];
  const byEmail = new Map(existing.map((student) => [String(student.email || "").toLowerCase(), student]));
  const missing = plannedStudents.filter((student) => !byEmail.has(student.email));
  for (const batch of chunk(missing, STUDENT_IMPORT_BATCH_SIZE)) {
    await client.request("/api/students/bulk", {
      method: "POST",
      bearer: adminAuth.bearer,
      timeoutMs: 120_000,
      body: {
        students: batch.map((student) => ({
          firstName: student.firstName,
          lastName: student.lastName,
          email: student.email,
          studentIdNumber: student.studentIdNumber,
          gradeLevel: "8",
          dismissalType: "car",
        })),
      },
    });
  }
  response = await client.request("/api/students", { bearer: adminAuth.bearer, timeoutMs: 60_000 });
  existing = Array.isArray(response.data?.students) ? response.data.students : [];
  const finalByEmail = new Map(existing.map((student) => [String(student.email || "").toLowerCase(), student]));
  return plannedStudents.map((student) => {
    const record = finalByEmail.get(student.email);
    if (!record?.id) throw new SafeError("Synthetic student verification failed after bulk import");
    if (
      record.studentIdNumber !== student.studentIdNumber
      || String(record.firstName || "") !== student.firstName
      || String(record.lastName || "") !== student.lastName
      || String(record.email || "").toLowerCase() !== student.email
    ) {
      throw new SafeError("A configured synthetic student email belongs to a non-fixture roster record");
    }
    return { ...student, id: record.id };
  });
}

async function ensureClasses(client, adminAuth, blueprint, teachers, primaryStudents) {
  const teacherByEmail = new Map(teachers.map((teacher) => [teacher.email, teacher]));
  const studentByEmail = new Map(primaryStudents.map((student) => [student.email, student]));
  const list = await client.request("/api/classpilot/admin/classes?status=all", { bearer: adminAuth.bearer });
  const classes = Array.isArray(list.data?.classes) ? list.data.classes : [];
  const byName = new Map(classes.map((entry) => [entry.name, entry]));
  const result = [];
  for (const planned of blueprint.classes) {
    const teacher = teacherByEmail.get(planned.teacherEmail);
    if (!teacher) throw new SafeError("Synthetic class has no matching teacher");
    let existing = byName.get(planned.name);
    if (existing && existing.description !== planned.description) {
      throw new SafeError("A class name collision lacks the fixture ownership marker");
    }
    if (existing && existing.status !== "active") {
      throw new SafeError("An archived fixture class cannot be safely reused; choose a new fixtureId");
    }
    if (!existing) {
      const created = await client.request("/api/classpilot/admin/classes", {
        method: "POST",
        bearer: adminAuth.bearer,
        body: {
          name: planned.name,
          description: planned.description,
          primaryTeacherId: teacher.userId,
          gradeLevel: "8",
          scheduleEnabled: false,
        },
      });
      existing = created.data?.class;
    } else {
      const updated = await client.request(`/api/classpilot/admin/classes/${encodeURIComponent(existing.id)}`, {
        method: "PATCH",
        bearer: adminAuth.bearer,
        body: {
          name: planned.name,
          description: planned.description,
          primaryTeacherId: teacher.userId,
          gradeLevel: "8",
          scheduleEnabled: false,
        },
      });
      existing = updated.data?.class;
    }
    if (!existing?.id || existing.scheduleEnabled === true) throw new SafeError("Synthetic class creation or schedule disablement failed");
    const rosterResponse = await client.request(`/api/classpilot/admin/classes/${encodeURIComponent(existing.id)}/students`, { bearer: adminAuth.bearer });
    const roster = Array.isArray(rosterResponse.data?.students) ? rosterResponse.data.students : [];
    const expectedIds = planned.studentEmails.map((email) => studentByEmail.get(email)?.id).filter(Boolean);
    if (expectedIds.length !== COUNTS.classSize) throw new SafeError("Synthetic class blueprint did not resolve to 40 students");
    const expectedSet = new Set(expectedIds);
    for (const extra of roster.filter((student) => !expectedSet.has(student.id))) {
      await client.request(`/api/classpilot/admin/classes/${encodeURIComponent(existing.id)}/students/${encodeURIComponent(extra.id)}`, {
        method: "DELETE", bearer: adminAuth.bearer,
      });
    }
    await client.request(`/api/classpilot/admin/classes/${encodeURIComponent(existing.id)}/students`, {
      method: "POST", bearer: adminAuth.bearer, body: { studentIds: expectedIds },
    });
    const verified = await client.request(`/api/classpilot/admin/classes/${encodeURIComponent(existing.id)}/students`, { bearer: adminAuth.bearer });
    const verifiedIds = new Set((verified.data?.students || []).map((student) => student.id));
    if (verifiedIds.size !== COUNTS.classSize || expectedIds.some((id) => !verifiedIds.has(id))) {
      throw new SafeError("Synthetic class roster did not converge to the required 40 students");
    }
    result.push({ ...planned, id: existing.id, teacherUserId: teacher.userId, studentIds: expectedIds });
  }
  const allStudentIds = result.flatMap((entry) => entry.studentIds);
  if (new Set(allStudentIds).size !== COUNTS.classes * COUNTS.classSize) throw new SafeError("Synthetic class rosters are not disjoint");
  return result;
}

function buildState(config, blueprint, resources) {
  return {
    schemaVersion: 1,
    fixtureId: config.fixtureId,
    baseUrl: config.baseUrl,
    generatedAt: new Date().toISOString(),
    refreshedAt: resources.previousRefreshedAt || null,
    ownershipAcknowledgement: config.ownershipAcknowledgement,
    schools: resources.schools,
    admin: { email: config.schools.primary.adminEmail, userId: resources.primaryAdmin.user?.id || null },
    teachers: resources.teachers.map((teacher, index) => ({
      ...teacher,
      classId: resources.classes[index].id,
      className: resources.classes[index].name,
    })),
    students: { primary: resources.primaryStudents, canary: resources.canaryStudents },
    devices: blueprint.devices.map((device) => {
      const school = resources.schools[device.schoolKey];
      const studentList = device.schoolKey === "primary" ? resources.primaryStudents : resources.canaryStudents;
      const student = studentList[device.studentOrdinal - 1];
      const classRecord = device.classOrdinal ? resources.classes[device.classOrdinal - 1] : null;
      return {
        ...device,
        studentId: student.id,
        schoolId: school.id,
        classId: classRecord?.id || null,
      };
    }),
    sessions: Array.isArray(resources.previousSessions) ? resources.previousSessions : [],
    enrollmentKeyGeneratedByTool: resources.enrollmentKeyGeneratedByTool,
  };
}

export function validateStateContract(state, config) {
  if (!state || state.schemaVersion !== 1 || state.fixtureId !== config.fixtureId || state.baseUrl !== config.baseUrl) {
    throw new SafeError("Fixture state does not match the current config");
  }
  if (state.ownershipAcknowledgement !== OWNERSHIP_ACK) throw new SafeError("Fixture state lacks the ownership acknowledgement");
  if (!state.schools?.primary?.id || !state.schools?.canary?.id) throw new SafeError("Fixture state is missing school identifiers");
  for (const schoolKey of ["primary", "canary"]) {
    const actual = state.schools[schoolKey];
    const expectedSchool = config.schools[schoolKey];
    if (
      actual.name !== expectedSchool.name
      || String(actual.domain || "").toLowerCase() !== expectedSchool.domain
      || actual.adminEmail !== expectedSchool.adminEmail
      || actual.createdByTool !== true
      || (expectedSchool.id && actual.id !== expectedSchool.id)
    ) {
      throw new SafeError("Fixture state contains a school identity that differs from config");
    }
    if (!Number.isFinite(Date.parse(actual.nonBillableVerifiedAt || "")) || actual.billingProtectionVerified !== true) {
      throw new SafeError("Fixture state lacks verified non-billable school evidence");
    }
  }
  const blueprint = buildFixtureBlueprint(config);
  if (!Array.isArray(state.teachers) || state.teachers.length !== 20) throw new SafeError("Fixture state must contain 20 teachers");
  if (new Set(state.teachers.map((teacher) => teacher.email)).size !== 20 || new Set(state.teachers.map((teacher) => teacher.userId)).size !== 20) {
    throw new SafeError("Fixture state must contain 20 distinct teacher identities");
  }
  for (let index = 0; index < blueprint.teachers.length; index += 1) {
    const actual = state.teachers[index];
    const expectedTeacher = blueprint.teachers[index];
    if (
      actual?.ordinal !== expectedTeacher.ordinal
      || actual.email !== expectedTeacher.email
      || actual.name !== expectedTeacher.name
      || !actual.userId
      || !actual.membershipId
      || actual.className !== blueprint.classes[index].name
    ) {
      throw new SafeError("Fixture state contains an unowned or mismatched teacher identity");
    }
  }
  if (!Array.isArray(state.students?.primary) || state.students.primary.length !== 1000 || !Array.isArray(state.students?.canary) || state.students.canary.length !== 10) {
    throw new SafeError("Fixture state must contain 1000 primary and 10 canary students");
  }
  for (const schoolKey of ["primary", "canary"]) {
    const expectedStudents = schoolKey === "primary" ? blueprint.primaryStudents : blueprint.canaryStudents;
    const actualStudents = state.students[schoolKey];
    if (new Set(actualStudents.map((student) => student.id)).size !== actualStudents.length) {
      throw new SafeError("Fixture state contains duplicate student ids");
    }
    for (let index = 0; index < expectedStudents.length; index += 1) {
      const actual = actualStudents[index];
      const expectedStudent = expectedStudents[index];
      if (
        !actual?.id
        || actual.ordinal !== expectedStudent.ordinal
        || actual.email !== expectedStudent.email
        || actual.firstName !== expectedStudent.firstName
        || actual.lastName !== expectedStudent.lastName
        || actual.studentIdNumber !== expectedStudent.studentIdNumber
      ) {
        throw new SafeError("Fixture state contains an unowned or mismatched student identity");
      }
    }
  }
  if (!Array.isArray(state.devices) || state.devices.length !== 1010) throw new SafeError("Fixture state must contain 1010 ordered devices");
  const expected = blueprint.devices;
  const deviceIds = new Set();
  for (let index = 0; index < expected.length; index += 1) {
    const actual = state.devices[index];
    if (!actual || actual.deviceId !== expected[index].deviceId || actual.cohort !== expected[index].cohort || actual.studentEmail !== expected[index].studentEmail) {
      throw new SafeError("Fixture state device ordering does not match the launch contract");
    }
    const expectedSchoolId = state.schools[expected[index].schoolKey].id;
    const expectedStudents = expected[index].schoolKey === "primary" ? state.students.primary : state.students.canary;
    const expectedStudentId = expectedStudents[expected[index].studentOrdinal - 1].id;
    if (
      !actual.studentId
      || actual.studentId !== expectedStudentId
      || actual.schoolId !== expectedSchoolId
      || deviceIds.has(actual.deviceId)
    ) throw new SafeError("Fixture state contains an incomplete, cross-tenant, or duplicate device");
    deviceIds.add(actual.deviceId);
  }
  const classIds = new Set(state.teachers.map((teacher) => teacher.classId));
  if (classIds.size !== 20 || classIds.has(undefined) || classIds.has(null)) throw new SafeError("Fixture state must map 20 distinct classes");
  return state;
}

function statePath(outputDirectory) {
  return path.join(outputDirectory, FILES.state);
}

function readState(outputDirectory, config) {
  if (!fs.existsSync(statePath(outputDirectory))) throw new SafeError(`Missing ${FILES.state}; run provision first`);
  return validateStateContract(readJsonFile(statePath(outputDirectory), "Fixture state"), config);
}

async function refreshArtifacts(client, config, outputDirectory, state, adminPassword, teacherPassword) {
  const registrationPacer = runtimePacer(config.registrationRequestsPerMinute);
  const superAuth = await superAuthFromEnvironment(client, config);
  const verifiedSchools = await verifySchoolsWithSuper(client, config, state, superAuth);
  for (const schoolKey of ["primary", "canary"]) {
    if (verifiedSchools[schoolKey].status !== "active"
      || !(verifiedSchools[schoolKey].products || []).includes("CLASSPILOT")
      || verifiedSchools[schoolKey].schoolHours?.enabled !== false) {
      throw new SafeError(`Refresh requires ${schoolKey} ClassPilot enabled with tracking hours disabled before artifact mutation`);
    }
  }
  const primaryAuth = await login(client, state.schools.primary.adminEmail, adminPassword, {
    schoolId: state.schools.primary.id, schoolName: state.schools.primary.name, role: "admin",
  });
  const canaryAuth = await login(client, state.schools.canary.adminEmail, adminPassword, {
    schoolId: state.schools.canary.id, schoolName: state.schools.canary.name, role: "admin",
  });
  const ownership = seedOwnershipFromState(readOwnership(outputDirectory, config), state);
  await collectLiveTenantInventory(client, config, state, { primary: primaryAuth, canary: canaryAuth }, ownership, {
    allowMissing: !state.refreshedAt,
  });
  const primaryEnrollment = await ensureEnrollmentSafety(client, primaryAuth);
  const canaryEnrollment = await ensureEnrollmentSafety(client, canaryAuth);
  for (const session of state.sessions || []) {
    await client.request(`/api/classpilot/teaching-sessions/${encodeURIComponent(session.sessionId)}/end`, {
      method: "POST", bearer: primaryAuth.bearer, body: {}, allowedStatuses: [200, 404],
    });
  }
  const enrollment = { primary: primaryEnrollment.key, canary: canaryEnrollment.key };
  const manifest = [];
  for (const device of state.devices) {
    const response = await client.request("/api/classpilot/extension/register", {
      method: "POST",
      pacer: registrationPacer,
      schoolId: device.schoolId,
      headers: { "x-classpilot-enrollment-key": enrollment[device.schoolKey] },
      body: {
        deviceId: device.deviceId,
        deviceName: `Synthetic ${device.deviceId}`,
        studentEmail: device.studentEmail,
        schoolId: device.schoolId,
        classId: device.classId || device.schoolId,
      },
    });
    const studentToken = response.data?.studentToken;
    if (typeof studentToken !== "string" || !studentToken) throw new SafeError("Device registration did not return a student token");
    client.bindBearerToSchool(studentToken, device.schoolId);
    manifest.push({
      deviceId: device.deviceId,
      studentToken,
      studentId: device.studentId,
      schoolId: device.schoolId,
      classId: device.classId || null,
    });
  }
  for (const schoolKey of ["primary", "canary"]) {
    const firstIndex = state.devices.findIndex((device) => device.schoolKey === schoolKey);
    const settings = await client.request("/api/classpilot/extension/settings", {
      bearer: manifest[firstIndex].studentToken, schoolId: state.schools[schoolKey].id,
    });
    if (settings.data?.enableTrackingHours !== false) throw new SafeError(`Tracking hours are not disabled for the ${schoolKey} synthetic school`);
  }
  const sessions = [];
  const teacherAuthEntries = [];
  for (const teacher of state.teachers) {
    const teacherAuth = await login(client, teacher.email, teacherPassword, {
      schoolId: state.schools.primary.id, schoolName: state.schools.primary.name, role: "teacher",
    });
    const response = await client.request("/api/classpilot/teaching-sessions/start", {
      method: "POST", bearer: teacherAuth.bearer, body: { groupId: teacher.classId },
    });
    if (!response.data?.session?.id) throw new SafeError("Teaching-session start did not return a session id");
    const teacherCsrfToken = await csrfForSession(client, teacherAuth);
    const studentIds = state.devices
      .filter((device) => device.schoolKey === "primary" && device.classId === teacher.classId)
      .map((device) => device.studentId);
    if (studentIds.length !== COUNTS.classSize || new Set(studentIds).size !== COUNTS.classSize) {
      throw new SafeError("Teacher auth mapping did not resolve exactly 40 fixture students");
    }
    sessions.push({
      ordinal: teacher.ordinal,
      teacherUserId: teacher.userId,
      classId: teacher.classId,
      sessionId: response.data.session.id,
    });
    teacherAuthEntries.push({
      teacherId: teacher.userId,
      schoolId: state.schools.primary.id,
      role: "teacher",
      teachingSessionId: response.data.session.id,
      teacherCookie: teacherAuth.cookie,
      csrfToken: teacherCsrfToken,
      teacherToken: teacherAuth.bearer,
      expiresAt: decodeJwtExpiry(teacherAuth.bearer),
      studentIds,
    });
  }
  const commands = sessions.map((session) => ({
    teachingSessionId: session.sessionId,
    targetScope: "class",
    commandType: "open-tab",
    commandPayload: { url: config.commandUrl },
  }));
  const csrfToken = await csrfForSession(client, primaryAuth);
  const refreshedAt = new Date().toISOString();
  const deviceManifestExpiresAt = manifest.map((entry) => decodeJwtExpiry(entry.studentToken)).filter(Boolean).sort()[0] || null;
  const commandAdminExpiresAt = decodeJwtExpiry(primaryAuth.bearer);
  const teacherAuthExpiresAt = teacherAuthEntries.map((entry) => entry.expiresAt).filter(Boolean).sort()[0] || null;
  const expiresAt = [commandAdminExpiresAt, teacherAuthExpiresAt].filter(Boolean).sort()[0] || null;
  const updatedState = {
    ...state,
    refreshedAt,
    sessions,
    tokenExpiry: {
      earliestDevice: deviceManifestExpiresAt,
      commandAdmin: commandAdminExpiresAt,
      earliestTeacher: teacherAuthExpiresAt,
    },
    enrollmentKeyGeneratedByTool: {
      primary: state.enrollmentKeyGeneratedByTool?.primary || primaryEnrollment.generatedByTool,
      canary: state.enrollmentKeyGeneratedByTool?.canary || canaryEnrollment.generatedByTool,
    },
  };
  writePrivateJson(outputDirectory, FILES.state, updatedState);
  writePrivateJson(outputDirectory, FILES.devices, manifest);
  writePrivateJson(outputDirectory, FILES.commands, commands);
  writePrivateJson(outputDirectory, FILES.auth, {
    schemaVersion: 2,
    generatedAt: refreshedAt,
    baseUrl: config.baseUrl,
    schoolId: state.schools.primary.id,
    role: "school_admin",
    teacherCookie: primaryAuth.cookie,
    csrfToken,
    teacherToken: primaryAuth.bearer,
    expiresAt,
    deviceManifestExpiresAt,
    teacherAuth: teacherAuthEntries,
  });
  return {
    command: "refresh",
    fixtureId: config.fixtureId,
    devicesRegistered: manifest.length,
    teachingSessionsStarted: sessions.length,
    commandBodiesWritten: commands.length,
    outputFiles: [FILES.state, FILES.devices, FILES.commands, FILES.auth],
  };
}

function existingProvisionContext(outputDirectory, config) {
  const stateExists = fs.existsSync(statePath(outputDirectory));
  const priorState = stateExists ? readState(outputDirectory, config) : null;
  if (priorState?.cleanup?.completedAt || priorState?.hold?.deactivatedAt) {
    throw new SafeError("This fixture output has entered deactivation or cleanup; use a new fixtureId and output directory");
  }
  if (!stateExists) {
    for (const filename of [FILES.devices, FILES.commands, FILES.auth, FILES.verification, FILES.cleanup]) {
      if (fs.existsSync(path.join(outputDirectory, filename))) {
        throw new SafeError(`Refusing to overwrite ${filename} without a matching validated fixture state`);
      }
    }
  }
  const ownership = seedOwnershipFromState(readOwnership(outputDirectory, config), priorState);
  if (priorState || Object.keys(ownership.schools).length > 0 || Object.keys(ownership.teachers).length > 0) {
    persistOwnership(outputDirectory, ownership);
  }
  return { priorState, ownership };
}

function validateExistingOutputReadOnly(outputDirectory, config) {
  const stateExists = fs.existsSync(statePath(outputDirectory));
  if (stateExists) {
    const state = readState(outputDirectory, config);
    if (state.cleanup?.completedAt || state.hold?.deactivatedAt) {
      throw new SafeError("This fixture output has entered deactivation or cleanup");
    }
  }
  if (fs.existsSync(ownershipPath(outputDirectory))) readOwnership(outputDirectory, config);
  if (!stateExists) {
    for (const filename of [FILES.devices, FILES.commands, FILES.auth, FILES.verification, FILES.cleanup]) {
      if (fs.existsSync(path.join(outputDirectory, filename))) {
        throw new SafeError(`Refusing to reuse ${filename} without a matching validated fixture state`);
      }
    }
  }
}

async function runProvision(client, config, outputDirectory) {
  const { priorState, ownership } = existingProvisionContext(outputDirectory, config);
  const missing = ["CLP_FIXTURE_ADMIN_PASSWORD", "CLP_FIXTURE_TEACHER_PASSWORD"]
    .filter((name) => typeof process.env[name] !== "string" || !process.env[name]);
  const authReasons = superAdminAuthPrerequisiteReasons(process.env);
  if (missing.length || authReasons.length) {
    failPrerequisite(outputDirectory, config, [
      ...authReasons,
      ...missing.map((name) => `${name} is absent from the current process`),
    ]);
  }
  if (process.env.CLP_OPERATOR_ALIAS_CONFIRMED !== config.fixtureId) {
    failPrerequisite(outputDirectory, config, [
      `Before provisioning, send an external test message to ${config.schools.primary.adminEmail}, verify receipt in ${config.operatorMailboxEmail}, then set CLP_OPERATOR_ALIAS_CONFIRMED=${config.fixtureId}`,
    ]);
  }
  const adminPassword = envSecret("CLP_FIXTURE_ADMIN_PASSWORD", 12);
  const teacherPassword = envSecret("CLP_FIXTURE_TEACHER_PASSWORD", 12);
  let superAuth;
  try {
    superAuth = await superAuthFromEnvironment(client, config);
  } catch (error) {
    if ((error instanceof HttpStatusError && [401, 403].includes(error.status)) || error?.code === "SUPER_ADMIN_AUTH") {
      failPrerequisite(outputDirectory, config, ["The supplied super-admin process authentication cannot access the supported school-provisioning API as the configured operator"]);
    }
    throw error;
  }
  const primarySchool = await discoverOrCreateSchool(
    client, superAuth, config, "primary", adminPassword, outputDirectory, ownership,
  );
  if (!primarySchool) failPrerequisite(outputDirectory, config, ["The exact primary synthetic school does not exist and allowSchoolCreation is false"]);
  let primaryAdmin;
  try {
    primaryAdmin = await login(client, primarySchool.adminEmail, adminPassword, {
      schoolId: primarySchool.id, schoolName: primarySchool.name, role: "admin",
    });
  }
  catch (error) {
    if (error instanceof HttpStatusError && error.status === 401) {
      failPrerequisite(outputDirectory, config, ["The primary synthetic admin alias cannot authenticate with CLP_FIXTURE_ADMIN_PASSWORD"]);
    }
    throw error;
  }
  const primarySchoolHours = await verifyBillingAndEnsureClassPilot(client, superAuth, primarySchool);
  if (process.env.CLP_CANARY_ALIAS_CONFIRMED !== config.fixtureId) {
    failPrerequisite(outputDirectory, config, [
      `Before creating the canary tenant, send an external test message to ${config.schools.canary.adminEmail}, verify receipt in ${config.operatorMailboxEmail}, then set CLP_CANARY_ALIAS_CONFIRMED=${config.fixtureId}`,
    ]);
  }
  const canarySchool = await discoverOrCreateSchool(
    client, superAuth, config, "canary", adminPassword, outputDirectory, ownership,
  );
  if (!canarySchool) failPrerequisite(outputDirectory, config, ["The exact canary synthetic school does not exist and allowSchoolCreation is false"]);
  let canaryAdmin;
  try {
    canaryAdmin = await login(client, canarySchool.adminEmail, adminPassword, {
      schoolId: canarySchool.id, schoolName: canarySchool.name, role: "admin",
    });
  }
  catch (error) {
    if (error instanceof HttpStatusError && error.status === 401) {
      failPrerequisite(outputDirectory, config, ["The canary synthetic admin alias cannot authenticate with CLP_FIXTURE_ADMIN_PASSWORD"]);
    }
    throw error;
  }
  const canarySchoolHours = await verifyBillingAndEnsureClassPilot(client, superAuth, canarySchool);
  const blueprint = buildFixtureBlueprint(config);
  await preflightDedicatedInventory(
    client,
    config,
    { primary: primarySchool, canary: canarySchool },
    { primary: primaryAdmin, canary: canaryAdmin },
    blueprint,
    ownership,
  );
  await disableTrackingAfterInventoryPreflight(client, superAuth, primarySchool, primarySchoolHours);
  await disableTrackingAfterInventoryPreflight(client, superAuth, canarySchool, canarySchoolHours);
  const primaryEnrollment = await ensureEnrollmentSafety(client, primaryAdmin);
  const canaryEnrollment = await ensureEnrollmentSafety(client, canaryAdmin);
  const teachers = await ensureTeachers(client, primaryAdmin, blueprint, teacherPassword, outputDirectory, ownership);
  const primaryStudents = await ensureStudents(client, primaryAdmin, blueprint.primaryStudents);
  const canaryStudents = await ensureStudents(client, canaryAdmin, blueprint.canaryStudents);
  const classes = await ensureClasses(client, primaryAdmin, blueprint, teachers, primaryStudents);
  const state = buildState(config, blueprint, {
    schools: { primary: primarySchool, canary: canarySchool },
    primaryAdmin,
    teachers,
    primaryStudents,
    canaryStudents,
    classes,
    enrollmentKeyGeneratedByTool: { primary: primaryEnrollment.generatedByTool, canary: canaryEnrollment.generatedByTool },
    previousSessions: priorState?.sessions || [],
    previousRefreshedAt: priorState?.refreshedAt || null,
  });
  validateStateContract(state, config);
  writePrivateJson(outputDirectory, FILES.state, state);
  persistOwnership(outputDirectory, seedOwnershipFromState(ownership, state));
  const refreshed = await refreshArtifacts(client, config, outputDirectory, state, adminPassword, teacherPassword);
  return {
    command: "provision",
    fixtureId: config.fixtureId,
    schools: 2,
    teachers: teachers.length,
    students: primaryStudents.length + canaryStudents.length,
    classes: classes.length,
    devicesRegistered: refreshed.devicesRegistered,
    teachingSessionsStarted: refreshed.teachingSessionsStarted,
    commandBodiesWritten: refreshed.commandBodiesWritten,
    outputFiles: refreshed.outputFiles,
  };
}

function readPrivateArray(outputDirectory, filename, label) {
  const target = path.join(outputDirectory, filename);
  if (!fs.existsSync(target)) throw new SafeError(`Missing ${filename}; run refresh first`);
  const value = readJsonFile(target, label);
  if (!Array.isArray(value)) throw new SafeError(`${label} must be a JSON array`);
  return value;
}

function validateLocalArtifacts(config, state, manifest, commands, options = {}) {
  const requireUnexpired = options.requireUnexpired !== false;
  if (manifest.length !== 1010) throw new SafeError("Device manifest must contain 1010 entries");
  const nowSeconds = Math.floor(Date.now() / 1000);
  for (let index = 0; index < state.devices.length; index += 1) {
    const expected = state.devices[index];
    const actual = manifest[index];
    if (!actual || actual.deviceId !== expected.deviceId || actual.studentId !== expected.studentId || actual.schoolId !== expected.schoolId) {
      throw new SafeError("Device manifest order or identity differs from fixture state");
    }
    const payload = typeof actual.studentToken === "string" ? decodeJwtPayload(actual.studentToken) : null;
    if (
      !payload
      || !Number.isFinite(payload.exp)
      || (requireUnexpired && payload.exp <= nowSeconds)
      || payload.deviceId !== expected.deviceId
      || payload.studentId !== expected.studentId
      || payload.schoolId !== expected.schoolId
      || typeof payload.sessionId !== "string"
      || !payload.sessionId
    ) {
      throw new SafeError("Device manifest contains an expired, malformed, or cross-tenant token");
    }
  }
  if (commands.length !== 20 || new Set(commands.map((body) => body.teachingSessionId)).size !== 20) {
    throw new SafeError("Command body artifact must contain 20 distinct teaching sessions");
  }
  const stateSessionIds = new Set((state.sessions || []).map((session) => session.sessionId));
  if (stateSessionIds.size !== 20 || commands.some((body) => !stateSessionIds.has(body.teachingSessionId))) {
    throw new SafeError("Command bodies do not match the 20 sessions recorded in fixture state");
  }
  for (const body of commands) {
    if (body.targetScope !== "class" || body.commandType !== "open-tab" || body.commandPayload?.url !== config.commandUrl) {
      throw new SafeError("Command body artifact differs from the safe class command contract");
    }
  }
}

function assertArtifactMeResponse(response, expected, source) {
  assertExactAuthMembership(response.data?.memberships, {
    schoolId: expected.schoolId,
    schoolName: expected.schoolName,
    role: expected.membershipRole,
  }, source);
  if (
    response.data?.user?.id !== expected.userId
    || String(response.data?.user?.email || "").toLowerCase() !== expected.email
  ) {
    throw new SafeError(`${source} returned a different fixture user identity`);
  }
}

async function verifyAuthArtifactLive(client, config, state, validatedAuth) {
  const schoolId = state.schools.primary.id;
  const schoolName = state.schools.primary.name;
  const verifyIdentity = async (credentials, expected, source) => {
    const cookieMe = await client.request("/api/auth/me", {
      cookie: credentials.cookie,
      schoolId,
    });
    assertArtifactMeResponse(cookieMe, expected, `${source} cookie`);
    const bearerMe = await client.request("/api/auth/me", {
      bearer: credentials.token,
      schoolId,
    });
    assertArtifactMeResponse(bearerMe, expected, `${source} bearer token`);
    const csrf = await client.request("/api/auth/csrf", {
      cookie: credentials.cookie,
      schoolId,
    });
    if (csrf.data?.csrfToken !== credentials.csrf) {
      throw new SafeError(`${source} CSRF token no longer matches its live session`);
    }
  };

  await verifyIdentity(validatedAuth.commandAdmin, {
    schoolId,
    schoolName,
    membershipRole: "admin",
    userId: state.admin.userId,
    email: config.schools.primary.adminEmail,
  }, "Command administrator artifact");

  for (const entry of validatedAuth.teachers) {
    await verifyIdentity(entry, {
      schoolId,
      schoolName,
      membershipRole: "teacher",
      userId: entry.teacher.userId,
      email: String(entry.teacher.email).toLowerCase(),
    }, "Synthetic teacher artifact");
    const response = await client.request(
      `/api/classpilot/teaching-sessions/${encodeURIComponent(entry.session.sessionId)}`,
      { cookie: entry.cookie, schoolId },
    );
    const session = response.data?.session;
    if (
      session?.id !== entry.session.sessionId
      || session.groupId !== entry.teacher.classId
      || session.teacherId !== entry.teacher.userId
      || session.endTime
      || (session.sessionMode !== undefined && session.sessionMode !== "live")
    ) {
      throw new SafeError("Synthetic teacher artifact does not retain its exact live teacher/class session");
    }
  }
  return { commandAdministrators: 1, teachers: validatedAuth.teachers.length };
}

async function runVerify(client, config, outputDirectory) {
  const state = readState(outputDirectory, config);
  const manifest = readPrivateArray(outputDirectory, FILES.devices, "Device manifest");
  const commands = readPrivateArray(outputDirectory, FILES.commands, "Command body artifact");
  validateLocalArtifacts(config, state, manifest, commands);
  const authArtifact = readJsonFile(path.join(outputDirectory, FILES.auth), "Teacher auth artifact");
  const validatedAuth = validateAuthArtifactContract(authArtifact, config, state);
  const adminPassword = envSecret("CLP_FIXTURE_ADMIN_PASSWORD", 12);
  const superAuth = await superAuthFromEnvironment(client, config);
  const verifiedSchools = await verifySchoolsWithSuper(client, config, state, superAuth);
  for (const schoolKey of ["primary", "canary"]) {
    if (verifiedSchools[schoolKey].status !== "active"
      || !(verifiedSchools[schoolKey].products || []).includes("CLASSPILOT")
      || verifiedSchools[schoolKey].schoolHours?.enabled !== false) {
      throw new SafeError(`Verification requires ${schoolKey} ClassPilot enabled with tracking hours disabled`);
    }
  }
  const liveAuth = await verifyAuthArtifactLive(client, config, state, validatedAuth);
  const primaryAuth = await login(client, state.schools.primary.adminEmail, adminPassword, {
    schoolId: state.schools.primary.id, schoolName: state.schools.primary.name, role: "admin",
  });
  const canaryAuth = await login(client, state.schools.canary.adminEmail, adminPassword, {
    schoolId: state.schools.canary.id, schoolName: state.schools.canary.name, role: "admin",
  });
  const ownership = seedOwnershipFromState(readOwnership(outputDirectory, config), state);
  const exactInventory = await collectLiveTenantInventory(
    client, config, state, { primary: primaryAuth, canary: canaryAuth }, ownership,
  );
  const [staff, primaryRoster, canaryRoster, classList, primaryEnrollment, canaryEnrollment] = await Promise.all([
    client.request("/api/admin/users", { bearer: primaryAuth.bearer }),
    client.request("/api/students", { bearer: primaryAuth.bearer, timeoutMs: 60_000 }),
    client.request("/api/students", { bearer: canaryAuth.bearer, timeoutMs: 60_000 }),
    client.request("/api/classpilot/admin/classes?status=all", { bearer: primaryAuth.bearer }),
    client.request("/api/classpilot/enrollment-key", { bearer: primaryAuth.bearer }),
    client.request("/api/classpilot/enrollment-key", { bearer: canaryAuth.bearer }),
  ]);
  if (primaryEnrollment.data?.autoEnrollStudents !== false || canaryEnrollment.data?.autoEnrollStudents !== false) {
    throw new SafeError("Auto-enrollment is enabled on a synthetic school");
  }
  const staffByEmail = new Map((staff.data?.users || []).map((entry) => [String(entry.user?.email || "").toLowerCase(), entry]));
  for (const teacher of state.teachers) {
    const entry = staffByEmail.get(teacher.email);
    if (!entry || entry.role !== "teacher") throw new SafeError("A synthetic teacher is missing or no longer a teacher");
    assertOwnedTeacherEntry(teacher, entry, ownership);
  }
  for (const [schoolKey, response] of [["primary", primaryRoster], ["canary", canaryRoster]]) {
    const byEmail = new Map((response.data?.students || []).map((student) => [String(student.email || "").toLowerCase(), student]));
    for (const expected of state.students[schoolKey]) {
      const actual = byEmail.get(expected.email);
      if (
        !actual
        || actual.id !== expected.id
        || actual.studentIdNumber !== expected.studentIdNumber
        || actual.firstName !== expected.firstName
        || actual.lastName !== expected.lastName
      ) {
        throw new SafeError("A synthetic student is missing or no longer matches its exact fixture marker and id");
      }
    }
  }
  const classById = new Map((classList.data?.classes || []).map((entry) => [entry.id, entry]));
  const seenRosterIds = new Set();
  for (const teacher of state.teachers) {
    const classRecord = classById.get(teacher.classId);
    const primaryTeacherId = classRecord?.teacherId || classRecord?.primaryTeacher?.id || classRecord?.primaryTeacher?.userId;
    const expectedDescription = `synthetic-load-fixture:${config.fixtureId}:class:${String(teacher.ordinal).padStart(2, "0")}`;
    if (!classRecord || classRecord.scheduleEnabled === true || classRecord.status !== "active" || classRecord.name !== teacher.className
      || classRecord.description !== expectedDescription || primaryTeacherId !== teacher.userId) {
      throw new SafeError("A synthetic class is missing, misassigned, unowned, archived, or scheduled");
    }
    const roster = await client.request(`/api/classpilot/admin/classes/${encodeURIComponent(teacher.classId)}/students`, { bearer: primaryAuth.bearer });
    const ids = (roster.data?.students || []).map((student) => student.id);
    const expectedIds = state.devices
      .filter((device) => device.schoolKey === "primary" && device.classId === teacher.classId)
      .map((device) => device.studentId);
    const actualSet = new Set(ids);
    if (
      ids.length !== 40
      || expectedIds.length !== 40
      || expectedIds.some((id) => !actualSet.has(id))
      || ids.some((id) => seenRosterIds.has(id))
    ) throw new SafeError("Synthetic class roster does not match its exact disjoint fixture students");
    ids.forEach((id) => seenRosterIds.add(id));
  }
  for (const session of state.sessions || []) {
    const response = await client.request(`/api/classpilot/teaching-sessions/${encodeURIComponent(session.sessionId)}`, { bearer: primaryAuth.bearer });
    if (response.data?.session?.endTime || response.data?.session?.groupId !== session.classId) throw new SafeError("A synthetic teaching session is not active for its expected class");
  }
  let activeDeviceSessions = 0;
  for (const batch of chunk(manifest, 25)) {
    const settingsResponses = await Promise.all(batch.map((entry) =>
      client.request("/api/classpilot/extension/settings", { bearer: entry.studentToken, schoolId: entry.schoolId })
    ));
    for (const settings of settingsResponses) {
      if (settings.data?.enableTrackingHours !== false) throw new SafeError("Tracking hours are enabled on a synthetic school");
      activeDeviceSessions += 1;
    }
  }
  const report = {
    schemaVersion: 1,
    verifiedAt: new Date().toISOString(),
    fixtureId: config.fixtureId,
    passed: true,
    counts: { schools: 2, teachers: 20, students: 1010, classes: 20, classRosterStudents: seenRosterIds.size, devices: 1010, activeDeviceSessions, activeSessions: exactInventory.activeTeachingSessions, commandBodies: 20, liveAuth },
    gates: { autoEnrollDisabled: true, trackingDisabled: true, schedulesDisabled: true, classRostersExactAndDisjoint: true, allDeviceTokensLive: true, allStaffAuthArtifactsLive: true },
  };
  writePrivateJson(outputDirectory, FILES.verification, report);
  return { command: "verify", fixtureId: config.fixtureId, passed: true, ...report.counts, outputFiles: [FILES.verification] };
}

export function buildCleanupPlan(config, state, tokenCount = 1010) {
  const ownedSchoolKeys = config.cleanupOwnedSchools
    ? ["primary", "canary"].filter((key) => state.schools[key]?.createdByTool === true)
    : [];
  return {
    dryRun: true,
    fixtureId: config.fixtureId,
    mutationsPerformed: 0,
    planned: {
      deviceSignOuts: tokenCount,
      teachingSessionEnds: state.sessions?.length || 0,
      classArchives: state.teachers.length,
      tenantTelemetryAndDevicePurges: 2,
      enrollmentKeyRotations: 2,
      classpilotLicenseDisables: 2,
      schoolSuspensions: 2,
      schoolSoftDeletes: ownedSchoolKeys.length,
      teacherMembershipDeletes: state.teachers.length,
      studentDeletes: state.students.primary.length + state.students.canary.length,
      localCredentialArtifactsRevoked: 3,
    },
    ownedSchoolKeys,
  };
}

async function verifySchoolsWithSuper(client, config, state, superAuth, options = {}) {
  const details = {};
  for (const schoolKey of ["primary", "canary"]) {
    if (options.skipSchoolKeys?.has?.(schoolKey)) {
      details[schoolKey] = { id: state.schools[schoolKey].id, deleted: true };
      continue;
    }
    const expected = state.schools[schoolKey];
    const response = await client.request(`/api/super-admin/schools/${encodeURIComponent(expected.id)}`, { bearer: superAuth.bearer });
    const school = response.data;
    if (
      school?.id !== expected.id
      || school.name !== config.schools[schoolKey].name
      || String(school.domain || "").toLowerCase() !== config.schools[schoolKey].domain
    ) throw new SafeError("Live synthetic school identity differs from validated state");
    assertSchoolIsNonBillable(school, `Live ${schoolKey}`);
    const billing = await client.request(`/api/super-admin/schools/${encodeURIComponent(expected.id)}/billing`, { bearer: superAuth.bearer });
    assertNoStripeBilling(billing.data);
    details[schoolKey] = school;
  }
  return details;
}

function assertExactStudentRecord(actual, expected) {
  if (
    actual.id !== expected.id
    || String(actual.email || "").toLowerCase() !== expected.email
    || actual.studentIdNumber !== expected.studentIdNumber
    || actual.firstName !== expected.firstName
    || actual.lastName !== expected.lastName
  ) throw new SafeError("Live student identity differs from its exact fixture marker and id");
}

async function collectLiveTenantInventory(client, config, state, authBySchool, ownership, options = {}) {
  const allowMissing = options.allowMissing === true;
  const [primaryStaff, canaryStaff, primaryStudents, canaryStudents, classes, primaryDevices, canaryDevices] = await Promise.all([
    client.request("/api/admin/users", { bearer: authBySchool.primary.bearer }),
    client.request("/api/admin/users", { bearer: authBySchool.canary.bearer }),
    client.request("/api/students", { bearer: authBySchool.primary.bearer, timeoutMs: 60_000 }),
    client.request("/api/students", { bearer: authBySchool.canary.bearer, timeoutMs: 60_000 }),
    client.request("/api/classpilot/admin/classes?status=all", { bearer: authBySchool.primary.bearer }),
    client.request("/api/classpilot/devices", { bearer: authBySchool.primary.bearer }),
    client.request("/api/classpilot/devices", { bearer: authBySchool.canary.bearer }),
  ]);

  const primaryExpectedStaff = new Set([state.schools.primary.adminEmail, ...state.teachers.map((teacher) => teacher.email)]);
  const canaryExpectedStaff = new Set([state.schools.canary.adminEmail]);
  for (const [schoolKey, response, expectedEmails] of [
    ["primary", primaryStaff, primaryExpectedStaff],
    ["canary", canaryStaff, canaryExpectedStaff],
  ]) {
    const entries = response.data?.users || [];
    for (const entry of entries) {
      const email = String(entry.user?.email || "").toLowerCase();
      if (!expectedEmails.has(email)) throw new SafeError(`Unexpected staff identity exists in the dedicated ${schoolKey} fixture tenant`);
    }
  }
  const primaryStaffByEmail = new Map((primaryStaff.data?.users || []).map((entry) => [String(entry.user?.email || "").toLowerCase(), entry]));
  for (const teacher of state.teachers) {
    const entry = primaryStaffByEmail.get(teacher.email);
    if (!entry) {
      if (!allowMissing) throw new SafeError("A fixture teacher is missing during live dry-run verification");
      continue;
    }
    assertOwnedTeacherEntry(teacher, entry, ownership);
  }

  const liveStudentCounts = {};
  for (const [schoolKey, response] of [["primary", primaryStudents], ["canary", canaryStudents]]) {
    const expectedById = new Map(state.students[schoolKey].map((student) => [student.id, student]));
    const expectedByEmail = new Map(state.students[schoolKey].map((student) => [student.email, student]));
    const live = response.data?.students || [];
    for (const actual of live) {
      const email = String(actual.email || "").toLowerCase();
      const expected = expectedById.get(actual.id) || expectedByEmail.get(email);
      if (!expected) throw new SafeError(`Unexpected student exists in the dedicated ${schoolKey} fixture tenant`);
      assertExactStudentRecord(actual, expected);
    }
    if (!allowMissing && live.length !== state.students[schoolKey].length) {
      throw new SafeError(`Live ${schoolKey} student count does not match validated fixture state`);
    }
    liveStudentCounts[schoolKey] = live.length;
  }

  const expectedClasses = new Map(state.teachers.map((teacher) => [teacher.classId, teacher]));
  const liveClasses = classes.data?.classes || [];
  for (const classRecord of liveClasses) {
    const teacher = expectedClasses.get(classRecord.id);
    if (!teacher) throw new SafeError("Unexpected class exists in the dedicated fixture tenant");
    const teacherId = classRecord.teacherId || classRecord.primaryTeacher?.id || classRecord.primaryTeacher?.userId;
    const expectedDescription = `synthetic-load-fixture:${config.fixtureId}:class:${String(teacher.ordinal).padStart(2, "0")}`;
    if (classRecord.name !== teacher.className || classRecord.description !== expectedDescription || teacherId !== teacher.userId) {
      throw new SafeError("Live class differs from its exact fixture marker and owner id");
    }
  }
  if (!allowMissing && liveClasses.length !== state.teachers.length) throw new SafeError("Live class count does not match validated fixture state");

  const liveDeviceCounts = {};
  for (const [schoolKey, response] of [["primary", primaryDevices], ["canary", canaryDevices]]) {
    const expectedIds = new Set(state.devices.filter((device) => device.schoolKey === schoolKey).map((device) => device.deviceId));
    const live = response.data?.devices || [];
    for (const device of live) {
      if (!expectedIds.has(device.deviceId) || device.schoolId !== state.schools[schoolKey].id) {
        throw new SafeError(`Unexpected or cross-tenant device exists in the dedicated ${schoolKey} fixture tenant`);
      }
    }
    if (!allowMissing && live.length !== expectedIds.size) throw new SafeError(`Live ${schoolKey} device count does not match fixture state`);
    liveDeviceCounts[schoolKey] = live.length;
  }

  let activeTeachingSessions = 0;
  for (const session of state.sessions || []) {
    const response = await client.request(`/api/classpilot/teaching-sessions/${encodeURIComponent(session.sessionId)}`, {
      bearer: authBySchool.primary.bearer,
      allowedStatuses: [200, 404],
    });
    if (response.status === 200) {
      if (response.data?.session?.groupId !== session.classId) throw new SafeError("Live teaching session belongs to an unexpected class");
      if (!response.data?.session?.endTime) activeTeachingSessions += 1;
    } else if (!allowMissing) {
      throw new SafeError("A fixture teaching session is missing during live dry-run verification");
    }
  }

  return {
    source: "live-tenant-scoped-api",
    verifiedAt: new Date().toISOString(),
    staff: { primary: primaryStaff.data?.users?.length || 0, canary: canaryStaff.data?.users?.length || 0 },
    teachers: state.teachers.filter((teacher) => primaryStaffByEmail.has(teacher.email)).length,
    students: { ...liveStudentCounts, total: liveStudentCounts.primary + liveStudentCounts.canary },
    classes: liveClasses.length,
    devices: { ...liveDeviceCounts, total: liveDeviceCounts.primary + liveDeviceCounts.canary },
    activeTeachingSessions,
  };
}

function initializeDeactivationState(state) {
  return {
    ...state,
    deactivation: {
      startedAt: state.deactivation?.startedAt || new Date().toISOString(),
      revokedDeviceIds: state.deactivation?.revokedDeviceIds || [],
      endedSessionIds: state.deactivation?.endedSessionIds || [],
      archivedClassIds: state.deactivation?.archivedClassIds || [],
      telemetryPurgedSchoolKeys: state.deactivation?.telemetryPurgedSchoolKeys || [],
      telemetryPurgeProof: state.deactivation?.telemetryPurgeProof || {},
      rotatedEnrollmentSchoolKeys: state.deactivation?.rotatedEnrollmentSchoolKeys || [],
      enrollmentKeyRotationProof: state.deactivation?.enrollmentKeyRotationProof || {},
      deletedTeacherMembershipIds: state.deactivation?.deletedTeacherMembershipIds || [],
      deletedStudentIds: state.deactivation?.deletedStudentIds || [],
      disabledLicenseSchoolKeys: state.deactivation?.disabledLicenseSchoolKeys || [],
      suspendedSchoolKeys: state.deactivation?.suspendedSchoolKeys || [],
      preHoldCompleteAt: state.deactivation?.preHoldCompleteAt || null,
      preHoldPostconditions: state.deactivation?.preHoldPostconditions || null,
    },
  };
}

export async function revokeDeviceSessionStrict(client, entry, device, enrollmentKey, pacer) {
  let response = await client.request("/api/classpilot/extension/sign-out", {
    method: "POST", bearer: entry.studentToken, schoolId: device.schoolId,
    body: { reason: "fixture-deactivation" }, pacer, allowedStatuses: [200, 401],
  });
  let replacementIssued = false;
  if (response.status === 401) {
    const registered = await client.request("/api/classpilot/extension/register", {
      method: "POST",
      pacer,
      schoolId: device.schoolId,
      headers: { "x-classpilot-enrollment-key": enrollmentKey },
      body: {
        deviceId: device.deviceId,
        deviceName: `Synthetic ${device.deviceId}`,
        studentEmail: device.studentEmail,
        schoolId: device.schoolId,
        classId: device.classId || device.schoolId,
      },
    });
    const replacementToken = registered.data?.studentToken;
    if (typeof replacementToken !== "string" || !replacementToken) throw new SafeError("Could not replace an expired token for strict device-session revocation");
    if (typeof client.bindBearerToSchool === "function") client.bindBearerToSchool(replacementToken, device.schoolId);
    response = await client.request("/api/classpilot/extension/sign-out", {
      method: "POST", bearer: replacementToken, schoolId: device.schoolId,
      body: { reason: "fixture-deactivation" }, pacer,
    });
    replacementIssued = true;
  }
  if (response.status !== 200) throw new SafeError("Device session revocation did not receive an explicit success response");
  return { revoked: true, replacementIssued };
}

function secretDigest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

async function verifyPreHoldTenantPostconditions(client, config, state, authBySchool) {
  const report = { verifiedAt: new Date().toISOString(), schools: {}, activeTeachingSessions: 0 };
  for (const schoolKey of ["primary", "canary"]) {
    const auth = authBySchool[schoolKey];
    const [staffResponse, studentsResponse, activeClassesResponse, allClassesResponse, devicesResponse, heartbeatsResponse, enrollmentResponse] = await Promise.all([
      client.request("/api/admin/users", { bearer: auth.bearer }),
      client.request("/api/students", { bearer: auth.bearer, timeoutMs: 60_000 }),
      client.request("/api/classpilot/admin/classes", { bearer: auth.bearer }),
      client.request("/api/classpilot/admin/classes?status=all", { bearer: auth.bearer }),
      client.request("/api/classpilot/devices", { bearer: auth.bearer }),
      client.request("/api/classpilot/heartbeats", { bearer: auth.bearer }),
      client.request("/api/classpilot/enrollment-key", { bearer: auth.bearer }),
    ]);
    const staff = staffResponse.data?.users || [];
    const expectedAdminEmail = state.schools[schoolKey].adminEmail;
    if (staff.length !== 1 || String(staff[0]?.user?.email || "").toLowerCase() !== expectedAdminEmail
      || !["admin", "school_admin"].includes(staff[0]?.role)) {
      throw new SafeError(`Post-deactivation ${schoolKey} tenant must retain only its fixture admin`);
    }
    if ((studentsResponse.data?.students || []).length !== 0) throw new SafeError("Synthetic students remain after deactivation");
    if ((activeClassesResponse.data?.classes || []).length !== 0) throw new SafeError("Active synthetic classes remain after deactivation");
    const allClasses = allClassesResponse.data?.classes || [];
    const expectedClasses = schoolKey === "primary" ? new Map(state.teachers.map((teacher) => [teacher.classId, teacher])) : new Map();
    if (allClasses.length !== expectedClasses.size) throw new SafeError("Archived synthetic class postcondition count is incorrect");
    for (const entry of allClasses) {
      const teacher = expectedClasses.get(entry.id);
      if (!teacher || entry.status !== "archived" || entry.name !== teacher.className) {
        throw new SafeError("A retained synthetic class is not the exact archived fixture class");
      }
    }
    if ((devicesResponse.data?.devices || []).length !== 0) throw new SafeError("Synthetic devices remain after telemetry purge");
    if ((heartbeatsResponse.data?.heartbeats || []).length !== 0) throw new SafeError("Synthetic heartbeat telemetry remains after purge");
    const key = enrollmentResponse.data?.key;
    const proof = state.deactivation.enrollmentKeyRotationProof[schoolKey];
    if (!proof || typeof key !== "string" || secretDigest(key) !== proof.afterDigest || proof.beforeDigest === proof.afterDigest) {
      throw new SafeError(`Enrollment-key rotation lacks a live verified postcondition for ${schoolKey}`);
    }
    if (state.deactivation.telemetryPurgeProof[schoolKey]?.ok !== true) {
      throw new SafeError(`Telemetry purge lacks a successful supported-API proof for ${schoolKey}`);
    }
    report.schools[schoolKey] = {
      retainedFixtureAdmins: 1,
      syntheticTeachers: 0,
      syntheticStudents: 0,
      activeClasses: 0,
      archivedFixtureClassesRetained: allClasses.length,
      devices: 0,
      heartbeats: 0,
      enrollmentKeyRotated: true,
      telemetryCleanupEndpointConfirmed: true,
      dailyUsageDirectCountAvailable: false,
    };
  }
  for (const session of state.sessions || []) {
    const response = await client.request(`/api/classpilot/teaching-sessions/${encodeURIComponent(session.sessionId)}`, {
      bearer: authBySchool.primary.bearer,
      allowedStatuses: [200, 404],
    });
    if (response.status === 200 && !response.data?.session?.endTime) report.activeTeachingSessions += 1;
  }
  if (report.activeTeachingSessions !== 0) throw new SafeError("Active synthetic teaching sessions remain after deactivation");
  return report;
}

async function verifySuspendedHoldPostconditions(client, config, state, superAuth) {
  const schools = await verifySchoolsWithSuper(client, config, state, superAuth);
  const report = { verifiedAt: new Date().toISOString(), schools: {} };
  for (const schoolKey of ["primary", "canary"]) {
    const school = schools[schoolKey];
    const admins = Array.isArray(school.admins) ? school.admins : [];
    if (school.status !== "suspended" || (school.products || []).includes("CLASSPILOT")
      || Number(school.studentCount || 0) !== 0 || (school.teachers || []).length !== 0
      || admins.length !== 1 || String(admins[0]?.email || "").toLowerCase() !== state.schools[schoolKey].adminEmail) {
      throw new SafeError("Held fixture school is not suspended, ClassPilot-disabled, empty of synthetic identities, and retaining exactly its fixture admin");
    }
    report.schools[schoolKey] = { status: "suspended", classpilotEnabled: false, retainedFixtureAdmins: 1, students: 0, teachers: 0 };
  }
  return report;
}

async function runDeactivate(client, config, outputDirectory, confirm, dryRun) {
  const originalState = readState(outputDirectory, config);
  if (originalState.hold?.deactivatedAt) {
    return { command: "deactivate", fixtureId: config.fixtureId, alreadyDeactivated: true, hold: originalState.hold };
  }
  const preHoldComplete = Boolean(originalState.deactivation?.preHoldCompleteAt);
  let state = initializeDeactivationState(originalState);
  const checkpoint = () => writePrivateJson(outputDirectory, FILES.state, state);
  const ownership = seedOwnershipFromState(readOwnership(outputDirectory, config), originalState);
  const superAuth = await superAuthFromEnvironment(client, config);
  await verifySchoolsWithSuper(client, config, originalState, superAuth);
  let live = {
    source: "durable-pre-hold-checkpoint",
    verifiedAt: state.deactivation.preHoldCompleteAt || new Date().toISOString(),
  };
  if (!preHoldComplete) {
    const manifest = readPrivateArray(outputDirectory, FILES.devices, "Device manifest");
    const commands = readPrivateArray(outputDirectory, FILES.commands, "Command body artifact");
    validateLocalArtifacts(config, originalState, manifest, commands, { requireUnexpired: false });
    const adminPassword = envSecret("CLP_FIXTURE_ADMIN_PASSWORD", 12);
    const authBySchool = {
      primary: await login(client, originalState.schools.primary.adminEmail, adminPassword, {
        schoolId: originalState.schools.primary.id, schoolName: originalState.schools.primary.name, role: "admin",
      }),
      canary: await login(client, originalState.schools.canary.adminEmail, adminPassword, {
        schoolId: originalState.schools.canary.id, schoolName: originalState.schools.canary.name, role: "admin",
      }),
    };
    live = await collectLiveTenantInventory(client, config, originalState, authBySchool, ownership, {
      allowMissing: Boolean(originalState.deactivation?.startedAt),
    });
    const plan = { ...buildCleanupPlan(config, originalState, manifest.length), command: "deactivate", live };
    if (dryRun) return plan;
    if (confirm !== config.fixtureId) throw new SafeError(`Deactivation requires --confirm ${config.fixtureId}`);
    checkpoint();
  const enrollment = {
    primary: await ensureEnrollmentSafety(client, authBySchool.primary),
    canary: await ensureEnrollmentSafety(client, authBySchool.canary),
  };
  const cleanupPacer = runtimePacer(config.registrationRequestsPerMinute);
  const revoked = new Set(state.deactivation.revokedDeviceIds);
  for (let index = 0; index < manifest.length; index += 1) {
    const entry = manifest[index];
    if (revoked.has(entry.deviceId)) continue;
    const device = state.devices[index];
    await revokeDeviceSessionStrict(client, entry, device, enrollment[device.schoolKey].key, cleanupPacer);
    revoked.add(entry.deviceId);
    state.deactivation.revokedDeviceIds = [...revoked];
    if ((index + 1) % 25 === 0 || index === manifest.length - 1) checkpoint();
  }
  state.deactivation.revokedDeviceIds = [...revoked];
  checkpoint();

  const ended = new Set(state.deactivation.endedSessionIds);
  for (const session of state.sessions || []) {
    if (ended.has(session.sessionId)) continue;
    await client.request(`/api/classpilot/teaching-sessions/${encodeURIComponent(session.sessionId)}/end`, {
      method: "POST", bearer: authBySchool.primary.bearer, body: {}, allowedStatuses: [200, 404],
    });
    ended.add(session.sessionId);
    state.deactivation.endedSessionIds = [...ended];
    checkpoint();
  }
  const archived = new Set(state.deactivation.archivedClassIds);
  for (const teacher of state.teachers) {
    if (archived.has(teacher.classId)) continue;
    await client.request(`/api/classpilot/admin/classes/${encodeURIComponent(teacher.classId)}/archive`, {
      method: "POST", bearer: authBySchool.primary.bearer, body: {}, allowedStatuses: [200, 404],
    });
    archived.add(teacher.classId);
    state.deactivation.archivedClassIds = [...archived];
    checkpoint();
  }
  for (const schoolKey of ["primary", "canary"]) {
    if (!state.deactivation.telemetryPurgedSchoolKeys.includes(schoolKey)) {
      const purged = await client.request("/api/admin/cleanup-students", { method: "POST", bearer: authBySchool[schoolKey].bearer, body: {} });
      if (purged.data?.ok !== true) throw new SafeError("Telemetry cleanup endpoint did not confirm success");
      state.deactivation.telemetryPurgeProof[schoolKey] = { ok: true, confirmedAt: new Date().toISOString() };
      state.deactivation.telemetryPurgedSchoolKeys.push(schoolKey);
      checkpoint();
    }
    if (!state.deactivation.rotatedEnrollmentSchoolKeys.includes(schoolKey)) {
      const beforeDigest = secretDigest(enrollment[schoolKey].key);
      const rotated = await client.request("/api/classpilot/enrollment-key/rotate", { method: "POST", bearer: authBySchool[schoolKey].bearer, body: {} });
      const rotatedKey = rotated.data?.key;
      if (typeof rotatedKey !== "string" || !rotatedKey || secretDigest(rotatedKey) === beforeDigest) {
        throw new SafeError("Enrollment-key rotation did not return a distinct key");
      }
      state.deactivation.enrollmentKeyRotationProof[schoolKey] = {
        beforeDigest,
        afterDigest: secretDigest(rotatedKey),
        verifiedAt: new Date().toISOString(),
      };
      state.deactivation.rotatedEnrollmentSchoolKeys.push(schoolKey);
      checkpoint();
    }
  }
  const deletedTeachers = new Set(state.deactivation.deletedTeacherMembershipIds);
  for (const teacher of state.teachers) {
    if (deletedTeachers.has(teacher.membershipId)) continue;
    await client.request(`/api/admin/users/${encodeURIComponent(teacher.membershipId)}`, {
      method: "DELETE", bearer: authBySchool.primary.bearer, allowedStatuses: [200, 404],
    });
    deletedTeachers.add(teacher.membershipId);
    state.deactivation.deletedTeacherMembershipIds = [...deletedTeachers];
    checkpoint();
  }
  const deletedStudents = new Set(state.deactivation.deletedStudentIds);
  for (const schoolKey of ["primary", "canary"]) {
    const studentsForSchool = state.students[schoolKey];
    for (let index = 0; index < studentsForSchool.length; index += 1) {
      const student = studentsForSchool[index];
      if (deletedStudents.has(student.id)) continue;
      await client.request(`/api/students/${encodeURIComponent(student.id)}`, {
        method: "DELETE", bearer: authBySchool[schoolKey].bearer, pacer: cleanupPacer, allowedStatuses: [200, 404],
      });
      deletedStudents.add(student.id);
      state.deactivation.deletedStudentIds = [...deletedStudents];
      if ((index + 1) % 25 === 0 || index === studentsForSchool.length - 1) checkpoint();
    }
    state.deactivation.deletedStudentIds = [...deletedStudents];
    checkpoint();
  }
  state.deactivation.preHoldPostconditions = await verifyPreHoldTenantPostconditions(client, config, state, authBySchool);
  state.deactivation.preHoldCompleteAt ||= new Date().toISOString();
  checkpoint();
  } else {
    const plan = { ...buildCleanupPlan(config, originalState, 0), command: "deactivate", live, resumingAfterPreHold: true };
    if (dryRun) return plan;
    if (confirm !== config.fixtureId) throw new SafeError(`Deactivation requires --confirm ${config.fixtureId}`);
  }

  for (const schoolKey of ["primary", "canary"]) {
    const school = state.schools[schoolKey];
    if (!state.deactivation.disabledLicenseSchoolKeys.includes(schoolKey)) {
      await client.request(`/api/super-admin/schools/${encodeURIComponent(school.id)}/products/CLASSPILOT`, {
        method: "DELETE", bearer: superAuth.bearer, allowedStatuses: [200, 404],
      });
      state.deactivation.disabledLicenseSchoolKeys.push(schoolKey);
      checkpoint();
    }
    if (!state.deactivation.suspendedSchoolKeys.includes(schoolKey)) {
      await client.request(`/api/super-admin/schools/${encodeURIComponent(school.id)}/suspend`, {
        method: "POST", bearer: superAuth.bearer, body: {},
      });
      state.deactivation.suspendedSchoolKeys.push(schoolKey);
      checkpoint();
    }
  }
  const suspendedPostconditions = await verifySuspendedHoldPostconditions(client, config, state, superAuth);
  const deactivatedAt = new Date().toISOString();
  const cleanupNotBefore = new Date(Date.parse(deactivatedAt) + HOLD_DAYS * 24 * 60 * 60 * 1000).toISOString();
  state = {
    ...state,
    sessions: [],
    hold: {
      deactivatedAt,
      cleanupNotBefore,
      days: HOLD_DAYS,
      deviceSessionsRevoked: true,
      telemetryAndDevicesPurged: true,
      syntheticTeacherMembershipsRemoved: true,
      syntheticStudentsRemoved: true,
      retainedFixtureAdmins: 2,
      retainedArchivedClasses: state.teachers.length,
      enrollmentKeysRotated: true,
      classpilotLicensesDisabled: true,
      schoolsSuspended: true,
      tenantPostconditions: state.deactivation.preHoldPostconditions,
      suspendedSchoolPostconditions: suspendedPostconditions,
    },
  };
  checkpoint();
  writePrivateJson(outputDirectory, FILES.devices, []);
  writePrivateJson(outputDirectory, FILES.commands, []);
  writePrivateJson(outputDirectory, FILES.auth, { schemaVersion: 2, revokedAt: deactivatedAt, expiresAt: deactivatedAt, teacherAuth: [] });
  return { command: "deactivate", fixtureId: config.fixtureId, completed: true, hold: state.hold, liveBeforeDeactivation: live };
}

export async function verifySchoolSoftDeletePostcondition(client, superAuth, config, state, schoolKey) {
  const expected = state.schools?.[schoolKey];
  const spec = config.schools?.[schoolKey];
  if (!expected?.id || !spec || expected.name !== spec.name || String(expected.domain || "").toLowerCase() !== spec.domain) {
    throw new SafeError("Cannot verify a soft delete without the exact fixture school identity");
  }
  const list = await client.request("/api/super-admin/schools?status=all", { bearer: superAuth.bearer });
  const visibleSchools = list.data?.schools;
  if (!Array.isArray(visibleSchools)) throw new SafeError("Soft-delete verification school list is invalid");
  if (visibleSchools.some((school) => school?.id === expected.id)) {
    throw new SafeError(`Soft-deleted ${schoolKey} school remains visible in the active super-admin inventory`);
  }
  if (visibleSchools.some((school) => school?.name === spec.name
    && String(school?.domain || "").toLowerCase() === spec.domain)) {
    throw new SafeError(`A visible school still occupies the exact soft-deleted ${schoolKey} fixture identity`);
  }

  const detail = await client.request(`/api/super-admin/schools/${encodeURIComponent(expected.id)}`, {
    bearer: superAuth.bearer,
    allowedStatuses: [200, 404],
  });
  if (detail.status === 404) {
    return {
      verifiedAt: new Date().toISOString(),
      schoolKey,
      schoolId: expected.id,
      terminalState: "absent",
    };
  }
  const school = detail.data;
  if (
    !school
    || typeof school !== "object"
    || school.id !== expected.id
    || school.name !== spec.name
    || String(school.domain || "").toLowerCase() !== spec.domain
    || school.status !== "suspended"
    || typeof school.deletedAt !== "string"
    || !Number.isFinite(Date.parse(school.deletedAt))
  ) {
    throw new SafeError(`Soft-deleted ${schoolKey} school did not reach the exact documented deletedAt terminal state`);
  }
  assertSchoolIsNonBillable(school, `Soft-deleted ${schoolKey}`);
  return {
    verifiedAt: new Date().toISOString(),
    schoolKey,
    schoolId: expected.id,
    terminalState: "soft-deleted",
    deletedAt: school.deletedAt,
    status: school.status,
  };
}

async function runCleanup(client, config, outputDirectory, confirm, dryRun) {
  let state = readState(outputDirectory, config);
  if (state.cleanup?.completedAt) return { command: "cleanup", fixtureId: config.fixtureId, alreadyCompleted: true };
  if (!state.hold?.deactivatedAt) {
    if (dryRun) return runDeactivate(client, config, outputDirectory, confirm, true);
    throw new SafeError("Run deactivate --confirm first so sessions and telemetry are purged before the 30-day hold");
  }
  const superAuth = await superAuthFromEnvironment(client, config);
  const ownership = seedOwnershipFromState(readOwnership(outputDirectory, config), state);
  const alreadyDeleted = new Set(state.cleanup?.deletedOwnedSchoolKeys || []);
  const ownedSchoolKeys = config.cleanupOwnedSchools
    ? ["primary", "canary"].filter((key) => state.schools[key]?.createdByTool === true
      && ownership.schools[key]?.createdByTool === true
      && ownership.schools[key]?.id === state.schools[key]?.id)
    : [];
  if ([...alreadyDeleted].some((key) => !ownedSchoolKeys.includes(key))) {
    throw new SafeError("Cleanup checkpoint contains a school that is not exact durable tool-owned inventory");
  }
  const deletedSchoolPostconditions = { ...(state.cleanup?.deletedSchoolPostconditions || {}) };
  for (const schoolKey of alreadyDeleted) {
    deletedSchoolPostconditions[schoolKey] = await verifySchoolSoftDeletePostcondition(
      client, superAuth, config, state, schoolKey,
    );
  }
  const liveSchools = await verifySchoolsWithSuper(client, config, state, superAuth, { skipSchoolKeys: alreadyDeleted });
  const plan = {
    dryRun: true,
    fixtureId: config.fixtureId,
    mutationsPerformed: 0,
    planned: { schoolSoftDeletes: ownedSchoolKeys.filter((key) => !alreadyDeleted.has(key)).length },
    ownedSchoolKeys,
  };
  const finalLive = {
    source: "live-super-admin-api",
    verifiedAt: new Date().toISOString(),
    schools: Object.fromEntries(["primary", "canary"].map((key) => [key, {
      deleted: liveSchools[key].deleted === true,
      status: liveSchools[key].status,
      studentCount: liveSchools[key].studentCount,
      teacherCount: Array.isArray(liveSchools[key].teachers) ? liveSchools[key].teachers.length : null,
      retainedFixtureAdminCount: Array.isArray(liveSchools[key].admins) ? liveSchools[key].admins.length : null,
      products: liveSchools[key].products || [],
    }])),
  };
  for (const schoolKey of ["primary", "canary"]) {
    const school = liveSchools[schoolKey];
    if (school.deleted) continue;
    const admins = Array.isArray(school.admins) ? school.admins : [];
    if (
      school.status !== "suspended"
      || Number(school.studentCount || 0) !== 0
      || (Array.isArray(school.teachers) && school.teachers.length !== 0)
      || (school.products || []).includes("CLASSPILOT")
      || admins.length !== 1
      || String(admins[0]?.email || "").toLowerCase() !== state.schools[schoolKey].adminEmail
    ) {
      throw new SafeError("Held fixture tenant is not suspended, synthetic-identity empty, ClassPilot-disabled, and retaining exactly its fixture admin");
    }
  }
  const eligible = Date.now() >= Date.parse(state.hold.cleanupNotBefore);
  if (dryRun) return { ...plan, command: "cleanup", eligible, cleanupNotBefore: state.hold.cleanupNotBefore, live: finalLive };
  if (!eligible) throw new SafeError(`Cleanup hold remains active until ${state.hold.cleanupNotBefore}`);
  if (confirm !== config.fixtureId) throw new SafeError(`Cleanup requires --confirm ${config.fixtureId}`);
  const deleted = new Set(state.cleanup?.deletedOwnedSchoolKeys || []);
  for (const schoolKey of plan.ownedSchoolKeys) {
    if (deleted.has(schoolKey)) continue;
    await client.request(`/api/super-admin/schools/${encodeURIComponent(state.schools[schoolKey].id)}`, {
      method: "DELETE", bearer: superAuth.bearer, body: {}, allowedStatuses: [200, 404],
    });
    deletedSchoolPostconditions[schoolKey] = await verifySchoolSoftDeletePostcondition(
      client, superAuth, config, state, schoolKey,
    );
    deleted.add(schoolKey);
    state = {
      ...state,
      cleanup: {
        ...(state.cleanup || {}),
        deletedOwnedSchoolKeys: [...deleted],
        deletedSchoolPostconditions,
      },
    };
    writePrivateJson(outputDirectory, FILES.state, state);
  }
  const completedAt = new Date().toISOString();
  const result = {
    schemaVersion: 2,
    fixtureId: config.fixtureId,
    completedAt,
    deletedOwnedSchoolKeys: [...deleted],
    deletedSchoolPostconditions,
    live: finalLive,
  };
  writePrivateJson(outputDirectory, FILES.cleanup, result);
  state = { ...state, cleanup: { completedAt, deletedOwnedSchoolKeys: [...deleted], deletedSchoolPostconditions } };
  writePrivateJson(outputDirectory, FILES.state, state);
  return { command: "cleanup", fixtureId: config.fixtureId, completed: true, ...result, outputFiles: [FILES.cleanup, FILES.state] };
}

export function buildHelpText() {
  const example = {
    version: 1,
    fixtureId: "launch-safe-2026",
    baseUrl: "https://app.example.org",
    ownershipAcknowledgement: OWNERSHIP_ACK,
    emailDeliveryAcknowledgement: EMAIL_DELIVERY_ACK,
    operatorMailboxEmail: "operator@primary-owned.example.org",
    operatorOwnedAdminEmail: "operator+launch-primary@primary-owned.example.org",
    allowSchoolCreation: false,
    cleanupOwnedSchools: false,
    schools: {
      primary: {
        name: "[SYNTHETIC LOAD TEST - NON-BILLABLE] launch-safe-2026 Primary School",
        domain: "primary-owned.example.org",
        adminEmail: "operator+launch-primary@primary-owned.example.org",
      },
      canary: {
        name: "[SYNTHETIC LOAD TEST - NON-BILLABLE] launch-safe-2026 Canary School",
        domain: "primary-owned.example.org",
        adminEmail: "operator+launch-canary@primary-owned.example.org",
      },
    },
    aliases: {
      teacherPrefix: "operator+launch-teacher",
      primaryStudentPrefix: "operator+launch-student",
      canaryStudentPrefix: "operator+launch-canary-student",
    },
    commandUrl: "https://example.org/schoolpilot-load-test",
    registrationRequestsPerMinute: 600,
    timezone: "America/New_York",
  };
  return [
    "SchoolPilot synthetic ClassPilot load-fixture preparer",
    "",
    "Usage:",
    "  node scripts/load/prepare-classpilot-load-test.mjs <command> --config <absolute-json> --output <absolute-directory> [options]",
    "  node scripts/load/prepare-classpilot-load-test.mjs --help",
    "",
    "Commands:",
    "  provision            Idempotently create/verify the dedicated fixtures and refresh private credentials.",
    "  refresh              Reissue private device, session, and command artifacts.",
    "  verify               Verify the live fixture plus current device, command, and staff-auth artifacts.",
    "  deactivate           Revoke sessions, purge telemetry/devices, remove non-admin identities, disable licenses, and start the 30-day hold.",
    "  cleanup              After the hold, verify and optionally soft-delete tool-owned synthetic school shells.",
    "",
    "Options:",
    "  --config <path>      Absolute external JSON config path.",
    "  --output <path>      Directory under %LOCALAPPDATA%\\SchoolPilot\\load-gates.",
    "  --dry-run            Supported by provision, deactivate, and cleanup.",
    "  --confirm <fixture>  Required for destructive deactivate/cleanup operations.",
    "",
    "Process environment (values are secrets or operator attestations; never put values in the config):",
    "  CLP_SUPER_ADMIN_BEARER (preferred for Google-sign-in super admins; token value only)",
    "    OR CLP_SUPER_ADMIN_EMAIL / CLP_SUPER_ADMIN_PASSWORD",
    "  The selected super-admin identity is verified through /api/auth/me and must exactly match operatorMailboxEmail.",
    "  CLP_FIXTURE_ADMIN_PASSWORD / CLP_FIXTURE_TEACHER_PASSWORD",
    "  CLP_OPERATOR_ALIAS_CONFIRMED=<fixtureId>",
    "  CLP_CANARY_ALIAS_CONFIRMED=<fixtureId>",
    "",
    "Email-delivery safety:",
    "  Both clearly named synthetic schools may safely share the base mailbox domain; SchoolPilot identifies them by exact domain plus name.",
    "  Every configured domain must be operator-owned and route Gmail-style plus aliases to operatorMailboxEmail. Use a different canary domain only if that exact domain is independently routed and tested.",
    "  Before setting either confirmation variable, send an external message to that exact configured admin plus alias and verify actual receipt. Provisioning performs no address-producing mutation for a school until its alias confirmation matches fixtureId.",
    "  All generated teacher and student addresses are forced to use the same mailbox local-part plus addressing, so the two probes cover later fixture notifications.",
    "  Initial schools must be created by this tool with allowSchoolCreation=true. Existing schools are accepted only with the matching private tool-ownership ledger or an exact checkpointed create intent; partial create repair binds the discovered id and completes only the configured admin/settings through supported APIs.",
    "  ClassPilot inventory APIs are license-gated: after exact admin context and billing proof, the tool may enable the non-billable ClassPilot license, then completes the read-only inventory preflight before tracking, roster, class, or device mutations.",
    "  Deactivation retains exactly one fixture admin per suspended school and retains exact archived classes when teaching history prevents supported-API deletion. It proves zero active classes/devices/heartbeats; cleanup is complete only after the super-admin APIs prove exact absence or a suspended deletedAt terminal record. The cleanup endpoint removes daily usage but no direct daily-usage count API exists.",
    "",
    "Config schema example (contains no credentials):",
    JSON.stringify(example, null, 2),
  ].join("\n");
}

function parseArguments(argv) {
  const args = [...argv];
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") return { command: "help" };
  const command = args.shift();
  if (!["provision", "refresh", "verify", "deactivate", "cleanup"].includes(command)) {
    throw new SafeError("First argument must be provision, refresh, verify, deactivate, or cleanup");
  }
  const options = { command, config: null, output: null, dryRun: false, confirm: null };
  while (args.length) {
    const arg = args.shift();
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--config") options.config = args.shift() || null;
    else if (arg === "--output") options.output = args.shift() || null;
    else if (arg === "--confirm") options.confirm = args.shift() || null;
    else throw new SafeError("Unknown argument; expected --config, --output, --dry-run, or --confirm");
  }
  if (!options.config || !options.output) throw new SafeError("--config and --output are required");
  if (options.dryRun && !["provision", "deactivate", "cleanup"].includes(command)) throw new SafeError("--dry-run is supported only for provision, deactivate, and cleanup");
  return options;
}

export async function runCli(argv) {
  const options = parseArguments(argv);
  if (options.command === "help") return { command: "help", helpText: buildHelpText() };
  const external = assertExternalPaths(options.config, options.output);
  const config = loadExternalConfig(external.configPath);
  const outputDirectory = preparePrivateOutputDirectory(external.outputPath, external.loadGatesRoot);
  if (options.command === "provision" && options.dryRun) {
    validateExistingOutputReadOnly(outputDirectory, config);
    return buildDryRunSummary(config);
  }
  const client = new ApiClient(config.baseUrl);
  if (options.command === "provision") return runProvision(client, config, outputDirectory);
  if (options.command === "refresh") {
    const state = readState(outputDirectory, config);
    if (state.hold?.deactivatedAt || state.cleanup?.completedAt) throw new SafeError("A deactivated or cleaned fixture cannot be refreshed");
    persistOwnership(outputDirectory, seedOwnershipFromState(readOwnership(outputDirectory, config), state));
    return refreshArtifacts(client, config, outputDirectory, state, envSecret("CLP_FIXTURE_ADMIN_PASSWORD", 12), envSecret("CLP_FIXTURE_TEACHER_PASSWORD", 12));
  }
  if (options.command === "verify") return runVerify(client, config, outputDirectory);
  if (options.command === "deactivate") return runDeactivate(client, config, outputDirectory, options.confirm, options.dryRun);
  return runCleanup(client, config, outputDirectory, options.confirm, options.dryRun);
}

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  runCli(process.argv.slice(2))
    .then((summary) => process.stdout.write(summary.command === "help" ? `${summary.helpText}\n` : `${JSON.stringify(summary, null, 2)}\n`))
    .catch((error) => {
      const message = error instanceof SafeError ? error.message : "Unexpected failure; no sensitive diagnostic details were printed";
      process.stderr.write(`ERROR: ${message}\n`);
      process.exitCode = 1;
    });
}
