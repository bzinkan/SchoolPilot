import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { readFileSync, existsSync } from "fs";
import * as schema from "./schema/index.js";
import { getTenantStore, rlsGucEnabled } from "./db/tenantContext.js";

// SOC 2 / SC-7: enforce TLS verify-full to AWS RDS using the bundled CA chain.
// The Docker image ships /app/rds-ca.pem from AWS' truststore so we can verify
// both the hostname and the certificate chain. In local dev (where the CA file
// may be absent), fall back to permissive SSL only if sslmode=require is set;
// otherwise let pg defaults apply.
const RDS_CA_PATH = "/app/rds-ca.pem";
const url = process.env.DATABASE_URL ?? "";

function buildSslConfig(): pg.ClientConfig["ssl"] {
  if (url.includes("sslmode=verify-full") && existsSync(RDS_CA_PATH)) {
    return {
      ca: readFileSync(RDS_CA_PATH, "utf8"),
      rejectUnauthorized: true,
    };
  }
  if (url.includes("sslmode=require") || url.includes("sslmode=no-verify")) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

const pool = new pg.Pool({
  connectionString: url,
  max: 50,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 15000,
  ssl: buildSslConfig(),
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle client", err);
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

export { pool };
export default db;
