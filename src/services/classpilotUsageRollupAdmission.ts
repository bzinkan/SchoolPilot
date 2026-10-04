import type { ClasspilotUsageRollupClient, ClasspilotUsageRollupPool } from "./classpilotUsageRollup.js";

/**
 * End-to-end success budget, including queueing and cleanup. PostgreSQL keeps
 * its separate statement limit; late SQL/cleanup is awaited and fails this
 * budget rather than returning a client while it is still working.
 */
export const CLASSPILOT_USAGE_ROLLUP_OPERATION_MS = 60_000;

export class ClasspilotUsageRollupOperationError extends Error {
  constructor(readonly code: "USAGE_ROLLUP_BUSY" | "USAGE_ROLLUP_DEADLINE" | "USAGE_ROLLUP_CANCELLED") {
    super(code === "USAGE_ROLLUP_BUSY" ? "Usage rollup admission is full"
      : code === "USAGE_ROLLUP_CANCELLED" ? "Usage rollup was cancelled" : "Usage rollup operation deadline exceeded");
    this.name = "ClasspilotUsageRollupOperationError";
  }
}

export type ClasspilotUsageRollupClock = {
  now(): number;
  schedule(callback: () => void, milliseconds: number): () => void;
};
const clock: ClasspilotUsageRollupClock = {
  now: () => performance.now(),
  schedule(callback, milliseconds) {
    const timer = setTimeout(callback, milliseconds);
    return () => clearTimeout(timer);
  },
};

// pg_settings.setting is in milliseconds, unlike current_setting's display
// value (which may be "1min"). Never raise an inherited, stricter timeout.
export const CLASSPILOT_USAGE_ROLLUP_TIMEOUT_SQL = `SELECT set_config('statement_timeout',
  LEAST($1::integer, CASE WHEN setting::integer = 0 THEN $1::integer ELSE setting::integer END)::text, true)
FROM pg_settings WHERE name = 'statement_timeout'`;

export class ClasspilotUsageRollupBudget {
  private readonly deadline: number;
  constructor(private readonly timer: ClasspilotUsageRollupClock, private readonly signal?: AbortSignal) {
    this.deadline = timer.now() + CLASSPILOT_USAGE_ROLLUP_OPERATION_MS;
  }

  remainingMs(): number {
    if (this.signal?.aborted) throw new ClasspilotUsageRollupOperationError("USAGE_ROLLUP_CANCELLED");
    const remaining = Math.floor(this.deadline - this.timer.now());
    if (remaining <= 0) throw new ClasspilotUsageRollupOperationError("USAGE_ROLLUP_DEADLINE");
    return remaining;
  }

  async query(client: ClasspilotUsageRollupClient, text: string, values?: unknown[]) {
    const remaining = this.remainingMs();
    await client.query(CLASSPILOT_USAGE_ROLLUP_TIMEOUT_SQL, [remaining]);
    this.remainingMs();
    const result = await client.query(text, values);
    // A delayed Node timer or PostgreSQL cleanup cannot turn a late result into
    // success. The caller still owns this connection until cleanup completes.
    this.remainingMs();
    return result;
  }
}

type Permit = { budget: ClasspilotUsageRollupBudget; release(): void };
type Waiter = {
  budget: ClasspilotUsageRollupBudget;
  resolve(permit: Permit): void;
  reject(error: unknown): void;
  cleanup(): void;
};
type State = { active: boolean; waiting: Waiter | null };

/** One bulk writer plus one FIFO waiter per shared pool, before any checkout. */
export class ClasspilotUsageRollupAdmission {
  private readonly pools = new WeakMap<object, State>();
  constructor(private readonly timer: ClasspilotUsageRollupClock = clock) {}

  acquire(pool: object, signal?: AbortSignal): Promise<Permit> {
    const budget = new ClasspilotUsageRollupBudget(this.timer, signal);
    try { budget.remainingMs(); } catch (error) { return Promise.reject(error); }
    let state = this.pools.get(pool);
    if (!state) { state = { active: false, waiting: null }; this.pools.set(pool, state); }
    if (!state.active) {
      state.active = true;
      return Promise.resolve(this.permit(state, budget));
    }
    if (state.waiting) return Promise.reject(new ClasspilotUsageRollupOperationError("USAGE_ROLLUP_BUSY"));
    const owned = state;
    return new Promise((resolve, reject) => {
      let cancelTimer = () => {};
      const remove = (error: unknown) => {
        if (owned.waiting !== waiter) return;
        owned.waiting = null; waiter.cleanup(); reject(error);
      };
      const abort = () => remove(new ClasspilotUsageRollupOperationError("USAGE_ROLLUP_CANCELLED"));
      const waiter: Waiter = { budget, resolve, reject,
        cleanup: () => { cancelTimer(); signal?.removeEventListener("abort", abort); } };
      owned.waiting = waiter;
      signal?.addEventListener("abort", abort, { once: true });
      try {
        cancelTimer = this.timer.schedule(() => remove(new ClasspilotUsageRollupOperationError("USAGE_ROLLUP_DEADLINE")), budget.remainingMs());
        if (owned.waiting !== waiter) cancelTimer();
      } catch (error) { remove(error); }
    });
  }

  private permit(state: State, budget: ClasspilotUsageRollupBudget): Permit {
    let released = false;
    return { budget, release: () => {
      if (released) return;
      released = true;
      const next = state.waiting;
      state.waiting = null;
      if (!next) { state.active = false; return; }
      next.cleanup();
      try { next.budget.remainingMs(); }
      catch (error) { state.active = false; next.reject(error); return; }
      // Keep ownership reserved before resolving: a new caller cannot jump
      // ahead of the already queued operation at the promise boundary.
      next.resolve(this.permit(state, next.budget));
    } };
  }
}

const admission = new ClasspilotUsageRollupAdmission();

export async function withClasspilotUsageRollupOperation<T>(
  pool: ClasspilotUsageRollupPool,
  work: (client: ClasspilotUsageRollupClient, budget: ClasspilotUsageRollupBudget, markBroken: () => void) => Promise<T>,
  options: { signal?: AbortSignal; admission?: ClasspilotUsageRollupAdmission } = {},
): Promise<T> {
  const permit = await (options.admission ?? admission).acquire(pool, options.signal);
  let client: ClasspilotUsageRollupClient | undefined;
  let broken = false;
  let failed = false;
  try {
    permit.budget.remainingMs();
    // Await the real checkout. Racing and releasing a permit early would let a
    // late client escape ownership or overlap a second bulk writer.
    client = await pool.connect();
    permit.budget.remainingMs();
    return await work(client, permit.budget, () => { broken = true; });
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    let releaseFailed = false;
    let releaseError: unknown;
    try { client?.release(broken); }
    catch (error) { releaseFailed = true; releaseError = error; }
    finally {
      // Preserve the original failure. Only otherwise-successful work needs a
      // new deadline error after cleanup; a cleanup error also stays visible.
      try { if (!failed && !releaseFailed) permit.budget.remainingMs(); }
      finally { permit.release(); }
    }
    if (!failed && releaseFailed) throw releaseError;
  }
}
