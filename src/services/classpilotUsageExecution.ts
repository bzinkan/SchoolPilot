import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import * as schema from "../schema/index.js";
import { tenantALS, rlsGucEnabled } from "../db/tenantContext.js";
import { acquireTenantClient, releaseTenantClient } from "../middleware/tenantContext.js";
import { ClasspilotUsageBusyError } from "./classpilotUsageAdmission.js";

/**
 * One cancellable report lease. Closing the socket cancels in-flight PostgreSQL
 * work without borrowing another connection. Ownership stays here until the
 * callback settles; the closed client is then discarded by normal cleanup.
 * No abort/HTTP event can put a still-running scoped client back in the pool.
 */
export async function runClasspilotUsageExecution<T>(options: {
  schoolId: string;
  signal: AbortSignal;
  deadlineAt: number;
}, callback: () => Promise<T>): Promise<T> {
  const check = () => {
    if (options.signal.aborted) throw options.signal.reason ?? new ClasspilotUsageBusyError();
    if (performance.now() >= options.deadlineAt) throw new ClasspilotUsageBusyError();
  };
  check();
  if (!rlsGucEnabled()) throw new Error("Usage reports require tenant database isolation");
  const client = await acquireTenantClient();
  let settled = false;
  let failed = false;
  let closing: Promise<void> | undefined;
  const abort = () => {
    if (settled || closing) return;
    closing = client.end().catch(() => { /* Normal cleanup discards this client. */ });
  };
  // Drizzle and all existing guards use this same client through tenantALS.
  // Guard every statement, including callback continuations after cancellation.
  const guardedClient: PoolClient = new Proxy(client, {
    get(target, property) {
      if (property === "query") return (...args: unknown[]) => {
        if (settled) throw new ClasspilotUsageBusyError();
        check();
        return Reflect.apply(target.query, target, args);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  options.signal.addEventListener("abort", abort, { once: true });
  try {
    check();
    await guardedClient.query(
      "SELECT set_config('app.is_super', 'off', false), set_config('app.school_id', $1, false)",
      [options.schoolId]
    );
    return await tenantALS.run({
      client: guardedClient,
      db: drizzle(guardedClient, { schema }),
      schoolId: options.schoolId,
      isSuper: false,
    }, async () => {
      const result = await callback();
      check();
      return result;
    });
  } catch (error) {
    failed = true;
    if (options.signal.aborted) throw options.signal.reason ?? new ClasspilotUsageBusyError();
    if (performance.now() >= options.deadlineAt) throw new ClasspilotUsageBusyError();
    throw error;
  } finally {
    settled = true;
    options.signal.removeEventListener("abort", abort);
    await closing;
    if (failed && !closing) {
      // A deadline may be noticed between statements, including between BEGIN
      // and COMMIT. Never return an open transaction with reset tenant GUCs.
      await client.query("ROLLBACK").catch(async () => { await client.end().catch(() => {}); });
    }
    await releaseTenantClient(client);
  }
}
