import { recordUsageCapacityCounter, recordUsageCapacityTiming } from "./usageCapacityDiagnostics.js";

/** Task-local report admission: queued work never owns a database connection. */
export const CLASSPILOT_USAGE_REPORT_DEADLINE_MS = 20_000;
export const CLASSPILOT_USAGE_REPORT_BUSY_CODE = "CLASSPILOT_USAGE_BUSY";

export class ClasspilotUsageBusyError extends Error {
  readonly code = CLASSPILOT_USAGE_REPORT_BUSY_CODE;
  readonly status = 503;
  constructor() {
    super("Usage reports are busy. Try again shortly.");
    this.name = "ClasspilotUsageBusyError";
  }
}

type Waiter = {
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal;
  onAbort: () => void;
};

export class ClasspilotUsageAdmission {
  private readonly queues = new Map<string, Waiter[]>();
  private readonly activeSchools = new Set<string>();
  private readonly order: string[] = [];
  private queued = 0;
  private peakActive = 0;
  private peakQueued = 0;
  private admitted = 0;
  private denied = 0;
  private cancelled = 0;

  snapshot() {
    return { active: this.activeSchools.size, queued: this.queued };
  }

  diagnostics() {
    return { ...this.snapshot(), peakActive: this.peakActive, peakQueued: this.peakQueued,
      admitted: this.admitted, denied: this.denied, cancelled: this.cancelled };
  }

  resetDiagnostics() {
    this.peakActive = this.activeSchools.size;
    this.peakQueued = this.queued;
    this.admitted = 0;
    this.denied = 0;
    this.cancelled = 0;
  }

  acquire(schoolId: string, signal: AbortSignal): Promise<() => void> {
    const started = performance.now();
    const timing = () => recordUsageCapacityTiming("operationMs", performance.now() - started, "usage_report_admission");
    if (signal.aborted) {
      this.cancelled++;
      recordUsageCapacityCounter("admissionCancelled", "usage_report_admission"); timing();
      return Promise.reject(signal.reason ?? new ClasspilotUsageBusyError());
    }
    const queue = this.queues.get(schoolId);
    if (this.queued >= 32 || (queue?.length ?? 0) >= 16) {
      this.denied++;
      recordUsageCapacityCounter("admissionDenied", "usage_report_admission"); timing();
      return Promise.reject(new ClasspilotUsageBusyError());
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve: release => { timing(); resolve(release); }, reject, signal,
        onAbort: () => {
          const waiting = this.queues.get(schoolId);
          const index = waiting?.indexOf(waiter) ?? -1;
          if (index < 0) return;
          waiting!.splice(index, 1);
          this.queued--;
          this.cancelled++;
          recordUsageCapacityCounter("admissionCancelled", "usage_report_admission"); timing();
          this.removeEmptySchool(schoolId);
          signal.removeEventListener("abort", waiter.onAbort);
          reject(signal.reason ?? new ClasspilotUsageBusyError());
          this.dispatch();
        },
      };
      if (!queue) {
        this.queues.set(schoolId, [waiter]);
        this.order.push(schoolId);
      } else queue.push(waiter);
      this.queued++;
      this.peakQueued = Math.max(this.peakQueued, this.queued);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.dispatch();
    });
  }

  private removeEmptySchool(schoolId: string) {
    if (this.queues.get(schoolId)?.length) return;
    this.queues.delete(schoolId);
    const index = this.order.indexOf(schoolId);
    if (index >= 0) this.order.splice(index, 1);
  }

  private dispatch() {
    while (this.activeSchools.size < 2) {
      const index = this.order.findIndex((school) => !this.activeSchools.has(school));
      if (index < 0) return;
      const schoolId = this.order.splice(index, 1)[0]!;
      const waiter = this.queues.get(schoolId)!.shift()!;
      this.queued--;
      if (this.queues.get(schoolId)!.length) this.order.push(schoolId);
      else this.queues.delete(schoolId);
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      this.activeSchools.add(schoolId);
      this.admitted++;
      this.peakActive = Math.max(this.peakActive, this.activeSchools.size);
      recordUsageCapacityCounter("admissionAdmitted", "usage_report_admission");
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.activeSchools.delete(schoolId);
        this.dispatch();
      });
    }
  }
}

export const classpilotUsageAdmission = new ClasspilotUsageAdmission();
