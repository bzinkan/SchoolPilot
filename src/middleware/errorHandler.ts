import type { ErrorRequestHandler } from "express";
import errorMonitor from "../services/errorMonitor.js";

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  console.error("Error:", err);

  // Track in error monitor for alerting
  const status = err.status || err.statusCode || 500;
  if (status >= 500) {
    errorMonitor.trackError("api_error", err, {
      method: req.method,
      path: req.originalUrl,
      userId: (req as any).authUser?.id,
    });
  }

  if (res.headersSent) {
    return;
  }

  const message =
    process.env.NODE_ENV === "development"
      ? err.message
      : "Internal server error";

  res.status(status).json({ error: message });
};
