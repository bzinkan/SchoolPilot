import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Request, RequestHandler } from "express";
import { getRuntimeMetadata } from "./runtimeMetadata.js";
import {
  recordRuntimePerformanceCounters,
  type RuntimePerformanceCounter,
} from "./runtimePerformanceMetrics.js";
import {
  operationalErrorCauses,
  studentAuthenticationFailureCause,
} from "../util/operationalErrors.js";
import {
  STUDENT_SIGN_IN_REASON_COUNTERS,
  STUDENT_SIGN_IN_STAGES,
  type StudentSignInFailureReason,
  type StudentSignInMethod,
  type StudentSignInStage,
} from "./classpilotStudentSignInDiagnosticsContract.js";

export type { StudentSignInFailureReason, StudentSignInMethod, StudentSignInStage };
export { STUDENT_SIGN_IN_REASON_COUNTERS } from "./classpilotStudentSignInDiagnosticsContract.js";

const ROUTE = /^\/api\/(?:classpilot\/)?extension\/student-login\/?$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DETAIL_LIMIT = 120;
const MINUTE_MS = 60_000;
const KNOWN_ERROR_CODES: Readonly<Record<string, StudentSignInFailureReason>> = {
  CLASSPILOT_NOT_ENTITLED: "ENTITLEMENT_DENIED",
  CLASSPILOT_MANUAL_SESSION_ISSUANCE_UNAVAILABLE: "MANUAL_ISSUANCE_DISABLED",
  CLASSPILOT_MANAGED_DEVICE_CONTINUITY_UNAUTHORIZED: "MANAGED_DEVICE_CONTINUITY_UNAUTHORIZED",
  CLASSPILOT_MANAGED_DEVICE_CONTINUITY_UNAVAILABLE: "MANAGED_DEVICE_CONTINUITY_UNAVAILABLE",
  STUDENT_SESSION_TRANSFER_UNAVAILABLE: "STUDENT_SESSION_TRANSFER_UNAVAILABLE",
  STUDENT_SESSION_REPLACED: "STUDENT_SESSION_REPLACED",
  STUDENT_SESSION_ACTIVE: "STUDENT_SESSION_ACTIVE",
  STUDENT_DEVICE_UNAVAILABLE: "STUDENT_DEVICE_UNAVAILABLE",
  STUDENT_INACTIVE: "STUDENT_INACTIVE",
};
const PARSER_ERROR_TYPES: Readonly<Record<string, StudentSignInFailureReason>> = {
  "entity.parse.failed": "REQUEST_BODY_INVALID",
  "request.size.invalid": "REQUEST_BODY_INVALID",
  "request.aborted": "REQUEST_BODY_INVALID",
  "entity.too.large": "REQUEST_BODY_TOO_LARGE",
  "encoding.unsupported": "REQUEST_ENCODING_UNSUPPORTED",
  "charset.unsupported": "REQUEST_ENCODING_UNSUPPORTED",
};
const OPERATIONAL_REASONS: Readonly<Record<string, StudentSignInFailureReason>> = {
  pool_acquisition_failed: "POOL_ACQUISITION_FAILED",
  query_cancelled: "QUERY_CANCELLED",
  authority_contention: "AUTHORITY_CONTENTION",
  connection_reset: "CONNECTION_RESET",
  connection_refused: "CONNECTION_REFUSED",
  connection_timeout: "CONNECTION_TIMEOUT",
  connection_unavailable: "CONNECTION_UNAVAILABLE",
  database_error: "DATABASE_ERROR",
};

function readField(value: object, name: "code" | "type"): unknown {
  try { return (value as Record<string, unknown>)[name]; } catch { return undefined; }
}

/** Never inspect an error message, stack, SQL, body, or arbitrary code string. */
function failureReason(error: unknown): StudentSignInFailureReason {
  for (const candidate of operationalErrorCauses(error)) {
    const code = readField(candidate, "code");
    if (typeof code === "string" && Object.hasOwn(KNOWN_ERROR_CODES, code)) {
      return KNOWN_ERROR_CODES[code]!;
    }
    const type = readField(candidate, "type");
    if (typeof type === "string" && Object.hasOwn(PARSER_ERROR_TYPES, type)) {
      return PARSER_ERROR_TYPES[type]!;
    }
  }
  const cause = studentAuthenticationFailureCause(error);
  return Object.hasOwn(OPERATIONAL_REASONS, cause) ? OPERATIONAL_REASONS[cause]! : "INTERNAL_ERROR";
}

type Counters = Partial<Record<RuntimePerformanceCounter, number>>;
type RequestState = {
  terminal: boolean;
  startedAt: number;
  stage: StudentSignInStage;
  method: StudentSignInMethod | "unknown";
  reason?: StudentSignInFailureReason;
};

/**
 * Identifier-free diagnostics. State lives only for one request and never holds
 * credentials, inbound request IDs or business identifiers. No DB, Redis, alerts,
 * additional timer or response mutation. Counters describe terminal requests:
 * finish (success only for 2xx) or premature close, never client consumption.
 */
export function createStudentSignInDiagnostics(options: {
  now?: () => number;
  elapsedNow?: () => number;
  sink?: (line: string) => void;
  recordCounters?: (increments: Counters) => void;
  randomId?: () => string;
} = {}) {
  const now = options.now ?? Date.now;
  const elapsedNow = options.elapsedNow ?? (() => performance.now());
  const sink = options.sink ?? ((line: string) => console.log(line));
  const recordCounters = options.recordCounters ?? recordRuntimePerformanceCounters;
  const randomId = options.randomId ?? randomUUID;
  const states = new WeakMap<object, RequestState>();
  let detailMinute = -Infinity;
  let detailAttempts = 0;

  function safeRecord(increments: Counters): void {
    // An unavailable metrics sink must not change authentication or recursively
    // report itself. Transport loss is not a guarantee of observed zero counts.
    try { recordCounters(increments); } catch { /* diagnostics are best effort */ }
  }

  function terminal(req: Request, status: unknown, interrupted: boolean): void {
    const state = states.get(req);
    if (!state || state.terminal) return;
    state.terminal = true;
    const httpStatus = !interrupted && typeof status === "number"
      && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
    const success = !interrupted && httpStatus !== null && httpStatus >= 200 && httpStatus < 300;
    const counts: Counters = { studentSignInCompleted: 1 };
    if (success) {
      counts.studentSignInSuccess = 1;
      safeRecord(counts);
      return;
    }
    const reason = interrupted ? "REQUEST_INTERRUPTED" : state.reason ?? "UNCLASSIFIED_HTTP_FAILURE";
    counts.studentSignInFailure = 1;
    counts[STUDENT_SIGN_IN_REASON_COUNTERS[reason]] = 1;
    try {
      const timestamp = now();
      if (!Number.isFinite(timestamp)) throw new Error("Invalid diagnostic clock");
      const minute = Math.floor(timestamp / MINUTE_MS);
      // A clock rollback must not replenish the per-process detail allowance.
      if (minute > detailMinute) {
        detailMinute = minute;
        detailAttempts = 0;
      }
      if (detailAttempts >= DETAIL_LIMIT) {
        counts.studentSignInDiagnosticSuppressed = 1;
      } else {
        detailAttempts += 1;
        const diagnosticId = randomId();
        if (typeof diagnosticId !== "string" || !UUID.test(diagnosticId)) {
          throw new Error("Invalid private diagnostic ID");
        }
        const runtime = getRuntimeMetadata();
        const elapsed = elapsedNow() - state.startedAt;
        sink(JSON.stringify({
          event: "student_signin_failure",
          schemaVersion: 1,
          diagnosticId,
          timestampUtc: new Date(timestamp).toISOString(),
          route: "student_login",
          method: state.method,
          stage: state.stage,
          reason,
          httpStatus,
          elapsedMs: Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed)) : null,
          Environment: ["production", "development", "test", "staging"].includes(runtime.environment)
            ? runtime.environment : "unknown",
          Service: runtime.service,
          InstanceId: UUID.test(runtime.instanceId) ? runtime.instanceId : "unknown",
          Release: /^[a-f0-9]{40}$/i.test(runtime.release) ? runtime.release : "unknown",
        }));
      }
    } catch {
      // Counts are unsampled even when detailed logging throws. A sink failure
      // consumes the allowance; repeated failures cannot bypass the detail cap.
      counts.studentSignInDiagnosticSinkFailure = 1;
    }
    safeRecord(counts);
  }

  const studentSignInDiagnostics: RequestHandler = (req, res, next) => {
    try {
      const pathname = req.path;
      if (req.method.toUpperCase() === "POST" && ROUTE.test(pathname) && !states.has(req)) {
        states.set(req, { terminal: false, startedAt: elapsedNow(), stage: "ingress", method: "unknown" });
        res.once("finish", () => {
          try { terminal(req, res.statusCode, false); } catch { /* never affect a response */ }
        });
        res.once("close", () => {
          try { terminal(req, null, true); } catch { /* never affect a response */ }
        });
      }
    } catch { /* malformed request objects or diagnostics must not alter routing */ }
    next();
  };

  function markStudentSignInStage(req: object, stage: StudentSignInStage): void {
    try {
      const state = states.get(req);
      if (state && !state.terminal && STUDENT_SIGN_IN_STAGES.includes(stage)) state.stage = stage;
    } catch { /* diagnostics are best effort */ }
  }
  function markStudentSignInMethod(req: object, method: StudentSignInMethod): void {
    try {
      const state = states.get(req);
      if (state && !state.terminal && (method === "name_pin" || method === "email_id")) state.method = method;
    } catch { /* diagnostics are best effort */ }
  }
  function markStudentSignInFailure(req: object, reason: StudentSignInFailureReason): void {
    try {
      const state = states.get(req);
      if (state && !state.terminal && typeof reason === "string"
        && Object.hasOwn(STUDENT_SIGN_IN_REASON_COUNTERS, reason)) state.reason = reason;
    } catch { /* diagnostics are best effort */ }
  }
  function markStudentSignInError(req: object, error: unknown): void {
    try {
      const state = states.get(req);
      if (state && !state.terminal) state.reason = failureReason(error);
    } catch { /* diagnostics are best effort */ }
  }

  return {
    studentSignInDiagnostics, markStudentSignInStage, markStudentSignInMethod,
    markStudentSignInFailure, markStudentSignInError,
  };
}

export const {
  studentSignInDiagnostics, markStudentSignInStage, markStudentSignInMethod,
  markStudentSignInFailure, markStudentSignInError,
} = createStudentSignInDiagnostics();
