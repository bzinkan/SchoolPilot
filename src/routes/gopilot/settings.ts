import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import { rejectDisabledGoPilotParent } from "../../middleware/rejectDisabledGoPilotParent.js";
import { requireGoPilotRole } from "../../services/gopilotAccess.js";
import {
  getGoPilotSettings,
  updateGoPilotSettings,
} from "../../services/gopilotSettings.js";
import { sendGoPilotParentPortalDisabled } from "../../util/gopilotParentContainment.js";

export const GOPILOT_SUPPORTED_SCHOOL_TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
] as const;

const dismissalTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Dismissal time must use 24-hour HH:MM format")
  .nullable();

const pickupZoneSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(16)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "Zone IDs may contain letters, numbers, _ and -"),
    name: z.string().trim().min(1).max(80),
  })
  .strict();

const patchSettingsSchema = z
  .object({
    expectedRevision: z.number().int().min(0),
    dismissalTime: dismissalTimeSchema.optional(),
    schoolTimezone: z.enum(GOPILOT_SUPPORTED_SCHOOL_TIMEZONES).optional(),
    autoStartEnabled: z.boolean().optional(),
    pickupZones: z
      .array(pickupZoneSchema)
      .min(1, "At least one pickup zone is required")
      .max(12)
      .superRefine((zones, ctx) => {
        const ids = new Set<string>();
        for (const [index, zone] of zones.entries()) {
          const normalized = zone.id.toLowerCase();
          if (ids.has(normalized)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "Pickup zone IDs must be unique",
              path: [index, "id"],
            });
          }
          ids.add(normalized);
        }
      })
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.dismissalTime !== undefined ||
      value.schoolTimezone !== undefined ||
      value.autoStartEnabled !== undefined ||
      value.pickupZones !== undefined,
    { message: "Provide at least one setting to update" }
  );

const router = Router();

// Retain the old URL as an explicit tombstone. It must never read or mutate
// the shared parent-digest settings after GoPilot becomes staff-only.
router.all("/parent-digests", authenticate, (_req, res) => sendGoPilotParentPortalDisabled(res));

const staffAuth = [
  authenticate,
  requireSchoolContext,
  rejectDisabledGoPilotParent,
  requireActiveSchool,
  requireProductLicense("GOPILOT"),
  requireGoPilotRole("admin", "school_admin", "office_staff", "teacher"),
] as const;

const adminAuth = [
  authenticate,
  requireSchoolContext,
  rejectDisabledGoPilotParent,
  requireActiveSchool,
  requireProductLicense("GOPILOT"),
  requireGoPilotRole("admin", "school_admin"),
] as const;

router.get("/", ...staffAuth, async (_req, res, next) => {
  try {
    const current = await getGoPilotSettings(res.locals.schoolId!);
    if (!current) return res.status(404).json({ error: "School not found" });
    return res.json(current);
  } catch (error) {
    next(error);
  }
});

router.patch("/", ...adminAuth, async (req, res, next) => {
  try {
    const parsed = patchSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: parsed.error.errors[0]?.message || "Invalid settings",
        code: "GOPILOT_SETTINGS_INVALID",
      });
    }

    const { expectedRevision, ...patch } = parsed.data;
    const result = await updateGoPilotSettings(
      res.locals.schoolId!,
      expectedRevision,
      patch,
      {
        userId: req.authUser!.id,
        userEmail: req.authUser!.email,
        userRole: res.locals.gopilotRole ?? res.locals.membershipRole,
      }
    );
    if (!result) return res.status(404).json({ error: "School not found" });

    if (result.status === "conflict") {
      return res.status(409).json({
        error: "Settings were changed by another administrator. Load the latest settings and try again.",
        code: "GOPILOT_SETTINGS_REVISION_CONFLICT",
        current: result.current,
      });
    }
    if (result.status === "dismissal_time_required") {
      return res.status(400).json({
        error: "Set a dismissal time before enabling automatic start.",
        code: "GOPILOT_DISMISSAL_TIME_REQUIRED",
        current: result.current,
      });
    }

    return res.json(result.current);
  } catch (error) {
    next(error);
  }
});

export default router;
