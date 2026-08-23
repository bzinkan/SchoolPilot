import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { rejectDisabledGoPilotParent } from "../../middleware/rejectDisabledGoPilotParent.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireGopilotEntitlement } from "../../middleware/requireGopilotEntitlement.js";
import { requireGoPilotRole } from "../../services/gopilotAccess.js";
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
  rejectDisabledGoPilotParent,
  requireGopilotEntitlement,
  requireActiveSchool,
  requireGoPilotRole("admin", "school_admin"),
] as const;

function routeError(code: string, message: string, status = 400) {
  return Object.assign(new Error(message), { code, status, expose: true });
}

function requestedMonth(value: unknown): string {
  if (typeof value !== "string" || !isValidInstructionalCalendarMonth(value)) {
    throw routeError("INVALID_INSTRUCTIONAL_CALENDAR_MONTH", "Month must use YYYY-MM format.");
  }
  return value;
}

async function context(schoolId: string) {
  const school = await getSchoolById(schoolId);
  if (!school) throw routeError("SCHOOL_NOT_FOUND", "School not found.", 404);
  const schoolTimezone = school.schoolTimezone || "America/New_York";
  return { schoolTimezone, schoolLocalToday: localDateInTimeZone(new Date(), schoolTimezone) };
}

function dto(state: InstructionalCalendarMonthState, schoolTimezone: string, schoolLocalToday: string) {
  return {
    month: state.month,
    schoolTimezone,
    schoolLocalToday,
    nonInstructionalDates: state.nonInstructionalDates,
    revision: state.revision,
    updatedAt: state.updatedAt,
  };
}

router.get("/", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const month = requestedMonth(req.query.month);
    const [state, schoolContext] = await Promise.all([
      getInstructionalCalendarMonth(schoolId, month),
      context(schoolId),
    ]);
    res.setHeader("Cache-Control", "no-store");
    return res.json(dto(state, schoolContext.schoolTimezone, schoolContext.schoolLocalToday));
  } catch (error) {
    return next(error);
  }
});

router.put("/:month", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const month = requestedMonth(req.params.month);
    const expectedRevision = req.body?.expectedRevision;
    const nonInstructionalDates = req.body?.nonInstructionalDates;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw routeError("INVALID_INSTRUCTIONAL_CALENDAR_REVISION", "expectedRevision must be a non-negative integer.");
    }
    if (!Array.isArray(nonInstructionalDates)) {
      throw routeError("INVALID_NON_INSTRUCTIONAL_DATES", "nonInstructionalDates must be an array.");
    }
    const result = await replaceInstructionalCalendarMonth({
      schoolId,
      month,
      expectedRevision,
      nonInstructionalDates,
      updatedBy: req.authUser?.id ?? null,
    });
    const current = dto(result.current, result.schoolTimezone, result.schoolLocalToday);
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
      userRole: res.locals.gopilotRole,
      action: "gopilot.instructional_calendar.update",
      entityType: "instructional_calendar_month",
      entityId: month,
      entityName: month,
      changes: { addedDates: result.addedDates, removedDates: result.removedDates },
      metadata: {
        month,
        addedCount: result.addedDates.length,
        removedCount: result.removedDates.length,
        revision: result.current.revision,
      },
    });
    return res.json(current);
  } catch (error) {
    return next(error);
  }
});

export default router;
