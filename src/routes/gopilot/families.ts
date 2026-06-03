import { Router } from "express";
import crypto from "crypto";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import {
  getFamilyGroupsBySchool,
  createFamilyGroup,
  updateFamilyGroup,
  deleteFamilyGroup,
  getFamilyGroupStudents,
  addStudentsToFamilyGroup,
  setFamilyGroupStudents,
  removeStudentFromFamilyGroup,
  autoAssignFamilyGroups,
} from "../../services/storage.js";
import {
  allStudentsBelongToSchool,
  getFamilyGroupForSchool,
  getHomeroomForSchool,
  requireGoPilotRole,
} from "../../services/gopilotAccess.js";
import { generateFamilyGroupNumber } from "../../util/studentCode.js";

const router = Router();

function param(req: any, key: string): string {
  return String(req.params[key] ?? "");
}

const auth = [
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireProductLicense("GOPILOT"),
] as const;

const manageAuth = [
  ...auth,
  requireGoPilotRole("admin", "school_admin", "office_staff"),
] as const;

// ============================================================================
// Family Groups
// ============================================================================

// GET /api/gopilot/family-groups
router.get("/family-groups", ...manageAuth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const groups = await getFamilyGroupsBySchool(schoolId);

    const enriched = await Promise.all(
      groups.map(async (g) => {
        const students = await getFamilyGroupStudents(g.id);

        const enrichedStudents = await Promise.all(
          students.map(async (s) => {
            let homeroomName: string | null = null;
            if (s.homeroomId) {
              // School-scoped lookup so a stray cross-school homeroomId can't
              // surface another school's homeroom name in this list.
              const homeroom = await getHomeroomForSchool(s.homeroomId, schoolId);
              if (homeroom) {
                homeroomName = homeroom.name;
              }
            }
            return {
              id: s.id,
              firstName: s.firstName,
              lastName: s.lastName,
              grade: s.gradeLevel,
              homeroomName,
            };
          })
        );

        return {
          ...g,
          students: enrichedStudents,
        };
      })
    );

    return res.json({ groups: enriched });
  } catch (err) {
    next(err);
  }
});

// POST /api/gopilot/family-groups
router.post(
  "/family-groups",
  ...manageAuth,
  async (req, res, next) => {
    try {
      const schoolId = res.locals.schoolId!;
      const { carNumber, familyName, studentIds } = req.body;

      const num = carNumber || (await generateFamilyGroupNumber(schoolId));

      const inviteToken = crypto.randomBytes(32).toString("hex");
      const group = await createFamilyGroup({
        schoolId,
        carNumber: num,
        familyName: familyName || null,
        inviteToken,
      });

      if (Array.isArray(studentIds) && studentIds.length > 0) {
        if (!(await allStudentsBelongToSchool(studentIds, schoolId))) {
          return res.status(404).json({ error: "One or more students not found" });
        }
        await addStudentsToFamilyGroup(group.id, studentIds);
      }

      return res.status(201).json({ group });
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/gopilot/family-groups/:id
router.put("/family-groups/:id", ...manageAuth, async (req, res, next) => {
  try {
    const id = param(req, "id");
    const existing = await getFamilyGroupForSchool(id, res.locals.schoolId!);
    if (!existing) {
      return res.status(404).json({ error: "Family group not found" });
    }

    const { familyName, carNumber, studentIds } = req.body;

    const data: Record<string, unknown> = {};
    if (carNumber !== undefined) data.carNumber = carNumber;
    if (familyName !== undefined) data.familyName = familyName;

    const updated = await updateFamilyGroup(id, data);
    if (!updated) {
      return res.status(404).json({ error: "Family group not found" });
    }

    if (studentIds !== undefined) {
      if (!Array.isArray(studentIds)) {
        return res.status(400).json({ error: "studentIds must be an array" });
      }
      if (!(await allStudentsBelongToSchool(studentIds, res.locals.schoolId!))) {
        return res.status(404).json({ error: "One or more students not found" });
      }
      await setFamilyGroupStudents(id, studentIds);
    }

    return res.json({ group: updated });
  } catch (err) {
    next(err);
  }
});

// POST /api/gopilot/family-groups/:id/students
router.post(
  "/family-groups/:id/students",
  ...manageAuth,
  async (req, res, next) => {
    try {
      const group = await getFamilyGroupForSchool(param(req, "id"), res.locals.schoolId!);
      if (!group) {
        return res.status(404).json({ error: "Family group not found" });
      }
      const { studentIds } = req.body;
      if (!Array.isArray(studentIds) || studentIds.length === 0) {
        return res.status(400).json({ error: "studentIds array required" });
      }
      if (!(await allStudentsBelongToSchool(studentIds, res.locals.schoolId!))) {
        return res.status(404).json({ error: "One or more students not found" });
      }
      await addStudentsToFamilyGroup(param(req, "id"), studentIds);
      return res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/gopilot/family-groups/:groupId/students/:studentId
router.delete(
  "/family-groups/:groupId/students/:studentId",
  ...manageAuth,
  async (req, res, next) => {
    try {
      const group = await getFamilyGroupForSchool(param(req, "groupId"), res.locals.schoolId!);
      if (!group || !(await allStudentsBelongToSchool([param(req, "studentId")], res.locals.schoolId!))) {
        return res.status(404).json({ error: "Family group or student not found" });
      }
      await removeStudentFromFamilyGroup(
        param(req, "groupId"),
        param(req, "studentId")
      );
      return res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/gopilot/family-groups/:id
router.delete("/family-groups/:id", ...manageAuth, async (req, res, next) => {
  try {
    const group = await getFamilyGroupForSchool(param(req, "id"), res.locals.schoolId!);
    if (!group) {
      return res.status(404).json({ error: "Family group not found" });
    }
    await deleteFamilyGroup(param(req, "id"));
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/gopilot/family-groups/auto-assign
router.post(
  "/family-groups/auto-assign",
  ...manageAuth,
  async (req, res, next) => {
    try {
      const schoolId = res.locals.schoolId!;
      const result = await autoAssignFamilyGroups(schoolId);
      return res.json({
        created: result.created,
        total: result.assigned,
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
