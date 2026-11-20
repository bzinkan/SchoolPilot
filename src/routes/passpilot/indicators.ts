import { Router, type RequestHandler } from "express";
import { z } from "zod";
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import { redisStore } from "../../middleware/rateLimiter.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import { requirePassPilotRole, requirePasspilotClassModel } from "../../services/passpilotAccess.js";
import { indicatorPairingRequestSchema, type PasspilotIndicatorService } from "../../services/passpilotIndicators.js";
import { indicatorError } from "../../services/passpilotIndicatorsStore.js";
import { passpilotIndicatorService } from "../../services/passpilotIndicatorsRuntime.js";

const staffAuthorization: RequestHandler[] = [
  authenticate, requireSchoolContext, requireActiveSchool,
  requireProductLicense("PASSPILOT"),
  requirePassPilotRole("admin", "school_admin", "office_staff", "teacher"),
  requirePasspilotClassModel,
];

export function createPasspilotIndicatorRouter(service: PasspilotIndicatorService = passpilotIndicatorService, staff: RequestHandler[] = staffAuthorization) {
  const router = Router();
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });

  // This route never consumes a staff cookie/JWT, school header, or kiosk PIN.
  router.get("/state", async (req, res, next) => {
    const match = /^Bearer (ppi_[A-Za-z0-9_-]{43})$/i.exec(req.get("authorization") ?? "");
    if (!match) return res.status(401).json({ error: "Indicator credential required" });
    try {
      return res.json(await service.state(match[1]!));
    } catch (error) {
      if (error instanceof Error && "code" in error && typeof error.code === "string" && error.code.startsWith("PASSPILOT_INDICATOR_")) return next(error);
      return next(indicatorError(503, "PASSPILOT_INDICATOR_UNAVAILABLE", "Indicator service unavailable"));
    }
  });

  // Normal application CSRF applies to both staff mutations; no exemption.
  router.use("/pairings", ...staff);
  router.get("/pairings/kiosks", async (req, res, next) => {
    const schoolId = res.locals.schoolId;
    if (!schoolId) return res.status(400).json({ error: "School context required" });
    try {
      const kiosks = await service.listKiosks({ schoolId, userId: req.authUser!.id });
      return res.json({ kiosks });
    } catch (error) { return next(error); }
  });
  const pairingLimiter = rateLimit({
    windowMs: 60_000, limit: 10,
    keyGenerator: (req, res) => crypto.createHash("sha256").update(JSON.stringify([res.locals.schoolId, req.authUser!.id])).digest("hex"),
    store: redisStore("rl:passpilot:indicator-pairing:"),
    passOnStoreError: true, standardHeaders: true, legacyHeaders: false,
    message: { error: "Too many indicator pairing attempts; wait one minute" },
  });
  router.post("/pairings", pairingLimiter, async (req, res, next) => {
    const parsed = indicatorPairingRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Choose one kiosk or class. The exact water destination is optional." });
    const schoolId = res.locals.schoolId;
    if (!schoolId) return res.status(400).json({ error: "School context required" });
    try {
      return res.status(201).json(await service.pair({ schoolId, userId: req.authUser!.id }, parsed.data));
    } catch (error) { return next(error); }
  });
  router.delete("/pairings/:id", async (req, res, next) => {
    const pairingId = String(req.params.id ?? "");
    if (!z.string().uuid().safeParse(pairingId).success) return res.status(404).json({ error: "Pairing not found" });
    const schoolId = res.locals.schoolId;
    if (!schoolId) return res.status(400).json({ error: "School context required" });
    try {
      if (!await service.revoke({ schoolId, userId: req.authUser!.id }, pairingId)) return res.status(404).json({ error: "Pairing not found" });
      return res.status(204).end();
    } catch (error) { return next(error); }
  });
  return router;
}

export default createPasspilotIndicatorRouter();
