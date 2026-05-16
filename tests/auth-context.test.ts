import { describe, expect, it, vi } from "vitest";
import { csrfProtection } from "../src/middleware/csrfProtection.js";
import { extractBearerToken } from "../src/middleware/requireDeviceAuth.js";
import { getRequestedSchoolId } from "../src/middleware/schoolContext.js";
import {
  createStudentToken,
  InvalidTokenError,
  verifyStudentToken,
} from "../src/services/deviceJwt.js";

function runCsrf(reqOverrides: Record<string, unknown>) {
  const req: any = {
    method: "POST",
    path: "/students",
    headers: {},
    body: {},
    session: undefined,
    ...reqOverrides,
  };
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  const next = vi.fn();

  csrfProtection(req, res, next);
  return { res, next };
}

describe("auth and school context policy", () => {
  it("round-trips ClassPilot student device tokens", () => {
    const token = createStudentToken({
      schoolId: "school-1",
      studentId: "student-1",
      deviceId: "device-1",
      studentEmail: "student@example.edu",
    });

    expect(verifyStudentToken(token)).toMatchObject({
      schoolId: "school-1",
      studentId: "student-1",
      deviceId: "device-1",
      studentEmail: "student@example.edu",
    });
  });

  it("rejects invalid ClassPilot student device tokens", () => {
    expect(() => verifyStudentToken("not-a-jwt")).toThrow(InvalidTokenError);
  });

  it("extracts bearer tokens case-insensitively", () => {
    expect(extractBearerToken("Bearer abc.def")).toBe("abc.def");
    expect(extractBearerToken("bearer token")).toBe("token");
    expect(extractBearerToken("Basic nope")).toBeNull();
    expect(extractBearerToken(undefined)).toBeNull();
  });

  it("requires matching CSRF tokens for cookie-authenticated writes", () => {
    const rejected = runCsrf({
      session: { userId: "user-1", csrfToken: "expected" },
    });
    expect(rejected.res.statusCode).toBe(403);
    expect(rejected.next).not.toHaveBeenCalled();

    const accepted = runCsrf({
      session: { userId: "user-1", csrfToken: "expected" },
      headers: { "x-csrf-token": "expected" },
    });
    expect(accepted.next).toHaveBeenCalledTimes(1);
  });

  it("skips CSRF checks for bearer-token writes", () => {
    const { next } = runCsrf({
      headers: { authorization: "Bearer api-token" },
      session: { userId: "user-1" },
    });

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("resolves school context only from trusted request sources", () => {
    expect(
      getRequestedSchoolId({
        params: { schoolId: "param-school" },
        headers: { "x-school-id": "header-school" },
        query: { schoolId: "query-school" },
        session: { schoolId: "session-school" },
      })
    ).toBe("param-school");

    expect(
      getRequestedSchoolId({
        headers: { "x-school-id": "header-school" },
        query: { schoolId: "query-school" },
        session: { schoolId: "session-school" },
      })
    ).toBe("header-school");

    expect(
      getRequestedSchoolId({
        query: { schoolId: "query-school" },
        session: { schoolId: "session-school" },
      })
    ).toBe("query-school");

    expect(getRequestedSchoolId({ session: { schoolId: "session-school" } })).toBe(
      "session-school"
    );
    expect(getRequestedSchoolId({})).toBe("");
  });
});
