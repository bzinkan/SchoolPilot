import type { Request, RequestHandler, Response } from "express";
import { recordRuntimePerformanceCounter } from "../services/runtimePerformanceMetrics.js";

/** A completed IncomingMessage may be destroyed while its response is still live. */
export function isRequestTransportDisconnected(req: Request, res: Response): boolean {
  return req.aborted === true || res.destroyed === true || req.socket?.destroyed === true;
}

/** Session lookup may finish after the browser has cancelled a dashboard poll. */
export const guardRequestTransportBeforeBody: RequestHandler = (req, res, next) => {
  if (isRequestTransportDisconnected(req, res)) {
    recordRuntimePerformanceCounter("requestDisconnectedBeforeBodyParser");
    return;
  }
  if (!res.writableEnded) next();
};

const MINUTE_MS = 60_000;
const MAX_DETAILS_PER_MINUTE = 20;

/** Only the parser's typed errors, on a confirmed closed transport, are noise. */
export function createRequestBodyFailureDiagnostics(options: {
  now?: () => number;
  sink?: (line: string) => void;
} = {}) {
  const now = options.now ?? Date.now;
  const sink = options.sink ?? ((line: string) => console.error(line));
  let detailMinute = -1, detailCount = 0;

  return (error: unknown, req: Request, res: Response): boolean => {
    if (!error || typeof error !== "object" || !("type" in error)) return false;
    const type = error.type;
    if (type !== "stream.not.readable" && type !== "request.aborted") return false;
    if (isRequestTransportDisconnected(req, res)) {
      recordRuntimePerformanceCounter("requestBodyParserCancelled");
      return true;
    }
    if (type !== "stream.not.readable") return false;

    recordRuntimePerformanceCounter("requestBodyParserLiveUnreadable");
    const at = now(), minute = Math.floor(at / MINUTE_MS);
    if (minute !== detailMinute) { detailMinute = minute; detailCount = 0; }
    if (detailCount++ >= MAX_DETAILS_PER_MINUTE) return false;
    // Fixed fields only. Never log URLs, request bodies, credentials, identities,
    // arbitrary error messages, or inbound correlation IDs in these diagnostics.
    const surface = /^\/api\/classpilot\/tiles\/screenshots\/?$/i.test(req.path) ? "tile_screenshots"
      : /^\/api\/classpilot\/tiles\/history\/?$/i.test(req.path) ? "tile_history" : "other";
    const elapsed = at - (req.requestReceivedAtMs ?? at);
    sink(JSON.stringify({
      event: "request_body_parser_live_unreadable", surface,
      elapsedMs: Number.isFinite(elapsed) ? Math.max(0, Math.min(300_000, elapsed)) : 0,
      requestAborted: req.aborted, requestComplete: req.complete,
      requestReadable: req.readable, requestReadableEnded: req.readableEnded,
      requestDestroyed: req.destroyed, socketDestroyed: req.socket.destroyed,
      responseDestroyed: res.destroyed, responseWritableEnded: res.writableEnded,
      responseHeadersSent: res.headersSent,
    }));
    return false;
  };
}

export const recordRequestBodyFailure = createRequestBodyFailureDiagnostics();
