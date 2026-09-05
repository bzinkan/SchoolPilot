const REPORTED_POOL_ACQUISITION_FAILURES = new WeakSet<object>();
const DATABASE_CODES = new Set([
  "08000", "08001", "08003", "08004", "08006", "08007", "08P01",
  "23502", "23503", "23505", "23514", "25000", "25P02", "40001", "40P01",
  "42501", "42703", "42P01", "53300", "53400", "55P03", "57014", "57P01", "57P02", "57P03",
]);
const NETWORK_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "ETIMEDOUT",
]);
const AUTH_CODES = new Set(["WS_AUTH_SOCKET_CLOSED", "WS_AUTH_REGISTRATION_UNAVAILABLE"]);

/** Never inspect message/SQL/body fields. Bound both wrappers and cycles. */
export function operationalErrorCauses(error: unknown): object[] {
  const seen = new Set<object>();
  const result: object[] = [];
  let candidate = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!candidate || (typeof candidate !== "object" && typeof candidate !== "function")) break;
    if (seen.has(candidate)) break;
    seen.add(candidate);
    result.push(candidate);
    try {
      candidate = (candidate as { cause?: unknown }).cause;
    } catch {
      break;
    }
  }
  return result;
}

export function markTenantPoolAcquisitionFailureReported(error: unknown): void {
  if (error && (typeof error === "object" || typeof error === "function")) {
    REPORTED_POOL_ACQUISITION_FAILURES.add(error);
  }
}

export function wasTenantPoolAcquisitionFailureReported(error: unknown): boolean {
  return operationalErrorCauses(error).some((candidate) =>
    REPORTED_POOL_ACQUISITION_FAILURES.has(candidate)
  );
}

export function safeOperationalErrorCode(error: unknown): string | undefined {
  for (const candidate of operationalErrorCauses(error)) {
    let code: unknown;
    try {
      code = (candidate as { code?: unknown }).code;
    } catch {
      continue;
    }
    if (typeof code === "string" && (
      DATABASE_CODES.has(code) || NETWORK_CODES.has(code) || AUTH_CODES.has(code)
    )) return code;
  }
  return wasTenantPoolAcquisitionFailureReported(error) ? "POOL_ACQUISITION_FAILED" : undefined;
}

export type StudentAuthenticationFailureCause =
  | "pool_acquisition_failed" | "query_cancelled" | "authority_contention"
  | "connection_reset" | "connection_refused" | "connection_timeout"
  | "connection_unavailable" | "database_error" | "socket_closed"
  | "registration_unavailable" | "unknown";

export function studentAuthenticationFailureCause(error: unknown): StudentAuthenticationFailureCause {
  const code = safeOperationalErrorCode(error);
  if (code === "WS_AUTH_SOCKET_CLOSED") return "socket_closed";
  if (code === "WS_AUTH_REGISTRATION_UNAVAILABLE") return "registration_unavailable";
  if (wasTenantPoolAcquisitionFailureReported(error)) return "pool_acquisition_failed";
  if (code === "57014") return "query_cancelled";
  if (code === "55P03" || code === "40001" || code === "40P01") return "authority_contention";
  if (code === "ECONNRESET" || code === "EPIPE") return "connection_reset";
  if (code === "ECONNREFUSED") return "connection_refused";
  if (code === "ETIMEDOUT") return "connection_timeout";
  if (code && NETWORK_CODES.has(code)) return "connection_unavailable";
  if (code && DATABASE_CODES.has(code)) return "database_error";
  return "unknown";
}

export function isDatabaseAuthenticationFailure(cause: StudentAuthenticationFailureCause): boolean {
  return cause !== "socket_closed" && cause !== "registration_unavailable" && cause !== "unknown";
}
