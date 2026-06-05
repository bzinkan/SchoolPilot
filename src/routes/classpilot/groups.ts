import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import { requireRole } from "../../middleware/requireRole.js";
import {
  getGroupsBySchool,
  getGroupsByTeacher,
  getGroupByIdAndSchool,
  getSubgroupByIdAndSchool,
  createGroup,
  updateGroup,
  deleteGroup,
  getGroupStudents,
  addGroupStudents,
  removeGroupStudent,
  setGroupStudents,
  getStudentsByIds,
  getSubgroupsByGroup,
  createSubgroup,
  updateSubgroup,
  deleteSubgroup,
  getSubgroupMembers,
  addSubgroupMembers,
  removeSubgroupMember,
  getGroupTeachers,
  addGroupTeacher,
  removeGroupTeacher,
  getUserById,
} from "../../services/storage.js";

const router = Router();

function param(req: any, key: string): string {
  return String(req.params[key] ?? "");
}

// Filter a list of student ids down to those that actually belong to the
// caller's school — prevents pulling another school's students into a group.
async function studentsInSchool(studentIds: unknown, schoolId: string): Promise<string[]> {
  if (!Array.isArray(studentIds) || studentIds.length === 0) return [];
  const ids = studentIds.map(String);
  const rows = await getStudentsByIds(ids);
  return rows.filter((s) => s.schoolId === schoolId).map((s) => s.id);
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
    const group = await getGroupByIdAndSchool(param(req, "id"), res.locals.schoolId!);
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
    const { name, description, periodLabel, gradeLevel, groupType, studentIds,
            scheduleEnabled, blockStartTime, blockEndTime } = req.body;
    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }

    // Validate schedule times if scheduling is enabled
    if (scheduleEnabled) {
      if (!blockStartTime || !blockEndTime) {
        return res.status(400).json({ error: "blockStartTime and blockEndTime are required when scheduling is enabled" });
      }
      if (blockStartTime >= blockEndTime) {
        return res.status(400).json({ error: "blockStartTime must be before blockEndTime" });
      }
    }

    const group = await createGroup({
      schoolId: res.locals.schoolId!,
      teacherId: req.authUser!.id,
      name,
      description: description || null,
      periodLabel: periodLabel || null,
      gradeLevel: gradeLevel || null,
      groupType: groupType || "teacher_created",
      scheduleEnabled: scheduleEnabled || false,
      blockStartTime: scheduleEnabled ? blockStartTime : null,
      blockEndTime: scheduleEnabled ? blockEndTime : null,
    });

    // Seed the junction table with the creator as primary teacher
    await addGroupTeacher(group.id, req.authUser!.id, "primary");

    const validStudentIds = await studentsInSchool(studentIds, res.locals.schoolId!);
    if (validStudentIds.length > 0) {
      await addGroupStudents(group.id, validStudentIds);
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
    const existing = await getGroupByIdAndSchool(id, res.locals.schoolId!);
    if (!existing) {
      return res.status(404).json({ error: "Group not found" });
    }
    const { name, description, periodLabel, gradeLevel, studentIds,
            scheduleEnabled, blockStartTime, blockEndTime } = req.body;

    const data: Record<string, unknown> = {};
    if (name !== undefined) data.name = name;
    if (description !== undefined) data.description = description;
    if (periodLabel !== undefined) data.periodLabel = periodLabel;
    if (gradeLevel !== undefined) data.gradeLevel = gradeLevel;

    if (scheduleEnabled !== undefined) {
      data.scheduleEnabled = scheduleEnabled;
      if (scheduleEnabled) {
        if (!blockStartTime || !blockEndTime) {
          return res.status(400).json({ error: "blockStartTime and blockEndTime are required when scheduling is enabled" });
        }
        if (blockStartTime >= blockEndTime) {
          return res.status(400).json({ error: "blockStartTime must be before blockEndTime" });
        }
        data.blockStartTime = blockStartTime;
        data.blockEndTime = blockEndTime;
        // Clear skip when schedule times are updated — allows auto-start with new times
        data.scheduleSkippedDate = null;
      } else {
        data.blockStartTime = null;
        data.blockEndTime = null;
        data.scheduleSkippedDate = null;
      }
    } else {
      if (blockStartTime !== undefined) data.blockStartTime = blockStartTime;
      if (blockEndTime !== undefined) data.blockEndTime = blockEndTime;
    }

    const updated = await updateGroup(id, data);
    if (!updated) {
      return res.status(404).json({ error: "Group not found" });
    }

    if (studentIds !== undefined) {
      await setGroupStudents(id, await studentsInSchool(studentIds, res.locals.schoolId!));
    }

    return res.json({ group: updated });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/classpilot/groups/:id - Delete group
router.delete("/:id", ...auth, async (req, res, next) => {
  try {
    const existing = await getGroupByIdAndSchool(param(req, "id"), res.locals.schoolId!);
    if (!existing) {
      return res.status(404).json({ error: "Group not found" });
    }
    await deleteGroup(param(req, "id"));
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/classpilot/groups/:id/students - List students in group
router.get("/:id/students", ...auth, async (req, res, next) => {
  try {
    const group = await getGroupByIdAndSchool(param(req, "id"), res.locals.schoolId!);
    if (!group) {
      return res.status(404).json({ error: "Group not found" });
    }
    const rows = await getGroupStudents(group.id);
    const students = rows.map((r) => ({
      id: r.student.id,
      studentName: [r.student.firstName, r.student.lastName].filter(Boolean).join(" ") || r.student.email || "",
      studentEmail: r.student.email || "",
      gradeLevel: r.student.gradeLevel || null,
      firstName: r.student.firstName,
      lastName: r.student.lastName,
      email: r.student.email,
    }));
    return res.json(students);
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
    const group = await getGroupByIdAndSchool(param(req, "id"), res.locals.schoolId!);
    if (!group) {
      return res.status(404).json({ error: "Group not found" });
    }
    await addGroupStudents(group.id, await studentsInSchool(studentIds, res.locals.schoolId!));
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/groups/:id/students/:studentId - Add single student to group
router.post("/:id/students/:studentId", ...auth, async (req, res, next) => {
  try {
    const group = await getGroupByIdAndSchool(param(req, "id"), res.locals.schoolId!);
    if (!group) {
      return res.status(404).json({ error: "Group not found" });
    }
    const valid = await studentsInSchool([param(req, "studentId")], res.locals.schoolId!);
    if (valid.length === 0) {
      return res.status(404).json({ error: "Student not found" });
    }
    await addGroupStudents(group.id, valid);
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/classpilot/groups/:groupId/students/:studentId - Remove student from group
router.delete("/:groupId/students/:studentId", ...auth, async (req, res, next) => {
  try {
    const group = await getGroupByIdAndSchool(param(req, "groupId"), res.locals.schoolId!);
    if (!group) {
      return res.status(404).json({ error: "Group not found" });
    }
    await removeGroupStudent(group.id, param(req, "studentId"));
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
    const group = await getGroupByIdAndSchool(param(req, "groupId"), res.locals.schoolId!);
    if (!group) {
      return res.status(404).json({ error: "Group not found" });
    }
    const subgroups = await getSubgroupsByGroup(group.id);

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

    const group = await getGroupByIdAndSchool(param(req, "groupId"), res.locals.schoolId!);
    if (!group) {
      return res.status(404).json({ error: "Group not found" });
    }

    const subgroup = await createSubgroup({
      groupId: group.id,
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
    const subgroupId = param(req, "subgroupId");
    const existing = await getSubgroupByIdAndSchool(subgroupId, res.locals.schoolId!);
    if (!existing) {
      return res.status(404).json({ error: "Subgroup not found" });
    }
    const { name, color } = req.body;
    const data: Record<string, unknown> = {};
    if (name !== undefined) data.name = name;
    if (color !== undefined) data.color = color;

    const updated = await updateSubgroup(subgroupId, data);
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
    const subgroupId = param(req, "subgroupId");
    const existing = await getSubgroupByIdAndSchool(subgroupId, res.locals.schoolId!);
    if (!existing) {
      return res.status(404).json({ error: "Subgroup not found" });
    }
    await deleteSubgroup(subgroupId);
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/classpilot/subgroups/:subgroupId/members - List members
router.get("/subgroups/:subgroupId/members", ...auth, async (req, res, next) => {
  try {
    const subgroupId = param(req, "subgroupId");
    const existing = await getSubgroupByIdAndSchool(subgroupId, res.locals.schoolId!);
    if (!existing) {
      return res.status(404).json({ error: "Subgroup not found" });
    }
    const members = await getSubgroupMembers(subgroupId);
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
    const subgroupId = param(req, "subgroupId");
    const existing = await getSubgroupByIdAndSchool(subgroupId, res.locals.schoolId!);
    if (!existing) {
      return res.status(404).json({ error: "Subgroup not found" });
    }
    await addSubgroupMembers(subgroupId, await studentsInSchool(studentIds, res.locals.schoolId!));
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/classpilot/subgroups/:subgroupId/members/:studentId - Remove member
router.delete("/subgroups/:subgroupId/members/:studentId", ...auth, async (req, res, next) => {
  try {
    const subgroupId = param(req, "subgroupId");
    const existing = await getSubgroupByIdAndSchool(subgroupId, res.locals.schoolId!);
    if (!existing) {
      return res.status(404).json({ error: "Subgroup not found" });
    }
    await removeSubgroupMember(subgroupId, param(req, "studentId"));
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Co-teacher management
// ============================================================================

// GET /api/classpilot/groups/:id/teachers - List teachers for a group
router.get("/:id/teachers", ...auth, async (req, res, next) => {
  try {
    const group = await getGroupByIdAndSchool(param(req, "id"), res.locals.schoolId!);
    if (!group) {
      return res.status(404).json({ error: "Group not found" });
    }
    const teachers = await getGroupTeachers(group.id);

    // Enrich with user info
    const enriched = [];
    for (const t of teachers) {
      const user = await getUserById(t.teacherId);
      enriched.push({
        ...t,
        teacher: user
          ? {
              id: user.id,
              firstName: user.firstName,
              lastName: user.lastName,
              name: `${user.firstName} ${user.lastName}`,
            }
          : null,
      });
    }

    return res.json({ teachers: enriched });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/groups/:id/teachers - Add co-teacher
router.post("/:id/teachers", ...auth, requireRole("admin"), async (req, res, next) => {
  try {
    const { teacherId, role } = req.body;
    if (!teacherId) {
      return res.status(400).json({ error: "teacherId is required" });
    }

    const group = await getGroupByIdAndSchool(param(req, "id"), res.locals.schoolId!);
    if (!group) {
      return res.status(404).json({ error: "Group not found" });
    }

    const teacher = await addGroupTeacher(
      group.id,
      teacherId,
      role || "co-teacher"
    );
    return res.status(201).json({ teacher });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/classpilot/groups/:id/teachers/:teacherId - Remove co-teacher
router.delete("/:id/teachers/:teacherId", ...auth, requireRole("admin"), async (req, res, next) => {
  try {
    const group = await getGroupByIdAndSchool(param(req, "id"), res.locals.schoolId!);
    if (!group) {
      return res.status(404).json({ error: "Group not found" });
    }

    const removed = await removeGroupTeacher(group.id, param(req, "teacherId"));
    if (!removed) {
      return res.status(404).json({ error: "Teacher not found in group" });
    }
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
