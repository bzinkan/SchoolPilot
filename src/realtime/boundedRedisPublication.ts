/** Pub/sub acceptance is a transport milestone, never device receipt. Once an
 * operation is admitted, a timeout/disconnect has an unknown outcome: Redis may
 * already have executed it. Do not retry one-shot effects on that evidence. */
export type RedisPublicationOutcome<T> =
  | { status: "accepted"; value: T }
  | { status: "not_admitted"; reason: "not_ready" | "queue_full" | "circuit_open" | "shutdown" | "aborted" | "not_configured" }
  | { status: "unknown"; reason: "timeout" | "transport_lost" | "shutdown" | "aborted" };

export const REDIS_PUBLICATION_LIMITS: Readonly<Record<"readyMs" | "ordinaryMs" | "orderedMs" | "maxInFlight"
  | "rawWatchdogMs" | "circuitWindowMs" | "circuitFailures" | "initialBackoffMs" | "maxBackoffMs", number>> = Object.freeze({
  readyMs: 100, ordinaryMs: 250, orderedMs: 500, maxInFlight: 32,
  rawWatchdogMs: 2_000, circuitWindowMs: 10_000, circuitFailures: 3,
  initialBackoffMs: 1_000, maxBackoffMs: 10_000,
});

export interface RedisPublicationConnection {
  readonly isReady: boolean;
  connect(): Promise<unknown>;
  destroy(): unknown;
}
export type PublicationDiagnostic = "accepted" | "not_admitted" | "unknown" | "late_accepted"
  | "late_rejected" | "watchdog" | "circuit_open" | "recovered";
type Generation<C> = { client: C; ready: Promise<boolean>; retired: boolean;
  retirementListeners: Set<() => void>; timer?: ReturnType<typeof setTimeout> };

/** Owns a dedicated publisher. Its subscriber and coordination connections are
 * intentionally outside this lifecycle, so disposing a wedged generation never
 * tears down subscriptions or mixes delayed RESP replies with a new socket. */
export class BoundedRedisPublication<C extends RedisPublicationConnection> {
  private generation: Generation<C> | null = null;
  private stopped = false;
  private active = 0;
  private failures: number[] = [];
  private openUntil = 0;
  private backoffMs: number;
  private probeActive = false;
  private circuitVersion = 0;
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly options: {
    create(): C;
    onDiagnostic?(event: PublicationDiagnostic, durationMs?: number): void;
    now?: () => number;
    random?: () => number;
    limits?: Partial<typeof REDIS_PUBLICATION_LIMITS>;
  }) { this.backoffMs = options.limits?.initialBackoffMs ?? REDIS_PUBLICATION_LIMITS.initialBackoffMs; }

  private get limits() { return { ...REDIS_PUBLICATION_LIMITS, ...this.options.limits }; }
  private now() { return this.options.now?.() ?? performance.now(); }
  private report(event: PublicationDiagnostic, started?: number) {
    try { this.options.onDiagnostic?.(event, started === undefined ? undefined : Math.max(0, this.now() - started)); }
    catch { /* Observability cannot change a publication's disposition. */ }
  }
  snapshot() {
    return { active: this.active, pending: this.pending.size, circuitOpen: this.openUntil > this.now(),
      retirementWaiters: this.generation?.retirementListeners.size ?? 0,
      ready: !this.stopped && this.openUntil <= this.now() && !!this.generation?.client.isReady };
  }
  /** Startup-only, nonblocking TLS warmup. It owns no request/tenant lease and
   * the generation watchdog still bounds failed initialization. */
  warmup(): void {
    if (this.stopped || this.openUntil > this.now()) return;
    try { this.connection(); } catch { this.openCircuit(); }
  }
  private openCircuit() {
    this.circuitVersion++;
    const jitter = 0.8 + (this.options.random?.() ?? Math.random()) * 0.4;
    this.openUntil = this.now() + Math.min(this.limits.maxBackoffMs, this.backoffMs * jitter);
    this.backoffMs = Math.min(this.limits.maxBackoffMs, this.backoffMs * 2);
    this.report("circuit_open");
  }
  private noteTimeout() {
    const now = this.now();
    this.failures = this.failures.filter(at => now - at <= this.limits.circuitWindowMs);
    this.failures.push(now);
    if (this.failures.length >= this.limits.circuitFailures) this.openCircuit();
  }
  private retire(generation: Generation<C>) {
    if (generation.retired) return;
    generation.retired = true;
    for (const listener of generation.retirementListeners) listener();
    generation.retirementListeners.clear();
    if (generation.timer) clearTimeout(generation.timer);
    if (this.generation === generation) this.generation = null;
    try { generation.client.destroy(); } catch { /* Already closed is terminal too. */ }
  }
  private connection(): Generation<C> {
    if (this.generation) return this.generation;
    const client = this.options.create();
    const generation: Generation<C> = { client, ready: Promise.resolve(false), retired: false, retirementListeners: new Set() };
    this.generation = generation;
    generation.timer = setTimeout(() => {
      if (generation.retired || client.isReady) return;
      this.report("watchdog");
      this.retire(generation);
      this.openCircuit();
    }, this.limits.rawWatchdogMs);
    generation.timer.unref?.();
    generation.ready = Promise.resolve().then(() => client.connect()).then(() => {
      if (generation.timer) clearTimeout(generation.timer);
      return !this.stopped && !generation.retired && client.isReady;
    }, () => {
      this.retire(generation);
      return false;
    });
    return generation;
  }

  async publish<T>(operation: (client: C) => Promise<T>, options: {
    budgetMs?: number; signal?: AbortSignal;
  } = {}): Promise<RedisPublicationOutcome<T>> {
    const started = this.now();
    const budget = options.budgetMs ?? this.limits.ordinaryMs;
    const denied = (reason: Extract<RedisPublicationOutcome<T>, { status: "not_admitted" }>["reason"]): RedisPublicationOutcome<T> => {
      this.report("not_admitted", started); return { status: "not_admitted", reason };
    };
    if (this.stopped) return denied("shutdown");
    if (options.signal?.aborted) return denied("aborted");
    if (this.openUntil > started || (this.openUntil > 0 && this.probeActive)) return denied("circuit_open");
    if (this.active >= this.limits.maxInFlight) return denied("queue_full");
    const probing = this.openUntil > 0;
    const circuitVersion = this.circuitVersion;
    if (probing) this.probeActive = true;
    let generation: Generation<C>;
    try { generation = this.connection(); }
    catch { if (probing) this.probeActive = false; return denied("not_ready"); }
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    const ready = generation.client.isReady || await Promise.race([
      generation.ready,
      new Promise<boolean>(resolve => {
        readyTimer = setTimeout(() => resolve(false), Math.min(this.limits.readyMs, budget));
      }),
    ]);
    if (readyTimer) clearTimeout(readyTimer);
    if (!ready || generation.retired || !generation.client.isReady || this.stopped || options.signal?.aborted) {
      if (probing) this.probeActive = false;
      return denied(this.stopped ? "shutdown" : options.signal?.aborted ? "aborted" : "not_ready");
    }
    if (this.circuitVersion !== circuitVersion || (!probing && this.openUntil > 0)) {
      if (probing) this.probeActive = false;
      return denied("circuit_open");
    }
    // Recheck after asynchronous readiness: many callers may have joined it.
    if (this.active >= this.limits.maxInFlight) { if (probing) this.probeActive = false; return denied("queue_full"); }
    this.active++;
    let returned = false;
    let raw: Promise<T>;
    try { raw = operation(generation.client); }
    catch (error) { raw = Promise.reject(error); }
    const watchdog = setTimeout(() => {
      if (generation.retired) return;
      this.report("watchdog", started);
      this.retire(generation);
      this.openCircuit();
    }, this.limits.rawWatchdogMs);
    watchdog.unref?.();
    // Always observe the underlying promise, even after retiring its socket.
    // Retirement releases admission independently of library destroy behavior.
    const observed = raw.then<RedisPublicationOutcome<T>, RedisPublicationOutcome<T>>(value => {
      this.report(returned || generation.retired ? "late_accepted" : "accepted", started);
      // A delayed reply is useful disposition evidence, but cannot undo a
      // circuit opened by newer failures or stand in for its recovery probe.
      if (!returned && !generation.retired && this.circuitVersion === circuitVersion
        && (probing || this.openUntil === 0)) {
        if (probing) {
          this.report("recovered");
          // Ordinary successes do not erase other deadlines in the rolling
          // failure window. Only the designated recovery probe resets it.
          this.failures = [];
        }
        this.openUntil = 0;
        this.backoffMs = this.limits.initialBackoffMs;
      }
      return { status: "accepted", value };
    }, () => {
      this.report(returned || generation.retired ? "late_rejected" : "unknown", started);
      return { status: "unknown", reason: this.stopped ? "shutdown" : "transport_lost" };
    });
    let onRetirement!: () => void;
    const retirement = new Promise<RedisPublicationOutcome<T>>(resolve => {
      onRetirement = () => {
        if (!returned) this.report("unknown", started);
        resolve({ status: "unknown", reason: this.stopped ? "shutdown" : "transport_lost" });
      };
      if (generation.retired) onRetirement();
      else generation.retirementListeners.add(onRetirement);
    });
    const terminal = Promise.race([observed, retirement]).finally(() => {
      generation.retirementListeners.delete(onRetirement);
      clearTimeout(watchdog);
      this.active--;
      if (probing) this.probeActive = false;
      this.pending.delete(terminal);
    });
    this.pending.add(terminal);
    let callerTimer: ReturnType<typeof setTimeout> | undefined;
    let removeAbort: (() => void) | undefined;
    const timeout = new Promise<RedisPublicationOutcome<T>>(resolve => {
      let settled = false;
      const expire = () => {
        if (settled) return;
        settled = true;
        this.noteTimeout(); this.report("unknown", started);
        resolve({ status: "unknown", reason: "timeout" });
      };
      const abort = () => {
        if (settled) return;
        settled = true;
        this.report("unknown", started);
        resolve({ status: "unknown", reason: "aborted" });
      };
      callerTimer = setTimeout(expire, Math.max(0, budget - (this.now() - started)));
      if (options.signal) {
        options.signal.addEventListener("abort", abort, { once: true });
        removeAbort = () => options.signal!.removeEventListener("abort", abort);
        if (options.signal.aborted) abort();
      }
    });
    try { return await Promise.race([terminal, timeout]); }
    finally { returned = true; if (callerTimer) clearTimeout(callerTimer); removeAbort?.(); }
  }

  async dispose(): Promise<void> {
    this.stopped = true;
    if (this.generation) this.retire(this.generation);
    // destroy rejects real node-redis operations; a bounded wait also protects
    // teardown from injected clients or a library regression.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.allSettled([...this.pending]), new Promise<void>(resolve => {
      timer = setTimeout(resolve, this.limits.rawWatchdogMs);
    })]);
    if (timer) clearTimeout(timer);
  }
}
