import { AsyncResource } from "node:async_hooks";
import type { RequestHandler } from "express";
import { readClasspilotUsageModes } from "../config/classpilotUsageModes.js";
import { recordUsageCapacityCounter } from "../services/usageCapacityDiagnostics.js";

export const CLASSPILOT_HEARTBEAT_MAX_ACTIVE = 8;
export const CLASSPILOT_HEARTBEAT_MAX_QUEUED = 32;
export const CLASSPILOT_HEARTBEAT_WAIT_MS = 250;
type Runtime = {
  now(): number;
  setTimer(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
};
type Waiter = {
  resolve(release: () => void): void; reject(error: Error): void;
  deadline: number; signal?: AbortSignal; abort?: () => void;
  timer?: ReturnType<typeof setTimeout>; settled: boolean;
};
export class HeartbeatAdmissionError extends Error {
  constructor(readonly code: "aborted" | "full" | "expired") {
    super("ClassPilot heartbeat admission unavailable");
  }
}

/** No database ownership or identity cache: this bounds whole foreground operations. */
export function createHeartbeatAdmissionGate(runtime: Runtime = {
  now: () => performance.now(), setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: timer => clearTimeout(timer),
}) {
  let active = 0;
  const queue: Waiter[] = [];
  const cleanup = (waiter: Waiter) => {
    if (waiter.timer) runtime.clearTimer(waiter.timer);
    if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort);
  };
  const reject = (waiter: Waiter, code: HeartbeatAdmissionError["code"]) => {
    if (waiter.settled) return;
    waiter.settled = true;
    const index = queue.indexOf(waiter);
    if (index !== -1) queue.splice(index, 1);
    cleanup(waiter); waiter.reject(new HeartbeatAdmissionError(code));
  };
  const releasePermit = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true; active--;
      dispatch();
    };
  };
  const dispatch = () => {
    while (active < CLASSPILOT_HEARTBEAT_MAX_ACTIVE && queue.length) {
      const waiter = queue[0]!;
      // Timers may be delayed by the event loop. An expired waiter never starts SQL.
      if (waiter.signal?.aborted || runtime.now() >= waiter.deadline) {
        reject(waiter, waiter.signal?.aborted ? "aborted" : "expired"); continue;
      }
      queue.shift(); waiter.settled = true; cleanup(waiter);
      active++; waiter.resolve(releasePermit());
    }
  };
  return {
    snapshot: () => ({ active, queued: queue.length }),
    acquire(signal?: AbortSignal): Promise<() => void> {
      if (signal?.aborted) return Promise.reject(new HeartbeatAdmissionError("aborted"));
      if (active < CLASSPILOT_HEARTBEAT_MAX_ACTIVE && !queue.length) {
        active++; return Promise.resolve(releasePermit());
      }
      if (queue.length >= CLASSPILOT_HEARTBEAT_MAX_QUEUED) return Promise.reject(new HeartbeatAdmissionError("full"));
      return new Promise((resolve, rejectPromise) => {
        const waiter: Waiter = { resolve, reject: rejectPromise, signal, settled: false,
          deadline: runtime.now() + CLASSPILOT_HEARTBEAT_WAIT_MS };
        waiter.timer = runtime.setTimer(() => reject(waiter, "expired"), CLASSPILOT_HEARTBEAT_WAIT_MS);
        waiter.timer.unref?.();
        waiter.abort = () => reject(waiter, "aborted");
        signal?.addEventListener("abort", waiter.abort, { once: true });
        queue.push(waiter);
      });
    },
  };
}
export type HeartbeatAdmissionGate = ReturnType<typeof createHeartbeatAdmissionGate>;
const heartbeatAdmissionGate = createHeartbeatAdmissionGate();
export function heartbeatAdmissionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const modes = readClasspilotUsageModes(env);
  return modes.rollupMode === "on" || modes.digitalUsageMode === "on";
}
// Runtime configuration changes replace ECS processes. Match the main pool's
// startup selection, avoiding parsing the table inventory on every heartbeat.
const runtimeAdmissionEnabled = heartbeatAdmissionEnabled();

/**
 * Installed after JWT verification, before entitlement's first database checkout.
 * Known Promise-returning middleware and the handler keep their original order.
 * Response finish/close can stop a queued request, but never release running SQL.
 */
export function withClasspilotHeartbeatAdmission(stages: readonly RequestHandler[], options: {
  gate?: HeartbeatAdmissionGate; enabled?: () => boolean;
} = {}): RequestHandler {
  const gate = options.gate ?? heartbeatAdmissionGate;
  const enabled = options.enabled ?? (() => runtimeAdmissionEnabled);
  return async (req, res, next) => {
    if (!enabled()) {
      // Preserve Express's ordinary, response-independent middleware dispatch
      // when both modes are off; do not add a gate, timer or tenant owner.
      const advance = (index: number, error?: unknown): void => {
        if (error) { next(error); return; }
        const stage = stages[index];
        if (!stage) { next(); return; }
        try {
          const result: unknown = stage(req, res, error => advance(index + 1, error));
          if (result instanceof Promise) void result.catch(next);
        } catch (error) { next(error); }
      };
      advance(0); return;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    const resource = new AsyncResource("classpilot-heartbeat-owner");
    req.once("aborted", abort); res.once("close", abort);
    if (req.aborted || res.destroyed) abort();
    let release: (() => void) | undefined;
    let stageError: unknown;
    const invoke = async (index: number): Promise<void> => {
      if (controller.signal.aborted || index >= stages.length) return;
      let advanced = false, stopped = false, child: Promise<void> | undefined;
      let settle!: () => void;
      const outcome = new Promise<void>(resolve => { settle = resolve; });
      const stop = () => { stopped = true; settle(); };
      res.once("finish", stop); res.once("close", stop);
      let invocationError: unknown;
      try {
        const result: unknown = resource.runInAsyncScope(() => stages[index]!(req, res, error => {
          if (advanced || stopped) return;
          advanced = true;
          if (error) stageError = error;
          else child = resource.runInAsyncScope(() => invoke(index + 1));
          settle();
        }));
        // A body can be sent before a finally block finishes RESET/discard.
        await result;
        if (res.writableEnded || res.destroyed) stop();
        await outcome;
      } catch (error) {
        invocationError = error;
      } finally {
        // Even a middleware that throws after next() has started downstream
        // work cannot return the admission permit while that work still runs.
        try { await child; }
        catch (error) { invocationError ??= error; }
        res.off("finish", stop); res.off("close", stop);
      }
      if (invocationError) throw invocationError;
    };
    try {
      release = await gate.acquire(controller.signal);
      recordUsageCapacityCounter("admissionAdmitted", "heartbeat_middleware");
      await resource.runInAsyncScope(() => invoke(0));
      if (stageError) next(stageError);
    } catch (error) {
      if (error instanceof HeartbeatAdmissionError) {
        recordUsageCapacityCounter(error.code === "aborted" ? "admissionCancelled" : "admissionDenied", "heartbeat_middleware");
        if (!controller.signal.aborted && !res.destroyed) {
          res.setHeader("Retry-After", "1");
          res.status(503).json({ error: "Heartbeat service is busy; retry shortly", code: "CLASSPILOT_HEARTBEAT_BUSY" });
        }
      } else next(error);
    } finally {
      release?.(); req.off("aborted", abort); res.off("close", abort); resource.emitDestroy();
    }
  };
}
