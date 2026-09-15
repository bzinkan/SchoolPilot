import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { describe, it, type TestContext } from "node:test";
import { runInNewContext } from "node:vm";
import express from "express";
import { MemoryStore, rateLimit, type Store } from "express-rate-limit";
import bcrypt from "bcryptjs";
import { RedisStore } from "rate-limit-redis";
import { createClient } from "redis";
import ts from "typescript";
import { apiLimiter } from "../src/middleware/rateLimiter.js";
import { comparePassword } from "../src/util/password.js";
import { usesEmailIdStudentSignIn } from "../src/util/classpilotStudentSignInMethod.js";
import {
  createStudentSignInDiagnostics,
  type StudentSignInStage, type StudentSignInMethod, type StudentSignInFailureReason,
} from "../src/services/classpilotStudentSignInDiagnostics.js";

// Execute the production route, with only its I/O replaced. This deliberately
// avoids importing the application, opening a database, or copying auth logic.
const source = readFileSync(new URL("../src/routes/classpilot/devices.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("devices.ts", source, ts.ScriptTarget.Latest, true);
const route = parsed.statements.find((statement) => {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false;
  const call = statement.expression;
  return ts.isPropertyAccessExpression(call.expression)
    && call.expression.expression.getText(parsed) === "router"
    && call.expression.name.text === "post"
    && call.arguments[0] !== undefined
    && ts.isStringLiteral(call.arguments[0])
    && call.arguments[0].text === "/extension/student-login";
});

class ObservedMemoryStore extends MemoryStore {
  increments = 0;
  unavailable = false;
  override async increment(key: string) {
    this.increments += 1;
    if (this.unavailable) throw new Error("Synthetic limiter store unavailable");
    return super.increment(key);
  }
}

// Execute the real compatibility rewrite, not a test copy of the alias rule.
const routeIndex = ts.createSourceFile("index.ts", readFileSync(
  new URL("../src/routes/index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const rewrite = routeIndex.statements.find((statement) => {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false;
  const call = statement.expression;
  return ts.isPropertyAccessExpression(call.expression)
    && call.expression.expression.getText(routeIndex) === "router"
    && call.expression.name.text === "use"
    && call.arguments[0] !== undefined && ts.isArrowFunction(call.arguments[0]);
});
assert.ok(rewrite, "production compatibility rewrite must be present");
const rewriteExecutable = ts.transpileModule(rewrite.getText(routeIndex), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
let httpFixtureNumber = 100;

async function serveScenario(t: TestContext, options: Scenario = {}, store: Store = new ObservedMemoryStore()) {
  const counts: Record<string, number> = {};
  const diagnostics = createStudentSignInDiagnostics({
    sink: () => {},
    recordCounters: (increments) => {
      for (const [key, value] of Object.entries(increments)) counts[key] = (counts[key] ?? 0) + value;
    },
  });
  const fixture = setupScenario(options, diagnostics);
  const limiter: express.RequestHandler = runInNewContext(limiterExecutable, {
    rateLimit,
    usesEmailIdStudentSignIn,
    extensionIp: () => "fixture-egress",
    redisStore: (prefix: string) => {
      assert.equal(prefix, "rl:classpilot:extension:login:");
      return store;
    },
    markStudentSignInFailure: diagnostics.markStudentSignInFailure,
  });
  const app = express();
  app.set("trust proxy", 1);
  app.use(diagnostics.studentSignInDiagnostics, express.json());
  app.use("/api", apiLimiter);
  const api = express.Router();
  runInNewContext(rewriteExecutable, { router: api });
  const devices = express.Router();
  devices.post("/extension/student-login", limiter, (req, res, next) => {
    void fixture.handler(req, res, next).catch(next);
  });
  api.use("/classpilot", devices);
  app.use("/api", api);
  const errorHandler: express.ErrorRequestHandler = (_error: unknown, _req, res, _next) => {
    res.status(500).json({ error: "Fixture authentication operation failed" });
  };
  app.use(errorHandler);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    store.shutdown?.();
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const ip = `198.51.100.${httpFixtureNumber++}`;
  const post = (path: string, overrides: Record<string, unknown> = {}) => fetch(base + path, {
    method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ ...fixture.request.body, ...overrides }),
  });
  return { ...fixture, counts, post, store };
}

function assertNoPinStateOperations(fixture: ReturnType<typeof setupScenario>) {
  assert.equal(fixture.calls.includes("lockout"), false, "must not consult retired lockout state");
  assert.deepEqual(fixture.failureKeys, [], "must not write failed-PIN state");
  assert.deepEqual(fixture.clearedKeys, [], "must not depend on Redis cleanup after a correct PIN");
}

describe("PIN retries through the production route, compatibility rewrite and real middleware", () => {
  for (const path of ["/api/extension/student-login", "/api/classpilot/extension/student-login"]) {
    it(`accepts a correct PIN immediately after 50 incorrect attempts on ${path}`, async (t) => {
      const student = { ...defaultStudent(), classpilotPinHash: await bcrypt.hash("1234", 4) };
      const store = new ObservedMemoryStore();
      const fixture = await serveScenario(t, {
        student, pinMatches: comparePassword, lockout: 600, continuity: "valid",
      }, store);
      const startedAt = Date.now();
      for (let attempt = 0; attempt < 50; attempt++) {
        const response = await fixture.post(path, { pin: "0000" });
        assert.equal(response.status, 401);
        assert.deepEqual(await response.json(), { ...incorrectPinError, managedDeviceContinuityAccepted: true });
        assert.equal(response.headers.get("retry-after"), null);
      }
      const accepted = await fixture.post(path, { pin: "1234" });
      assert.equal(accepted.status, 200);
      assert.deepEqual(await accepted.json(), publicLogin);
      assert.ok(Date.now() - startedAt < 60_000, "all requests must occur within the former request-limit window");
      assert.equal(accepted.headers.get("ratelimit-limit"), "1000", "global API protection remains active");
      assert.equal(store.increments, 0, "PIN requests must bypass the email/ID limiter store entirely");
      assert.equal(fixture.compares.length, 51);
      assert.equal(fixture.issuedOptions.length, 1);
      assert.equal(fixture.counts.studentSignInCompleted, 51);
      assert.equal(fixture.counts.studentSignInFailure, 50);
      assert.equal(fixture.counts.studentSignInReasonPinMismatch, 50);
      assert.equal(fixture.counts.studentSignInSuccess, 1);
      assert.equal(fixture.counts.studentSignInReasonPinLockout ?? 0, 0);
      assertNoPinStateOperations(fixture);
    });
  }

  it("does not depend on limiter-store recovery, and checks the current PIN after an administrative reset", async (t) => {
    const student = { ...defaultStudent(), classpilotPinHash: await bcrypt.hash("1234", 4) };
    const store = new ObservedMemoryStore();
    store.unavailable = true;
    const fixture = await serveScenario(t, { student, pinMatches: comparePassword, lockout: 600 }, store);
    student.classpilotPinHash = await bcrypt.hash("5678", 4);
    const oldPin = await fixture.post("/api/extension/student-login", { pin: "1234" });
    assert.equal(oldPin.status, 401);
    assert.deepEqual(await oldPin.json(), incorrectPinError);
    const newPin = await fixture.post("/api/classpilot/extension/student-login", { pin: "5678" });
    assert.equal(newPin.status, 200);
    await newPin.text();
    assert.equal(store.increments, 0);
    assert.equal(fixture.compares.length, 2);
    assertNoPinStateOperations(fixture);
  });

  const payloads: Array<{ name: string; fields: Record<string, unknown>; limited: boolean; status: number }> = [
    { name: "email/ID with PIN fields and a claimed PIN method", fields: {
      studentEmail: "student@example.invalid", studentIdNumber: "id-fixture", mode: "pin", studentId: "student-fixture", pin: "0000",
    }, limited: true, status: 200 },
    { name: "truthy whitespace email", fields: { studentEmail: " ", studentIdNumber: "" }, limited: true, status: 400 },
    { name: "truthy malformed array email", fields: { studentEmail: [], studentIdNumber: "" }, limited: true, status: 400 },
    { name: "truthy malformed ID object", fields: { studentEmail: "", studentIdNumber: {} }, limited: true, status: 400 },
    { name: "falsy email/ID fields with a claimed email method", fields: {
      studentEmail: false, studentIdNumber: 0, mode: "email_id",
    }, limited: false, status: 200 },
    { name: "empty email and null ID", fields: { studentEmail: "", studentIdNumber: null }, limited: false, status: 200 },
  ];
  for (const entry of payloads) {
    it(`uses the same method branch and request-limit eligibility for ${entry.name}`, async (t) => {
      const fixture = await serveScenario(t, { configuredMethod: entry.limited ? "email_id" : "name_pin" });
      for (let attempt = 0; attempt < 20; attempt++) {
        const response = await fixture.post(attempt % 2
          ? "/api/extension/student-login" : "/api/classpilot/extension/student-login", entry.fields);
        assert.equal(response.status, entry.status);
        await response.text();
      }
      const next = await fixture.post("/api/extension/student-login", entry.fields);
      assert.equal(next.status, entry.limited ? 429 : entry.status);
      if (entry.limited) {
        assert.deepEqual(await next.json(), { error: "Too many login attempts, please wait" });
        assert.equal(next.headers.get("ratelimit-limit"), "20");
        assert.equal(next.headers.get("ratelimit-remaining"), "0");
        assert.ok(Number(next.headers.get("retry-after")) > 0);
        assert.equal(fixture.counts.studentSignInReasonStudentLoginRateLimit, 1);
        assert.equal(fixture.compares.length, 0);
        assert.ok(fixture.methods.every((method) => method === "email_id"));
      } else {
        await next.text();
        assert.equal(next.headers.get("ratelimit-limit"), "1000");
        assert.equal(fixture.counts.studentSignInReasonStudentLoginRateLimit ?? 0, 0);
        assert.equal(fixture.compares.length, 21);
        assert.ok(fixture.methods.every((method) => method === "name_pin"));
      }
      assertNoPinStateOperations(fixture);
    });
  }

  it("ignores pre-existing Redis PIN keys across two app instances and leaves another student unaffected", {
    skip: !process.env.TEST_REDIS_URL,
  }, async (t) => {
    const redisUrl = process.env.TEST_REDIS_URL;
    assert.ok(redisUrl);
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(redisUrl).hostname), "only a local Redis test fixture is allowed");
    const client = createClient({ url: redisUrl });
    client.on("error", () => {});
    await client.connect();
    const prefix = `test:pin-retries:${process.pid}:${Date.now()}:`;
    const lockKey = `${prefix}classpilot:pin-lockout:school-fixture:student-fixture`;
    const countKey = `${prefix}classpilot:pin-failures:school-fixture:student-fixture`;
    await client.set(lockKey, "1", { EX: 600 });
    await client.set(countKey, "17"); // Includes the historical missing-expiry case.
    const commandCalls: string[][] = [];
    const storeForInstance = () => new RedisStore({
      prefix: `${prefix}login:`,
      sendCommand: async (...args: string[]) => {
        commandCalls.push(args);
        return client.sendCommand(args);
      },
    });
    t.after(async () => {
      await client.del([lockKey, countKey]);
      await client.quit();
    });
    const student = { ...defaultStudent(), classpilotPinHash: await bcrypt.hash("1234", 4) };
    const otherStudent = { ...student, id: "other-student-fixture", classpilotPinHash: await bcrypt.hash("5678", 4) };
    const students = new Map([[student.id, student], [otherStudent.id, otherStudent]]);
    const first = await serveScenario(t, { students, pinMatches: comparePassword, lockout: 600 }, storeForInstance());
    const second = await serveScenario(t, { students, pinMatches: comparePassword, lockout: 600 }, storeForInstance());
    const startedAt = Date.now();
    for (let attempt = 0; attempt < 50; attempt++) {
      const instance = attempt % 2 ? second : first;
      const path = attempt % 2 ? "/api/classpilot/extension/student-login" : "/api/extension/student-login";
      const rejected = await instance.post(path, { pin: "0000" });
      assert.equal(rejected.status, 401);
      assert.deepEqual(await rejected.json(), incorrectPinError);
    }
    const accepted = await second.post("/api/classpilot/extension/student-login", { pin: "1234" });
    assert.equal(accepted.status, 200);
    await accepted.text();
    const other = await first.post("/api/classpilot/extension/student-login", { studentId: otherStudent.id, pin: "5678" });
    assert.equal(other.status, 200);
    await other.text();
    assert.ok(Date.now() - startedAt < 60_000, "cross-instance retries must occur within the former request-limit window");
    assert.equal(first.compares.length, 26);
    assert.equal(second.compares.length, 26);
    assert.equal(first.issuedOptions.length, 1);
    assert.equal(second.issuedOptions.length, 1);
    assert.equal(await client.get(lockKey), "1");
    assert.equal(await client.get(countKey), "17");
    assert.ok(await client.pTTL(lockKey) > 0);
    assert.equal(await client.pTTL(countKey), -1);
    assert.ok(commandCalls.every(([operation]) => operation === "SCRIPT"), "only limiter script preparation is permitted; PIN requests must not use Redis");
    assertNoPinStateOperations(first);
    assertNoPinStateOperations(second);
  });
});
assert.ok(route, "the actual student-login route must be present");
const entitlementHelper = parsed.statements.find((statement) => ts.isFunctionDeclaration(statement)
  && statement.name?.text === "requireUncachedClasspilotEntitlementForIssuance");
assert.ok(entitlementHelper, "the actual entitlement response helper must be present");
const executable = ts.transpileModule(`${entitlementHelper.getText(parsed)}\n${route.getText(parsed)}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const limiterStatement = parsed.statements.find((item) => ts.isVariableStatement(item)
  && item.declarationList.declarations.some((declaration) => ts.isIdentifier(declaration.name)
    && declaration.name.text === "extensionLoginLimiter"));
assert.ok(limiterStatement, "the actual extension login limiter must be present");
const limiterExecutable = ts.transpileModule(`${limiterStatement.getText(parsed)}\nextensionLoginLimiter;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

type Student = {
  id: string;
  schoolId: string;
  status: string;
  classpilotPinHash: string | null;
  studentIdNumber: string;
};
type Scenario = {
  method?: "name_pin" | "email_id";
  body?: Record<string, unknown>;
  student?: Student | null;
  enabled?: boolean;
  schoolFound?: boolean;
  resolvedSchoolFound?: boolean;
  slugSchoolId?: string;
  entitled?: boolean;
  sharedEnabled?: boolean;
  configuredMethod?: "name_pin" | "email_id";
  enrollment?: { ok: false; status: number; error: string };
  continuity?: "valid" | "invalid";
  correctPin?: boolean;
  pinMatches?: (pin: string, hash: string) => boolean | Promise<boolean>;
  students?: Map<string, Student>;
  lockout?: number;
  throwAt?: "tenant_checkout" | "student_lookup" | "compare";
  issuanceError?: Error;
};
type CapturedResponse = {
  statusCode: number;
  body?: unknown;
  locals: Record<string, unknown>;
  status(code: number): CapturedResponse;
  json(body: unknown): CapturedResponse;
};
type Handler = (request: Pick<express.Request, "body" | "headers">,
  response: CapturedResponse, next: (error?: unknown) => void) => Promise<unknown>;

const defaultStudent = (): Student => ({
  id: "student-fixture", schoolId: "school-fixture", status: "active",
  classpilotPinHash: "hash-fixture", studentIdNumber: "id-fixture",
});
const credentialsError = { error: "Invalid student credentials" };
const incorrectPinError = { error: "Incorrect PIN. Please try again." };
const publicLogin = { studentSessionId: "session-fixture", student: { id: "student-fixture" } };
const plain = (value: unknown): unknown => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function setupScenario(options: Scenario = {}, diagnostics?: ReturnType<typeof createStudentSignInDiagnostics>) {
  const method = options.method ?? "name_pin";
  const calls: string[] = [];
  const failures: string[] = [];
  const stages: string[] = [];
  const methods: string[] = [];
  const markedErrors: unknown[] = [];
  const nextErrors: unknown[] = [];
  const failureKeys: Array<[string, string]> = [];
  const clearedKeys: Array<[string, string]> = [];
  const compares: Array<[string, string]> = [];
  const issuedOptions: unknown[] = [];
  const injectedError = new Error("private lookup fixture must remain an exception");
  const body = {
    deviceId: "device-fixture", schoolId: "school-fixture",
    ...(method === "email_id"
      ? { studentEmail: " Student@Example.Invalid ", studentIdNumber: " id-fixture " }
      : { studentId: "student-fixture", pin: " 1234 " }),
    ...options.body,
  };
  const request: Parameters<Handler>[0] = { body, headers: options.continuity ? { authorization: "continuity-fixture" } : {} };
  const response: CapturedResponse = {
    statusCode: 200, body: undefined, locals: {},
    status(code) { this.statusCode = code; return this; },
    json(value) { calls.push("response"); this.body = plain(value); return this; },
  };
  let handler: Handler | undefined;
  const student = options.student === undefined ? defaultStudent() : options.student;
  const failAt = (point: Scenario["throwAt"]) => { if (options.throwAt === point) throw injectedError; };
  const context = {
    router: { post: (path: string, _limiter: unknown, registered: Handler) => {
      assert.equal(path, "/extension/student-login"); handler = registered;
    } },
    extensionLoginLimiter: () => {},
    usesEmailIdStudentSignIn,
    setClassPilotNoStore: () => { calls.push("no_store"); },
    classpilotManualSharedSessionIssuanceEnabled: () => options.enabled !== false,
    studentSessionRecoveryTokenFromAuthorization: () => undefined,
    classpilotManagedDeviceAuthorizationPresented: () => Boolean(options.continuity),
    classpilotManagedDeviceProofFromAuthorization: () => options.continuity ? "proof-fixture" : undefined,
    enrollmentKeyFromRequest: () => "enrollment-fixture",
    resolveSchoolForStudent: async (email: string) => {
      calls.push("resolve_school");
      assert.equal(email, "student@example.invalid");
      return options.resolvedSchoolFound === false ? undefined : { school: { id: "school-fixture" } };
    },
    getSchoolById: async () => {
      calls.push("school_lookup"); return options.schoolFound === false ? undefined : { id: "school-fixture" };
    },
    getSchoolBySlug: async () => {
      calls.push("slug_lookup");
      return options.schoolFound === false ? undefined : { id: options.slugSchoolId ?? "school-fixture" };
    },
    resolveClasspilotEntitlement: async (schoolId: string) => {
      calls.push("entitlement");
      assert.equal(schoolId, "school-fixture");
      return { entitled: options.entitled !== false, reason: "school_inactive" };
    },
    runWithTenantContext: async (_scope: unknown, work: () => Promise<unknown>) => {
      calls.push("tenant"); failAt("tenant_checkout"); return work();
    },
    getSettingsForSchool: async () => {
      calls.push("settings");
      return { sharedChromebookSignInEnabled: options.sharedEnabled !== false };
    },
    effectiveSharedChromebookLoginMethod: () => options.configuredMethod ?? method,
    validateEnrollmentKeyForSettings: () => { calls.push("enrollment"); return options.enrollment ?? { ok: true }; },
    verifyClasspilotManagedDeviceContinuityProof: () => {
      calls.push("continuity"); return options.continuity === "valid" ? { deviceId: "managed-device-fixture" } : null;
    },
    getStudentByEmail: async (schoolId: string, email: string) => {
      calls.push("student_lookup"); failAt("student_lookup");
      assert.equal(schoolId, "school-fixture"); assert.equal(email, "student@example.invalid"); return student;
    },
    getStudentById: async (studentId: string) => {
      calls.push("student_lookup"); failAt("student_lookup");
      if (options.students) return options.students.get(studentId);
      assert.equal(studentId, "student-fixture"); return student;
    },
    getPinLockout: async () => {
      calls.push("lockout"); return options.lockout === undefined ? { ok: true } : { ok: false, retryAfterSeconds: options.lockout };
    },
    comparePassword: async (pin: string, hash: string) => {
      calls.push("compare"); compares.push([pin, hash]); failAt("compare");
      return options.pinMatches ? options.pinMatches(pin, hash) : options.correctPin !== false;
    },
    recordPinFailure: async (schoolId: string, studentId: string) => {
      calls.push("failure_counter"); failureKeys.push([schoolId, studentId]);
    },
    clearPinFailures: async (schoolId: string, studentId: string) => {
      calls.push("clear_counter"); clearedKeys.push([schoolId, studentId]);
    },
    completeStudentDeviceLogin: async (input: { onDiagnosticsStage?: (stage: "response_preparation") => void }, sendResponse: (prepared: unknown) => unknown) => {
      calls.push("issuance"); issuedOptions.push(input);
      if (options.issuanceError) throw options.issuanceError;
      input.onDiagnosticsStage?.("response_preparation");
      return sendResponse(publicLogin);
    },
    markStudentSignInStage: (req: object, stage: StudentSignInStage) => {
      stages.push(stage); diagnostics?.markStudentSignInStage(req, stage);
    },
    markStudentSignInMethod: (req: object, value: StudentSignInMethod) => {
      methods.push(value); diagnostics?.markStudentSignInMethod(req, value);
    },
    markStudentSignInFailure: (req: object, reason: StudentSignInFailureReason) => {
      calls.push(`mark_failure:${reason}`); failures.push(reason); diagnostics?.markStudentSignInFailure(req, reason);
    },
    markStudentSignInError: (req: object, error: unknown) => {
      markedErrors.push(error); diagnostics?.markStudentSignInError(req, error);
    },
  };
  runInNewContext(executable, context);
  assert.ok(handler, "production route registered a handler");
  return { response, calls, failures, stages, methods, markedErrors, nextErrors, failureKeys,
    clearedKeys, compares, issuedOptions, injectedError, handler, request };
}

async function scenario(options: Scenario = {}) {
  const result = setupScenario(options);
  await result.handler(result.request, result.response, (error) => { result.nextErrors.push(error); });
  return result;
}

describe("student-login private route diagnostics preserve authentication behavior", () => {
  const groupedPinFailures: Array<{ name: string; student?: Student | null; correctPin?: boolean; reason: string; comparisons: number }> = [
    { name: "missing student", student: null, reason: "STUDENT_NOT_FOUND", comparisons: 0 },
    { name: "foreign-school student", student: { ...defaultStudent(), schoolId: "foreign-school", status: "inactive", classpilotPinHash: null }, reason: "STUDENT_SCHOOL_MISMATCH", comparisons: 0 },
    { name: "inactive student", student: { ...defaultStudent(), status: "inactive", classpilotPinHash: null }, reason: "STUDENT_INACTIVE", comparisons: 0 },
    { name: "unconfigured PIN", student: { ...defaultStudent(), classpilotPinHash: null }, reason: "PIN_NOT_CONFIGURED", comparisons: 0 },
    { name: "incorrect PIN", correctPin: false, reason: "PIN_MISMATCH", comparisons: 1 },
  ];
  for (const entry of groupedPinFailures) {
    it(`keeps the credential decision without lockout writes for ${entry.name}`, async () => {
      const result = await scenario(entry);
      assert.equal(result.response.statusCode, 401);
      assert.deepEqual(result.response.body, entry.reason === "PIN_MISMATCH" ? incorrectPinError : credentialsError);
      assert.deepEqual(result.failures, [entry.reason]);
      assert.equal(result.compares.length, entry.comparisons);
      assert.deepEqual(result.failureKeys, []);
      assert.deepEqual(result.clearedKeys, []);
      assert.deepEqual(result.issuedOptions, []);
      assert.deepEqual(result.nextErrors, []);
      assert.equal(result.calls.filter((call) => call === "student_lookup").length, 1);
      assert.equal(result.calls.includes("lockout"), false);
    });
  }

  it("does not evaluate later PIN predicates after a school or activity rejection", async () => {
    for (const field of ["status", "classpilotPinHash"] as const) {
      const student = { ...defaultStudent(), schoolId: field === "status" ? "foreign-school" : "school-fixture", status: "inactive" };
      Object.defineProperty(student, field, { get() { throw new Error(`later predicate ${field} was evaluated`); } });
      const result = await scenario({ student });
      assert.equal(result.response.statusCode, 401);
      assert.deepEqual(result.response.body, credentialsError);
      assert.deepEqual(result.nextErrors, []);
      assert.equal(result.failureKeys.length, 0);
      assert.deepEqual(result.compares, []);
    }
  });

  const earlyPinFailures: Array<{ name: string; options: Scenario; reason: string }> = [
    { name: "missing school", options: { schoolFound: false, body: { studentId: "", pin: "x" } }, reason: "SCHOOL_CONTEXT_MISSING" },
    { name: "missing selection", options: { body: { studentId: "", pin: "x" } }, reason: "STUDENT_SELECTION_MISSING" },
    { name: "malformed PIN", options: { body: { pin: "123" } }, reason: "PIN_FORMAT_INVALID" },
  ];
  for (const entry of earlyPinFailures) {
    it(`does not increment failures or compare credentials for ${entry.name}`, async () => {
      const result = await scenario(entry.options);
      assert.equal(result.response.statusCode, 401);
      assert.deepEqual(result.response.body, credentialsError);
      assert.deepEqual(result.failures, [entry.reason]);
      assert.deepEqual(result.failureKeys, []);
      assert.deepEqual(result.compares, []);
      assert.equal(result.calls.includes("entitlement"), false);
      assert.equal(result.calls.includes("student_lookup"), false);
    });
  }

  it("ignores a pre-existing lockout and preserves continuity on a wrong PIN response", async () => {
    const result = await scenario({ lockout: 47, continuity: "valid", correctPin: false });
    assert.equal(result.response.statusCode, 401);
    assert.deepEqual(result.response.body, { ...incorrectPinError, managedDeviceContinuityAccepted: true });
    assert.deepEqual(result.failures, ["PIN_MISMATCH"]);
    assert.equal(result.compares.length, 1);
    assert.deepEqual(result.failureKeys, []);
    assert.deepEqual(result.clearedKeys, []);
    assert.equal(result.calls.includes("lockout"), false);
  });

  it("accepts the correct PIN despite a pre-existing lockout without Redis cleanup", async () => {
    const result = await scenario({ lockout: 600 });
    assert.deepEqual(result.compares, [["1234", "hash-fixture"]]);
    assert.deepEqual(result.clearedKeys, []);
    assert.deepEqual(result.failureKeys, []);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.methods, ["name_pin"]);
    assert.equal(result.stages.at(-1), "response_preparation");
    assert.deepEqual(result.response.body, publicLogin);
    assert.equal(result.calls.includes("lockout"), false);
    assert.ok(result.calls.indexOf("compare") < result.calls.indexOf("issuance"));
    assert.ok(result.calls.indexOf("issuance") < result.calls.indexOf("response"));
  });

  const emailFailures: Array<{ name: string; options: Scenario; reason: string }> = [
    { name: "unresolved email school", options: { resolvedSchoolFound: false }, reason: "EMAIL_SCHOOL_UNRESOLVED" },
    { name: "missing email student", options: { student: null }, reason: "STUDENT_NOT_FOUND" },
    { name: "inactive email student", options: { student: { ...defaultStudent(), status: "inactive", studentIdNumber: "wrong" } }, reason: "STUDENT_INACTIVE" },
    { name: "incorrect Student ID Number", options: { student: { ...defaultStudent(), studentIdNumber: "wrong" } }, reason: "STUDENT_ID_NUMBER_MISMATCH" },
  ];
  for (const entry of emailFailures) {
    it(`keeps generic email/ID denial for ${entry.name} without touching PIN counters`, async () => {
      const result = await scenario({ method: "email_id", ...entry.options });
      assert.equal(result.response.statusCode, 401);
      assert.deepEqual(result.response.body, credentialsError);
      assert.deepEqual(result.failures, [entry.reason]);
      assert.deepEqual(result.compares, []);
      assert.deepEqual(result.failureKeys, []);
      assert.deepEqual(result.clearedKeys, []);
      assert.deepEqual(result.issuedOptions, []);
    });
  }

  it("does not read Student ID Number after an inactive email student rejection", async () => {
    const student = { ...defaultStudent(), status: "inactive" };
    Object.defineProperty(student, "studentIdNumber", { get() { throw new Error("later ID predicate was evaluated"); } });
    const result = await scenario({ method: "email_id", student });
    assert.equal(result.response.statusCode, 401);
    assert.deepEqual(result.failures, ["STUDENT_INACTIVE"]);
    assert.deepEqual(result.nextErrors, []);
  });

  it("normalizes email/ID inputs and issues without PIN comparisons or counter writes", async () => {
    const result = await scenario({ method: "email_id" });
    assert.equal(result.response.statusCode, 200);
    assert.deepEqual(result.response.body, publicLogin);
    assert.deepEqual(result.methods, ["email_id"]);
    assert.equal(result.stages.at(-1), "response_preparation");
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.compares, []);
    assert.deepEqual(result.failureKeys, []);
    assert.deepEqual(result.clearedKeys, []);
    assert.equal(result.issuedOptions.length, 1);
  });

  const guards: Array<{ name: string; options: Scenario; reason: string; status: number; body: unknown }> = [
    { name: "disabled manual issuance", options: { enabled: false }, reason: "MANUAL_ISSUANCE_DISABLED", status: 503,
      body: { error: "Manual student sign-in is temporarily unavailable", code: "CLASSPILOT_MANUAL_SESSION_ISSUANCE_UNAVAILABLE", retryable: true } },
    { name: "missing device binding", options: { body: { deviceId: undefined } }, reason: "DEVICE_BINDING_MISSING", status: 400, body: { error: "deviceId required" } },
    { name: "missing email/ID field", options: { method: "email_id", body: { studentIdNumber: "" } }, reason: "EMAIL_ID_FIELDS_MISSING", status: 400, body: { error: "Email and Student ID are required" } },
    { name: "email school mismatch", options: { method: "email_id", body: { schoolId: "wrong-school" } }, reason: "SCHOOL_CONTEXT_MISMATCH", status: 403, body: { error: "School context does not match student email" } },
    { name: "email slug mismatch", options: { method: "email_id", body: { schoolSlug: "fixture" }, slugSchoolId: "wrong-school" }, reason: "SCHOOL_CONTEXT_MISMATCH", status: 403, body: { error: "School context does not match student email" } },
  ];
  for (const entry of guards) {
    it(`keeps the existing public response for ${entry.name}`, async () => {
      const result = await scenario(entry.options);
      assert.equal(result.response.statusCode, entry.status);
      assert.deepEqual(result.response.body, entry.body);
      assert.deepEqual(result.failures, [entry.reason]);
      assert.deepEqual(result.compares, []);
      assert.deepEqual(result.failureKeys, []);
      assert.deepEqual(result.issuedOptions, []);
    });
  }

  for (const method of ["name_pin", "email_id"] as const) {
    it(`marks tenant checkout before the ${method} scoped callback starts`, async () => {
      const result = await scenario({ method, throwAt: "tenant_checkout" });
      assert.deepEqual(result.nextErrors, [result.injectedError]);
      assert.deepEqual(result.markedErrors, [result.injectedError]);
      assert.equal(result.stages.at(-1), "tenant_checkout");
      assert.equal(result.calls.includes("settings"), false);
      assert.equal(result.response.body, undefined);
    });
    for (const guard of ["entitlement", "shared", "method", "enrollment", "enrollment_configuration", "continuity"] as const) {
      it(`preserves the ${guard} guard before ${method} credential evaluation`, async () => {
        const options: Scenario = { method };
        const expected = { status: 403, reason: "", body: {} as unknown };
        if (guard === "entitlement") {
          options.entitled = false; expected.reason = "ENTITLEMENT_DENIED";
          expected.body = { error: "school_not_entitled", code: "CLASSPILOT_NOT_ENTITLED", reason: "school_inactive", schoolActive: false, planStatus: "inactive" };
        } else if (guard === "shared") {
          options.sharedEnabled = false; expected.reason = "SHARED_SIGNIN_DISABLED";
          expected.body = { error: "Shared Chromebook sign-in is not enabled for this school" };
        } else if (guard === "method") {
          options.configuredMethod = method === "name_pin" ? "email_id" : "name_pin"; expected.reason = "LOGIN_METHOD_DISABLED";
          expected.body = { error: `${method === "name_pin" ? "PIN" : "Email + Student ID"} login is not enabled for this school` };
        } else if (guard === "enrollment") {
          options.enrollment = { ok: false, status: 401, error: "Invalid enrollment key" }; expected.status = 401; expected.reason = "ENROLLMENT_KEY_INVALID_OR_MISSING";
          expected.body = { error: "Invalid enrollment key" };
        } else if (guard === "enrollment_configuration") {
          options.enrollment = { ok: false, status: 403, error: "School enrollment key is not configured" }; expected.reason = "ENROLLMENT_NOT_CONFIGURED";
          expected.body = { error: "School enrollment key is not configured" };
        } else {
          options.continuity = "invalid"; expected.status = 401; expected.reason = "MANAGED_DEVICE_CONTINUITY_UNAUTHORIZED";
          expected.body = { error: "Managed-device continuity authorization failed", code: "CLASSPILOT_MANAGED_DEVICE_CONTINUITY_UNAUTHORIZED" };
        }
        const result = await scenario(options);
        assert.equal(result.response.statusCode, expected.status);
        assert.deepEqual(result.response.body, expected.body);
        assert.deepEqual(result.failures, [expected.reason]);
        assert.deepEqual(result.compares, []);
        assert.deepEqual(result.failureKeys, []);
        assert.deepEqual(result.issuedOptions, []);
        assert.equal(result.calls.includes("student_lookup"), false);
        if (guard === "entitlement") {
          assert.equal(result.calls.filter((call) => call === "entitlement").length, 1);
          assert.ok(result.calls.indexOf("mark_failure:ENTITLEMENT_DENIED") < result.calls.indexOf("response"),
            "the actual entitlement helper must mark denial before synchronous response completion");
        }
      });
    }
    it(`preserves accepted managed continuity on a ${method} credential denial`, async () => {
      const result = await scenario({ method, continuity: "valid", student: null });
      assert.equal(result.response.statusCode, 401);
      assert.deepEqual(result.response.body, { ...credentialsError, managedDeviceContinuityAccepted: true });
      assert.deepEqual(result.failures, ["STUDENT_NOT_FOUND"]);
    });
    it(`passes a coded ${method} issuance error through unchanged`, async () => {
      const error = Object.assign(new Error("Student session was replaced before login completed"), { status: 409, code: "STUDENT_SESSION_REPLACED" });
      const result = await scenario({ method, issuanceError: error });
      assert.deepEqual(result.nextErrors, [error]);
      assert.deepEqual(result.markedErrors, [error]);
      assert.equal(result.response.body, undefined);
      assert.deepEqual(result.failureKeys, []);
      assert.equal(result.issuedOptions.length, 1);
    });
  }

  for (const point of ["student_lookup", "compare"] as const) {
    it(`does not convert a ${point} infrastructure exception into a credential response`, async () => {
      const result = await scenario({ throwAt: point });
      assert.deepEqual(result.nextErrors, [result.injectedError]);
      assert.deepEqual(result.markedErrors, [result.injectedError]);
      assert.equal(result.response.body, undefined);
      assert.deepEqual(result.issuedOptions, []);
      assert.ok(result.compares.length <= 1);
      assert.ok(result.failureKeys.length <= 1);
      assert.ok(result.clearedKeys.length <= 1);
      if (point === "compare") {
        assert.deepEqual(result.failures, []);
        assert.deepEqual(result.failureKeys, []);
        assert.deepEqual(result.clearedKeys, []);
      }
    });
  }
});

describe("student-login route limiter diagnostic hook", () => {
  type LimiterOptions = {
    windowMs: number; max: number; standardHeaders: boolean; legacyHeaders: boolean; passOnStoreError: boolean;
    message: unknown;
    keyGenerator(req: { body: Record<string, unknown> }): string;
    handler(req: object, res: { writableEnded: boolean; status(code: number): void; send(body: unknown): void },
      next: () => void, options: { statusCode: number; message: unknown }): Promise<void>;
  };

  for (const writableEnded of [false, true]) {
    for (const dynamicMessage of [false, true]) {
    it(`preserves default limiter handling (ended=${writableEnded}, dynamic=${dynamicMessage})`, async () => {
      const reasons: string[] = [];
      const sent: Array<{ status: number; body: unknown }> = [];
      let statusCalls = 0;
      let statusCode = 0;
      let messageCalls = 0;
      const limiter = runInNewContext(limiterExecutable, {
        rateLimit: (options: LimiterOptions) => options,
        extensionIp: () => "ip-fixture",
        usesEmailIdStudentSignIn,
        redisStore: () => undefined,
        markStudentSignInFailure: (_req: unknown, reason: string) => { reasons.push(reason); },
      }) as LimiterOptions;
      assert.equal(limiter.windowMs, 60_000);
      assert.equal(limiter.max, 20);
      assert.equal(limiter.standardHeaders, true);
      assert.equal(limiter.legacyHeaders, false);
      assert.equal(limiter.passOnStoreError, true);
      assert.equal(limiter.keyGenerator({ body: { schoolId: "school-fixture", deviceId: "device-fixture", studentEmail: "STUDENT@EXAMPLE.INVALID" } }),
        "ip-fixture:school-fixture:device-fixture:student@example.invalid");
      const request = {};
      const response = {
        writableEnded,
        status(code: number) { statusCalls += 1; statusCode = code; },
        send(body: unknown) { sent.push({ status: statusCode, body: plain(body) }); },
      };
      const message = dynamicMessage ? async (req: object, res: object) => {
        messageCalls += 1;
        assert.equal(req, request); assert.equal(res, response);
        assert.equal(statusCode, 429, "the default handler sets status before resolving the message");
        return limiter.message;
      } : limiter.message;
      await limiter.handler(request, response,
        () => { assert.fail("a rejected login must not continue"); }, { statusCode: 429, message });
      assert.deepEqual(reasons, ["STUDENT_LOGIN_RATE_LIMIT"]);
      assert.equal(statusCalls, 1);
      assert.equal(messageCalls, dynamicMessage ? 1 : 0);
      assert.deepEqual(sent, writableEnded ? [] : [{ status: 429, body: { error: "Too many login attempts, please wait" } }]);
    });
    }
  }
});
