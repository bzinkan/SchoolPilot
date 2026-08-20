import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import { requirePassPilotRole } from "../../services/passpilotAccess.js";
import {
  getPasspilotAdminSettings,
  updatePasspilotActiveGradeLevels,
  updatePasspilotAdminSettings,
  updatePasspilotAdminSettingsCompatibility,
} from "../../services/storage.js";
import { logAudit } from "../../services/audit.js";
import { hashPassword } from "../../util/password.js";

export const PASSPILOT_SUPPORTED_SCHOOL_TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
] as const;

const patchSettingsSchema = z
  .object({
    expectedRevision: z.number().int().min(0),
    name: z.string().trim().min(1, "School name is required").max(200).optional(),
    schoolTimezone: z.enum(PASSPILOT_SUPPORTED_SCHOOL_TIMEZONES).optional(),
    kioskEnabled: z.boolean().optional(),
    kioskRequiresApproval: z.boolean().optional(),
    kioskPin: z
      .string()
      .regex(/^\d{4,8}$/, "Kiosk PIN must be 4-8 digits")
      .nullable()
      .optional(),
    kioskStyle: z.enum(["simple", "badge"]).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.schoolTimezone !== undefined ||
      value.kioskEnabled !== undefined ||
      value.kioskRequiresApproval !== undefined ||
      value.kioskPin !== undefined ||
      value.kioskStyle !== undefined,
    { message: "Provide at least one setting to update" }
  );

const legacyPatchSettingsSchema = z
  .object({
    name: z.string().trim().min(1, "School name is required").max(200).optional(),
    schoolTimezone: z.enum(PASSPILOT_SUPPORTED_SCHOOL_TIMEZONES).optional(),
    kioskEnabled: z.boolean().optional(),
    kioskRequiresApproval: z.boolean().optional(),
    // The deployed form sends a PIN only when an administrator typed one. It
    // never had a PIN-clear action; keep null exclusive to the canonical API.
    kioskPin: z.string().regex(/^\d{4,8}$/, "Kiosk PIN must be 4-8 digits").optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.schoolTimezone !== undefined ||
      value.kioskEnabled !== undefined ||
      value.kioskRequiresApproval !== undefined ||
      value.kioskPin !== undefined,
    { message: "Provide at least one setting to update" }
  );

const activeGradeLevel = z.enum([
  "K", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12",
]);
const activeGradeLevelsCompatibilitySchema = z.object({
  activeGradeLevels: z.string().min(1),
}).strict();

function parseActiveGradeLevels(value: string): string[] | undefined {
  try {
    const parsed = z.array(activeGradeLevel).max(13).safeParse(JSON.parse(value));
    if (!parsed.success || new Set(parsed.data).size !== parsed.data.length) return undefined;
    return parsed.data;
  } catch {
    return undefined;
  }
}

// The existing Classes setup screen saves only this one unrelated field through
// /admin/settings. Keep that live workflow as a narrow compatibility branch;
// canonical /passpilot/admin/settings never accepts it.
export const passpilotActiveGradeLevelsCompatibilityRouter = Router();
passpilotActiveGradeLevelsCompatibilityRouter.use((req, _res, next) => {
  if (
    req.method !== "PATCH" ||
    !req.body ||
    !Object.prototype.hasOwnProperty.call(req.body, "activeGradeLevels")
  ) {
    return next("router");
  }
  return next();
});
passpilotActiveGradeLevelsCompatibilityRouter.use(
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireProductLicense("PASSPILOT"),
  requirePassPilotRole("admin", "school_admin")
);
passpilotActiveGradeLevelsCompatibilityRouter.patch("/", async (req, res, next) => {
  try {
    const body = activeGradeLevelsCompatibilitySchema.safeParse(req.body);
    const gradeLevels = body.success
      ? parseActiveGradeLevels(body.data.activeGradeLevels)
      : undefined;
    if (!gradeLevels) {
      return res.status(400).json({
        error: "activeGradeLevels must be a unique JSON array containing K and/or grades 1-12.",
        code: "PASSPILOT_ACTIVE_GRADE_LEVELS_INVALID",
      });
    }
    const activeGradeLevels = await updatePasspilotActiveGradeLevels(
      res.locals.schoolId!,
      gradeLevels
    );
    if (activeGradeLevels === undefined) {
      return res.status(404).json({ error: "School not found" });
    }
    await logAudit({
      schoolId: res.locals.schoolId!,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.membershipRole,
      action: "passpilot.active_grade_levels.update",
      entityType: "school",
      entityId: res.locals.schoolId!,
      changes: { fields: ["activeGradeLevels"] },
      metadata: { gradeLevelCount: gradeLevels.length },
    });
    return res.json({ activeGradeLevels });
  } catch (error) {
    next(error);
  }
});

const LEGACY_SETTINGS_FIELDS = [
  "name",
  "schoolTimezone",
  "kioskEnabled",
  "kioskRequiresApproval",
  "kioskPin",
] as const;

// Backend-first bridge for the web bundle that predates expectedRevision. It
// is mounted only on /admin/settings; /passpilot/admin/settings stays strict.
export const passpilotLegacySettingsCompatibilityRouter = Router();
passpilotLegacySettingsCompatibilityRouter.use((req, _res, next) => {
  if (
    req.method !== "PATCH" ||
    !req.body ||
    Object.prototype.hasOwnProperty.call(req.body, "expectedRevision") ||
    !LEGACY_SETTINGS_FIELDS.some((field) =>
      Object.prototype.hasOwnProperty.call(req.body, field)
    )
  ) {
    return next("router");
  }
  return next();
});
passpilotLegacySettingsCompatibilityRouter.use(
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireProductLicense("PASSPILOT"),
  requirePassPilotRole("admin", "school_admin")
);
passpilotLegacySettingsCompatibilityRouter.patch("/", async (req, res, next) => {
  try {
    const parsed = legacyPatchSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: parsed.error.errors[0]?.message || "Invalid settings",
        code: "PASSPILOT_LEGACY_SETTINGS_INVALID",
      });
    }
    const { kioskPin, ...settingsPatch } = parsed.data;
    const result = await updatePasspilotAdminSettingsCompatibility(
      res.locals.schoolId!,
      {
        ...settingsPatch,
        ...(kioskPin === undefined ? {} : { kioskPinHash: await hashPassword(kioskPin) }),
      },
      {
        userId: req.authUser!.id,
        userEmail: req.authUser!.email,
        userRole: res.locals.membershipRole,
      }
    );
    if (!result) return res.status(404).json({ error: "School not found" });
    if (result.status === "pin_required") {
      return res.status(400).json({
        error: "Set a 4-8 digit kiosk PIN before enabling Kiosk Mode.",
        code: "PASSPILOT_KIOSK_PIN_REQUIRED",
        current: result.current,
      });
    }
    // No revision is supplied by this compatibility contract, so its row-lock
    // path cannot conflict. Keep this defensive branch fail closed.
    if (result.status === "conflict") {
      return res.status(409).json({
        error: "Settings changed while saving. Refresh and try again.",
        code: "PASSPILOT_SETTINGS_REVISION_CONFLICT",
        current: result.current,
      });
    }
    return res.json(result.current);
  } catch (error) {
    next(error);
  }
});

const router = Router();

router.use(
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireProductLicense("PASSPILOT"),
  requirePassPilotRole("admin", "school_admin")
);

router.get("/", async (_req, res, next) => {
  try {
    const current = await getPasspilotAdminSettings(res.locals.schoolId!);
    if (!current) return res.status(404).json({ error: "School not found" });
    return res.json(current);
  } catch (error) {
    next(error);
  }
});

router.patch("/", async (req, res, next) => {
  try {
    const parsed = patchSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: parsed.error.errors[0]?.message || "Invalid settings",
        code: "PASSPILOT_SETTINGS_INVALID",
      });
    }

    const { expectedRevision, kioskPin, ...settingsPatch } = parsed.data;
    const kioskPinHash = kioskPin === undefined
      ? undefined
      : kioskPin === null
        ? null
        : await hashPassword(kioskPin);
    const result = await updatePasspilotAdminSettings(
      res.locals.schoolId!,
      expectedRevision,
      { ...settingsPatch, kioskPinHash },
      {
        userId: req.authUser!.id,
        userEmail: req.authUser!.email,
        userRole: res.locals.membershipRole,
      }
    );
    if (!result) return res.status(404).json({ error: "School not found" });

    if (result.status === "conflict") {
      return res.status(409).json({
        error: "Settings were changed by another administrator. Load the latest settings and try again.",
        code: "PASSPILOT_SETTINGS_REVISION_CONFLICT",
        current: result.current,
      });
    }
    if (result.status === "pin_required") {
      return res.status(400).json({
        error: "Set a 4-8 digit kiosk PIN before enabling Kiosk Mode. Disable Kiosk Mode before clearing its PIN.",
        code: "PASSPILOT_KIOSK_PIN_REQUIRED",
        current: result.current,
      });
    }

    return res.json(result.current);
  } catch (error) {
    next(error);
  }
});

export default router;
