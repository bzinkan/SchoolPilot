import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import { requireRole } from "../../middleware/requireRole.js";
import {
  getGroupsBySchool,
  getGroupsByTeacher,
  getGroupById,
  createGroup,
  updateGroup,
  deleteGroup,
  getGroupStudents,
  addGroupStudents,
  removeGroupStudent,
  setGroupStudents,
  getSubgroupsByGroup,
  createSubgroup,
  updateSubgroup,
  deleteSubgroup,
  getSubgroupMembers,
  addSubgroupMembers,
  removeSubgroupMember,
} from "../../services/storage.js";

const router = Router();

function param(req: any, key: string): string {
  return String(req.params[key] ?? "");
}

const auth = [
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireProductLicense("CLASSPILOT"),
] as const;

// ============================================================================
// Groups
// ============================================================================

// GET /api/classpilot/groups - List groups (admin sees all, teacher sees own)
router.get("/", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const user = req.authUser!;

    // Get membership to check role
    const membership = (req as any).membership;
    const role = membership?.role || "teacher";

    let groups;
    if (role === "admin" || role === "school_admin" || user.isSuperAdmin) {
      groups = await getGroupsBySchool(schoolId);
    } else {
      groups = await getGroupsByTeacher(user.id);
    }

    // Enrich with student counts
    const enriched = await Promise.all(
      groups.map(async (g) => {
        const students = await getGroupStudents(g.id);
        return { ...g, studentCount: students.length };
      })
    );

    return res.json({ groups: enriched });
  } catch (err) {
    next(err);
  }
});

// GET /api/classpilot/groups/:id - Get group details with students
router.get("/:id", ...auth, async (req, res, next) => {
  try {
    const group = await getGroupById(param(req, "id"));
    if (!group) {
      return res.status(404).json({ error: "Group not found" });
    }

    const students = await getGroupStudents(group.id);
    const subgroups = await getSubgroupsByGroup(group.id);

    return res.json({ group, students, subgroups });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/groups - Create group
router.post("/", ...auth, async (req, res, next) => {
  try {
    const { name, description, periodLabel, gradeLevel, groupType, studentIds } = req.body;
    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }

    const group = await createGroup({
      schoolId: res.locals.schoolId!,
      teacherId: req.authUser!.id,
      name,
      description: description || null,
      periodLabel: periodLabel || null,
      gradeLevel: gradeLevel || null,
      groupType: groupType || "teacher_created",
    });

    if (Array.isArray(studentIds) && studentIds.length > 0) {
      await addGroupStudents(group.id, studentIds);
    }

    return res.status(201).json({ group });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/classpilot/groups/:id - Update group
router.patch("/:id", ...auth, async (req, res, next) => {
  try {
    const id = param(req, "id");
    const { name, description, periodLabel, gradeLevel, studentIds } = req.body;

    const data: Record<string, unknown> = {};
    if (name !== undefined) data.name = name;
    if (description !== undefined) data.description = description;
    if (periodLabel !== undefined) data.periodLabel = periodLabel;
    if (gradeLevel !== undefined) data.gradeLevel = gradeLevel;

    const updated = await updateGroup(id, data);
    if (!updated) {
      return res.status(404).json({ error: "Group not found" });
    }

    if (studentIds !== undefined) {
      await setGroupStudents(id, studentIds);
    }

    return res.json({ group: updated });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/classpilot/groups/:id - Delete group
router.delete("/:id", ...auth, async (req, res, next) => {
  try {
    const existing = await getGroupById(param(req, "id"));
    if (!existing) {
      return res.status(404).json({ error: "Group not found" });
    }
    await deleteGroup(param(req, "id"));
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/groups/:id/students - Add students to group
router.post("/:id/students", ...auth, async (req, res, next) => {
  try {
    const { studentIds } = req.body;
    if (!Array.isArray(studentIds)) {
      return res.status(400).json({ error: "studentIds array required" });
    }
    await addGroupStudents(param(req, "id"), studentIds);
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/classpilot/groups/:groupId/students/:studentId - Remove student from group
router.delete("/:groupId/students/:studentId", ...auth, async (req, res, next) => {
  try {
    await removeGroupStudent(param(req, "groupId"), param(req, "studentId"));
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Subgroups
// ============================================================================

// GET /api/classpilot/groups/:groupId/subgroups - List subgroups
router.get("/:groupId/subgroups", ...auth, async (req, res, next) => {
  try {
    const subgroups = await getSubgroupsByGroup(param(req, "groupId"));

    const enriched = await Promise.all(
      subgroups.map(async (sg) => {
        const members = await getSubgroupMembers(sg.id);
        return { ...sg, memberCount: members.length };
      })
    );

    return res.json({ subgroups: enriched });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/groups/:groupId/subgroups - Create subgroup
router.post("/:groupId/subgroups", ...auth, async (req, res, next) => {
  try {
    const { name, color } = req.body;
    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }

    const subgroup = await createSubgroup({
      groupId: param(req, "groupId"),
      name,
      color: color || null,
    });

    return res.status(201).json({ subgroup });
  } catch (err) {
    next(err);
  }
});

// PUT /api/classpilot/subgroups/:subgroupId - Update subgroup
router.put("/subgroups/:subgroupId", ...auth, async (req, res, next) => {
  try {
    const { name, color } = req.body;
    const data: Record<string, unknown> = {};
    if (name !== undefined) data.name = name;
    if (color !== undefined) data.color = color;

    const updated = await updateSubgroup(param(req, "subgroupId"), data);
    if (!updated) {
      return res.status(404).json({ error: "Subgroup not found" });
    }
    return res.json({ subgroup: updated });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/classpilot/subgroups/:subgroupId - Delete subgroup
router.delete("/subgroups/:subgroupId", ...auth, async (req, res, next) => {
  try {
    await deleteSubgroup(param(req, "subgroupId"));
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/classpilot/subgroups/:subgroupId/members - List members
router.get("/subgroups/:subgroupId/members", ...auth, async (req, res, next) => {
  try {
    const members = await getSubgroupMembers(param(req, "subgroupId"));
    return res.json({ members });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/subgroups/:subgroupId/members - Add members
router.post("/subgroups/:subgroupId/members", ...auth, async (req, res, next) => {
  try {
    const { studentIds } = req.body;
    if (!Array.isArray(studentIds)) {
      return res.status(400).json({ error: "studentIds array required" });
    }
    await addSubgroupMembers(param(req, "subgroupId"), studentIds);
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/classpilot/subgroups/:subgroupId/members/:studentId - Remove member
router.delete("/subgroups/:subgroupId/members/:studentId", ...auth, async (req, res, next) => {
  try {
    await removeSubgroupMember(param(req, "subgroupId"), param(req, "studentId"));
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
