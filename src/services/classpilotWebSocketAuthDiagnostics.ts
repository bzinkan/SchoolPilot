import errorMonitor, { type ErrorMonitor } from "./errorMonitor.js";
import { getRuntimeMetadata } from "./runtimeMetadata.js";
import { recordRuntimePerformanceCounter } from "./runtimePerformanceMetrics.js";
import {
  isDatabaseAuthenticationFailure,
  safeOperationalErrorCode,
  studentAuthenticationFailureCause,
  wasTenantPoolAcquisitionFailureReported,
} from "../util/operationalErrors.js";

export type StudentWebSocketAuthStage =
  | "tenant_checkout" | "session_resolution" | "entitlement" | "settings_protocol"
  | "observation_hint" | "authority_lock" | "bootstrap_projection"
  | "socket_delivery" | "transaction_completion" | "passive_revalidation" | "message_revalidation";

type AuthJob = "studentWebSocketAuth" | "studentWebSocketPongRevalidation" | "studentWebSocketRevalidation";

/** Operational causes are fixed enums; raw errors never enter this log or alert. */
export function reportStudentWebSocketAuthenticationFailure(
  error: unknown,
  stage: StudentWebSocketAuthStage,
  job: AuthJob,
  options: {
    monitor?: Pick<ErrorMonitor, "trackError">;
    sink?: (line: string) => void;
  } = {},
) {
  const cause = studentAuthenticationFailureCause(error);
  const errorCode = safeOperationalErrorCode(error) ?? "WS_AUTH_UNKNOWN";
  const runtime = getRuntimeMetadata();
  if (job === "studentWebSocketAuth") {
    recordRuntimePerformanceCounter(cause === "socket_closed"
      ? "studentWebSocketAuthSocketClosed" : "studentWebSocketAuthServiceFailure");
  } else {
    recordRuntimePerformanceCounter("studentWebSocketRevalidationFailure");
  }
  (options.sink ?? console.log)(JSON.stringify({
    event: "student_websocket_auth_failure",
    stage,
    cause,
    errorCode,
    job,
    Environment: runtime.environment,
    Service: runtime.service,
    InstanceId: runtime.instanceId,
    Release: runtime.release,
  }));
  // The acquisition boundary already reports its event. A peer closing an
  // in-flight bootstrap is an ordinary disconnect, not a database failure.
  if (cause !== "socket_closed" && !wasTenantPoolAcquisitionFailureReported(error)) {
    (options.monitor ?? errorMonitor).trackError(
      isDatabaseAuthenticationFailure(cause) ? "database_connectivity" : "health_failure",
      new Error("Student authentication service unavailable"),
      { job, messageType: "authentication_service_error", surface: stage, errorCode },
      { persist: false, priority: "high" },
    );
  }
  return cause;
}
