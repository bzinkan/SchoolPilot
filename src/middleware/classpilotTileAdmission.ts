import type { RequestHandler, Response } from "express";
import { databasePoolLimits } from "../config/databasePools.js";
import { recordHeartbeatHotPathCounter } from "../services/heartbeatHotPathMetrics.js";

export function classPilotTileMaxActiveForPool(mainPoolLimit: number): number {
  if (!Number.isSafeInteger(mainPoolLimit) || mainPoolLimit <= 0) {
    throw new RangeError("mainPoolLimit must be a positive safe integer");
  }
  // Teacher tiles may use at most 60% of a task's main pool. Heartbeat auth,
  // commands, health work, and other API traffic retain the remaining slots.
  return Math.max(1, Math.min(10, Math.floor(mainPoolLimit * 0.6)));
}

export const CLASSPILOT_TILE_MAX_ACTIVE = classPilotTileMaxActiveForPool(
  // This middleware is API-only. Derive its limit from the API pool even when
  // imported by a test or utility process whose scheduler flag is enabled.
  databasePoolLimits({ ...process.env, SCHEDULER_ENABLED: "false" }).main
);
export const CLASSPILOT_TILE_MAX_QUEUED = 1_024;
export const CLASSPILOT_TILE_WAIT_TIMEOUT_MS = 750;

type AdmissionWaiter = {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  timer: NodeJS.Timeout;
  abort?: () => void;
  settled: boolean;
  queuedAt: number;
};

export class AdmissionGateError extends Error {
  readonly code: "admission_aborted" | "admission_queue_full" | "admission_timeout";

  constructor(
    code: AdmissionGateError["code"],
    message: string
  ) {
    super(message);
    this.name = "AdmissionGateError";
    this.code = code;
  }
}

export type AdmissionGateSnapshot = {
  active: number;
  queued: number;
  admitted: number;
  aborted: number;
  queueFull: number;
  timedOut: number;
  maxObservedActive: number;
  maxObservedQueued: number;
  maxWaitMs: number;
};

export type AdmissionGate = {
  acquire(signal?: AbortSignal): Promise<() => void>;
  snapshot(options?: { resetCounters?: boolean }): AdmissionGateSnapshot;
};

export function createAdmissionGate(options: {
  maxActive: number;
  maxQueued: number;
  waitTimeoutMs: number;
  now?: () => number;
}): AdmissionGate {
  const { maxActive, maxQueued, waitTimeoutMs } = options;
  const now = options.now ?? Date.now;
  for (const [name, value] of Object.entries({ maxActive, maxQueued, waitTimeoutMs })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }

  let active = 0;
  const queue: AdmissionWaiter[] = [];
  let counters = {
    admitted: 0,
    aborted: 0,
    queueFull: 0,
    timedOut: 0,
    maxObservedActive: 0,
    maxObservedQueued: 0,
    maxWaitMs: 0,
  };

  const remove = (waiter: AdmissionWaiter): boolean => {
    const index = queue.indexOf(waiter);
    if (index < 0) return false;
    queue.splice(index, 1);
    return true;
  };

  const cleanup = (waiter: AdmissionWaiter): void => {
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.abort) {
      waiter.signal.removeEventListener("abort", waiter.abort);
    }
  };

  const dispatch = (): void => {
    while (active < maxActive && queue.length > 0) {
      const waiter = queue.shift()!;
      if (waiter.settled) continue;
      waiter.settled = true;
      cleanup(waiter);
      active += 1;
      counters.admitted += 1;
      counters.maxObservedActive = Math.max(counters.maxObservedActive, active);
      counters.maxWaitMs = Math.max(counters.maxWaitMs, Math.max(0, now() - waiter.queuedAt));
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        active = Math.max(0, active - 1);
        dispatch();
      });
    }
  };

  const acquire = (signal?: AbortSignal): Promise<() => void> => {
    if (signal?.aborted) {
      counters.aborted += 1;
      return Promise.reject(new AdmissionGateError("admission_aborted", "Request was aborted"));
    }

    if (active < maxActive && queue.length === 0) {
      active += 1;
      counters.admitted += 1;
      counters.maxObservedActive = Math.max(counters.maxObservedActive, active);
      let released = false;
      return Promise.resolve(() => {
        if (released) return;
        released = true;
        active = Math.max(0, active - 1);
        dispatch();
      });
    }

    if (queue.length >= maxQueued) {
      counters.queueFull += 1;
      return Promise.reject(
        new AdmissionGateError("admission_queue_full", "ClassPilot tile queue is full")
      );
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: AdmissionWaiter = {
        resolve,
        reject,
        signal,
        timer: undefined as unknown as NodeJS.Timeout,
        settled: false,
        queuedAt: now(),
      };
      waiter.timer = setTimeout(() => {
        if (waiter.settled || !remove(waiter)) return;
        waiter.settled = true;
        cleanup(waiter);
        counters.timedOut += 1;
        reject(new AdmissionGateError("admission_timeout", "ClassPilot tile queue timed out"));
      }, waitTimeoutMs);
      waiter.timer.unref?.();
      if (signal) {
        waiter.abort = () => {
          if (waiter.settled || !remove(waiter)) return;
          waiter.settled = true;
          cleanup(waiter);
          counters.aborted += 1;
          reject(new AdmissionGateError("admission_aborted", "Request was aborted"));
        };
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      queue.push(waiter);
      counters.maxObservedQueued = Math.max(counters.maxObservedQueued, queue.length);
    });
  };

  return {
    acquire,
    snapshot(options = {}) {
      const snapshot = { active, queued: queue.length, ...counters };
      if (options.resetCounters) {
        counters = {
          admitted: 0,
          aborted: 0,
          queueFull: 0,
          timedOut: 0,
          maxObservedActive: active,
          maxObservedQueued: queue.length,
          maxWaitMs: 0,
        };
      }
      return snapshot;
    },
  };
}

const tileAdmissionGate = createAdmissionGate({
  maxActive: CLASSPILOT_TILE_MAX_ACTIVE,
  maxQueued: CLASSPILOT_TILE_MAX_QUEUED,
  waitTimeoutMs: CLASSPILOT_TILE_WAIT_TIMEOUT_MS,
});

const admissionLogTimer = setInterval(() => {
  const snapshot = tileAdmissionGate.snapshot({ resetCounters: true });
  if (
    snapshot.admitted === 0 &&
    snapshot.aborted === 0 &&
    snapshot.queueFull === 0 &&
    snapshot.timedOut === 0
  ) {
    return;
  }
  console.log(JSON.stringify({
    event: "classpilot_tile_admission_summary",
    intervalSeconds: 60,
    ...snapshot,
  }));
}, 60_000);
admissionLogTimer.unref?.();

const TILE_ADMISSION_RELEASE_LOCAL = "classPilotTileAdmissionRelease";

export function releaseClassPilotTileAdmission(res: Response): void {
  const release = res.locals[TILE_ADMISSION_RELEASE_LOCAL];
  if (typeof release === "function") release();
}

export const classPilotTileAdmission: RequestHandler = async (req, res, next) => {
  const requestPath = req.path ?? "";
  const routeFamily = requestPath.startsWith("/device/screenshot/") ||
    requestPath === "/tiles/screenshots"
    ? "screenshot"
    : requestPath.startsWith("/heartbeats/") ||
        requestPath === "/tiles/history"
      ? "history"
      : undefined;
  const controller = new AbortController();
  const abortQueuedRequest = () => controller.abort();
  req.once("aborted", abortQueuedRequest);
  res.once("close", abortQueuedRequest);

  let release: (() => void) | undefined;
  try {
    release = await tileAdmissionGate.acquire(controller.signal);
  } catch (error) {
    req.removeListener("aborted", abortQueuedRequest);
    res.removeListener("close", abortQueuedRequest);
    if (error instanceof AdmissionGateError && error.code === "admission_aborted") {
      return;
    }
    if (error instanceof AdmissionGateError) {
      if (routeFamily === "screenshot") {
        recordHeartbeatHotPathCounter("tileAdmissionRejectedScreenshot");
      } else if (routeFamily === "history") {
        recordHeartbeatHotPathCounter("tileAdmissionRejectedHistory");
      }
      res.setHeader("Retry-After", "1");
      return res.status(503).json({
        error: "ClassPilot tile service is busy; retry shortly",
        code: error.code,
      });
    }
    return next(error);
  }

  if (routeFamily === "screenshot") {
    recordHeartbeatHotPathCounter("tileAdmissionScreenshot");
  } else if (routeFamily === "history") {
    recordHeartbeatHotPathCounter("tileAdmissionHistory");
  }

  // The response can close in the narrow interval between gate dispatch and
  // this continuation. In that case the earlier close listener has already
  // aborted the controller, so release immediately instead of waiting for a
  // finish/close event that has already happened.
  if (controller.signal.aborted || req.aborted || res.destroyed) {
    req.removeListener("aborted", abortQueuedRequest);
    res.removeListener("close", abortQueuedRequest);
    release();
    return;
  }

  let released = false;
  const finish = () => {
    if (released) return;
    released = true;
    if (res.locals[TILE_ADMISSION_RELEASE_LOCAL] === finish) {
      delete res.locals[TILE_ADMISSION_RELEASE_LOCAL];
    }
    req.removeListener("aborted", abortQueuedRequest);
    res.removeListener("finish", finish);
    res.removeListener("close", finish);
    res.removeListener("close", abortQueuedRequest);
    release?.();
  };
  res.locals[TILE_ADMISSION_RELEASE_LOCAL] = finish;
  res.once("finish", finish);
  res.once("close", finish);

  try {
    next();
  } catch (error) {
    finish();
    next(error);
  }
};
