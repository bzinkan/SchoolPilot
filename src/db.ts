import { drizzle } from "drizzle-orm/node-postgres";
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
// configured ceiling of 148 connections, below the launch gate of 150.
const sessionPool = new pg.Pool({
  connectionString: url,
  max: poolLimits.session,
  idleTimeoutMillis: poolIdleTimeouts.session,
  connectionTimeoutMillis: 5000,
  statement_timeout: 15000,
  ssl: buildPgSslConfig(url),
  allowExitOnIdle: process.env.NODE_ENV !== "production",
});

export async function prewarmMainPool(): Promise<number> {
  await prewarmDatabasePool(pool, poolMinimums.main);
  return poolMinimums.main;
}

pool.on("error", (err) => {
  console.error("Unexpected error on idle client", err);
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
  console.error("Unexpected error on idle session client", err);
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
  logger: process.env.NODE_ENV === "development",
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
