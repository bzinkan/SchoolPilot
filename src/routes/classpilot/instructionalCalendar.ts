import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import { requireRole } from "../../middleware/requireRole.js";
import { requireClasspilotEntitlement } from "../../middleware/requireClasspilotEntitlement.js";
import { logAudit } from "../../services/audit.js";
import {
  getInstructionalCalendarMonth,
  getSchoolById,
  isValidInstructionalCalendarMonth,
  replaceInstructionalCalendarMonth,
  type InstructionalCalendarMonthState,
} from "../../services/storage.js";
import { localDateInTimeZone } from "../../util/schoolTime.js";

const router = Router();

const auth = [
  authenticate,
  requireSchoolContext,
  requireClasspilotEntitlement,
  requireActiveSchool,
  requireProductLicense("CLASSPILOT"),
  requireRole("admin", "school_admin"),
] as const;

type PublicInstructionalCalendarMonth = {
  month: string;
  schoolTimezone: string;
  schoolLocalToday: string;
  nonInstructionalDates: string[];
  revision: number;
  updatedAt: string | null;
};

function publicMonth(
  state: InstructionalCalendarMonthState,
  schoolTimezone: string,
  schoolLocalToday: string
): PublicInstructionalCalendarMonth {
  return {
    month: state.month,
    schoolTimezone,
    schoolLocalToday,
    nonInstructionalDates: state.nonInstructionalDates,
    revision: state.revision,
    updatedAt: state.updatedAt,
  };
}

function routeError(code: string, message: string, status = 400) {
  return Object.assign(new Error(message), { code, status, expose: true });
}

function requestedMonth(value: unknown): string {
  if (typeof value !== "string" || !isValidInstructionalCalendarMonth(value)) {
    throw routeError(
      "INVALID_INSTRUCTIONAL_CALENDAR_MONTH",
      "Month must use YYYY-MM format."
    );
  }
  return value;
}

async function schoolCalendarContext(schoolId: string) {
  const school = await getSchoolById(schoolId);
  if (!school) throw routeError("SCHOOL_NOT_FOUND", "School not found.", 404);
  const schoolTimezone = school.schoolTimezone || "America/New_York";
  return {
    schoolTimezone,
    schoolLocalToday: localDateInTimeZone(new Date(), schoolTimezone),
  };
}

// GET /api/classpilot/admin/instructional-calendar?month=YYYY-MM
router.get("/", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const month = requestedMonth(req.query.month);
    const [state, context] = await Promise.all([
      getInstructionalCalendarMonth(schoolId, month),
      schoolCalendarContext(schoolId),
    ]);
    res.setHeader("Cache-Control", "no-store");
    return res.json(publicMonth(state, context.schoolTimezone, context.schoolLocalToday));
  } catch (error) {
    next(error);
  }
});

// PUT /api/classpilot/admin/instructional-calendar/:month
router.put("/:month", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const month = requestedMonth(req.params.month);
    const expectedRevision = req.body?.expectedRevision;
    const nonInstructionalDates = req.body?.nonInstructionalDates;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw routeError(
        "INVALID_INSTRUCTIONAL_CALENDAR_REVISION",
        "expectedRevision must be a non-negative integer."
      );
    }
    if (!Array.isArray(nonInstructionalDates)) {
      throw routeError(
        "INVALID_NON_INSTRUCTIONAL_DATES",
        "nonInstructionalDates must be an array."
      );
    }

    const result = await replaceInstructionalCalendarMonth({
      schoolId,
      month,
      expectedRevision,
      nonInstructionalDates,
      updatedBy: req.authUser?.id ?? null,
    });
    const current = publicMonth(
      result.current,
      result.schoolTimezone,
      result.schoolLocalToday
    );
    res.setHeader("Cache-Control", "no-store");
    if (result.status === "conflict") {
      return res.status(409).json({
        error: "The school calendar changed in another administrator session.",
        code: "INSTRUCTIONAL_CALENDAR_REVISION_CONFLICT",
        current,
      });
    }

    await logAudit({
      schoolId,
      userId: req.authUser?.id ?? null,
      userEmail: req.authUser?.email,
      userRole: res.locals.membershipRole,
      action: "classpilot.instructional_calendar.update",
      entityType: "instructional_calendar_month",
      entityId: month,
      entityName: month,
      changes: {
        addedDates: result.addedDates,
        removedDates: result.removedDates,
      },
      metadata: {
        month,
        addedCount: result.addedDates.length,
        removedCount: result.removedDates.length,
        revision: result.current.revision,
      },
    });
    return res.json(current);
  } catch (error) {
    next(error);
  }
});

export default router;
