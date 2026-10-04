import type { RequestHandler, Response } from "express";
import { ClasspilotUsageBusyError, CLASSPILOT_USAGE_REPORT_DEADLINE_MS } from "./classpilotUsageAdmission.js";
import { readClasspilotDigitalUsageMode } from "../config/classpilotUsageModes.js";

type UsageRequest = {
  controller: AbortController;
  deadlineAt: number;
  sessionSchoolVersion?: number;
  sessionSchoolId?: string | null;
  sessionCaptured: boolean;
  check: () => void;
  sendBusy: () => void;
};
const requests = new WeakMap<Response, UsageRequest>();
const managedResponses = new WeakSet<Response>();
const MAX_USAGE_RESPONSE_BYTES = 2 * 1024 * 1024;

/** JSON/CSV is bounded. Defer transport writes until express-session's save
 * callback ends the response, so a slow save cannot expose a partial 200. */
function usageResponseTransport(res: Response, stopped: () => boolean, expired: () => boolean, overflow: () => void) {
  const rawEnd = res.end, rawWriteHead = res.writeHead;
  const rawSetHeader = res.setHeader, rawRemoveHeader = res.removeHeader;
  let chunks: Buffer[] = [], size = 0;
  let head: Parameters<Response["writeHead"]> | undefined;
  const append = (chunk: unknown, encoding?: unknown) => {
    if (chunk === undefined || chunk === null) return true;
    const bytes = Buffer.isBuffer(chunk) ? chunk
      : Buffer.from(String(chunk), typeof encoding === "string" ? encoding as BufferEncoding : "utf8");
    if (size + bytes.length > MAX_USAGE_RESPONSE_BYTES) { overflow(); return false; }
    chunks.push(bytes); size += bytes.length; return true;
  };
  res.setHeader = function (...args: Parameters<Response["setHeader"]>) {
    return stopped() ? res : Reflect.apply(rawSetHeader, res, args);
  };
  res.removeHeader = function (...args: Parameters<Response["removeHeader"]>) {
    if (!stopped()) Reflect.apply(rawRemoveHeader, res, args);
  };
  res.writeHead = function (...args: Parameters<Response["writeHead"]>) {
    if (!stopped()) { head = args; res.statusCode = args[0]; }
    return res;
  } as Response["writeHead"];
  res.flushHeaders = () => {};
  res.write = function (chunk: unknown, encoding?: unknown, callback?: unknown) {
    if (stopped() || !append(chunk, encoding)) return false;
    const done = typeof encoding === "function" ? encoding : callback;
    if (typeof done === "function") queueMicrotask(() => done());
    return true;
  } as Response["write"];
  res.end = function (chunk?: unknown, encoding?: unknown, callback?: unknown) {
    if (!stopped() && expired()) { overflow(); return res; }
    if (stopped() || !append(typeof chunk === "function" ? undefined : chunk, encoding)) return res;
    const body = Buffer.concat(chunks, size); chunks = []; size = 0;
    // Run session's onHeaders once for ordinary responses, including a store
    // whose save callback completes synchronously. Busy intentionally skips it.
    if (!head) res.writeHead(res.statusCode);
    if (expired()) { overflow(); return res; }
    Reflect.apply(rawWriteHead, res, head ?? [res.statusCode]);
    const done = typeof chunk === "function" ? chunk : typeof encoding === "function" ? encoding : callback;
    return Reflect.apply(rawEnd, res, [body, ...(typeof done === "function" ? [done] : [])]);
  } as Response["end"];
  return () => {
    chunks = []; size = 0;
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) { res.destroy(); return; }
    for (const key of ["Content-Length", "Content-Disposition", "ETag", "Set-Cookie", "Content-Encoding"]) {
      Reflect.apply(rawRemoveHeader, res, [key]);
    }
    const error = new ClasspilotUsageBusyError();
    const body = Buffer.from(JSON.stringify({ error: error.message, code: error.code }));
    const headers = {
      "Content-Type": "application/json; charset=utf-8", "Content-Length": String(body.length),
      "Cache-Control": "no-store, private", "Retry-After": "1",
    };
    for (const [key, value] of Object.entries(headers)) Reflect.apply(rawSetHeader, res, [key, value]);
    Reflect.apply(rawWriteHead, res, [error.status]);
    Reflect.apply(rawEnd, res, [body]);
  };
}

export function classpilotUsageRequest(res: Response): UsageRequest {
  const request = requests.get(res);
  if (!request) throw new Error("Usage request deadline is missing");
  return request;
}

/** Start before authentication, and clean up even when an auth guard denies. */
export function beginClasspilotUsageRequest(deadlineMs = CLASSPILOT_USAGE_REPORT_DEADLINE_MS, beforeSession = false): RequestHandler {
  return (req, res, next) => {
    const existing = requests.get(res);
    if (existing) {
      if (!beforeSession && !existing.sessionCaptured) {
        existing.sessionSchoolVersion = req.session?.schoolSessionVersion;
        existing.sessionSchoolId = req.session?.schoolId;
        existing.sessionCaptured = true;
      }
      return existing.controller.signal.aborted || res.writableEnded || res.destroyed ? undefined : next();
    }
    const controller = new AbortController();
    const deadlineAt = performance.now() + deadlineMs;
    let busyTransport: (() => void) | undefined;
    const sendBusy = () => {
      if (busyTransport) return busyTransport();
      if (res.headersSent || res.destroyed || res.writableEnded) return;
      const error = new ClasspilotUsageBusyError();
      res.set({ "Cache-Control": "no-store, private", "Retry-After": "1" });
      res.status(error.status).json({ error: error.message, code: error.code });
    };
    if (beforeSession) busyTransport = usageResponseTransport(res,
      () => controller.signal.aborted || res.destroyed || res.writableEnded,
      () => performance.now() >= deadlineAt,
      () => { controller.abort(new ClasspilotUsageBusyError()); sendBusy(); });
    const timeout = setTimeout(() => {
      controller.abort(new ClasspilotUsageBusyError());
      sendBusy();
    }, deadlineMs);
    timeout.unref?.();
    const cleanup = () => {
      clearTimeout(timeout);
      res.off("finish", cleanup);
      res.off("close", disconnected);
      requests.delete(res);
    };
    const disconnected = () => {
      controller.abort(new ClasspilotUsageBusyError());
      cleanup();
    };
    requests.set(res, {
      controller, deadlineAt, sessionCaptured: !beforeSession,
      sessionSchoolVersion: beforeSession ? undefined : req.session?.schoolSessionVersion,
      sessionSchoolId: beforeSession ? undefined : req.session?.schoolId, sendBusy,
      check() {
        if (controller.signal.aborted) throw controller.signal.reason ?? new ClasspilotUsageBusyError();
        if (performance.now() >= deadlineAt) {
          controller.abort(new ClasspilotUsageBusyError());
          throw controller.signal.reason;
        }
      },
    });
    managedResponses.add(res);
    res.once("finish", cleanup);
    res.once("close", disconnected);
    next();
  };
}

/** Match the actual case-insensitive GET route (Express also serves HEAD).
 * Dark/unadmitted Usage keeps the ordinary unknown-route session semantics. */
export function beginClasspilotUsageIngress(): RequestHandler {
  const begin = beginClasspilotUsageRequest(CLASSPILOT_USAGE_REPORT_DEADLINE_MS, true);
  return (req, res, next) => {
    if (!["GET", "HEAD"].includes(req.method.toUpperCase())
      || !/^\/api\/classpilot\/admin\/usage\/?$/i.test(req.path)
      || readClasspilotDigitalUsageMode() !== "on") return next();
    return begin(req, res, next);
  };
}

/** Global middleware receives the real response, including session internals.
 * Only requests with an ingress deadline acquire this continuation fence. */
export function guardClasspilotUsageIngressMiddleware(middleware: RequestHandler): RequestHandler {
  return (req, res, next) => {
    const scope = requests.get(res);
    if (!scope) return managedResponses.has(res) ? undefined : middleware(req, res, next);
    const stopped = () => scope.controller.signal.aborted || res.destroyed || res.writableEnded;
    if (stopped()) return;
    try {
      const result = middleware(req, res, error => { if (!stopped()) next(error); });
      void Promise.resolve(result).catch(error => { if (!stopped()) next(error); });
    } catch (error) { if (!stopped()) next(error); }
  };
}

/**
 * Existing auth guards may complete after an HTTP deadline. Keep their reads
 * and credential/session invalidation behavior, but suppress any late response
 * or next() after the deadline has already completed the request.
 */
export function guardClasspilotUsageMiddleware(middleware: RequestHandler): RequestHandler {
  return (req, res, next) => {
    const scope = classpilotUsageRequest(res);
    const stopped = () => scope.controller.signal.aborted || res.destroyed || res.writableEnded;
    if (stopped()) return;
    const writes = new Set<PropertyKey>(["status", "json", "send", "end", "set", "header", "setHeader", "removeHeader", "clearCookie", "cookie"]);
    const guarded: Response = new Proxy(res, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        // Express's `app` is itself callable and carries .get/.set; it is a
        // value, not a response method. Only wrap response-writing methods.
        if (typeof value !== "function" || !writes.has(property)) return value;
        return (...args: unknown[]) => {
          if (writes.has(property) && stopped()) return guarded;
          // Node's outgoing-message identity must stay the actual response
          // (the socket compares it by identity); Express methods may chain
          // through the facade so a late status().json() stays fenced.
          const receiver = property === "end" || property === "setHeader" || property === "removeHeader"
            ? target : guarded;
          return Reflect.apply(value, receiver, args);
        };
      },
    });
    try {
      const result = middleware(req, guarded, error => { if (!stopped()) next(error); });
      void Promise.resolve(result).catch(error => { if (!stopped()) next(error); });
    } catch (error) { if (!stopped()) next(error); }
  };
}
