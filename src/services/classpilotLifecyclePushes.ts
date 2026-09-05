import { runWithoutTenantContext } from "../db/tenantContext.js";
import { safeErrorMetadata } from "../util/safeLogging.js";
import errorMonitor from "./errorMonitor.js";
import { getRuntimeMetadata } from "./runtimeMetadata.js";
import { safeOperationalErrorCode, wasTenantPoolAcquisitionFailureReported } from "../util/operationalErrors.js";

export type LifecyclePushOutcome =
  | { status: "completed" }
  | { status: "failed"; recovery: "reconciliation_deferred" }
  | { status: "deferred"; reason: "queue_full" | "shutdown"; recovery: "reconciliation_deferred" };
type Push = (signal: AbortSignal) => Promise<void>;
type WaitingPush = { run: Push; resolve: (outcome: LifecyclePushOutcome) => void; queuedAt: number };

const phaseFailureLabels = {
  clear: "[ClassPilot] Final classroom-state clear push failed:",
  restore: "[ClassPilot] Restored classroom-state push failed:",
  fab: "[ClassPilot] Student FAB finalization push failed:",
} as const;
const reportedFailures = new WeakSet<object>();

function reportLifecycleFailure(error: unknown, phase: string): void {
  if (error instanceof AggregateError) {
    for (const cause of error.errors) reportLifecycleFailure(cause, phase);
    return;
  }
  if (wasTenantPoolAcquisitionFailureReported(error)) return;
  if (error && typeof error === "object") {
    if (reportedFailures.has(error)) return;
    reportedFailures.add(error);
  }
  errorMonitor.trackError("scheduler_failure", error instanceof Error ? error : new Error("Lifecycle push failed"), {
    job: "classpilotLifecyclePush", messageType: phase, errorCode: safeOperationalErrorCode(error),
  }, { persist: false, priority: "high" });
}

export async function runClasspilotLifecyclePushPhases(
  signal: AbortSignal,
  phases: Array<{ phase: keyof typeof phaseFailureLabels; run(): Promise<void> }>
): Promise<void> {
  const failures: unknown[] = [];
  for (const phase of phases) {
    if (signal.aborted) break;
    try { await phase.run(); } catch (error) {
      failures.push(error);
      console.warn(phaseFailureLabels[phase.phase], safeErrorMetadata(error));
      reportLifecycleFailure(error, phase.phase);
    }
  }
  if (failures.length) throw new AggregateError(failures, "Lifecycle push phases failed");
}

/** Best-effort, post-commit delivery only. Persisted state and heartbeat/auth
 * reconciliation remain authoritative when this bounded queue cannot deliver. */
export class ClasspilotLifecyclePushExecutor {
  private waiting: WaitingPush[] = [];
  private active: AbortController | null = null;
  private accepting = true;
  private cancelled = false;
  private idleWaiters = new Set<() => void>();
  private completed = 0;
  private failed = 0;
  private deferred = 0;
  private lastExecutionMs = 0;
  private lastWaitMs = 0;

  constructor(private readonly options: {
    maxWaiting?: number;
    now?: () => number;
    onOutcome?: (outcome: LifecyclePushOutcome, snapshot: ReturnType<ClasspilotLifecyclePushExecutor["snapshot"]>) => void;
    onFailure?: (error: unknown) => void;
  } = {}) {}

  snapshot() {
    return {
      active: this.active ? 1 : 0,
      waiting: this.waiting.length,
      oldestWaitingMs: this.waiting.length ? Math.max(0, this.now() - this.waiting[0]!.queuedAt) : 0,
      accepting: this.accepting,
      completed: this.completed,
      failed: this.failed,
      deferred: this.deferred,
      lastExecutionMs: this.lastExecutionMs,
      lastWaitMs: this.lastWaitMs,
    };
  }

  enqueue(run: Push): Promise<LifecyclePushOutcome> {
    if (!this.accepting) return Promise.resolve(this.record({ status: "deferred", reason: "shutdown", recovery: "reconciliation_deferred" }));
    if (this.active && this.waiting.length >= (this.options.maxWaiting ?? 256)) {
      return Promise.resolve(this.record({ status: "deferred", reason: "queue_full", recovery: "reconciliation_deferred" }));
    }
    return new Promise((resolve) => {
      this.waiting.push({ run, resolve, queuedAt: this.now() });
      this.startNext();
    });
  }

  /** Producers may still enqueue while this barrier is pending. */
  flush(): Promise<void> {
    if (!this.active && !this.waiting.length) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  stopAccepting(): void { this.accepting = false; }

  /** Deadline handling never starts another queued job. An active DB operation
   * still owns its lease until its own finally block releases it. */
  cancelPending(): void {
    this.stopAccepting();
    this.cancelled = true;
    this.active?.abort();
    for (const job of this.waiting.splice(0)) {
      job.resolve(this.record({ status: "deferred", reason: "shutdown", recovery: "reconciliation_deferred" }));
    }
    this.resolveIdle();
  }

  private now(): number { return this.options.now?.() ?? performance.now(); }

  private record(outcome: LifecyclePushOutcome): LifecyclePushOutcome {
    if (outcome.status === "completed") this.completed++;
    else if (outcome.status === "failed") this.failed++;
    else this.deferred++;
    // Observability must not turn a committed transition into a failed response.
    try { this.options.onOutcome?.(outcome, this.snapshot()); } catch { /* best effort */ }
    return outcome;
  }

  private startNext(): void {
    if (this.active || this.cancelled) return;
    const job = this.waiting.shift();
    if (!job) { this.resolveIdle(); return; }
    const controller = new AbortController();
    this.active = controller;
    const startedAt = this.now();
    this.lastWaitMs = Math.max(0, startedAt - job.queuedAt);
    // Exit ALS when executing, not merely when enqueueing. Never retain a
    // request/transaction lease in a callback that can outlive its owner.
    void runWithoutTenantContext(async () => {
      let outcome: LifecyclePushOutcome;
      try {
        await job.run(controller.signal);
        outcome = controller.signal.aborted
          ? { status: "deferred", reason: "shutdown", recovery: "reconciliation_deferred" }
          : { status: "completed" };
      } catch (error) {
        try { this.options.onFailure?.(error); } catch { /* telemetry is best effort */ }
        outcome = controller.signal.aborted
          ? { status: "deferred", reason: "shutdown", recovery: "reconciliation_deferred" }
          : { status: "failed", recovery: "reconciliation_deferred" };
      }
      this.lastExecutionMs = Math.max(0, this.now() - startedAt);
      this.active = null;
      job.resolve(this.record(outcome));
      this.startNext();
      this.resolveIdle();
    });
  }

  private resolveIdle(): void {
    if (this.active || this.waiting.length) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}

export const classpilotLifecyclePushes = new ClasspilotLifecyclePushExecutor({
  onFailure: (error) => reportLifecycleFailure(error, "push"),
  onOutcome(outcome, snapshot) {
    const runtime = getRuntimeMetadata();
    if (outcome.status === "deferred" && outcome.reason === "queue_full") {
      reportLifecycleFailure(new Error("ClassPilot lifecycle push queue capacity exceeded"), "queue_full");
    }
    const metricName = outcome.status === "completed" ? "LifecyclePushCompleted"
      : outcome.status === "failed" ? "LifecyclePushFailed" : "LifecyclePushDeferred";
    console.log(JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [{
          Namespace: "SchoolPilot/ClassPilot",
          Dimensions: [["Environment", "Service"]],
          Metrics: [
            { Name: metricName, Unit: "Count" }, { Name: "LifecyclePushQueueDepth", Unit: "Count" },
            { Name: "LifecyclePushOldestWaitingMs", Unit: "Milliseconds" },
            ...(outcome.status !== "deferred" ? [
              { Name: "LifecyclePushExecutionMs", Unit: "Milliseconds" },
              { Name: "LifecyclePushWaitMs", Unit: "Milliseconds" },
            ] : []),
          ],
        }],
      },
      Environment: runtime.environment,
      Service: runtime.service,
      runtime,
      [metricName]: 1,
      LifecyclePushQueueDepth: snapshot.waiting,
      LifecyclePushOldestWaitingMs: Math.round(snapshot.oldestWaitingMs),
      ...(outcome.status !== "deferred" ? {
        LifecyclePushExecutionMs: Math.round(snapshot.lastExecutionMs),
        LifecyclePushWaitMs: Math.round(snapshot.lastWaitMs),
      } : {}),
      event: "classpilot_lifecycle_push_outcome",
      outcome: outcome.status,
      ...(outcome.status === "deferred" ? { reason: outcome.reason } : {}),
      ...(outcome.status !== "completed" ? { recovery: outcome.recovery } : {}),
      active: snapshot.active,
      queueDepth: snapshot.waiting,
      oldestWaitingMs: Math.round(snapshot.oldestWaitingMs),
      executionMs: Math.round(snapshot.lastExecutionMs),
    }));
  },
});

const pendingTransports = new Set<Promise<void>>();
let transportFailures = 0;
export function trackClasspilotLifecycleTransport(work: Promise<unknown>): void {
  const failed = (error: unknown) => {
    transportFailures++;
    console.warn("[ClassPilot] Lifecycle transport failed:", safeErrorMetadata(error));
    reportLifecycleFailure(error, "transport");
    const runtime = getRuntimeMetadata();
    console.log(JSON.stringify({
      _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{
        Namespace: "SchoolPilot/ClassPilot", Dimensions: [["Environment", "Service"]],
        Metrics: [{ Name: "LifecycleTransportFailure", Unit: "Count" }],
      }] },
      Environment: runtime.environment, Service: runtime.service, runtime,
      event: "classpilot_lifecycle_transport_failure", LifecycleTransportFailure: 1,
      recovery: "reconciliation_deferred",
    }));
  };
  const tracked = work.then((value) => {
    if (value === false && process.env.REDIS_URL) failed(new Error("Lifecycle publication unavailable"));
  }, failed);
  pendingTransports.add(tracked);
  void tracked.then(() => pendingTransports.delete(tracked));
}

export async function flushClasspilotLifecyclePushes(): Promise<void> {
  // A completing producer can register transports while the queue drains.
  do {
    await classpilotLifecyclePushes.flush();
    await Promise.all([...pendingTransports]);
  } while (pendingTransports.size || classpilotLifecyclePushes.snapshot().active || classpilotLifecyclePushes.snapshot().waiting);
}

export function snapshotClasspilotLifecyclePushes() {
  return { ...classpilotLifecyclePushes.snapshot(), transports: pendingTransports.size, transportFailures };
}
