import { Router } from "express";
import crypto from "crypto";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import { requireRole } from "../../middleware/requireRole.js";
import {
  getFamilyGroupsBySchool,
  getFamilyGroupById,
  createFamilyGroup,
  updateFamilyGroup,
  deleteFamilyGroup,
  getFamilyGroupStudents,
  addStudentsToFamilyGroup,
  setFamilyGroupStudents,
  removeStudentFromFamilyGroup,
  getUnassignedStudents,
  getHomeroomById,
} from "../../services/storage.js";
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

// ============================================================================
// Family Groups
// ============================================================================

// GET /api/gopilot/family-groups
router.get("/family-groups", ...auth, async (req, res, next) => {
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
              const homeroom = await getHomeroomById(s.homeroomId);
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
  ...auth,
  requireRole("admin", "office_staff"),
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
        await addStudentsToFamilyGroup(group.id, studentIds);
      }

      return res.status(201).json({ group });
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/gopilot/family-groups/:id
router.put("/family-groups/:id", ...auth, async (req, res, next) => {
  try {
    const id = param(req, "id");
    const { familyName, carNumber, studentIds } = req.body;

    const data: Record<string, unknown> = {};
    if (carNumber !== undefined) data.carNumber = carNumber;
    if (familyName !== undefined) data.familyName = familyName;

    const updated = await updateFamilyGroup(id, data);
    if (!updated) {
      return res.status(404).json({ error: "Family group not found" });
    }

    if (studentIds !== undefined) {
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
  ...auth,
  async (req, res, next) => {
    try {
      const { studentIds } = req.body;
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
  ...auth,
  async (req, res, next) => {
    try {
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
router.delete("/family-groups/:id", ...auth, async (req, res, next) => {
  try {
    await deleteFamilyGroup(param(req, "id"));
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/gopilot/family-groups/auto-assign
router.post(
  "/family-groups/auto-assign",
  ...auth,
  requireRole("admin", "office_staff"),
  async (req, res, next) => {
    try {
      const schoolId = res.locals.schoolId!;
      const unassigned = await getUnassignedStudents(schoolId);

      let created = 0;
      for (const student of unassigned) {
        const carNum = await generateFamilyGroupNumber(schoolId);
        const inviteToken = crypto.randomBytes(32).toString("hex");
        const group = await createFamilyGroup({
          schoolId,
          carNumber: carNum,
          familyName: `${student.lastName} Family`,
          inviteToken,
        });
        await addStudentsToFamilyGroup(group.id, [student.id]);
        created++;
      }

      return res.json({ created, total: unassigned.length });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
