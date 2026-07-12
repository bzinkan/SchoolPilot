import type { RequestHandler } from "express";
import { drizzle } from "drizzle-orm/node-postgres";
import { pool } from "../db.js";
import { tenantALS, rlsGucEnabled, type TenantStore } from "../db/tenantContext.js";
import * as schema from "../schema/index.js";

// Binds a per-request tenant DB connection for Row-Level Security. Call this at
// the END of the auth/school-context middleware (after res.locals.schoolId is
// resolved AND after any pre-context membership lookup), so the GUC reflects the
// caller's school and the bootstrap queries run un-scoped.
//
// Inert unless RLS_GUC_ENABLED === "true": then it checks out one client, sets
// app.school_id / app.is_super on it (session-level, via set_config so the value
// is safely parameterized), stashes it in AsyncLocalStorage for the Proxy `db`,
// and resets + releases it when the response finishes. Never holds a transaction
// (short connection hold), and releases exactly once even on errors.
export const bindTenantContext: RequestHandler = async (req, res, next) => {
  if (!rlsGucEnabled()) return next();

  const schoolId = res.locals.schoolId as string | undefined;
  const isSuper = !!req.authUser?.isSuperAdmin;
  // No school and not super-admin → nothing to scope. Such requests must not
  // touch tenant tables (they'd be denied by default); run on the global pool.
  if (!schoolId && !isSuper) return next();

  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    return next(err);
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    client!
      .query("SELECT set_config('app.school_id', '', false), set_config('app.is_super', 'off', false)")
      .catch(() => {})
      .finally(() => client!.release());
  };
  res.on("finish", release);
  res.on("close", release);

  try {
    // set_config(name, value, is_local=false) = session-level SET, but safely
    // parameterized (SET ... = $1 is not allowed in Postgres).
    await client.query(
      "SELECT set_config('app.is_super', $1, false), set_config('app.school_id', $2, false)",
      [isSuper ? "on" : "off", schoolId ?? ""]
    );
  } catch (err) {
    release();
    return next(err);
  }

  const store = {
    client,
    db: drizzle(client, { schema }),
    schoolId,
    isSuper,
  };
  tenantALS.run(store, () => next());
};

// Establishes a tenant DB context OUTSIDE an HTTP request — for fire-and-forget
// work that runs after the request's connection is already released: the
// detached classifyUrl().then() heartbeat callback and the unauthenticated
// MailPilot Pub/Sub webhook. Checks out one client, sets the GUC, runs `fn`
// inside the AsyncLocalStorage scope so the Proxy `db` routes every query to it,
// then resets + releases. Inert (just runs `fn`) when RLS_GUC_ENABLED !== "true".
// Pass `schoolId` to scope to one school (the common case — keeps writes isolated
// to that school), or `isSuper` for genuinely cross-school work.
export async function runWithTenantContext<T>(
  opts: { schoolId?: string; isSuper?: boolean },
  fn: () => Promise<T>,
): Promise<T> {
  if (!rlsGucEnabled()) return fn();

  const client = await pool.connect();
  try {
    await client.query(
      "SELECT set_config('app.is_super', $1, false), set_config('app.school_id', $2, false)",
      [opts.isSuper ? "on" : "off", opts.schoolId ?? ""]
    );
    const store: TenantStore = {
      client,
      db: drizzle(client, { schema }),
      schoolId: opts.schoolId,
      isSuper: opts.isSuper,
    };
    return await tenantALS.run(store, fn);
  } finally {
    await client
      .query("SELECT set_config('app.school_id', '', false), set_config('app.is_super', 'off', false)")
      .catch(() => {});
    client.release();
  }
}
