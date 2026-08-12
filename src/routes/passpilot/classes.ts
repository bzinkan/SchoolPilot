import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import {
  getRequestPassPilotRole,
  canAccessGrade,
  isPassPilotManager,
  requireLegacyPasspilotClassSource,
  requirePasspilotClassModel,
  requirePassPilotRole,
} from "../../services/passpilotAccess.js";
import {
  getPasspilotClasses,
  getPasspilotClassRoster,
} from "../../services/passpilotClasses.js";
import {
  addStudentsToLegacyPasspilotGrade,
  removeStudentFromLegacyPasspilotGrade,
} from "../../services/storage.js";
import { logAudit } from "../../services/audit.js";
import { safeStudent } from "../../util/safeStudent.js";

const router = Router();

router.use(
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireProductLicense("PASSPILOT"),
  requirePassPilotRole("admin", "school_admin", "office_staff", "teacher")
);
router.use(requirePasspilotClassModel);

router.get("/", async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const role = await getRequestPassPilotRole(req, res);
    const result = await getPasspilotClasses(schoolId, {
      userId: req.authUser!.id,
      manager: isPassPilotManager(role),
      scope: req.query.scope === "history" ? "history" : "active",
    });
    return res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get("/:id/students", async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const role = await getRequestPassPilotRole(req, res);
    const result = await getPasspilotClassRoster(schoolId, String(req.params.id ?? ""), {
      userId: req.authUser!.id,
      manager: isPassPilotManager(role),
    });
    if (!result) return res.status(404).json({ error: "Class not found" });
    return res.json({
      source: result.source,
      class: result.classRecord,
      students: result.students.map((student) => safeStudent(student)),
    });
  } catch (err) {
    next(err);
  }
});

router.post(
  "/:id/students",
  requireLegacyPasspilotClassSource,
  async (req, res, next) => {
    try {
      const rawStudentIds = req.body?.studentIds;
      if (
        !Array.isArray(rawStudentIds) ||
        rawStudentIds.length === 0 ||
        rawStudentIds.length > 1_000 ||
        rawStudentIds.some((value: unknown) => typeof value !== "string" || !value.trim())
      ) {
        return res.status(400).json({
          error: "studentIds must contain between 1 and 1000 student IDs.",
          code: "PASSPILOT_STUDENT_IDS_INVALID",
        });
      }
      const schoolId = res.locals.schoolId!;
      const classId = String(req.params.id ?? "");
      const role = await getRequestPassPilotRole(req, res);
      if (
        !isPassPilotManager(role) &&
        role !== "super_admin" &&
        !(role === "teacher" && await canAccessGrade(req.authUser!, schoolId, classId, role))
      ) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }
      const result = await addStudentsToLegacyPasspilotGrade(
        schoolId,
        classId,
        rawStudentIds.map((value: string) => value.trim()),
        {
          actorUserId: req.authUser!.id,
          manager: isPassPilotManager(role) || role === "super_admin",
        }
      );
      await logAudit({
        schoolId,
        userId: req.authUser?.id ?? null,
        userEmail: req.authUser?.email,
        userRole: res.locals.membershipRole,
        action: "passpilot.class.roster.add",
        entityType: "grade",
        entityId: classId,
        metadata: {
          requestedCount: result.studentIds.length,
          addedCount: result.addedCount,
          studentIds: result.studentIds,
        },
      });
      return res.json({
        source: "legacy_grades",
        classId,
        ...result,
      });
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  "/:id/students/:studentId",
  requireLegacyPasspilotClassSource,
  async (req, res, next) => {
    try {
      const schoolId = res.locals.schoolId!;
      const classId = String(req.params.id ?? "");
      const studentId = String(req.params.studentId ?? "");
      if (!classId || !studentId) {
        return res.status(400).json({ error: "Class and student are required." });
      }
      const role = await getRequestPassPilotRole(req, res);
      if (
        !isPassPilotManager(role) &&
        role !== "super_admin" &&
        !(role === "teacher" && await canAccessGrade(req.authUser!, schoolId, classId, role))
      ) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }
      const result = await removeStudentFromLegacyPasspilotGrade(
        schoolId,
        classId,
        studentId,
        {
          actorUserId: req.authUser!.id,
          manager: isPassPilotManager(role) || role === "super_admin",
        }
      );
      await logAudit({
        schoolId,
        userId: req.authUser?.id ?? null,
        userEmail: req.authUser?.email,
        userRole: res.locals.membershipRole,
        action: "passpilot.class.roster.remove",
        entityType: "grade",
        entityId: classId,
        metadata: { studentId, removed: result.removed },
      });
      return res.json({
        source: "legacy_grades",
        classId,
        studentId,
        ...result,
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
