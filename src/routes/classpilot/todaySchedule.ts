import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import { requireClasspilotEntitlement } from "../../middleware/requireClasspilotEntitlement.js";
import { requireRole } from "../../middleware/requireRole.js";
import { getClasspilotTodaySchedule, previewClasspilotTodaySchedule, createClasspilotTodayScheduleChange,
  getClasspilotTodayScheduleChange, actOnClasspilotTodayScheduleChange } from "../../services/classpilotTodaySchedule.js";
import { todayScheduleError } from "../../services/classpilotTodayScheduleModel.js";

const router = Router();
router.use(authenticate, requireSchoolContext, requireClasspilotEntitlement, requireActiveSchool,
  requireProductLicense("CLASSPILOT"), requireRole("admin", "school_admin", "teacher"));

const id = z.string().trim().min(1).max(100);
const previewSchema = z.object({ expectedSchoolDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), currentGroupId: id,
  selectedGroupId: id.optional(), currentMeetingRef: z.string().max(12_000).optional(),
  selectedMeetingRef: z.string().max(12_000).optional(), counterpartTeacherId: id.optional(),
  action: z.enum(["swap", "skip"]) }).strict();
const createSchema = z.object({ reviewToken: z.string().min(1).max(12_000), idempotencyKey: z.string().trim().min(1).max(128) }).strict();
const actionSchema = z.object({ action: z.enum(["accept", "decline", "cancel"]), expectedRevision: z.number().int().nonnegative(),
  reviewToken: z.string().min(1).max(12_000).optional() }).strict();

function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw todayScheduleError("Invalid schedule request. Review the selected classes and try again.", "TODAY_SCHEDULE_INVALID_BODY", 400);
  return result.data;
}
function context(req: Request, res: Response) {
  if (!req.authUser?.id || !res.locals.schoolId) throw todayScheduleError("Teaching context required.", "TODAY_SCHEDULE_FORBIDDEN", 403);
  return { schoolId: res.locals.schoolId, actorId: req.authUser.id };
}

router.get("/", async (req, res, next) => {
  try { res.json(await getClasspilotTodaySchedule(context(req, res))); } catch (error) { next(error); }
});
router.post("/preview", async (req, res, next) => {
  try { res.json(await previewClasspilotTodaySchedule({ ...context(req, res), input: parsed(previewSchema, req.body) })); } catch (error) { next(error); }
});
router.post("/changes", async (req, res, next) => {
  try { res.status(201).json(await createClasspilotTodayScheduleChange({ ...context(req, res), ...parsed(createSchema, req.body) })); } catch (error) { next(error); }
});
router.get("/changes/:id", async (req, res, next) => {
  try { res.json(await getClasspilotTodayScheduleChange({ ...context(req, res), changeId: parsed(id, req.params.id) })); } catch (error) { next(error); }
});
router.post("/changes/:id/actions", async (req, res, next) => {
  try { res.json(await actOnClasspilotTodayScheduleChange({ ...context(req, res), changeId: parsed(id, req.params.id),
    ...parsed(actionSchema, req.body) })); } catch (error) { next(error); }
});
export default router;
