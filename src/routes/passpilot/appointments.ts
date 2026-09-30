import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import { requirePassPilotRole, requirePasspilotClassModel, getRequestPassPilotRole } from "../../services/passpilotAccess.js";
import { normalizePasspilotPass } from "../../services/passpilotClasses.js";
import { readPasspilotAppointmentsMode } from "../../config/passpilotAppointmentsMode.js";
import { PASSPILOT_APPOINTMENT_STATUSES } from "../../schema/passpilotAppointments.js";
import { createAppointmentSchema, editAppointmentSchema, cancelAppointmentSchema, activateAppointmentSchema } from "../../services/passpilotAppointmentsValidation.js";
import { createPasspilotAppointment, editPasspilotAppointment, cancelPasspilotAppointment, getPasspilotAppointment,
  listPasspilotAppointments, activatePasspilotAppointment } from "../../services/passpilotAppointments.js";
import { isPasspilotRuleError, recordPasspilotRuleDenial, passpilotRuleTeacherResponse } from "../../services/passpilotRules.js";
import { isDatabaseErrorCode } from "../../util/databaseError.js";

const router = Router();
router.use((_req, _res, next) => readPasspilotAppointmentsMode() === "on" ? next() : next("router"));
router.use(authenticate, requireSchoolContext, requireActiveSchool, requireProductLicense("PASSPILOT"),
  requirePassPilotRole("admin", "school_admin", "office_staff", "teacher"), requirePasspilotClassModel);
router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });

const id = z.string().min(1).max(128);
const date = z.string().datetime({ offset: true }).transform(value => new Date(value));
const querySchema = z.object({ from: date.optional(), through: date.optional(),
  status: z.enum(PASSPILOT_APPOINTMENT_STATUSES).optional(), studentId: id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().min(1).max(512).optional() }).strict();
function invalid(res: Response, message = "Invalid appointment request.") {
  return res.status(400).json({ error: message, code: "APPOINTMENT_INVALID" });
}
function param(req: Request) { return id.parse(req.params.id); }
function actor(req: Request) { return { id: req.authUser!.id, authVersion: req.authUser!.authVersion }; }
const cursorSchema = z.object({ startsAt: date, id }).strict();
async function list(req: Request, res: Response, next: NextFunction, accessRequest = false) {
  try {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return invalid(res);
    const { cursor: encoded, ...query } = parsed.data;
    const cursor = encoded ? cursorSchema.safeParse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))) : undefined;
    if (cursor && !cursor.success) return invalid(res, "Invalid appointment cursor.");
    if (accessRequest && (!query.from || !query.through)) return invalid(res, "Choose a bounded records date range.");
    const result = await listPasspilotAppointments(res.locals.schoolId!, actor(req), {
      ...query, ...(accessRequest ? { studentId: id.parse(req.params.studentId) } : {}),
      ...(cursor?.success ? { cursor: cursor.data } : {}),
    }, accessRequest);
    return res.json({ ...result, nextCursor: result.nextCursor
      ? Buffer.from(JSON.stringify({ startsAt: result.nextCursor.startsAt.toISOString(), id: result.nextCursor.id })).toString("base64url") : null });
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) return invalid(res);
    next(error);
  }
}
router.get("/", (req, res, next) => list(req, res, next));
// Administrator access/erasure handling is separate from teacher reminders and
// future aggregate reporting. No private notes are copied into pass records.
router.get("/students/:studentId/records", (req, res, next) => list(req, res, next, true));
router.post("/", async (req, res, next) => {
  try {
    const body = createAppointmentSchema.safeParse(req.body);
    if (!body.success) return invalid(res);
    const result = await createPasspilotAppointment(res.locals.schoolId!, actor(req), body.data);
    return res.status(result.replayed ? 200 : 201).json(result);
  } catch (error) { next(error); }
});
router.get("/:id", async (req, res, next) => {
  try { return res.json(await getPasspilotAppointment(res.locals.schoolId!, actor(req), param(req))); }
  catch (error) { if (error instanceof z.ZodError) return invalid(res); next(error); }
});
router.patch("/:id", async (req, res, next) => {
  try {
    const body = editAppointmentSchema.safeParse(req.body);
    if (!body.success) return invalid(res);
    return res.json(await editPasspilotAppointment(res.locals.schoolId!, actor(req), param(req), body.data));
  } catch (error) { if (error instanceof z.ZodError) return invalid(res); next(error); }
});
router.post("/:id/cancel", async (req, res, next) => {
  try {
    const body = cancelAppointmentSchema.safeParse(req.body);
    if (!body.success) return invalid(res);
    return res.json(await cancelPasspilotAppointment(res.locals.schoolId!, actor(req), param(req), body.data.expectedRevision));
  } catch (error) { if (error instanceof z.ZodError) return invalid(res); next(error); }
});
router.post("/:id/activate", async (req, res, next) => {
  try {
    const body = activateAppointmentSchema.safeParse(req.body);
    if (!body.success) return invalid(res);
    const schoolId = res.locals.schoolId!;
    const result = await activatePasspilotAppointment(schoolId, actor(req), param(req), body.data);
    if (result.missed) return res.status(409).json({ error: "The appointment window has ended.", code: "APPOINTMENT_MISSED", appointment: result.appointment });
    return res.status(result.replayed ? 200 : 201).json({ appointment: result.appointment, replayed: result.replayed,
      pass: await normalizePasspilotPass(result.pass!, schoolId, result.viewerRole) });
  } catch (error) {
    if (error instanceof z.ZodError) return invalid(res);
    if (isDatabaseErrorCode(error, "23505")) return res.status(409).json({ error: "Student already has an active pass", code: "APPOINTMENT_ACTIVE_PASS" });
    if (isPasspilotRuleError(error)) {
      await recordPasspilotRuleDenial(error.passpilotRule);
      return res.status(409).json(passpilotRuleTeacherResponse(error, await getRequestPassPilotRole(req, res)));
    }
    next(error);
  }
});
export default router;
