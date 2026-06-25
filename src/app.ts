import "dotenv/config";
import crypto from "crypto";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import cookieParser from "cookie-parser";
import { pool } from "./db.js";
import { getIO } from "./realtime/socketio.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { requestId } from "./middleware/requestId.js";
import { sessionIdleTimeout } from "./middleware/sessionIdleTimeout.js";
import { csrfProtection } from "./middleware/csrfProtection.js";
import { apiLimiter } from "./middleware/rateLimiter.js";
import { safeCompare } from "./util/safeCompare.js";
import routes from "./routes/index.js";
import errorMonitor from "./services/errorMonitor.js";

const PgStore = connectPgSimple(session);
const isProduction = process.env.NODE_ENV === "production";

function skipsWebSession(req: express.Request): boolean {
  const path = req.path;
  return (
    path.startsWith("/api/classpilot/device/") ||
    path.startsWith("/api/device/") ||
    path.startsWith("/api/classpilot/extension/") ||
    path.startsWith("/api/extension/") ||
    path.startsWith("/api/classpilot/student/") ||
    path.startsWith("/api/student/") ||
    path.startsWith("/api/classpilot/polls/") ||
    path.startsWith("/api/polls/") ||
    path.startsWith("/api/classpilot/checkin/") ||
    path.startsWith("/api/checkin/") ||
    path === "/api/classpilot/school/status" ||
    path === "/api/school/status" ||
    path === "/api/classpilot/register" ||
    path === "/api/register" ||
    path === "/api/classpilot/register-student" ||
    path === "/api/register-student"
  );
}

export function createApp() {
  const app = express();

  // Trust proxy depth: in production the chain is CloudFront → ALB → app, so
  // X-Forwarded-For ends with "<viewer>, <cloudfront-edge>" and we must trust
  // 2 hops for req.ip to be the real viewer (1 hop made req.ip the CloudFront
  // edge IP, which broke IP-keyed rate limiting). Locally/dev: 1 hop (Vite proxy).
  app.set(
    "trust proxy",
    Number(process.env.TRUST_PROXY_HOPS ?? (isProduction ? 2 : 1))
  );

  // Correlation id on every request (first, so all downstream logs/errors carry it)
  app.use(requestId);

  // Security headers
  app.use(
    helmet({
      contentSecurityPolicy: false, // CSP handled by CloudFront/frontend
      hsts: isProduction
        ? { maxAge: 31536000, includeSubDomains: true, preload: true }
        : false,
      crossOriginEmbedderPolicy: false, // Allow loading cross-origin resources
    })
  );

  // CORS — allow all configured frontend origins + Capacitor native origins
  const allowlist = (process.env.CORS_ALLOWLIST || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Fail fast BEFORE the always-allowed Capacitor origins are added — otherwise
  // the allowlist is never empty and a prod boot without CORS_ALLOWLIST would
  // silently come up with only localhost origins (breaking the real frontend).
  if (isProduction && allowlist.length === 0) {
    throw new Error(
      "FATAL: CORS_ALLOWLIST must be set in production. " +
        "Provide a comma-separated list of allowed origins."
    );
  }

  // Capacitor native app origins (always allowed). Android WebView origin is
  // https://localhost (androidScheme: 'https' in both capacitor configs);
  // capacitor://localhost covers a future iOS build. Plain http://localhost is
  // not used by any client and stays out of the prod allowlist.
  const capacitorOrigins = ["capacitor://localhost", "https://localhost"];
  for (const origin of capacitorOrigins) {
    if (!allowlist.includes(origin)) allowlist.push(origin);
  }

  app.use(
    cors({
      origin: allowlist.length > 0 ? allowlist : true,
      credentials: true,
    })
  );

  // Capture raw body for Stripe webhooks
  app.use(
    express.json({
      limit: "1mb",
      verify: (req, _res, buf) => {
        (req as express.Request).rawBody = buf;
      },
    })
  );
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));
  app.use(cookieParser());

  // CloudFront → ALB uses HTTP ("http-only" origin protocol), so the ALB sets
  // X-Forwarded-Proto: http. But the viewer → CloudFront link is always HTTPS
  // (ViewerProtocolPolicy: redirect-to-https). Override so express-session
  // correctly marks cookies as secure.
  if (isProduction) {
    app.use((req, _res, next) => {
      req.headers["x-forwarded-proto"] = "https";
      next();
    });
  }

  // Session secret: require in production, random fallback for dev
  if (isProduction && !process.env.SESSION_SECRET) {
    throw new Error(
      "FATAL: SESSION_SECRET environment variable is required in production"
    );
  }
  const sessionSecret =
    process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

  const webSession = session({
    store: new PgStore({
      pool: pool as any,
      tableName: "session",
      createTableIfMissing: false,
    }),
    name: "schoolpilot.sid",
    secret: sessionSecret,
    rolling: true,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      httpOnly: true,
      secure: isProduction,
      sameSite: "lax", // "lax" required for cross-subdomain navigation
      domain: process.env.COOKIE_DOMAIN || undefined, // .classpilot.net in production
    },
  });

  // Session (connect-pg-simple stores sessions in the "session" table).
  // ClassPilot extension/device endpoints authenticate with device JWTs and do
  // not need web sessions. Bypassing the session store here keeps high-frequency
  // screenshot/device traffic from consuming Postgres pool connections before
  // the request reaches device auth.
  app.use((req, res, next) => {
    if (skipsWebSession(req)) {
      return next();
    }
    return webSession(req, res, next);
  });

  // Global API rate limit (Redis-backed, falls back to in-memory). The old
  // "CloudFront masks client IPs" false-429 problem is fixed by trust proxy = 2
  // above, so req.ip is the real viewer again.
  app.use("/api", apiLimiter);

  // Health check (no auth required). The ALB target check and the Docker
  // HEALTHCHECK only consume the status code, so 200/503 semantics are public;
  // the detailed body (pool stats, error counts, client counts) is operational
  // intel and only returned when the caller presents HEALTH_TOKEN.
  app.get("/health", async (req, res) => {
    const results: Record<string, any> = {};
    let allOk = true;

    // 1. Postgres ping
    try {
      const start = Date.now();
      await pool.query("SELECT 1");
      results.postgres = { ok: true, latencyMs: Date.now() - start };
    } catch (err: any) {
      results.postgres = { ok: false, error: err.message };
      allOk = false;
    }

    // 2. DB pool stats
    const waiting = pool.waitingCount;
    results.dbPool = {
      ok: waiting === 0,
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting,
    };
    if (waiting > 0) allOk = false;

    // 3. Socket.IO
    const io = getIO();
    results.socketio = io
      ? { ok: true, clients: io.engine.clientsCount }
      : { ok: false, error: "not initialized" };
    if (!io) allOk = false;

    results.uptime = Math.floor(process.uptime());
    results.timestamp = new Date().toISOString();
    results.recentErrors = errorMonitor.getErrorSummary();

    const expected = process.env.HEALTH_TOKEN;
    const provided = req.get("x-health-token") ?? req.query.token;
    const detailed =
      Boolean(expected) &&
      typeof provided === "string" &&
      safeCompare(provided, expected!);
    res.status(allOk ? 200 : 503).json(
      detailed
        ? { status: allOk ? "ok" : "degraded", checks: results }
        : { status: allOk ? "ok" : "degraded" }
    );
  });

  // Client config for Chrome extension (public, no auth)
  app.get("/client-config.json", (_req, res) => {
    res.json({
      baseUrl: process.env.PUBLIC_BASE_URL || "http://localhost:4000",
      wsAvailable: true,
    });
  });
  app.get("/api/client-config", (_req, res) => {
    res.json({
      baseUrl: process.env.PUBLIC_BASE_URL || "http://localhost:4000",
      wsAvailable: true,
    });
  });

  // Enforce tighter idle timeout for elevated roles (admin/super_admin)
  app.use("/api", sessionIdleTimeout);

  // CSRF protection on cookie-authenticated state-changing requests
  // (JWT bearer requests skip this — they have no CSRF vector)
  app.use("/api", csrfProtection);

  // Routes
  app.use("/api", routes);

  // JSON 404 for unknown API routes — otherwise Express emits an HTML
  // "Cannot GET" page, which CloudFront used to mask as 200 + SPA shell.
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // Error handler (must be last)
  app.use(errorHandler);

  return app;
}
