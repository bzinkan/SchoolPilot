import type { RequestHandler } from "express";
import { drizzle } from "drizzle-orm/node-postgres";
import { pool } from "../db.js";
import { tenantALS, rlsGucEnabled } from "../db/tenantContext.js";
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
    await client.query("SELECT set_config('app.is_super', $1, false)", [isSuper ? "on" : "off"]);
    await client.query("SELECT set_config('app.school_id', $1, false)", [schoolId ?? ""]);
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
