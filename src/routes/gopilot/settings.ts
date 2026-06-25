import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import { getSchoolById, getSettingsForSchool, upsertSettings } from "../../services/storage.js";
import { requireGoPilotRole } from "../../services/gopilotAccess.js";

const router = Router();

const adminAuth = [
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireProductLicense("GOPILOT"),
  requireGoPilotRole("admin", "school_admin"),
] as const;

router.get("/parent-digests", ...adminAuth, async (_req, res, next) => {
  try {
    const settings = await getSettingsForSchool(res.locals.schoolId!);
    return res.json({
      settings: {
        parentTransparencyEnabled: !!settings?.parentTransparencyEnabled,
        parentDigestCadence: settings?.parentDigestCadence || "weekly",
        parentDigestIncludesSafety: !!settings?.parentDigestIncludesSafety,
        parentDigestIncludesPassDismissal: settings?.parentDigestIncludesPassDismissal !== false,
        parentDigestLastSentAt: settings?.parentDigestLastSentAt || null,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.patch("/parent-digests", ...adminAuth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const existing = await getSettingsForSchool(schoolId);
    const schoolName = existing?.schoolName || (await getSchoolById(schoolId))?.name || "School";

    const settings = await upsertSettings(schoolId, {
      schoolName,
      wsSharedKey: existing?.wsSharedKey || "configured",
      parentTransparencyEnabled: !!req.body.parentTransparencyEnabled,
      parentDigestCadence: "weekly",
      parentDigestIncludesSafety: !!req.body.parentDigestIncludesSafety,
      parentDigestIncludesPassDismissal: req.body.parentDigestIncludesPassDismissal !== false,
    });

    return res.json({ settings });
  } catch (err) {
    next(err);
  }
});

export default router;
