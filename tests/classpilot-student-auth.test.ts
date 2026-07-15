import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createActiveStudentTokenSessionResolver,
  studentAuthenticationServiceError,
  type ActiveStudentTokenSessionLookupResult,
} from "../src/services/classpilotStudentAuth.ts";
import type { StudentTokenPayload } from "../src/services/deviceJwt.ts";

function token(
  overrides: Partial<StudentTokenPayload> = {}
): StudentTokenPayload {
  return {
    schoolId: "school-a",
    studentId: "student-a",
    deviceId: "device-a",
    sessionId: "session-a",
    ...overrides,
  };
}

function lookupResult(
  payload: StudentTokenPayload,
  overrides: {
    studentSchoolId?: string;
    deviceSchoolId?: string;
    session?: Partial<ActiveStudentTokenSessionLookupResult["session"]>;
  } = {}
): ActiveStudentTokenSessionLookupResult {
  return {
    studentSchoolId: overrides.studentSchoolId ?? payload.schoolId,
    deviceSchoolId: overrides.deviceSchoolId ?? payload.schoolId,
    studentEmail: "student-a@example.invalid",
    session: {
      id: payload.sessionId,
      studentId: payload.studentId,
      deviceId: payload.deviceId,
      startedAt: new Date("2026-07-12T00:00:00.000Z"),
      lastSeenAt: new Date("2026-07-12T00:01:00.000Z"),
      endedAt: null,
      isActive: true,
      ...overrides.session,
    },
  };
}

describe("active ClassPilot student token session resolver", () => {
  it("uses one lookup for simultaneous callers of the same signed session", async () => {
    const payload = token();
    let lookupCalls = 0;
    let releaseLookup!: (
      value: ActiveStudentTokenSessionLookupResult | undefined
    ) => void;
    const lookupPending = new Promise<
      ActiveStudentTokenSessionLookupResult | undefined
    >((resolve) => {
      releaseLookup = resolve;
    });
    const resolveSession = createActiveStudentTokenSessionResolver(async () => {
      lookupCalls += 1;
      return lookupPending;
    });

    const callers = Array.from({ length: 100 }, () => resolveSession(payload));
    await Promise.resolve();
    assert.equal(lookupCalls, 1);

    releaseLookup(lookupResult(payload));
    const sessions = await Promise.all(callers);
    assert.equal(sessions.length, 100);
    assert.ok(sessions.every((session) => session?.id === payload.sessionId));
    assert.ok(
      sessions.every(
        (session) => session?.studentEmail === "student-a@example.invalid"
      )
    );
  });

  it("never coalesces different signed school, student, device, or session identities", async () => {
    const payloads = [
      token(),
      token({ schoolId: "school-b" }),
      token({ studentId: "student-b" }),
      token({ deviceId: "device-b" }),
      token({ sessionId: "session-b" }),
    ];
    let lookupCalls = 0;
    const releases: Array<() => void> = [];
    const resolveSession = createActiveStudentTokenSessionResolver(
      async (payload) => {
        lookupCalls += 1;
        await new Promise<void>((resolve) => releases.push(resolve));
        return lookupResult(payload);
      }
    );

    const pending = payloads.map((payload) => resolveSession(payload));
    await Promise.resolve();
    assert.equal(lookupCalls, payloads.length);
    releases.forEach((release) => release());
    const sessions = await Promise.all(pending);
    assert.deepEqual(
      sessions.map((session) => session?.id),
      payloads.map((payload) => payload.sessionId)
    );
  });

  it("rejects every school, student, device, session, and active-state mismatch", async () => {
    const payload = token();
    const mismatches: ActiveStudentTokenSessionLookupResult[] = [
      lookupResult(payload, { studentSchoolId: "school-b" }),
      lookupResult(payload, { deviceSchoolId: "school-b" }),
      lookupResult(payload, { session: { id: "session-b" } }),
      lookupResult(payload, { session: { studentId: "student-b" } }),
      lookupResult(payload, { session: { deviceId: "device-b" } }),
      lookupResult(payload, { session: { isActive: false } }),
    ];

    for (const mismatch of mismatches) {
      const resolveSession = createActiveStudentTokenSessionResolver(
        async () => mismatch
      );
      assert.equal(await resolveSession(payload), undefined);
    }
  });

  it("retains neither successful nor negative results after settlement", async () => {
    const payload = token();
    let successCalls = 0;
    const resolveSuccess = createActiveStudentTokenSessionResolver(
      async (lookupPayload) => {
        successCalls += 1;
        return lookupResult(lookupPayload);
      }
    );
    assert.ok(await resolveSuccess(payload));
    assert.ok(await resolveSuccess(payload));
    assert.equal(successCalls, 2);

    let missCalls = 0;
    const resolveMiss = createActiveStudentTokenSessionResolver(async () => {
      missCalls += 1;
      return undefined;
    });
    assert.equal(await resolveMiss(payload), undefined);
    assert.equal(await resolveMiss(payload), undefined);
    assert.equal(missCalls, 2);
  });

  it("does not retain lookup errors after settlement", async () => {
    const payload = token();
    let lookupCalls = 0;
    const resolveSession = createActiveStudentTokenSessionResolver(
      async (lookupPayload) => {
        lookupCalls += 1;
        if (lookupCalls === 1) {
          throw new Error("temporary database failure");
        }
        return lookupResult(lookupPayload);
      }
    );

    await assert.rejects(resolveSession(payload), /temporary database failure/);
    assert.equal((await resolveSession(payload))?.id, payload.sessionId);
    assert.equal(lookupCalls, 2);
  });

  it("redacts query parameters while retaining only a safe operational code", () => {
    const unsafe = Object.assign(
      new Error("Failed query: select ... params: school-secret,device-secret"),
      {
        cause: Object.assign(new Error("database unavailable"), { code: "57P01" }),
        params: ["school-secret", "device-secret"],
      }
    );
    const safe = studentAuthenticationServiceError(unsafe) as NodeJS.ErrnoException & {
      expose?: boolean;
      status?: number;
    };

    assert.equal(safe.name, "StudentAuthenticationServiceError");
    assert.equal(safe.message, "Student authentication service unavailable");
    assert.equal(safe.code, "57P01");
    assert.equal(safe.status, 503);
    assert.equal(safe.expose, true);
    assert.doesNotMatch(JSON.stringify(safe), /school-secret|device-secret|select|params/i);
    assert.equal((safe as Error & { cause?: unknown }).cause, undefined);
  });
});
