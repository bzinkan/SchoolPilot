import { safeErrorMetadata } from "../util/safeLogging.js";

export type ShutdownPool = {
  name: "main" | "session" | "scheduler" | "scheduler_lock";
  pool: { totalCount: number; idleCount: number; waitingCount: number; end(): Promise<void> };
};

export function snapshotShutdownPools(pools: ShutdownPool[]) {
  return pools.map(({ name, pool }) => ({ name, total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }));
}

/** One monotonic deadline for both entrypoints. In particular, closing a pool
 * cannot race a producer's final committed lifecycle notification on a clean
 * drain. A deadline is reported as an incomplete shutdown, never success. */
export async function drainService(options: {
  stopIntake(): void;
  drainProducers(): Promise<void>;
  sealBackground(): void;
  drainBackground(): Promise<void>;
  cancelBackground(): void;
  disposeMonitor(timeoutMs: number): Promise<void>;
  stopMetrics(): void;
  pools: ShutdownPool[];
  snapshot(): unknown;
  report?(event: Record<string, unknown>): void;
  timeoutMs?: number;
  cleanupReserveMs?: number;
  onPhase?: (phase: string) => void;
}): Promise<{ completed: boolean; timedOut: boolean }> {
  const started = performance.now();
  const deadline = started + (options.timeoutMs ?? 15_000);
  const reserve = options.cleanupReserveMs ?? 4_000;
  let completed = true;
  let timedOut = false;
  const ended = new Set<string>();
  const report = options.report ?? ((event) => console.log(JSON.stringify(event)));
  const poolSnapshot = () => options.pools.map(({ name, pool }) => ({
    name, ended: ended.has(name), total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount,
  }));
  const phase = async (name: string, work: () => Promise<void>, phaseDeadline: number) => {
    options.onPhase?.(name);
    const remaining = phaseDeadline - performance.now();
    if (remaining <= 0) {
      completed = false;
      timedOut = true;
      report({ event: "shutdown_phase_timeout", phase: name, pools: poolSnapshot(), pending: options.snapshot() });
      return false;
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve().then(work).then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), remaining); }),
      ]);
      if (!result) {
        completed = false;
        timedOut = true;
        report({ event: "shutdown_phase_timeout", phase: name, pools: poolSnapshot(), pending: options.snapshot() });
      }
      return result;
    } catch (error) {
      completed = false;
      report({ event: "shutdown_phase_failed", phase: name, ...safeErrorMetadata(error), pools: poolSnapshot() });
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  options.stopIntake();
  const producersComplete = await phase("producers", options.drainProducers, deadline - reserve);
  // Producers may enqueue their final post-commit work until this point.
  options.sealBackground();
  if (!producersComplete) options.cancelBackground();
  const backgroundComplete = await phase("background", options.drainBackground, deadline - reserve);
  if (!backgroundComplete) options.cancelBackground();
  await phase("error_monitor", () => options.disposeMonitor(Math.max(1, reserve / 4)), deadline - reserve * 3 / 4);
  options.stopMetrics();
  await phase("database_pools", async () => {
    await Promise.all(options.pools.map(async ({ name, pool }) => {
      try { await pool.end(); ended.add(name); } catch (error) {
        completed = false;
        report({ event: "shutdown_pool_failed", pool: name, ...safeErrorMetadata(error) });
      }
    }));
  }, deadline);
  report({ event: "shutdown_completed", completed, timedOut, elapsedMs: Math.round(performance.now() - started), pools: poolSnapshot() });
  options.onPhase?.("completed");
  return { completed, timedOut };
}
