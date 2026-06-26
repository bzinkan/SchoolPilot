import express, { Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { browserTelemetrySchema, trackBrowserTelemetry } from "../services/runtimeTelemetry.js";

const router = Router();

function monitoringIp(req: express.Request): string {
  return ipKeyGenerator(req.ip || req.socket.remoteAddress || "0.0.0.0");
}

const browserTelemetryLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: "Too many telemetry events, please wait" },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: monitoringIp,
});

router.use(express.json({ limit: "16kb", strict: true }));

router.post("/browser-error", browserTelemetryLimiter, (req, res) => {
  const parsed = browserTelemetrySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid telemetry payload" });
  }

  const schoolId =
    typeof req.headers["x-school-id"] === "string"
      ? req.headers["x-school-id"]
      : req.session?.schoolId ?? undefined;

  trackBrowserTelemetry(parsed.data, {
    requestId: req.requestId,
    userId: req.session?.userId,
    schoolId,
  });

  return res.status(204).send();
});

export default router;
