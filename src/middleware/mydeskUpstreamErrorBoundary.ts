import type { ErrorRequestHandler } from "express";

const malformedBodyTypes = new Set([
  "entity.parse.failed", "entity.verify.failed", "request.aborted", "request.size.invalid",
  "charset.unsupported", "encoding.unsupported",
]);

/** Mounted at /api/mydesk after routes: catches parser/session errors that never entered the private router. */
export const myDeskUpstreamErrorBoundary: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  const type = error && typeof error === "object" && "type" in error ? error.type : undefined;
  const tooLarge = type === "entity.too.large" || type === "parameters.too.many";
  const malformed = typeof type === "string" && malformedBodyTypes.has(type);
  const status = tooLarge ? 413 : malformed ? 400 : 503;
  const code = tooLarge ? "MYDESK_REQUEST_TOO_LARGE" : malformed ? "MYDESK_INVALID_REQUEST" : "MYDESK_UNAVAILABLE";
  if (status === 503) console.error(JSON.stringify({ event: "mydesk_upstream_error", code }));
  // Never forward the original error: parser messages/body fields can contain private authored text.
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.end(); return; }
  res.set({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
  res.status(status).json({ code, error: tooLarge ? "The notebook request is too large."
    : malformed ? "Invalid notebook request." : "My Desk is temporarily unavailable. Please retry." });
};
