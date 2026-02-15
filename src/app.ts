import "dotenv/config";
import crypto from "crypto";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import cookieParser from "cookie-parser";
import { pool } from "./db.js";
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
  app.use(helmet());

  // CORS — allow all configured frontend origins
  const allowlist = (process.env.CORS_ALLOWLIST || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

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
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Routes
  app.use("/api", routes);

  // Error handler (must be last)
  app.use(errorHandler);

  return app;
}
