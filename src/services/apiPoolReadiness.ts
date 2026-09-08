export const API_POOL_READINESS_CONFIG = Object.freeze({
  // Shorter than the main pool's 5s checkout timeout, so even pre-auth/global
  // database waiters are observed without wrapping pg.connect's overloads.
  sampleIntervalMs: 1_000,
  stallThresholdMs: 60_000,
  confirmationIntervalMs: 10_000,
  confirmationCount: 2,
});

export type ReadinessPoolCounts = {
  total: number;
  idle: number;
  waiting: number;
  max: number;
};

type ReadinessReason = "starting" | "ready" | "pool_stalled" | "draining";
export type PoolReadinessTransition = {
  state: "ready" | "pool_stalled" | "probe_deferred";
  pool: ReadinessPoolCounts;
  stalledForMs: number;
};

/**
 * Task-local admission decision. Counts alone never establish failure: a full
 * pool must stop making progress under demand, while an independent existing
 * pool confirms that PostgreSQL can still answer. No query runs on HTTP probes.
 */
export class ApiPoolReadiness {
  private active = false;
  private reason: ReadinessReason = "starting";
  private generation = 0;
  private saturatedSince: number | null = null;
  private demandObserved = false;
  private confirmations = 0;
  private lastConfirmationAt: number | null = null;
  private lastProbeAt: number | null = null;
  private pending: Promise<void> | null = null;
  private readonly now: () => number;

  constructor(private readonly dependencies: {
    now?: () => number;
    readPool: () => ReadinessPoolCounts;
    probeDatabase: () => Promise<boolean>;
    onTransition?: (event: PoolReadinessTransition) => void;
  }) {
    this.now = dependencies.now ?? (() => performance.now());
  }

  start(): void {
    if (this.active || this.reason === "draining") return;
    this.active = true;
    this.reason = "ready";
    this.resetCandidate();
  }

  status(): { ready: boolean; reason: ReadinessReason } {
    return { ready: this.reason === "ready", reason: this.reason };
  }

  recordProgress(): void {
    if (!this.active) return;
    const recovering = this.reason === "pool_stalled";
    this.resetCandidate();
    this.reason = "ready";
    // pg emits release before updating idleCount; defer snapshots to sample().
    if (recovering) this.recoveryPending = true;
  }

  private recoveryPending = false;

  recordAcquisitionFailure(): void {
    if (this.active) this.demandObserved = true;
  }

  private resetCandidate(): void {
    this.generation += 1;
    this.saturatedSince = null;
    this.demandObserved = false;
    this.confirmations = 0;
    this.lastConfirmationAt = null;
    this.lastProbeAt = null;
  }

  private full(pool: ReadinessPoolCounts): boolean {
    return Number.isInteger(pool.max) && pool.max > 0 &&
      pool.total >= pool.max && pool.idle === 0;
  }

  private emit(state: PoolReadinessTransition["state"], pool: ReadinessPoolCounts): void {
    this.dependencies.onTransition?.({
      state,
      pool,
      stalledForMs: this.saturatedSince === null ? 0 : this.now() - this.saturatedSince,
    });
  }

  async sample(): Promise<void> {
    if (!this.active) return;
    const pool = this.dependencies.readPool();
    if (this.recoveryPending) {
      this.recoveryPending = false;
      this.emit("ready", pool);
    }
    if (!this.full(pool)) {
      const recovering = this.reason === "pool_stalled";
      this.resetCandidate();
      this.reason = "ready";
      if (recovering) this.emit("ready", pool);
      return;
    }
    const now = this.now();
    this.saturatedSince ??= now;
    if (pool.waiting > 0) this.demandObserved = true;
    if (this.pending) return this.pending;
    if (this.reason === "pool_stalled" || !this.demandObserved ||
        now - this.saturatedSince < API_POOL_READINESS_CONFIG.stallThresholdMs ||
        (this.lastProbeAt !== null &&
          now - this.lastProbeAt < API_POOL_READINESS_CONFIG.confirmationIntervalMs) ||
        (this.lastConfirmationAt !== null &&
          now - this.lastConfirmationAt < API_POOL_READINESS_CONFIG.confirmationIntervalMs)) return;

    this.lastProbeAt = now;
    const generation = this.generation;
    const attempt = this.confirm(generation);
    this.pending = attempt;
    try {
      await attempt;
    } finally {
      if (this.pending === attempt) this.pending = null;
    }
  }

  private async confirm(generation: number): Promise<void> {
    let databaseReachable = false;
    try {
      databaseReachable = await this.dependencies.probeDatabase();
    } catch {
      // Failure cannot distinguish shared database trouble from a local stall.
    }
    if (!this.active || this.generation !== generation) return;
    const pool = this.dependencies.readPool();
    if (!this.full(pool)) {
      this.resetCandidate();
      return;
    }
    if (!databaseReachable) {
      this.confirmations = 0;
      this.lastConfirmationAt = null;
      this.emit("probe_deferred", pool);
      return;
    }
    this.confirmations += 1;
    this.lastConfirmationAt = this.now();
    if (this.confirmations >= API_POOL_READINESS_CONFIG.confirmationCount) {
      this.reason = "pool_stalled";
      this.emit("pool_stalled", pool);
    }
  }

  stop(): void {
    this.active = false;
    this.reason = "draining";
    this.resetCandidate();
  }

  async drain(): Promise<void> {
    await this.pending;
  }
}
