import "dotenv/config";
import { initSentry } from "./services/sentry.js";
import { startScheduler, stopScheduler, drainSchedulerJobs, snapshotSchedulerJobs } from "./services/scheduler.js";
import { pool, sessionPool } from "./db.js";
import { schedulerLockPool, schedulerPool } from "./services/schedulerDb.js";
import errorMonitor from "./services/errorMonitor.js";
import { schedulerEnabled } from "./config/runtime.js";
import { safeErrorMetadata } from "./util/safeLogging.js";
import { drainService, snapshotShutdownPools, type ShutdownPool } from "./services/serviceShutdown.js";
import { classpilotLifecyclePushes, flushClasspilotLifecyclePushes, snapshotClasspilotLifecyclePushes } from "./services/classpilotLifecyclePushes.js";
import { drainTenantContextReleases, getTenantContextReleaseSnapshot } from "./middleware/tenantContext.js";
import { stopRuntimePerformanceMetrics } from "./services/runtimePerformanceMetrics.js";

initSentry();

let shutdownStarted = false;
let heartbeatTimer: NodeJS.Timeout | null = null;
let shutdownPhase = "idle";
const shutdownPools: ShutdownPool[] = [
  { name: "main", pool }, { name: "session", pool: sessionPool },
  { name: "scheduler", pool: schedulerPool }, { name: "scheduler_lock", pool: schedulerLockPool },
];

function emitWorkerHeartbeat() {
  const environment = process.env.APP_ENV || process.env.NODE_ENV || "development";
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: "SchoolPilot/Scheduler",
        Dimensions: [["Environment", "Service"]],
        Metrics: [{ Name: "WorkerHeartbeat", Unit: "Count" }],
      }],
    },
    Environment: environment,
    Service: "scheduler-worker",
    WorkerHeartbeat: 1,
  }));
}

async function shutdown(reason: string, err?: unknown): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  const forceExit = setTimeout(() => {
    classpilotLifecyclePushes.cancelPending();
    console.error(JSON.stringify({ event: "shutdown_deadline_exceeded", service: "scheduler-worker", phase: shutdownPhase, pools: snapshotShutdownPools(shutdownPools), pending: { scheduler: snapshotSchedulerJobs(), lifecycle: snapshotClasspilotLifecyclePushes() } }));
    process.exit(1);
  }, 15_000);
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  stopScheduler();

  if (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`[SchedulerWorker] ${reason}:`, safeErrorMetadata(error));
    errorMonitor.trackError(
      "fatal_process_error",
      error,
      { eventType: reason, service: "scheduler-worker" },
      { priority: "high" }
    );
    process.exitCode = 1;
  } else {
    console.log(`[SchedulerWorker] ${reason}`);
  }

  const result = await drainService({
    timeoutMs: 14_500,
    onPhase(phase) { shutdownPhase = phase; },
    stopIntake: stopScheduler,
    drainProducers: drainSchedulerJobs,
    sealBackground() { classpilotLifecyclePushes.stopAccepting(); },
    async drainBackground() {
      await flushClasspilotLifecyclePushes();
      await drainTenantContextReleases();
    },
    cancelBackground() { classpilotLifecyclePushes.cancelPending(); },
    async disposeMonitor(timeoutMs) {
      await errorMonitor.disposeAndWait(timeoutMs);
      if (!errorMonitor.getDisposalSnapshot().complete) throw new Error("Error monitor disposal incomplete");
    },
    stopMetrics: stopRuntimePerformanceMetrics,
    pools: shutdownPools,
    snapshot: () => ({ scheduler: snapshotSchedulerJobs(), lifecycle: snapshotClasspilotLifecyclePushes(), tenantReleases: getTenantContextReleaseSnapshot() }),
  });
  clearTimeout(forceExit);
  process.exit(result.completed ? (process.exitCode ?? 0) : 1);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("uncaughtException", (err) => void shutdown("uncaughtException", err));
process.on("unhandledRejection", (reason) =>
  void shutdown("unhandledRejection", reason instanceof Error ? reason : new Error(String(reason)))
);

if (!schedulerEnabled()) {
  void shutdown("SCHEDULER_ENABLED=false; worker exiting");
} else {
  console.log("[SchedulerWorker] starting");
  emitWorkerHeartbeat();
  heartbeatTimer = setInterval(emitWorkerHeartbeat, 60_000);
  startScheduler(null);
}
