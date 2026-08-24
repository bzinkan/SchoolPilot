import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireGopilotEntitlement } from "../../middleware/requireGopilotEntitlement.js";
import { rejectDisabledGoPilotParent } from "../../middleware/rejectDisabledGoPilotParent.js";
import {
  getHomeroomsBySchool,
  createHomeroomWithPrimaryTeacher,
  updateHomeroomWithPrimaryTeacher,
  deleteHomeroom,
  assignStudentsToHomeroom,
  searchStudents,
  getUserById,
  getMembershipByUserAndSchool,
  getHomeroomTeachers,
  addHomeroomTeacher,
  removeHomeroomTeacher,
} from "../../services/storage.js";
import {
  allStudentsBelongToSchool,
  effectiveGoPilotRole,
  getRequestGoPilotRole,
  getHomeroomForSchool,
  getTeacherHomeroomIds,
  isGoPilotManager,
  requireGoPilotRole,
} from "../../services/gopilotAccess.js";
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

async function isActiveSchoolTeacher(userId: string, schoolId: string): Promise<boolean> {
  const membership = await getMembershipByUserAndSchool(userId, schoolId);
  if (!membership || membership.status !== "active") return false;
  return effectiveGoPilotRole(membership) === "teacher";
}

// GET /api/gopilot/homerooms/mine - Teacher's own homerooms
router.get("/mine", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const userId = req.authUser!.id;

    // Find homerooms where this teacher is assigned (primary or co-teacher)
    const allHomerooms = await getHomeroomsBySchool(schoolId);
    const myHomeroomIds = new Set<string>();
    for (const h of allHomerooms) {
      const teachers = await getHomeroomTeachers(h.id);
      if (teachers.some((t) => t.teacherId === userId)) {
        myHomeroomIds.add(h.id);
      }
    }
    const mine = allHomerooms.filter((h) => myHomeroomIds.has(h.id));

    // Get student counts
    const allStudents = await searchStudents(schoolId, { status: "active" });
    const countMap = new Map<string, number>();
    for (const s of allStudents) {
      if (s.homeroomId) {
        countMap.set(s.homeroomId, (countMap.get(s.homeroomId) ?? 0) + 1);
      }
    }

    // Enrich with teacher info
    const uniqueTeacherIds = [
      ...new Set(mine.map((r) => r.teacherId).filter(Boolean)),
    ] as string[];
    const teacherMap = new Map<
      string,
      { id: string; firstName: string; lastName: string }
    >();
    for (const tid of uniqueTeacherIds) {
      const user = await getUserById(tid);
      if (user) teacherMap.set(tid, user);
    }

    const homerooms = mine.map((r) => ({
      ...r,
      teacher:
        r.teacherId && teacherMap.has(r.teacherId)
          ? {
              id: teacherMap.get(r.teacherId)!.id,
              firstName: teacherMap.get(r.teacherId)!.firstName,
              lastName: teacherMap.get(r.teacherId)!.lastName,
              name: `${teacherMap.get(r.teacherId)!.firstName} ${teacherMap.get(r.teacherId)!.lastName}`,
            }
          : null,
      studentCount: countMap.get(r.id) ?? 0,
    }));

    return res.json({ homerooms });
  } catch (err) {
    next(err);
  }
});

// GET /api/gopilot/homerooms - List homerooms with teacher and student count
router.get("/", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const role = await getRequestGoPilotRole(req, res);
    if (!role || (role !== "teacher" && !isGoPilotManager(role))) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    const allRows = await getHomeroomsBySchool(schoolId);
    let rows = allRows;
    if (role === "teacher") {
      const allowedHomeroomIds = await getTeacherHomeroomIds(req.authUser!.id, schoolId);
      rows = allRows.filter((row) => allowedHomeroomIds.has(row.id));
    }

    // Get student counts per homeroom
    const allStudents = role === "teacher"
      ? (
          await Promise.all(
            rows.map((row) => searchStudents(schoolId, { status: "active", homeroomId: row.id }))
          )
        ).flat()
      : await searchStudents(schoolId, { status: "active" });
    const countMap = new Map<string, number>();
    for (const s of allStudents) {
      if (s.homeroomId) {
        countMap.set(s.homeroomId, (countMap.get(s.homeroomId) ?? 0) + 1);
      }
    }

    // Enrich with teacher info
    const teacherIds = [...new Set(rows.map((r) => r.teacherId).filter(Boolean))] as string[];
    const teacherMap = new Map<string, { id: string; firstName: string; lastName: string }>();
    for (const tid of teacherIds) {
      const user = await getUserById(tid);
      if (user) teacherMap.set(tid, user);
    }

    const homerooms = rows.map((r) => ({
      ...r,
      teacher: r.teacherId && teacherMap.has(r.teacherId)
        ? {
            id: teacherMap.get(r.teacherId)!.id,
            firstName: teacherMap.get(r.teacherId)!.firstName,
            lastName: teacherMap.get(r.teacherId)!.lastName,
            name: `${teacherMap.get(r.teacherId)!.firstName} ${teacherMap.get(r.teacherId)!.lastName}`,
          }
        : null,
      studentCount: countMap.get(r.id) ?? 0,
    }));

    return res.json({ homerooms });
  } catch (err) {
    next(err);
  }
});

// POST /api/gopilot/homerooms - Create homeroom
router.post("/", ...manageAuth, async (req, res, next) => {
  try {
    const { name, grade, room, teacherId } = req.body;
    if (!name || !grade) {
      return res
        .status(400)
        .json({ error: "name and grade are required" });
    }
    if (teacherId && !(await isActiveSchoolTeacher(teacherId, res.locals.schoolId!))) {
      return res.status(404).json({ error: "Teacher not found" });
    }

    const homeroom = await createHomeroomWithPrimaryTeacher({
      schoolId: res.locals.schoolId!,
      name,
      grade,
      room: room || null,
      teacherId: teacherId || null,
    });

    await logAudit({
      schoolId: res.locals.schoolId!,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.gopilotRole,
      action: "gopilot.homeroom.created",
      entityType: "homeroom",
      entityId: homeroom.id,
      changes: { fields: ["name", "grade", ...(room ? ["room"] : []), ...(teacherId ? ["teacherId"] : [])] },
    });

    return res.status(201).json({ homeroom });
  } catch (err) {
    next(err);
  }
});

// PUT /api/gopilot/homerooms/:id - Update homeroom
router.put("/:id", ...manageAuth, async (req, res, next) => {
  try {
    const id = param(req, "id");
    const existing = await getHomeroomForSchool(id, res.locals.schoolId!);
    if (!existing) {
      return res.status(404).json({ error: "Homeroom not found" });
    }

    const { name, grade, room, teacherId } = req.body;
    if (teacherId && !(await isActiveSchoolTeacher(teacherId, res.locals.schoolId!))) {
      return res.status(404).json({ error: "Teacher not found" });
    }

    const updated = await updateHomeroomWithPrimaryTeacher(id, res.locals.schoolId!, {
      ...(name !== undefined && { name }),
      ...(grade !== undefined && { grade }),
      ...(room !== undefined && { room }),
      ...(teacherId !== undefined && { teacherId }),
    });

    if (!updated) {
      return res.status(404).json({ error: "Homeroom not found" });
    }

    await logAudit({
      schoolId: res.locals.schoolId!,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.gopilotRole,
      action: "gopilot.homeroom.updated",
      entityType: "homeroom",
      entityId: id,
      changes: {
        fields: [
          ...(name !== undefined ? ["name"] : []),
          ...(grade !== undefined ? ["grade"] : []),
          ...(room !== undefined ? ["room"] : []),
          ...(teacherId !== undefined ? ["teacherId"] : []),
        ],
      },
    });

    return res.json({ homeroom: updated });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/gopilot/homerooms/:id - Delete homeroom
router.delete("/:id", ...manageAuth, async (req, res, next) => {
  try {
    const existing = await getHomeroomForSchool(param(req, "id"), res.locals.schoolId!);
    if (!existing) {
      return res.status(404).json({ error: "Homeroom not found" });
    }
    const deleted = await deleteHomeroom(param(req, "id"), res.locals.schoolId!);
    if (!deleted) {
      return res.status(404).json({ error: "Homeroom not found" });
    }
    await logAudit({
      schoolId: res.locals.schoolId!,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.gopilotRole,
      action: "gopilot.homeroom.deleted",
      entityType: "homeroom",
      entityId: param(req, "id"),
    });
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/gopilot/homerooms/:id/assign - Bulk assign students
router.post("/:id/assign", ...manageAuth, async (req, res, next) => {
  try {
    const id = param(req, "id");
    const { studentIds } = req.body;

    if (!Array.isArray(studentIds) || studentIds.length === 0) {
      return res.status(400).json({ error: "studentIds array required" });
    }

    const homeroom = await getHomeroomForSchool(id, res.locals.schoolId!);
    if (!homeroom) {
      return res.status(404).json({ error: "Homeroom not found" });
    }
    if (!(await allStudentsBelongToSchool(studentIds, res.locals.schoolId!))) {
      return res.status(404).json({ error: "One or more students not found" });
    }

    await assignStudentsToHomeroom(id, studentIds);
    await logAudit({
      schoolId: res.locals.schoolId!,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.gopilotRole,
      action: "gopilot.homeroom.students_assigned",
      entityType: "homeroom",
      entityId: id,
      metadata: { studentCount: studentIds.length },
    });
    return res.json({ ok: true, assigned: studentIds.length });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Co-teacher management
// ============================================================================

// GET /api/gopilot/homerooms/:id/teachers - List teachers for a homeroom
router.get("/:id/teachers", ...auth, async (req, res, next) => {
  try {
    const homeroom = await getHomeroomForSchool(param(req, "id"), res.locals.schoolId!);
    if (!homeroom) {
      return res.status(404).json({ error: "Homeroom not found" });
    }
    const role = await getRequestGoPilotRole(req, res);
    if (role === "teacher") {
      const assigned = await getTeacherHomeroomIds(req.authUser!.id, res.locals.schoolId!);
      if (!assigned.has(homeroom.id)) {
        return res.status(404).json({ error: "Homeroom not found" });
      }
    } else if (!isGoPilotManager(role)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    const teachers = await getHomeroomTeachers(homeroom.id);

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

// POST /api/gopilot/homerooms/:id/teachers - Add co-teacher
router.post("/:id/teachers", ...manageAuth, async (req, res, next) => {
  try {
    const { teacherId, role } = req.body;
    if (!teacherId) {
      return res.status(400).json({ error: "teacherId is required" });
    }
    if (role !== undefined && role !== "co-teacher") {
      return res.status(422).json({
        error: "This endpoint only adds co-teachers.",
        code: "GOPILOT_CO_TEACHER_ROLE_REQUIRED",
      });
    }
    if (!(await isActiveSchoolTeacher(teacherId, res.locals.schoolId!))) {
      return res.status(404).json({ error: "Teacher not found" });
    }

    const homeroom = await getHomeroomForSchool(param(req, "id"), res.locals.schoolId!);
    if (!homeroom) {
      return res.status(404).json({ error: "Homeroom not found" });
    }

    const teacher = await addHomeroomTeacher(
      homeroom.id,
      teacherId,
      "co-teacher"
    );
    await logAudit({
      schoolId: res.locals.schoolId!,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.gopilotRole,
      action: "gopilot.homeroom.teacher_added",
      entityType: "homeroom",
      entityId: homeroom.id,
      metadata: { teacherCount: 1 },
    });
    return res.status(201).json({ teacher });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/gopilot/homerooms/:id/teachers/:teacherId - Remove co-teacher
router.delete("/:id/teachers/:teacherId", ...manageAuth, async (req, res, next) => {
  try {
    const homeroom = await getHomeroomForSchool(param(req, "id"), res.locals.schoolId!);
    if (!homeroom) {
      return res.status(404).json({ error: "Homeroom not found" });
    }

    const removed = await removeHomeroomTeacher(homeroom.id, param(req, "teacherId"));
    if (!removed) {
      return res.status(404).json({ error: "Teacher not found in homeroom" });
    }
    await logAudit({
      schoolId: res.locals.schoolId!,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.gopilotRole,
      action: "gopilot.homeroom.teacher_removed",
      entityType: "homeroom",
      entityId: homeroom.id,
      metadata: { teacherCount: 1 },
    });
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
