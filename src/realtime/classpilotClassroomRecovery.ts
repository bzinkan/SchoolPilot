import type { RuntimePerformanceCounter } from "../services/runtimePerformanceMetrics.js";

export type ClasspilotRecoveryIdentity = {
  schoolId: string;
  studentId: string;
  studentSessionId: string;
  deviceId: string;
  generation: number;
  acceptedCapabilities: string[];
};
type FrozenIdentity = Readonly<Omit<ClasspilotRecoveryIdentity, "acceptedCapabilities">> & {
  readonly acceptedCapabilities: readonly string[];
};
type CancellationReason = "socket_closed" | "identity_superseded";
export type ClasspilotRecoveryStage = "authority" | "projection" | "serialization" | "send" | "commit";
type Outcome = "transmitted" | "denied" | "withheld";

/** Thrown inside authority work and handled only after its transaction unwinds. */
export class ClasspilotRecoveryCancelledError extends Error {
  constructor(readonly reason: CancellationReason) {
    super("Classroom recovery cancelled");
    this.name = "ClasspilotRecoveryCancelledError";
  }
}

export class ClasspilotRecoveryAttempt {
  stage: ClasspilotRecoveryStage = "authority";
  readonly writes: Promise<void>[] = [];
  readonly startedAt = performance.now();
  constructor(readonly identity: FrozenIdentity, readonly assertCurrent: () => void) {}

  /** Queue synchronously under authority; observe callbacks after COMMIT. */
  send(frame: unknown, sender: (payload: string, callback: (error?: Error) => void) => void): void {
    this.assertCurrent();
    this.stage = "serialization";
    const payload = JSON.stringify(frame);
    this.stage = "send";
    let delivered!: () => void, failed!: (error: Error) => void;
    const write = new Promise<void>((resolve, reject) => { delivered = resolve; failed = reject; });
    // Callbacks may fail before the transaction finishes. Own that rejection
    // immediately without confusing a write with committed/client-applied state.
    void write.catch(() => {});
    this.writes.push(write);
    try { sender(payload, error => { if (error) failed(error); else delivered(); }); }
    catch (error) { failed(error instanceof Error ? error : new Error("WebSocket send failed")); throw error; }
  }
}

type Options = {
  identity: () => ClasspilotRecoveryIdentity | undefined;
  open: () => boolean;
  accepting: () => boolean;
  counter: (name: RuntimePerformanceCounter) => void;
  timing: (durationMs: number) => void;
  failure: (error: unknown, stage: ClasspilotRecoveryStage) => void;
  track: (work: Promise<unknown>) => void;
};

/** One queued/running recovery per authenticated connection, without timers. */
export class ClasspilotClassroomRecoveryCoordinator {
  private pending: ClasspilotRecoveryAttempt | undefined;
  private closed = false;
  constructor(private readonly options: Options) {}

  invalidate(): void { this.closed = true; this.pending = undefined; }

  private assertCurrent(identity: FrozenIdentity): void {
    if (this.closed || !this.options.open() || !this.options.accepting()) {
      throw new ClasspilotRecoveryCancelledError("socket_closed");
    }
    const current = this.options.identity();
    if (!current || current.generation !== identity.generation || current.schoolId !== identity.schoolId
      || current.studentId !== identity.studentId || current.studentSessionId !== identity.studentSessionId
      || current.deviceId !== identity.deviceId) {
      throw new ClasspilotRecoveryCancelledError("identity_superseded");
    }
  }

  admit(): ClasspilotRecoveryAttempt | undefined {
    const identity = this.options.identity();
    if (!identity || this.closed || !this.options.open() || !this.options.accepting()) return undefined;
    if (this.pending) {
      try {
        this.pending.assertCurrent();
        this.options.counter("classroomRecoveryCoalesced");
        return undefined;
      } catch (error) { if (!(error instanceof ClasspilotRecoveryCancelledError)) throw error; }
    }
    const frozen = Object.freeze({ ...identity, acceptedCapabilities: Object.freeze([...identity.acceptedCapabilities]) });
    const attempt = new ClasspilotRecoveryAttempt(frozen, () => this.assertCurrent(frozen));
    this.pending = attempt;
    this.options.counter("classroomRecoveryAdmitted");
    return attempt;
  }

  release(attempt: ClasspilotRecoveryAttempt): void {
    if (this.pending === attempt) this.pending = undefined;
  }

  private failed(error: unknown, stage: ClasspilotRecoveryStage): void {
    this.options.counter(stage === "send" ? "classroomRecoveryTransportFailed" : "classroomRecoveryServiceFailed");
    this.options.failure(error, stage);
  }

  async run(attempt: ClasspilotRecoveryAttempt, work: (attempt: ClasspilotRecoveryAttempt) => Promise<Outcome | void>): Promise<void> {
    let outcome: Outcome | void;
    let committed = false;
    const reported = new Set<unknown>();
    try {
      attempt.assertCurrent();
      outcome = await work(attempt);
      committed = true;
      if (outcome === "denied") this.options.counter("classroomRecoveryDenied");
      else if (outcome === "withheld") this.options.counter("classroomRecoveryWithheld");
    } catch (error) {
      if (error instanceof ClasspilotRecoveryCancelledError) {
        this.options.counter(error.reason === "socket_closed"
          ? "classroomRecoveryCancelledClosed" : "classroomRecoveryCancelledSuperseded");
      } else {
        reported.add(error);
        this.failed(error, attempt.stage);
      }
    } finally {
      // Register even when COMMIT or a later send failed. Observe every callback
      // to settlement: Promise.all(writes) would release drain on the first error
      // while another transport write was still pending. Never hold the ACK queue.
      let writeFailed = false;
      this.options.track(Promise.all(attempt.writes.map(write => write.catch(error => {
        writeFailed = true;
        if (!reported.has(error)) { reported.add(error); this.failed(error, "send"); }
      }))).then(() => {
        if (committed && !writeFailed && outcome === "transmitted") this.options.counter("classroomRecoveryTransmitted");
      }));
      this.release(attempt);
      this.options.timing(performance.now() - attempt.startedAt);
    }
  }
}
