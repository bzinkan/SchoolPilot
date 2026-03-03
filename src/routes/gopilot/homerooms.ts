import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import { requireRole } from "../../middleware/requireRole.js";
import {
  getHomeroomsBySchool,
  getHomeroomById,
  createHomeroom,
  updateHomeroom,
  deleteHomeroom,
  assignStudentsToHomeroom,
  searchStudents,
  getUserById,
  getHomeroomTeachers,
  addHomeroomTeacher,
  removeHomeroomTeacher,
} from "../../services/storage.js";

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
    const rows = await getHomeroomsBySchool(schoolId);

    // Get student counts per homeroom
    const allStudents = await searchStudents(schoolId, { status: "active" });
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
router.post("/", ...auth, async (req, res, next) => {
  try {
    const { name, grade, room, teacherId } = req.body;
    if (!name || !grade) {
      return res
        .status(400)
        .json({ error: "name and grade are required" });
    }

    const homeroom = await createHomeroom({
      schoolId: res.locals.schoolId!,
      name,
      grade,
      room: room || null,
      teacherId: teacherId || null,
    });

    // Also seed the junction table
    if (teacherId) {
      await addHomeroomTeacher(homeroom.id, teacherId, "primary");
    }

    return res.status(201).json({ homeroom });
  } catch (err) {
    next(err);
  }
});

// PUT /api/gopilot/homerooms/:id - Update homeroom
router.put("/:id", ...auth, async (req, res, next) => {
  try {
    const id = param(req, "id");
    const { name, grade, room, teacherId } = req.body;

    const updated = await updateHomeroom(id, {
      ...(name !== undefined && { name }),
      ...(grade !== undefined && { grade }),
      ...(room !== undefined && { room }),
      ...(teacherId !== undefined && { teacherId }),
    });

    if (!updated) {
      return res.status(404).json({ error: "Homeroom not found" });
    }

    return res.json({ homeroom: updated });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/gopilot/homerooms/:id - Delete homeroom
router.delete("/:id", ...auth, async (req, res, next) => {
  try {
    const existing = await getHomeroomById(param(req, "id"));
    if (!existing) {
      return res.status(404).json({ error: "Homeroom not found" });
    }
    await deleteHomeroom(param(req, "id"));
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/gopilot/homerooms/:id/assign - Bulk assign students
router.post("/:id/assign", ...auth, async (req, res, next) => {
  try {
    const id = param(req, "id");
    const { studentIds } = req.body;

    if (!Array.isArray(studentIds) || studentIds.length === 0) {
      return res.status(400).json({ error: "studentIds array required" });
    }

    const homeroom = await getHomeroomById(id);
    if (!homeroom) {
      return res.status(404).json({ error: "Homeroom not found" });
    }

    await assignStudentsToHomeroom(id, studentIds);
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
    const homeroom = await getHomeroomById(param(req, "id"));
    if (!homeroom) {
      return res.status(404).json({ error: "Homeroom not found" });
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
router.post("/:id/teachers", ...auth, requireRole("admin"), async (req, res, next) => {
  try {
    const { teacherId, role } = req.body;
    if (!teacherId) {
      return res.status(400).json({ error: "teacherId is required" });
    }

    const homeroom = await getHomeroomById(param(req, "id"));
    if (!homeroom) {
      return res.status(404).json({ error: "Homeroom not found" });
    }

    const teacher = await addHomeroomTeacher(
      homeroom.id,
      teacherId,
      role || "co-teacher"
    );
    return res.status(201).json({ teacher });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/gopilot/homerooms/:id/teachers/:teacherId - Remove co-teacher
router.delete("/:id/teachers/:teacherId", ...auth, requireRole("admin"), async (req, res, next) => {
  try {
    const homeroom = await getHomeroomById(param(req, "id"));
    if (!homeroom) {
      return res.status(404).json({ error: "Homeroom not found" });
    }

    const removed = await removeHomeroomTeacher(homeroom.id, param(req, "teacherId"));
    if (!removed) {
      return res.status(404).json({ error: "Teacher not found in homeroom" });
    }
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
