import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestHandler } from "express";

// Fixed labels only: no school, student, device, SQL, URL or message content.
export const USAGE_CAPACITY_OPERATIONS = [
  "auth", "heartbeat_persistence", "heartbeat_final_delivery", "heartbeat_background",
  "api_limiter", "heartbeat_middleware", "heartbeat_handler",
  "usage_report_admission", "usage_report", "usage_worker", "tenant_request", "tenant_background", "unclassified",
] as const;
export type UsageCapacityOperation = typeof USAGE_CAPACITY_OPERATIONS[number];
export type UsageCapacityTiming = "operationMs" | "checkoutMs" | "holdMs" | "sqlMs";
export type UsageCapacityCounter = "checkoutAttempts" | "checkoutSuccess" | "checkoutFailure" | "sqlFailure"
  | "admissionAdmitted" | "admissionDenied" | "admissionCancelled" | "heartbeatOptionalTelemetryFailures" | "heartbeatHandlerFailures" | "heartbeatOptionalInboxFailures" | "heartbeatInboxChecks";
const timingNames: readonly UsageCapacityTiming[] = ["operationMs", "checkoutMs", "holdMs", "sqlMs"];
const counterNames: readonly UsageCapacityCounter[] = ["checkoutAttempts", "checkoutSuccess", "checkoutFailure", "sqlFailure",
  "admissionAdmitted", "admissionDenied", "admissionCancelled", "heartbeatOptionalTelemetryFailures", "heartbeatHandlerFailures", "heartbeatOptionalInboxFailures", "heartbeatInboxChecks"];
const durationBoundsMs = [1, 5, 10, 25, 50, 100, 250, 500, 1_000, 5_000, 15_000] as const;
type Timing = { count: number; totalMs: number; maxMs: number; buckets: number[] };
type OperationMetrics = {
  counters: Record<UsageCapacityCounter, number>;
  timings: Record<UsageCapacityTiming, Timing>;
  activeCheckouts: number;
  peakActiveCheckouts: number;
  pendingCheckouts: number;
  peakPendingCheckouts: number;
  activeOperations: number;
  peakActiveOperations: number;
};
const operationContext = new AsyncLocalStorage<UsageCapacityOperation>();
const fixedOperation = (value: UsageCapacityOperation): UsageCapacityOperation =>
  USAGE_CAPACITY_OPERATIONS.includes(value) ? value : "unclassified";
const newTiming = (): Timing => ({ count: 0, totalMs: 0, maxMs: 0, buckets: Array(durationBoundsMs.length + 1).fill(0) });
const newMetrics = (active = 0, pending = 0, operations = 0): OperationMetrics => ({
  counters: { checkoutAttempts: 0, checkoutSuccess: 0, checkoutFailure: 0, sqlFailure: 0,
    admissionAdmitted: 0, admissionDenied: 0, admissionCancelled: 0, heartbeatOptionalTelemetryFailures: 0, heartbeatHandlerFailures: 0, heartbeatOptionalInboxFailures: 0, heartbeatInboxChecks: 0 },
  timings: { operationMs: newTiming(), checkoutMs: newTiming(), holdMs: newTiming(), sqlMs: newTiming() },
  activeCheckouts: active, peakActiveCheckouts: active,
  pendingCheckouts: pending, peakPendingCheckouts: pending,
  activeOperations: operations, peakActiveOperations: operations,
});
const metrics = new Map(USAGE_CAPACITY_OPERATIONS.map(operation => [operation, newMetrics()]));

export function getUsageCapacityOperation(): UsageCapacityOperation {
  return operationContext.getStore() ?? "unclassified";
}

export function recordUsageCapacityTiming(name: UsageCapacityTiming, durationMs: number,
  operation: UsageCapacityOperation = getUsageCapacityOperation()): void {
  if (!timingNames.includes(name) || !Number.isFinite(durationMs) || durationMs < 0) return;
  const timing = metrics.get(fixedOperation(operation))!.timings[name];
  timing.count += 1;
  timing.totalMs += durationMs;
  timing.maxMs = Math.max(timing.maxMs, durationMs);
  const index = durationBoundsMs.findIndex(bound => durationMs <= bound);
  timing.buckets[index < 0 ? durationBoundsMs.length : index]! += 1;
}

export function recordUsageCapacityCounter(name: UsageCapacityCounter,
  operation: UsageCapacityOperation = getUsageCapacityOperation()): void {
  if (!counterNames.includes(name)) return;
  const value = metrics.get(fixedOperation(operation))!;
  value.counters[name] += 1;
  if (name === "checkoutAttempts") {
    value.pendingCheckouts += 1;
    value.peakPendingCheckouts = Math.max(value.peakPendingCheckouts, value.pendingCheckouts);
  } else if (name === "checkoutSuccess" || name === "checkoutFailure") {
    value.pendingCheckouts = Math.max(0, value.pendingCheckouts - 1);
  }
}

/** A complete async owner, including gaps between leases. Does not change ALS attribution. */
export function startUsageCapacityOperation(operation: UsageCapacityOperation): () => void {
  operation = fixedOperation(operation);
  const started = performance.now(), value = metrics.get(operation)!;
  value.activeOperations += 1;
  value.peakActiveOperations = Math.max(value.peakActiveOperations, value.activeOperations);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const current = metrics.get(operation)!;
    current.activeOperations -= 1;
    recordUsageCapacityTiming("operationMs", performance.now() - started, operation);
  };
}

/** Only for known synchronous or Promise-returning middleware, never callback-owned work. */
export function trackUsageCapacityMiddleware(operation: UsageCapacityOperation, middleware: RequestHandler): RequestHandler {
  return (req, res, next) => {
    const end = startUsageCapacityOperation(operation);
    try {
      // Express4's RequestHandler type declares void even for the installed
      // async limiters/auth middleware; inspect the actual returned value.
      const result: unknown = middleware(req, res, next);
      if (result instanceof Promise) return result.finally(end);
      end();
      return result;
    } catch (error) {
      end();
      throw error;
    }
  };
}

/** Scope work without retaining arguments/results or changing its error semantics. */
export async function runWithUsageCapacityOperation<T>(operation: UsageCapacityOperation,
  fn: () => Promise<T>): Promise<T> {
  return operationContext.run(fixedOperation(operation), async () => {
    const end = startUsageCapacityOperation(operation);
    try { return await fn(); }
    finally { end(); }
  });
}

/** End only after RESET/discard and release; response completion is not ownership release. */
export function startUsageCapacityCheckout(operation: UsageCapacityOperation = getUsageCapacityOperation()): () => void {
  operation = fixedOperation(operation);
  const started = performance.now();
  const value = metrics.get(operation)!;
  value.activeCheckouts += 1;
  value.peakActiveCheckouts = Math.max(value.peakActiveCheckouts, value.activeCheckouts);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const current = metrics.get(operation)!;
    current.activeCheckouts = Math.max(0, current.activeCheckouts - 1);
    recordUsageCapacityTiming("holdMs", performance.now() - started, operation);
  };
}

export function resetUsageCapacityDiagnostics(): void {
  // A phase reset cannot make an outstanding owner disappear. A lease spanning
  // the reset contributes its full hold duration when it actually releases.
  for (const operation of USAGE_CAPACITY_OPERATIONS) {
    const value = metrics.get(operation)!;
    metrics.set(operation, newMetrics(value.activeCheckouts, value.pendingCheckouts, value.activeOperations));
  }
}

export function getUsageCapacityDiagnostics() {
  return {
    schemaVersion: 2,
    durationBoundsMs: [...durationBoundsMs],
    operations: Object.fromEntries(USAGE_CAPACITY_OPERATIONS.map(operation => {
      const value = metrics.get(operation)!;
      return [operation, {
        ...value, counters: { ...value.counters },
        timings: Object.fromEntries(timingNames.map(name => [name, { ...value.timings[name], buckets: [...value.timings[name].buckets] }])),
      }];
    })),
  };
}
