import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestHandler } from "express";
import { ClasspilotNativeError } from "./classpilotNativeProtocol.js";

export const NATIVE_REQUEST_BUDGET_MS = 4_000;
export const NATIVE_REDIS_BUDGET_MS = 750;
type Phase = "tenant_context" | "school_lock" | "entitlement" | "student_control" | "redis" | "image_decode";
type State = { started: number; disconnected: boolean; responseEnded: () => boolean; failure?: string;
  phases: Partial<Record<Phase, { count: number; milliseconds: number }>>; redisOutcome?: string };
const context = new AsyncLocalStorage<State>();
const operations = new Map([
  ["POST /enrollment-tokens", "enrollment_issue"], ["POST /enroll", "installation_enroll"],
  ["DELETE /installations/:installationId", "installation_revoke"], ["POST /sessions", "student_sign_in"],
  ["POST /session/renew", "session_renew"], ["DELETE /session", "session_end"], ["GET /policy", "capture_policy"],
  ["DELETE /observations", "source_stop"], ["POST /observations", "observation_upload"],
  ["PUT /observation-leases/:viewerInstanceId", "viewer_renew"], ["DELETE /observation-leases/:viewerInstanceId", "viewer_release"],
  ["POST /tiles/desktop", "tiles_read"],
]);

export function nativeRequestRemainingMs(): number {
  const state = context.getStore();
  return state ? Math.max(0, NATIVE_REQUEST_BUDGET_MS - (performance.now() - state.started)) : NATIVE_REQUEST_BUDGET_MS;
}
export function assertNativeRequestActive(): void {
  if (context.getStore()?.disconnected || nativeRequestRemainingMs() <= 0) {
    throw new ClasspilotNativeError("NATIVE_REQUEST_EXPIRED", 503);
  }
}
export function nativeResponseEnded(): boolean { return context.getStore()?.responseEnded() ?? false; }
export async function nativePhase<T>(phase: Phase, action: () => Promise<T>): Promise<T> {
  const state = context.getStore(), started = performance.now();
  try { return await action(); }
  finally {
    if (state) {
      const entry = state.phases[phase] ?? { count: 0, milliseconds: 0 };
      entry.count++; entry.milliseconds += Math.round(performance.now() - started);
      state.phases[phase] = entry;
    }
  }
}
export function nativeRedisOutcome(status: "accepted" | "not_admitted" | "unknown", reason?: string): void {
  const state = context.getStore();
  const reasons = ["not_ready", "queue_full", "circuit_open", "shutdown", "aborted", "not_configured", "timeout", "transport_lost"];
  if (state && status !== "accepted") state.redisOutcome = `${status}_${reason && reasons.includes(reason) ? reason : "unclassified"}`;
}
export function nativeRequestFailure(error: unknown): void {
  const state = context.getStore();
  if (state) state.failure = error instanceof ClasspilotNativeError ? error.code : "unclassified_error";
}

/** Fixed labels and elapsed times only. No URLs, IDs, bodies, keys or error messages. */
export const nativeRequestDiagnostics: RequestHandler = (req, res, next) => {
  const state: State = { started: performance.now(), disconnected: false, responseEnded: () => res.writableEnded, phases: {} };
  let reported = false;
  const finish = () => {
    if (reported) return;
    reported = true;
    state.disconnected = !res.writableFinished;
    const milliseconds = Math.round(performance.now() - state.started);
    if (res.statusCode < 400 && milliseconds < 1_000 && !state.disconnected) return;
    console.info(JSON.stringify({ event: "classpilot_native_request", timestamp: new Date().toISOString(),
      operation: operations.get(`${req.method} ${req.route?.path}`) ?? "unmatched",
      status: res.statusCode, outcome: state.disconnected ? "disconnected" : "completed",
      code: state.failure ?? `http_${res.statusCode}`, milliseconds, phases: state.phases,
      ...(state.redisOutcome ? { redisOutcome: state.redisOutcome } : {}) }));
  };
  res.once("finish", finish); res.once("close", finish);
  context.run(state, next);
};
