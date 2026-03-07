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
import { apiLimiter } from "./middleware/rateLimiter.js";
import routes from "./routes/index.js";

const PgStore = connectPgSimple(session);
const isProduction = process.env.NODE_ENV === "production";

export function createApp() {
  const app = express();

  // Trust proxy for rate limiting behind reverse proxy
  app.set("trust proxy", 1);

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

  // Capacitor native app origins (always allowed)
  const capacitorOrigins = ["capacitor://localhost", "http://localhost"];
  for (const origin of capacitorOrigins) {
    if (!allowlist.includes(origin)) allowlist.push(origin);
  }

  if (isProduction && allowlist.length === 0) {
    throw new Error(
      "FATAL: CORS_ALLOWLIST must be set in production. " +
        "Provide a comma-separated list of allowed origins."
    );
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

  // Session (connect-pg-simple stores sessions in the "session" table)
  app.use(
    session({
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
    })
  );

  // Global rate limit for API routes
  app.use("/api", apiLimiter);

  // Health check (no auth required)
  app.get("/health", async (_req, res) => {
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

    res.status(allOk ? 200 : 503).json({ status: allOk ? "ok" : "degraded", checks: results });
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

  // Routes
  app.use("/api", routes);

  // Error handler (must be last)
  app.use(errorHandler);

  return app;
}
