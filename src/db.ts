import { drizzle } from "drizzle-orm/node-postgres";
import { createHash } from "node:crypto";
import pg from "pg";
import * as schema from "./schema/index.js";
import { getTenantStore, rlsGucEnabled } from "./db/tenantContext.js";
import { buildPgSslConfig } from "./db/ssl.js";
import errorMonitor from "./services/errorMonitor.js";
import {
  databasePoolIdleTimeouts,
  databasePoolLimits,
  databasePoolMinimums,
  prewarmDatabasePool,
} from "./config/databasePools.js";
import { safeErrorMetadata } from "./util/safeLogging.js";
import { ApiPoolReadiness, API_POOL_READINESS_CONFIG } from "./services/apiPoolReadiness.js";
import { getRuntimeMetadata } from "./services/runtimeMetadata.js";
import { recordRuntimePerformanceCounter } from "./services/runtimePerformanceMetrics.js";

// SOC 2 / SC-7: enforce TLS verify-full to AWS RDS using the bundled CA chain.
// The Docker image ships /app/rds-ca.pem from AWS' truststore so we can verify
// both the hostname and the certificate chain.
const url = process.env.DATABASE_URL ?? "";
if (!url) {
  throw new Error(
    "FATAL: DATABASE_URL is not set. Refusing to fall back to pg defaults (localhost:5432 as the OS user)."
  );
}
const poolLimits = databasePoolLimits();
const poolMinimums = databasePoolMinimums();
const poolIdleTimeouts = databasePoolIdleTimeouts();

const databaseQueryDiagnosticsEnabled = /^(1|true|yes|on)$/i.test(
  process.env.DB_QUERY_DIAGNOSTICS || ""
);
const redactedQueryLogger = {
  logQuery(query: string, params: unknown[]): void {
    const statement = query.trim().split(/\s+/, 1)[0]?.toLowerCase() || "unknown";
    // Query text can contain dynamically authored literals, so emit only a
    // one-way shape digest and parameter count. Parameter values are never
    // logged in any environment.
    console.debug(JSON.stringify({
      event: "database_query_shape",
      statement,
      parameterCount: params.length,
      shapeSha256: createHash("sha256").update(query).digest("hex"),
    }));
  },
};

const pool = new pg.Pool({
  connectionString: url,
  max: poolLimits.main,
  min: poolMinimums.main,
  idleTimeoutMillis: poolIdleTimeouts.main,
  connectionTimeoutMillis: 5000,
  statement_timeout: 15000,
  ssl: buildPgSslConfig(url),
});

// Keep web-session reads/saves off the RLS application pool. A request-bound
// RLS client is intentionally held until the response completes; using that
// same pool for connect-pg-simple can make a classroom burst wait for a second
// client to save its session before the first client is allowed to release.
// All process pools are role-capped. Six API tasks plus one worker have a
// configured ceiling of 124 connections, below the launch gate of 150.
const sessionPool = new pg.Pool({
  connectionString: url,
  max: poolLimits.session,
  idleTimeoutMillis: poolIdleTimeouts.session,
  connectionTimeoutMillis: 5000,
  statement_timeout: 15000,
  ssl: buildPgSslConfig(url),
  allowExitOnIdle: process.env.NODE_ENV !== "production",
});

export const apiPoolReadiness = new ApiPoolReadiness({
  readPool: () => ({
    total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount, max: poolLimits.main,
  }),
  async probeDatabase() {
    // Use the existing session pool's two-connection ceiling, never a new
    // connection budget or a tenant query. pg bounds checkout at 5s and its
    // pool.query releases/discards the client on this 2s query timeout.
    const probe = { text: "SELECT 1", query_timeout: 2_000 };
    await sessionPool.query(probe);
    return true;
  },
  onTransition(transition) {
    recordRuntimePerformanceCounter(transition.state === "pool_stalled"
      ? "apiPoolReadinessStalled" : transition.state === "ready"
        ? "apiPoolReadinessRecovered" : "apiPoolReadinessProbeDeferred");
    console.log(JSON.stringify({
      event: "api_pool_readiness_transition", ...getRuntimeMetadata(), ...transition,
    }));
    // Acquisition failures already emit non-persisted database_connectivity
    // alerts. This transition supplies recovery context without duplicate alerts.
  },
});

let readinessTimer: NodeJS.Timeout | undefined;
const recordMainPoolProgress = () => apiPoolReadiness.recordProgress();

/** API entrypoint only, after startup and prewarming, before accepting traffic. */
export function startApiPoolReadiness(): void {
  if (readinessTimer || poolLimits.role !== "api") return;
  apiPoolReadiness.start();
  if (!apiPoolReadiness.status().ready) return;
  for (const event of ["acquire", "release", "remove"] as const) {
    pool.on(event, recordMainPoolProgress);
  }
  readinessTimer = setInterval(() => {
    void apiPoolReadiness.sample().catch(() => {
      // Never log raw database errors, SQL or request context from this path.
      console.error(JSON.stringify({ event: "api_pool_readiness_sample_failed", ...getRuntimeMetadata() }));
    });
  }, API_POOL_READINESS_CONFIG.sampleIntervalMs);
  readinessTimer.unref();
  console.log(JSON.stringify({
    event: "api_pool_readiness_started", contractVersion: 1, path: "/readyz",
    ...API_POOL_READINESS_CONFIG, ...getRuntimeMetadata(),
  }));
}

export function stopApiPoolReadiness(): void {
  if (readinessTimer) clearInterval(readinessTimer);
  readinessTimer = undefined;
  apiPoolReadiness.stop();
  for (const event of ["acquire", "release", "remove"] as const) {
    pool.off(event, recordMainPoolProgress);
  }
}

export async function drainApiPoolReadiness(): Promise<void> {
  await apiPoolReadiness.drain();
}

export async function prewarmMainPool(): Promise<number> {
  await prewarmDatabasePool(pool, poolMinimums.main);
  return poolMinimums.main;
}

pool.on("error", (err) => {
  console.error("Unexpected error on idle client", safeErrorMetadata(err));
  errorMonitor.trackError(
    "database_connectivity",
    err,
    {
      job: "main_pool",
      messageType: "idle_client_error",
      errorCode: (err as NodeJS.ErrnoException).code,
    },
    { persist: false, priority: "high" }
  );
});

sessionPool.on("error", (err) => {
  console.error("Unexpected error on idle session client", safeErrorMetadata(err));
  errorMonitor.trackError(
    "database_connectivity",
    err,
    {
      job: "session_pool",
      messageType: "idle_client_error",
      errorCode: (err as NodeJS.ErrnoException).code,
    },
    { persist: false, priority: "high" }
  );
});

// The global (pool-backed) Drizzle instance. Used directly when RLS request
// binding is off, and as the fallback when there's no per-request tenant context
// (startup, scheduler via schedulerDb, pre-auth/bootstrap paths).
const globalDb = drizzle(pool, {
  schema,
  logger: databaseQueryDiagnosticsEnabled ? redactedQueryLogger : false,
});

function resolveDb(): typeof globalDb {
  if (rlsGucEnabled()) {
    const store = getTenantStore();
    if (store) return store.db as typeof globalDb;
  }
  return globalDb;
}

// `db` is a Proxy that transparently routes each query to the per-request,
// GUC-scoped connection when one is bound (RLS on), else the global pool. This
// keeps every storage function's `db.select()/insert()/...` unchanged — no
// signature churn — while letting RLS enforce tenant isolation in the database.
export const db: typeof globalDb = new Proxy(globalDb, {
  get(_target, prop) {
    const active = resolveDb();
    const value = (active as unknown as Record<string | symbol, unknown>)[prop];
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(active) : value;
  },
});

export { pool, sessionPool };
export default db;
