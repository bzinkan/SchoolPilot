import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { RequestHandler } from "express";

import { pool } from "../src/db.ts";
import { errorHandler } from "../src/middleware/errorHandler.ts";
import {
  authenticate,
  authenticationServiceError,
  optionalAuth,
} from "../src/middleware/authenticate.ts";
import errorMonitor from "../src/services/errorMonitor.ts";
import { signUserToken } from "../src/services/jwt.ts";

type CapturedResponse = {
  statusCode: number;
  body: unknown;
  locals: Record<string, unknown>;
  status(code: number): CapturedResponse;
  json(body: unknown): CapturedResponse;
};

type MiddlewareResult = {
  response: CapturedResponse;
  nextCalled: boolean;
  nextError: unknown;
};

function responseStub(): CapturedResponse {
  return {
    statusCode: 200,
    body: undefined,
    locals: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function invoke(
  middleware: RequestHandler,
  request: Record<string, unknown>
): Promise<MiddlewareResult> {
  const response = responseStub();
  let nextCalled = false;
  let nextError: unknown;

  await Promise.resolve(
    middleware(request as never, response as never, (error?: unknown) => {
      nextCalled = true;
      nextError = error;
    })
  );

  return { response, nextCalled, nextError };
}

function emptyQueryResult() {
  return {
    command: "SELECT",
    rowCount: 0,
    oid: 0,
    rows: [],
    fields: [],
  };
}

function databaseFailure(secret: string) {
  return Object.assign(
    new Error(`timeout exceeded; query params included ${secret}`),
    {
      code: "57P01",
      params: [secret],
    }
  );
}

type CapturedLog = {
  mock: {
    calls: Array<{ arguments: unknown[] }>;
  };
};

function captureExpectedLogs(t: TestContext) {
  return {
    error: t.mock.method(console, "error", () => {}),
    warn: t.mock.method(console, "warn", () => {}),
  };
}

function serializedLogs(...logs: CapturedLog[]): string {
  return JSON.stringify(
    logs.flatMap((log) =>
      log.mock.calls.map((call) =>
        call.arguments.map((argument) => {
          if (!(argument instanceof Error)) return argument;
          const error = argument as Error & {
            cause?: unknown;
            code?: string;
            params?: unknown;
            status?: number;
          };
          return {
            name: error.name,
            message: error.message,
            status: error.status,
            code: error.code,
            cause: error.cause,
            params: error.params,
          };
        })
      )
    )
  );
}

function assertLogsRedacted(
  logs: ReturnType<typeof captureExpectedLogs>,
  ...sensitiveValues: string[]
) {
  const output = serializedLogs(logs.error, logs.warn);
  for (const sensitiveValue of sensitiveValues) {
    assert.doesNotMatch(output, new RegExp(sensitiveValue, "i"));
  }
  assert.doesNotMatch(output, /timeout exceeded|query params included/i);
}

function assertSanitizedServiceError(error: unknown, secret: string) {
  assert.ok(error instanceof Error);
  const operational = error as Error & {
    cause?: unknown;
    code?: string;
    expose?: boolean;
    params?: unknown;
    status?: number;
  };
  assert.equal(operational.name, "AuthenticationServiceError");
  assert.equal(operational.message, "Authentication service unavailable");
  assert.equal(operational.status, 503);
  assert.equal(operational.expose, true);
  assert.equal(operational.code, "57P01");
  assert.equal(operational.cause, undefined);
  assert.equal(operational.params, undefined);

  const publicShape = JSON.stringify({
    name: operational.name,
    message: operational.message,
    status: operational.status,
    expose: operational.expose,
    code: operational.code,
    cause: operational.cause,
    params: operational.params,
    stack: operational.stack,
  });
  assert.doesNotMatch(publicShape, new RegExp(secret, "i"));
  assert.doesNotMatch(publicShape, /timeout exceeded|query params included/i);
}

function assertServiceUnavailableResponse(
  t: TestContext,
  error: unknown,
  secret: string
) {
  t.mock.method(errorMonitor, "trackError", () => {});
  const response = responseStub();
  errorHandler(
    error,
    {
      method: "GET",
      path: "/api/test-auth",
      requestId: "auth-redaction-test",
    } as never,
    response as never,
    (() => {}) as never
  );

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.body, {
    error: "Authentication service unavailable",
    code: "57P01",
    requestId: "auth-redaction-test",
  });
  assert.doesNotMatch(JSON.stringify(response.body), new RegExp(secret, "i"));
  assert.doesNotMatch(
    JSON.stringify(response.body),
    /timeout exceeded|query params included/i
  );
}

describe("authentication operational failures", () => {
  it("returns a sanitized 503 for a valid bearer token whose user lookup fails", async (t) => {
    const secret = "bearer-db-secret-should-never-escape";
    const logs = captureExpectedLogs(t);
    t.mock.method(pool, "query", async () => {
      throw databaseFailure(secret);
    });

    const token = signUserToken({
      userId: "auth-db-failure-bearer-user",
      email: "auth-db-failure-bearer@example.invalid",
    });
    const result = await invoke(authenticate, {
      headers: { authorization: `Bearer ${token}` },
      session: {},
    });

    assert.equal(result.nextCalled, true);
    assert.equal(result.response.statusCode, 200);
    assert.equal(result.response.body, undefined);
    assertSanitizedServiceError(result.nextError, secret);
    assertServiceUnavailableResponse(t, result.nextError, secret);
    assertLogsRedacted(logs, secret, token);
  });

  it("returns a sanitized 503 for a valid session whose user lookup fails", async (t) => {
    const secret = "session-db-secret-should-never-escape";
    const logs = captureExpectedLogs(t);
    t.mock.method(pool, "query", async () => {
      throw databaseFailure(secret);
    });

    const result = await invoke(authenticate, {
      headers: {},
      session: { userId: "auth-db-failure-session-user" },
    });

    assert.equal(result.nextCalled, true);
    assert.equal(result.response.statusCode, 200);
    assert.equal(result.response.body, undefined);
    assertSanitizedServiceError(result.nextError, secret);
    assertServiceUnavailableResponse(t, result.nextError, secret);
    assertLogsRedacted(logs, secret);
  });

  it("keeps an invalid bearer token as a 401 without querying the database", async (t) => {
    const logs = captureExpectedLogs(t);
    const query = t.mock.method(pool, "query", async () => {
      throw new Error("database must not be queried for an invalid token");
    });

    const result = await invoke(authenticate, {
      headers: { authorization: "Bearer definitely-not-a-valid-jwt" },
      session: {},
    });

    assert.equal(query.mock.callCount(), 0);
    assert.equal(result.nextCalled, false);
    assert.equal(result.response.statusCode, 401);
    assert.deepEqual(result.response.body, { error: "Authentication required" });
    assertLogsRedacted(logs, "definitely-not-a-valid-jwt");
  });

  it("keeps a valid bearer token for a missing user as a 401", async (t) => {
    captureExpectedLogs(t);
    t.mock.method(pool, "query", async () => emptyQueryResult());

    const token = signUserToken({
      userId: "auth-missing-bearer-user",
      email: "auth-missing-bearer@example.invalid",
    });
    const result = await invoke(authenticate, {
      headers: { authorization: `Bearer ${token}` },
      session: {},
    });

    assert.equal(result.nextCalled, false);
    assert.equal(result.response.statusCode, 401);
    assert.deepEqual(result.response.body, { error: "Authentication required" });
  });

  it("keeps a valid session for a missing user as a 401", async (t) => {
    captureExpectedLogs(t);
    t.mock.method(pool, "query", async () => emptyQueryResult());

    const result = await invoke(authenticate, {
      headers: {},
      session: { userId: "auth-missing-session-user" },
    });

    assert.equal(result.nextCalled, false);
    assert.equal(result.response.statusCode, 401);
    assert.deepEqual(result.response.body, { error: "Authentication required" });
  });

  it("propagates a sanitized bearer lookup failure from optionalAuth", async (t) => {
    const secret = "optional-bearer-db-secret";
    const logs = captureExpectedLogs(t);
    t.mock.method(pool, "query", async () => {
      throw databaseFailure(secret);
    });

    const token = signUserToken({
      userId: "optional-db-failure-bearer-user",
      email: "optional-db-failure-bearer@example.invalid",
    });
    const result = await invoke(optionalAuth, {
      headers: { authorization: `Bearer ${token}` },
      session: {},
    });

    assert.equal(result.nextCalled, true);
    assertSanitizedServiceError(result.nextError, secret);
    assertLogsRedacted(logs, secret, token);
  });

  it("propagates a sanitized session lookup failure from optionalAuth", async (t) => {
    const secret = "optional-session-db-secret";
    const logs = captureExpectedLogs(t);
    t.mock.method(pool, "query", async () => {
      throw databaseFailure(secret);
    });

    const result = await invoke(optionalAuth, {
      headers: {},
      session: { userId: "optional-db-failure-session-user" },
    });

    assert.equal(result.nextCalled, true);
    assertSanitizedServiceError(result.nextError, secret);
    assertLogsRedacted(logs, secret);
  });

  it("redacts unsafe messages, properties, causes, and malformed error codes", () => {
    const secret = "factory-secret-value";
    const unsafe = Object.assign(databaseFailure(secret), {
      code: "SECRETAPIKEY123",
      cause: Object.assign(new Error(`nested ${secret}`), {
        code: "NESTEDSECRET456",
      }),
    });

    const safe = authenticationServiceError(unsafe) as Error & {
      cause?: unknown;
      code?: string;
      expose?: boolean;
      params?: unknown;
      status?: number;
    };

    assert.equal(safe.name, "AuthenticationServiceError");
    assert.equal(safe.message, "Authentication service unavailable");
    assert.equal(safe.status, 503);
    assert.equal(safe.expose, true);
    assert.equal(safe.code, undefined);
    assert.equal(safe.cause, undefined);
    assert.equal(safe.params, undefined);
    assert.doesNotMatch(
      JSON.stringify({
        name: safe.name,
        message: safe.message,
        status: safe.status,
        expose: safe.expose,
        code: safe.code,
        cause: safe.cause,
        params: safe.params,
        stack: safe.stack,
      }),
      new RegExp(secret, "i")
    );
  });
});
