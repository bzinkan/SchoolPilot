import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "../schema/index.js";
import { buildPgSslConfig } from "../db/ssl.js";
import errorMonitor from "./errorMonitor.js";
import {
  databasePoolLimits,
  databaseProcessRole,
} from "../config/databasePools.js";
import {
  migrationsOnStartup,
  migrationsOnly,
} from "../config/runtime.js";
import { safeErrorMetadata } from "../util/safeLogging.js";

const schedulerConnectionString =
  process.env.DATABASE_URL_PRIVILEGED || process.env.DATABASE_URL;

type SchedulerPoolKind = "query" | "lock";

let schedulerPoolInstance: pg.Pool | null = null;
let schedulerLockPoolInstance: pg.Pool | null = null;

function schedulerDatabaseAllowed(): boolean {
  return (
    databaseProcessRole() === "worker" ||
    migrationsOnly() ||
    migrationsOnStartup()
  );
}

function trackPoolError(kind: SchedulerPoolKind, err: Error): void {
  const label = kind === "query" ? "scheduler_pool" : "scheduler_lock_pool";
  console.error(`[${label}] Unexpected error on idle client`, safeErrorMetadata(err));
  errorMonitor.trackError(
    "database_connectivity",
    err,
    {
      job: label,
      messageType: "idle_client_error",
      errorCode: (err as NodeJS.ErrnoException).code,
    },
    { persist: false, priority: "high" }
  );
}

function createSchedulerPool(kind: SchedulerPoolKind): pg.Pool {
  if (!schedulerDatabaseAllowed()) {
    throw new Error(
      `Scheduler ${kind} pool is unavailable in an API process. ` +
        "Run scheduler work in the dedicated worker or migration task."
    );
  }
  if (!schedulerConnectionString) {
    throw new Error("DATABASE_URL is required for scheduler database access");
  }
  // Migration-only tasks use the reviewed worker pool profile even though
  // their task definition otherwise resembles the API process.
  const limits = databasePoolLimits({
    ...process.env,
    SCHEDULER_ENABLED: "true",
  });
  const pool = new pg.Pool({
    connectionString: schedulerConnectionString,
    max: kind === "query" ? limits.scheduler : limits.schedulerLock,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 60_000,
    ...(kind === "query" ? { options: "-c app.is_super=on" } : {}),
    ssl: buildPgSslConfig(schedulerConnectionString),
  });
  pool.on("error", (err) => trackPoolError(kind, err));
  return pool;
}

function instanceFor(kind: SchedulerPoolKind): pg.Pool {
  if (kind === "query") {
    schedulerPoolInstance ??= createSchedulerPool(kind);
    return schedulerPoolInstance;
  }
  schedulerLockPoolInstance ??= createSchedulerPool(kind);
  return schedulerLockPoolInstance;
}

function createLazyPool(kind: SchedulerPoolKind): pg.Pool {
  // Retain Pool.prototype so Drizzle correctly treats transactions as pooled
  // connections, while deferring the real pg.Pool until the first query.
  const target = Object.create(pg.Pool.prototype) as pg.Pool;
  return new Proxy(target, {
    get(_target, property) {
      // Drizzle's overload discriminator reads client.constructor.name during
      // module initialization. Answer from the proxy target without creating
      // a worker-only pool in an API process; actual I/O remains lazy below.
      if (property === "constructor") return pg.Pool;
      const existing =
        kind === "query" ? schedulerPoolInstance : schedulerLockPoolInstance;
      if (property === "end") {
        return async () => {
          if (!existing) return;
          if (kind === "query") schedulerPoolInstance = null;
          else schedulerLockPoolInstance = null;
          await existing.end();
        };
      }
      if (
        !existing &&
        (property === "totalCount" ||
          property === "idleCount" ||
          property === "waitingCount")
      ) {
        return 0;
      }
      const pool = existing ?? instanceFor(kind);
      const value = Reflect.get(pool, property, pool);
      return typeof value === "function" ? value.bind(pool) : value;
    },
  });
}

const schedulerPool = createLazyPool("query");
const schedulerLockPool = createLazyPool("lock");

export function schedulerPoolsInitialized(): {
  query: boolean;
  lock: boolean;
} {
  return {
    query: schedulerPoolInstance !== null,
    lock: schedulerLockPoolInstance !== null,
  };
}

export const schedulerDb = drizzle(schedulerPool, { schema });
export { schedulerPool, schedulerLockPool };
