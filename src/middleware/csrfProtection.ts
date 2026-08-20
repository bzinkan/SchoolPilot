import type { RequestHandler } from "express";

/**
 * CSRF protection for cookie-authenticated state-changing requests.
 *
 * Strategy ("defense in depth, not single point of failure"):
 *
 *   1. PRIMARY: Cookies are SameSite=Lax (configured in app.ts), which already
 *      blocks the browser from sending session cookies on cross-site POST/PUT/
 *      PATCH/DELETE. This is the main mitigation in modern browsers.
 *
 *   2. DEFENSE-IN-DEPTH: This middleware enforces a token check on top of that.
 *      For requests authenticated by session cookie, a valid X-CSRF-Token header
 *      matching req.session.csrfToken is required on state-changing methods.
 *
 *   3. JWT-bearer requests (Authorization: Bearer ...) skip CSRF entirely.
 *      Bearer tokens are not auto-attached by browsers, so there's no CSRF
 *      vector. This covers the mobile app (Capacitor), Chrome extension
 *      (device JWT), and any future API clients.
 *
 * Frontend integration: web client fetches /api/csrf once after login and sends
 * the token in X-CSRF-Token on all state-changing requests. Implemented in
 * schoolpilot-app/src/shared/utils/api.js as an axios request interceptor.
 *
 * Whitelisted paths bypass CSRF (intentional):
 *   - /api/auth/login, /api/auth/register* — no session yet to attach token to
 *   - /api/auth/csrf — the endpoint that issues the token
 *   - /api/auth/google* — OAuth flow has its own state parameter
 *   - /api/monitoring/browser-error — mounted before this middleware with its
 *     own 16KB parser and telemetry rate limiter
 *   - /health — operational
 *   - /api/stripe/* webhooks — verified by Stripe-Signature instead
 *   - /api/extension/* and /api/classpilot/device/* — JWT-bearer authenticated
 *     (these would also be skipped by the bearer-token rule, listed for clarity)
 *   - /api/passpilot/kiosk/lookup|checkout|checkin (and the legacy /api/kiosk/*
 *     aliases) — public kiosk endpoints authenticated by X-School-Id +
 *     X-Kiosk-Pin (validateKiosk in routes/passpilot/kiosk.ts). They never read
 *     the session, so a staff cookie present on the kiosk device has no CSRF
 *     vector. The session-authenticated PUT /kiosk config routes stay protected.
 */

const CSRF_EXEMPT_PATHS = [
  "/auth/login",
  "/auth/register",
  "/auth/register-parent",
  "/auth/csrf",
  "/auth/exchange-code",
  "/auth/google",
  "/auth/forgot-password",
  "/auth/reset-password",
  "/health",
  "/admin/billing/webhook", // Stripe webhook — verified by signature
];

// Public PassPilot kiosk endpoints: authenticated by X-School-Id + X-Kiosk-Pin
// (validateKiosk in routes/passpilot/kiosk.ts), never by the session cookie.
// A staff login in the same browser must not force CSRF onto requests that
// ignore the session. Matched exactly — no sub-path exemption — so the
// session-authenticated PUT /passpilot/kiosk/config (and compat PUT
// /kiosk-config) stay protected, and any future kiosk sub-route must opt in
// here deliberately.
const CSRF_EXEMPT_EXACT_PATHS = new Set([
  "/passpilot/kiosk/lookup",
  "/passpilot/kiosk/checkout",
  "/passpilot/kiosk/checkin",
  // Kiosk device session bootstrap (public, PIN-gated). The authenticated
  // /kiosk/sessions/* teacher endpoints are intentionally NOT exempt.
  "/passpilot/kiosk/session",
  // Legacy alias mounts (routes/index.ts also mounts the kiosk router at /kiosk)
  "/kiosk/lookup",
  "/kiosk/checkout",
  "/kiosk/checkin",
  "/kiosk/session",
]);

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isPathExempt(path: string): boolean {
  if (CSRF_EXEMPT_EXACT_PATHS.has(path)) return true;
  return CSRF_EXEMPT_PATHS.some((p) => path === p || path.startsWith(p + "/"));
}

export const csrfProtection: RequestHandler = (req, res, next) => {
  // Only enforce on state-changing methods
  if (!STATE_CHANGING_METHODS.has(req.method)) return next();

  // Exempt known-safe paths
  if (isPathExempt(req.path)) return next();

  // Bearer-token (JWT) auth → no CSRF risk, skip
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.toLowerCase().startsWith("bearer ")) {
    return next();
  }

  // Cookie session present → require CSRF token
  if (req.session && req.session.userId) {
    const expected = req.session.csrfToken;
    const provided =
      (req.headers["x-csrf-token"] as string | undefined) ??
      (req.body && typeof req.body === "object" && "_csrf" in req.body ? (req.body as any)._csrf : undefined);
    if (!expected || !provided || expected !== provided) {
      return res.status(403).json({ error: "Invalid or missing CSRF token" });
    }
    return next();
  }

  // No session, no bearer — request will fail at auth middleware anyway. Pass through.
  return next();
};
