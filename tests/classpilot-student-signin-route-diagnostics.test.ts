import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

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
assert.ok(route, "the actual student-login route must be present");
const entitlementHelper = parsed.statements.find((statement) => ts.isFunctionDeclaration(statement)
  && statement.name?.text === "requireUncachedClasspilotEntitlementForIssuance");
assert.ok(entitlementHelper, "the actual entitlement response helper must be present");
const executable = ts.transpileModule(`${entitlementHelper.getText(parsed)}\n${route.getText(parsed)}`, {
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
  lockout?: number;
  throwAt?: "tenant_checkout" | "student_lookup" | "compare" | "failure_counter" | "clear_counter";
  issuanceError?: Error;
};
type CapturedResponse = {
  statusCode: number;
  body: unknown;
  locals: Record<string, unknown>;
  status(code: number): CapturedResponse;
  json(body: unknown): CapturedResponse;
};
type Handler = (request: { body: Record<string, unknown>; headers: Record<string, string> },
  response: CapturedResponse, next: (error?: unknown) => void) => Promise<unknown>;

const defaultStudent = (): Student => ({
  id: "student-fixture", schoolId: "school-fixture", status: "active",
  classpilotPinHash: "hash-fixture", studentIdNumber: "id-fixture",
});
const credentialsError = { error: "Invalid student credentials" };
const publicLogin = { studentSessionId: "session-fixture", student: { id: "student-fixture" } };
const plain = (value: unknown): unknown => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

async function scenario(options: Scenario = {}) {
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
      calls.push("student_lookup"); failAt("student_lookup"); assert.equal(studentId, "student-fixture"); return student;
    },
    getPinLockout: async () => {
      calls.push("lockout"); return options.lockout === undefined ? { ok: true } : { ok: false, retryAfterSeconds: options.lockout };
    },
    comparePassword: async (pin: string, hash: string) => {
      calls.push("compare"); compares.push([pin, hash]); failAt("compare"); return options.correctPin !== false;
    },
    recordPinFailure: async (schoolId: string, studentId: string) => {
      calls.push("failure_counter"); failureKeys.push([schoolId, studentId]); failAt("failure_counter");
    },
    clearPinFailures: async (schoolId: string, studentId: string) => {
      calls.push("clear_counter"); clearedKeys.push([schoolId, studentId]); failAt("clear_counter");
    },
    completeStudentDeviceLogin: async (input: { onDiagnosticsStage?: (stage: "response_preparation") => void }, sendResponse: (prepared: unknown) => unknown) => {
      calls.push("issuance"); issuedOptions.push(input);
      if (options.issuanceError) throw options.issuanceError;
      input.onDiagnosticsStage?.("response_preparation");
      return sendResponse(publicLogin);
    },
    markStudentSignInStage: (_req: unknown, stage: string) => { stages.push(stage); },
    markStudentSignInMethod: (_req: unknown, value: string) => { methods.push(value); },
    markStudentSignInFailure: (_req: unknown, reason: string) => { calls.push(`mark_failure:${reason}`); failures.push(reason); },
    markStudentSignInError: (_req: unknown, error: unknown) => { markedErrors.push(error); },
  };
  runInNewContext(executable, context);
  assert.ok(handler, "production route registered a handler");
  await handler(request, response, (error) => { nextErrors.push(error); });
  return { response, calls, failures, stages, methods, markedErrors, nextErrors, failureKeys,
    clearedKeys, compares, issuedOptions, injectedError };
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
    it(`keeps the generic 401 and exactly one failure increment for ${entry.name}`, async () => {
      const result = await scenario(entry);
      assert.equal(result.response.statusCode, 401);
      assert.deepEqual(result.response.body, credentialsError);
      assert.deepEqual(result.failures, [entry.reason]);
      assert.equal(result.compares.length, entry.comparisons);
      assert.deepEqual(result.failureKeys, [["school-fixture", "student-fixture"]]);
      assert.deepEqual(result.clearedKeys, []);
      assert.deepEqual(result.issuedOptions, []);
      assert.deepEqual(result.nextErrors, []);
      assert.equal(result.calls.filter((call) => call === "student_lookup").length, 1);
      assert.ok(result.calls.indexOf("lockout") < result.calls.indexOf("failure_counter"));
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
      assert.equal(result.failureKeys.length, 1);
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

  it("checks lockout before bcrypt without incrementing or clearing failures", async () => {
    const result = await scenario({ lockout: 47, continuity: "valid" });
    assert.equal(result.response.statusCode, 429);
    assert.deepEqual(result.response.body, { error: "Too many PIN attempts. Try again later.",
      retryAfterSeconds: 47, managedDeviceContinuityAccepted: true });
    assert.deepEqual(result.failures, ["PIN_LOCKOUT"]);
    assert.deepEqual(result.compares, []);
    assert.deepEqual(result.failureKeys, []);
    assert.deepEqual(result.clearedKeys, []);
    assert.ok(result.calls.indexOf("student_lookup") < result.calls.indexOf("lockout"));
  });

  it("clears PIN failures exactly once before issuance and preserves the callback response", async () => {
    const result = await scenario();
    assert.deepEqual(result.compares, [["1234", "hash-fixture"]]);
    assert.deepEqual(result.clearedKeys, [["school-fixture", "student-fixture"]]);
    assert.deepEqual(result.failureKeys, []);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.methods, ["name_pin"]);
    assert.equal(result.stages.at(-1), "response_preparation");
    assert.deepEqual(result.response.body, publicLogin);
    assert.ok(result.calls.indexOf("compare") < result.calls.indexOf("clear_counter"));
    assert.ok(result.calls.indexOf("clear_counter") < result.calls.indexOf("issuance"));
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

  for (const point of ["student_lookup", "compare", "failure_counter", "clear_counter"] as const) {
    it(`does not convert a ${point} infrastructure exception into a credential response`, async () => {
      const result = await scenario({ throwAt: point, correctPin: point === "failure_counter" ? false : true });
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
  const statement = parsed.statements.find((item) => ts.isVariableStatement(item)
    && item.declarationList.declarations.some((declaration) => ts.isIdentifier(declaration.name)
      && declaration.name.text === "extensionLoginLimiter"));
  assert.ok(statement, "the actual extension login limiter must be present");
  const limiterExecutable = ts.transpileModule(`${statement.getText(parsed)}\nextensionLoginLimiter;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
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
