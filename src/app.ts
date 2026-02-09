import "dotenv/config";
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

export function createApp() {
  const app = express();

  // Trust proxy for rate limiting behind reverse proxy
  app.set("trust proxy", 1);

  // Security headers
  app.use(helmet());

  // CORS - allow all configured frontend origins
  const allowlist = (process.env.CORS_ALLOWLIST || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  app.use(
    cors({
      origin: allowlist.length > 0 ? allowlist : true,
      credentials: true,
    })
  );

  // Capture raw body for Stripe webhooks
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as express.Request).rawBody = buf;
      },
    })
  );
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  // Session (connect-pg-simple stores sessions in the "session" table)
  app.use(
    session({
      store: new PgStore({
        pool: pool as any,
        tableName: "session",
        createTableIfMissing: false,
      }),
      name: "schoolpilot.sid",
      secret: process.env.SESSION_SECRET || "fallback-dev-secret",
      resave: false,
      saveUninitialized: false,
      cookie: {
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: process.env.NODE_ENV === "production" ? "strict" : "lax",
      },
    })
  );

  // Global rate limit for API routes
  app.use("/api", apiLimiter);

  // Health check (no auth required)
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Routes
  app.use("/api", routes);

  // Error handler (must be last)
  app.use(errorHandler);

  return app;
}
