import "dotenv/config";
import { initSentry } from "./services/sentry.js";
import { startScheduler, stopScheduler } from "./services/scheduler.js";
import { pool } from "./db.js";
import { schedulerLockPool, schedulerPool } from "./services/schedulerDb.js";
import errorMonitor from "./services/errorMonitor.js";
import { schedulerEnabled } from "./config/runtime.js";

initSentry();

let shutdownStarted = false;
let heartbeatTimer: NodeJS.Timeout | null = null;

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
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  stopScheduler();

  if (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`[SchedulerWorker] ${reason}:`, error);
    await errorMonitor.trackErrorAndFlush(
      "fatal_process_error",
      error,
      { eventType: reason, service: "scheduler-worker" },
      5_000
    );
    process.exitCode = 1;
  } else {
    console.log(`[SchedulerWorker] ${reason}`);
  }

  await Promise.allSettled([pool.end(), schedulerPool.end(), schedulerLockPool.end()]);
  errorMonitor.dispose();
  process.exit(process.exitCode ?? 0);
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
