import { AsyncLocalStorage } from "node:async_hooks";
import type { PoolClient } from "pg";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../schema/index.js";

// Per-request tenant database context for Row-Level Security.
//
// When RLS is enabled, a middleware checks out ONE dedicated pg client for the
// request, sets the tenant GUC on it (app.school_id / app.is_super), and stores
// it here. The Proxy `db` in ../db.ts resolves this store per query so the
// request's queries all run on the GUC-scoped connection — WITHOUT changing any
// storage-function signatures. The client is released (and GUC reset) when the
// response finishes. See ../middleware/tenantContext.ts.
export interface TenantStore {
  client: PoolClient;
  db: NodePgDatabase<typeof schema>;
  schoolId?: string;
  isSuper?: boolean;
}

export const tenantALS = new AsyncLocalStorage<TenantStore>();

export function getTenantStore(): TenantStore | undefined {
  return tenantALS.getStore();
}

// Master kill-switch. When not "true", the whole mechanism is inert: the Proxy
// `db` always returns the global pool and the middleware is a no-op. Lets us
// disable RLS request-binding instantly without a code change.
export function rlsGucEnabled(): boolean {
  return process.env.RLS_GUC_ENABLED === "true";
}
