import type { ErrorRequestHandler } from "express";
import errorMonitor from "../services/errorMonitor.js";

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const reqId = req.requestId;
  // Prefix the log with the correlation id so it's greppable in CloudWatch.
  console.error(`Error [req:${reqId ?? "n/a"}]:`, err);

  // Track in error monitor for alerting
  const status = err.status || err.statusCode || 500;
  const errMsg = String(err?.message || err);

  // Ignore client-side network noise — not actionable server errors:
  // - "request aborted" = client disconnected mid-request (WiFi drop, sleep)
  // - "ECONNRESET" / "socket hang up" = transient TCP issues
  const isClientNetworkNoise = /request aborted|ECONNRESET|socket hang up|aborted/i.test(errMsg);

  // Shared correlation context recorded on the durable error_logs row.
  const ctx = {
    requestId: reqId,
    method: req.method,
    path: req.originalUrl,
    status,
    userId: req.authUser?.id,
    schoolId: res.locals?.schoolId,
  };

  if (status >= 500) {
    errorMonitor.trackError("api_error", err, ctx);
  } else if (status >= 400 && !isClientNetworkNoise) {
    errorMonitor.trackError("client_error", err, ctx);
  }

  if (res.headersSent) {
    return;
  }

  const message =
    process.env.NODE_ENV === "development"
      ? err.message
      : "Internal server error";

  // Return the requestId so a user/IT admin can quote it when reporting an
  // issue — it ties directly to the error_logs row + CloudWatch line.
  res.status(status).json({ error: message, requestId: reqId });
};
