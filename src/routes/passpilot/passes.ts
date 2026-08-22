import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import { issuePassSchema } from "../../schema/validation.js";
import {
  getActivePassesBySchool,
  getActivePassForStudent,
  getPassHistoryPage,
  createLegacyPass,
  createCanonicalPass,
  returnPass,
  cancelPass,
  expireOverduePasses,
  getStudentById,
  getStudentsByIds,
  getUserById,
  getGradesBySchool,
  getSchoolById,
  getSettingsForSchool,
  getAbsentStudentIds,
  createStudentTimelineEvent,
  getPasspilotReportIssuers,
} from "../../services/storage.js";
import { isWithinTrackingWindow } from "../../services/schoolHours.js";
import type { Pass } from "../../schema/passpilot.js";
import { normalizePasspilotPass } from "../../services/passpilotClasses.js";
import {
  canAccessGrade,
  canAccessPasspilotClass,
  canAccessCanonicalPassHistory,
  canAccessLegacyPassHistory,
  canAccessPass,
  canAccessStudent,
  filterPassesForRole,
  getGradeForSchool,
  getPassForSchool,
  getPassHistoryQueryAccessScope,
  getRequestPassPilotRole,
  getPasspilotClassSourceForSchool,
  isPassPilotManager,
  requirePasspilotClassModel,
  requirePassPilotRole,
} from "../../services/passpilotAccess.js";

const router = Router();

function param(req: { params: Record<string, unknown> }, key: string): string {
  return String(req.params[key] ?? "");
}

function decodeHistoryCursor(value: string): { issuedAtMs: string; id: string } | null {
  if (!value || value.length > 512) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      issuedAtMs?: unknown;
      id?: unknown;
    };
    if (
      typeof decoded.issuedAtMs !== "string" ||
      !/^-?\d+$/.test(decoded.issuedAtMs) ||
      typeof decoded.id !== "string" ||
      !decoded.id
    ) {
      return null;
    }
    return { issuedAtMs: decoded.issuedAtMs, id: decoded.id };
  } catch {
    return null;
  }
}

function encodeHistoryCursor(cursor: { issuedAtMs: string; id: string }): string {
  return Buffer.from(
    JSON.stringify(cursor),
    "utf8"
  ).toString("base64url");
}

// All pass routes require auth + school context + active school + PassPilot license
router.use(
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireProductLicense("PASSPILOT"),
  requirePassPilotRole("admin", "school_admin", "office_staff", "teacher")
);
router.use(requirePasspilotClassModel);

// Enrich passes with student/teacher/grade data
async function enrichPasses(rawPasses: Pass[], schoolId: string) {
  if (rawPasses.length === 0) return [];

  const [allStudents, allGrades] = await Promise.all([
    getStudentsByIds([...new Set(rawPasses.map((pass) => pass.studentId))])
      .then((rows) => rows.filter((student) => student.schoolId === schoolId)),
    getGradesBySchool(schoolId),
  ]);

  const studentMap = new Map(allStudents.map((s) => [s.id, s]));
  const gradeMap = new Map(allGrades.map((g) => [g.id, g]));

  // Collect unique teacher IDs
  const teacherIds = [...new Set(rawPasses.map((p) => p.teacherId).filter(Boolean))] as string[];
  const teacherMap = new Map<string, {
    id: string;
    firstName: string;
    lastName: string;
    displayName: string | null;
    email: string;
  }>();
  for (const tid of teacherIds) {
    const user = await getUserById(tid);
    if (user) teacherMap.set(tid, user);
  }

  return rawPasses.map((pass) => {
    const student = studentMap.get(pass.studentId);
    const teacher = pass.teacherId ? teacherMap.get(pass.teacherId) : null;
    const grade = pass.gradeId ? gradeMap.get(pass.gradeId) : null;
    const classId = pass.classpilotGroupId || grade?.classpilotGroupId || pass.gradeId || null;
    const className = pass.classNameSnapshot || grade?.name || null;
    const classSource = pass.classpilotGroupId ? "classpilot_groups" : "legacy_grades";

    const teacherFullName = teacher
      ? [teacher.firstName, teacher.lastName]
          .map((part) => part?.trim())
          .filter(Boolean)
          .join(" ")
      : "";
    const teacherDisplayName = teacher?.displayName?.trim()
      || teacherFullName
      || teacher?.email?.trim()
      || "Former staff member";

    return {
      ...pass,
      classId,
      className,
      class: classId
        ? {
            id: classId,
            name: className,
            source: classSource,
          }
        : null,
      student: student
        ? {
            id: student.id,
            firstName: student.firstName,
            lastName: student.lastName,
            grade: className,
            gradeId: pass.classpilotGroupId ? null : pass.gradeId,
            legacyGradeId: pass.gradeId,
          }
        : null,
      teacher: teacher
        ? {
            id: teacher.id,
            firstName: teacher.firstName,
            lastName: teacher.lastName,
            name: teacherDisplayName,
          }
        : null,
    };
  });
}

// Map legacy passType to destination
function mapPassTypeToDestination(passType?: string): string {
  switch (passType) {
    case "nurse": return "nurse";
    case "office": return "office";
    case "restroom": return "bathroom";
    case "custom": return "custom";
    case "general":
    default: return "bathroom";
  }
}

function recordPassTimeline(pass: Pass, action: "issued" | "returned" | "cancelled", actorUserId: string) {
  return createStudentTimelineEvent({
    schoolId: pass.schoolId,
    studentId: pass.studentId,
    eventType: "pass",
    sourceType: "passpilot",
    sourceId: pass.id,
    title: `Hall pass ${action}: ${pass.destination}`,
    summary: pass.customDestination || pass.notes || null,
    actorUserId,
    metadata: {
      status: pass.status,
      destination: pass.destination,
      customDestination: pass.customDestination,
      issuedAt: pass.issuedAt,
      returnedAt: pass.returnedAt,
      expiresAt: pass.expiresAt,
    },
  });
}

// ============================================================================
// Pass CRUD
// ============================================================================

// GET /api/passpilot/passes - List active passes
router.get("/", async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const role = await getRequestPassPilotRole(req, res);

    // Expire overdue passes first
    await expireOverduePasses(schoolId);

    const rawPasses = await getActivePassesBySchool(schoolId);
    const scopedPasses = await filterPassesForRole(rawPasses, req.authUser!, schoolId, role);
    const enriched = await enrichPasses(scopedPasses, schoolId);
    return res.json({ passes: enriched });
  } catch (err) {
    next(err);
  }
});

// GET /api/passpilot/passes/active - Alias for active passes
router.get("/active", async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const role = await getRequestPassPilotRole(req, res);
    await expireOverduePasses(schoolId);
    const rawPasses = await getActivePassesBySchool(schoolId);
    const scopedPasses = await filterPassesForRole(rawPasses, req.authUser!, schoolId, role);
    const enriched = await enrichPasses(scopedPasses, schoolId);
    return res.json({ passes: enriched });
  } catch (err) {
    next(err);
  }
});

// GET /api/passpilot/passes/issuers - School-wide report issuer filter
router.get(
  "/issuers",
  requirePassPilotRole("admin", "school_admin", "office_staff"),
  async (_req, res, next) => {
    try {
      const issuers = await getPasspilotReportIssuers(res.locals.schoolId!);
      return res.json({ issuers });
    } catch (err) {
      return next(err);
    }
  }
);

// GET /api/passpilot/passes/history - Pass history with filtering
router.get("/history", async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const role = await getRequestPassPilotRole(req, res);
    const {
      gradeId,
      classId,
      studentId,
      teacherId,
      startDate,
      dateStart,
      endDate,
      dateEnd,
      grade: gradeName,
      passType,
      cursor: cursorValue,
      limit: limitValue,
    } = req.query as Record<string, string | undefined>;

    const limit = limitValue === undefined ? 500 : Number(limitValue);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      return res.status(400).json({ error: "limit must be an integer between 1 and 500" });
    }
    const cursor = cursorValue === undefined
      ? undefined
      : (decodeHistoryCursor(cursorValue) ?? undefined);
    if (cursorValue !== undefined && !cursor) {
      return res.status(400).json({ error: "Invalid history cursor", code: "PASSPILOT_HISTORY_CURSOR_INVALID" });
    }

    // Resolve grade name to gradeId
    let resolvedGradeId = gradeId;
    if (!resolvedGradeId && gradeName) {
      const allGrades = await getGradesBySchool(res.locals.schoolId!);
      const matchedGrade = allGrades.find(
        (g) => g.name.toLowerCase() === gradeName.toLowerCase()
      );
      if (matchedGrade) resolvedGradeId = matchedGrade.id;
    }

    if (classId && !(await canAccessCanonicalPassHistory(req.authUser!, schoolId, classId, role))) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    if (resolvedGradeId && !(await canAccessLegacyPassHistory(req.authUser!, schoolId, resolvedGradeId, role))) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    if (studentId && !(await canAccessStudent(req.authUser!, schoolId, studentId, role))) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    if (teacherId && !isPassPilotManager(role) && teacherId !== req.authUser!.id) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    const start = startDate || dateStart;
    const end = endDate || dateEnd;
    const access = await getPassHistoryQueryAccessScope(
      req.authUser!,
      schoolId,
      role
    );

    const historyPage = await getPassHistoryPage(schoolId, {
      gradeId: resolvedGradeId,
      classId,
      studentId,
      teacherId: isPassPilotManager(role) ? teacherId : undefined,
      startDate: start ? new Date(start) : undefined,
      endDate: end ? new Date(end) : undefined,
      limit,
      cursor,
      passType,
      access: access ?? undefined,
    });
    const rawPasses = historyPage.passes;

    const enriched = await enrichPasses(rawPasses, schoolId);
    return res.json({
      passes: enriched,
      nextCursor: historyPage.nextCursor ? encodeHistoryCursor(historyPage.nextCursor) : null,
      hasMore: historyPage.hasMore,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/passpilot/passes - Issue a pass
router.post("/", async (req, res, next) => {
  try {
    const body = { ...req.body };

    // Legacy passType → destination mapping
    if (body.passType && !body.destination) {
      body.destination = mapPassTypeToDestination(body.passType);
      if (body.passType === "custom" && body.customReason) {
        body.customDestination = body.customReason;
      }
    }

    const parsed = issuePassSchema.safeParse(body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: parsed.error.errors[0]?.message || "Invalid input" });
    }

    const { studentId, destination, customDestination, duration, gradeId, classId, notes } =
      parsed.data;
    const schoolId = res.locals.schoolId!;
    const role = await getRequestPassPilotRole(req, res);

    // Verify student exists in school
    const student = await getStudentById(studentId);
    if (!student || student.schoolId !== schoolId || student.status !== "active") {
      return res.status(400).json({ error: "Student not found" });
    }
    if (!(await canAccessStudent(req.authUser!, schoolId, studentId, role))) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    const classSource = await getPasspilotClassSourceForSchool(schoolId);
    if (classSource === "classpilot_groups" && !classId) {
      return res.status(400).json({
        error: "classId is required when issuing a pass",
        code: "PASSPILOT_CLASS_REQUIRED",
      });
    }

    let passGradeId: string | null = null;
    const requestedLegacyGradeId = gradeId || (classSource === "legacy_grades" ? classId : undefined);
    if (requestedLegacyGradeId) {
      const grade = await getGradeForSchool(requestedLegacyGradeId, schoolId);
      if (!grade) {
        return res.status(400).json({ error: "Class not found" });
      }
      if (!(await canAccessGrade(req.authUser!, schoolId, requestedLegacyGradeId, role))) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }
      passGradeId = requestedLegacyGradeId;
    }
    if (classSource === "classpilot_groups" && classId) {
      if (gradeId) {
        return res.status(400).json({ error: "Use classId, not gradeId, for canonical classes" });
      }
      if (!(await canAccessPasspilotClass(req.authUser!, schoolId, classId, role))) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }
    }

    // Check if student is absent
    const today = new Date().toISOString().slice(0, 10);
    const absentIds = await getAbsentStudentIds(schoolId, today);
    if (absentIds.has(studentId)) {
      return res.status(400).json({ error: "Cannot issue pass to absent student" });
    }

    // Expire any overdue passes FIRST, so a pass that already lapsed doesn't
    // block issuing a new one (otherwise a stale "active" pass returns 409).
    await expireOverduePasses(schoolId);

    // Check for existing active pass
    const activePass = await getActivePassForStudent(studentId, schoolId);
    if (activePass) {
      return res.status(409).json({ error: "Student already has an active pass" });
    }

    // Enforce school hours
    const schoolSettings = await getSettingsForSchool(schoolId);
    if (schoolSettings && !isWithinTrackingWindow(schoolSettings)) {
      return res.status(403).json({ error: "Passes cannot be issued outside school hours" });
    }

    // Calculate duration and expiry
    const school = res.locals.school || (await getSchoolById(schoolId));
    const passDuration = duration || school?.defaultPassDuration || 5;
    const expiresAt = new Date(Date.now() + passDuration * 60 * 1000);

    let pass;
    try {
      const commonPass = {
          schoolId,
          studentId,
          teacherId: req.authUser!.id,
          destination,
          customDestination: destination === "custom" ? (customDestination || null) : null,
          status: "active" as const,
          duration: passDuration,
          expiresAt,
          issuedVia: "teacher" as const,
          notes: notes || null,
        };
      pass = classSource === "classpilot_groups"
        ? await createCanonicalPass(
            { ...commonPass, classId: classId! },
            {
              actorUserId: req.authUser!.id,
              manager: isPassPilotManager(role),
            }
          )
        : await createLegacyPass(
            { ...commonPass, gradeId: passGradeId },
            {
              actorUserId: req.authUser!.id,
              manager: isPassPilotManager(role),
            }
          );
    } catch (err: any) {
      // Partial unique index (one active pass per student) — a concurrent
      // double-issue loses the race here. Surface it as the same 409.
      if (err?.code === "23505") {
        return res.status(409).json({ error: "Student already has an active pass" });
      }
      throw err;
    }

    await recordPassTimeline(pass, "issued", req.authUser!.id);
    return res.status(201).json({ pass: await normalizePasspilotPass(pass, schoolId) });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/passpilot/passes/:id/return - Return a pass
router.patch("/:id/return", async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const id = param(req, "id");
    const role = await getRequestPassPilotRole(req, res);
    const existing = await getPassForSchool(id, schoolId);
    if (!existing || !(await canAccessPass(req.authUser!, schoolId, existing, role))) {
      return res.status(404).json({ error: "Active pass not found" });
    }

    const pass = await returnPass(id, schoolId);
    if (!pass) {
      return res.status(400).json({ error: "Active pass not found" });
    }
    await recordPassTimeline(pass, "returned", req.authUser!.id);
    return res.json({ pass: await normalizePasspilotPass(pass, schoolId) });
  } catch (err) {
    next(err);
  }
});

// PUT /api/passpilot/passes/:id/return - Alias
router.put("/:id/return", async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const id = param(req, "id");
    const role = await getRequestPassPilotRole(req, res);
    const existing = await getPassForSchool(id, schoolId);
    if (!existing || !(await canAccessPass(req.authUser!, schoolId, existing, role))) {
      return res.status(404).json({ error: "Active pass not found" });
    }

    const pass = await returnPass(id, schoolId);
    if (!pass) {
      return res.status(400).json({ error: "Active pass not found" });
    }
    await recordPassTimeline(pass, "returned", req.authUser!.id);
    return res.json({ pass: await normalizePasspilotPass(pass, schoolId) });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/passpilot/passes/:id/cancel - Cancel a pass
router.patch("/:id/cancel", async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const id = param(req, "id");
    const role = await getRequestPassPilotRole(req, res);
    const existing = await getPassForSchool(id, schoolId);
    if (!existing || !(await canAccessPass(req.authUser!, schoolId, existing, role))) {
      return res.status(404).json({ error: "Active pass not found" });
    }

    const pass = await cancelPass(id, schoolId);
    if (!pass) {
      return res.status(400).json({ error: "Active pass not found" });
    }
    await recordPassTimeline(pass, "cancelled", req.authUser!.id);
    return res.json({ pass: await normalizePasspilotPass(pass, schoolId) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/passpilot/passes/:id - Cancel (alias)
router.delete("/:id", async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const id = param(req, "id");
    const role = await getRequestPassPilotRole(req, res);
    const existing = await getPassForSchool(id, schoolId);
    if (!existing || !(await canAccessPass(req.authUser!, schoolId, existing, role))) {
      return res.status(404).json({ error: "Active pass not found" });
    }
    const pass = await cancelPass(id, schoolId);
    if (!pass) {
      return res.status(400).json({ error: "Active pass not found" });
    }
    await recordPassTimeline(pass, "cancelled", req.authUser!.id);
    return res.json({ ok: true, pass: await normalizePasspilotPass(pass, schoolId) });
  } catch (err) {
    next(err);
  }
});

export default router;
