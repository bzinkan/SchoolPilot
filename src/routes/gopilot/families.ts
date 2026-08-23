import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireGopilotEntitlement } from "../../middleware/requireGopilotEntitlement.js";
import { rejectDisabledGoPilotParent } from "../../middleware/rejectDisabledGoPilotParent.js";
import {
  getFamilyGroupsBySchool,
  createFamilyGroupWithStudents,
  updateFamilyGroupWithStudents,
  deleteFamilyGroup,
  getFamilyGroupStudents,
  addStudentsToFamilyGroup,
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
import { logAudit } from "../../services/audit.js";

const router = Router();

function param(req: any, key: string): string {
  return String(req.params[key] ?? "");
}

const auth = [
  authenticate,
  requireSchoolContext,
  rejectDisabledGoPilotParent,
  requireGopilotEntitlement,
  requireActiveSchool,
] as const;

const manageAuth = [
  ...auth,
  requireGoPilotRole("admin", "school_admin", "office_staff"),
] as const;

function familyGroupDto(group: {
  id: string;
  carNumber: string;
  familyName?: string | null;
  createdAt: Date | string;
}) {
  return {
    id: group.id,
    carNumber: group.carNumber,
    familyName: group.familyName ?? null,
    createdAt: group.createdAt,
  };
}

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
          ...familyGroupDto(g),
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

      if (
        Array.isArray(studentIds) &&
        studentIds.length > 0 &&
        !(await allStudentsBelongToSchool(studentIds, schoolId))
      ) {
        return res.status(404).json({ error: "One or more students not found" });
      }

      const num = carNumber || (await generateFamilyGroupNumber(schoolId));

      const group = await createFamilyGroupWithStudents({
        schoolId,
        carNumber: num,
        familyName: familyName || null,
        // Family groups and car numbers are internal staff identifiers. The
        // former parent invitation tokens are retained only as historical data
        // and are never generated for new groups.
        inviteToken: null,
      }, Array.isArray(studentIds) ? studentIds : []);

      await logAudit({
        schoolId,
        userId: req.authUser!.id,
        userEmail: req.authUser!.email,
        userRole: res.locals.gopilotRole,
        action: "gopilot.family_group.created",
        entityType: "family_group",
        entityId: group.id,
        metadata: { studentCount: Array.isArray(studentIds) ? studentIds.length : 0 },
      });

      return res.status(201).json({ group: familyGroupDto(group) });
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

    if (studentIds !== undefined) {
      if (!Array.isArray(studentIds)) {
        return res.status(400).json({ error: "studentIds must be an array" });
      }
      if (!(await allStudentsBelongToSchool(studentIds, res.locals.schoolId!))) {
        return res.status(404).json({ error: "One or more students not found" });
      }
    }

    const updated = await updateFamilyGroupWithStudents(
      id,
      res.locals.schoolId!,
      data,
      studentIds
    );
    if (!updated) {
      return res.status(404).json({ error: "Family group not found" });
    }

    await logAudit({
      schoolId: res.locals.schoolId!,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.gopilotRole,
      action: "gopilot.family_group.updated",
      entityType: "family_group",
      entityId: id,
      changes: {
        fields: [
          ...(familyName !== undefined ? ["familyName"] : []),
          ...(carNumber !== undefined ? ["carNumber"] : []),
          ...(studentIds !== undefined ? ["studentIds"] : []),
        ],
      },
      metadata: { studentCount: Array.isArray(studentIds) ? studentIds.length : undefined },
    });

    return res.json({ group: familyGroupDto(updated) });
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
      await logAudit({
        schoolId: res.locals.schoolId!,
        userId: req.authUser!.id,
        userEmail: req.authUser!.email,
        userRole: res.locals.gopilotRole,
        action: "gopilot.family_group.students_added",
        entityType: "family_group",
        entityId: param(req, "id"),
        metadata: { studentCount: studentIds.length },
      });
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
      await logAudit({
        schoolId: res.locals.schoolId!,
        userId: req.authUser!.id,
        userEmail: req.authUser!.email,
        userRole: res.locals.gopilotRole,
        action: "gopilot.family_group.student_removed",
        entityType: "family_group",
        entityId: param(req, "groupId"),
        metadata: { studentCount: 1 },
      });
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
    const deleted = await deleteFamilyGroup(param(req, "id"), res.locals.schoolId!);
    if (!deleted) {
      return res.status(404).json({ error: "Family group not found" });
    }
    await logAudit({
      schoolId: res.locals.schoolId!,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.gopilotRole,
      action: "gopilot.family_group.deleted",
      entityType: "family_group",
      entityId: param(req, "id"),
    });
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
      await logAudit({
        schoolId,
        userId: req.authUser!.id,
        userEmail: req.authUser!.email,
        userRole: res.locals.gopilotRole,
        action: "gopilot.family_groups.auto_assigned",
        entityType: "school",
        entityId: schoolId,
        metadata: { createdCount: result.created, assignedCount: result.assigned },
      });
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
