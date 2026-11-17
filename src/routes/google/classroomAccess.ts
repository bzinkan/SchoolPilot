import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/authenticate.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireRole } from "../../middleware/requireRole.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { logAudit } from "../../services/audit.js";
import { disableStudentClassroomAccessForSchool, getStudentClassroomAccessSetupInfo, verifyStudentClassroomAccessForSchool } from "../../services/googleClassroomAccess.js";

const router = Router();
const adminAuth = [authenticate, requireSchoolContext, requireActiveSchool, requireRole("admin", "school_admin")] as const;
export const studentClassroomAccessVerifySchema = z.object({ studentId: z.string().min(1).max(128).regex(/^\S+$/) }).strict();

router.get("/setup-info", ...adminAuth, async (_req, res, next) => {
  try { return res.json(await getStudentClassroomAccessSetupInfo(res.locals.schoolId!)); }
  catch (error) { next(error); }
});

router.post("/verify", ...adminAuth, async (req, res, next) => {
  const parsed = studentClassroomAccessVerifySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ code: "STUDENT_CLASSROOM_VERIFY_INVALID", error: "Choose one current-school student to verify Classroom access." });
  try {
    const result = await verifyStudentClassroomAccessForSchool(res.locals.schoolId!, parsed.data.studentId, req.authUser!.id);
    await logAudit({ schoolId: res.locals.schoolId!, userId: req.authUser!.id,
      userEmail: req.authUser!.email, userRole: res.locals.membershipRole,
      action: "google.student_classroom_access.verified", entityType: "school", entityId: res.locals.schoolId!,
      metadata: { purpose: "student_classroom_access" } });
    return res.json(result);
  } catch (error) { next(error); }
});

router.delete("/", ...adminAuth, async (req, res, next) => {
  if (!z.object({}).strict().safeParse(req.body ?? {}).success)
    return res.status(400).json({ code: "STUDENT_CLASSROOM_VERIFY_INVALID", error: "Refresh the Classroom access setup and retry." });
  try {
    const result = await disableStudentClassroomAccessForSchool(res.locals.schoolId!);
    await logAudit({ schoolId: res.locals.schoolId!, userId: req.authUser!.id,
      userEmail: req.authUser!.email, userRole: res.locals.membershipRole,
      action: "google.student_classroom_access.disabled", entityType: "school", entityId: res.locals.schoolId!,
      metadata: { purpose: "student_classroom_access", rosterImportsPreserved: true } });
    return res.json(result);
  } catch (error) { next(error); }
});

export default router;
