import type { RequestHandler } from "express";
import crypto from "crypto";

/**
 * Assigns a correlation id to every request so logs + error records for a
 * single request can be tied together. Honors an inbound X-Request-Id (e.g.
 * from CloudFront / a load balancer) when present and well-formed; otherwise
 * generates a UUID. Always echoes the id back in the X-Request-Id response
 * header so a user reporting a problem can hand you the exact id to grep.
 *
 * Must be mounted FIRST, before any route or error handler.
 */
export const requestId: RequestHandler = (req, res, next) => {
  const inbound = req.headers["x-request-id"];
  const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
  // Only trust short, safe inbound ids; otherwise generate our own.
  const id =
    typeof candidate === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(candidate)
      ? candidate
      : crypto.randomUUID();
  req.requestId = id;
  res.setHeader("X-Request-Id", id);
  next();
};
