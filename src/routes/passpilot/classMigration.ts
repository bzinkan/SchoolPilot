import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import {
  hasPasspilotCanonicalClassCapability,
  PASSPILOT_CANONICAL_CLASS_MODEL,
  requirePassPilotRole,
} from "../../services/passpilotAccess.js";
import {
  completePasspilotClassMigration,
  initializePasspilotClassMigrationInventory,
  updatePasspilotClassMappings,
  type PasspilotClassMigrationInventory,
} from "../../services/storage.js";

const router = Router();

const mappingSchema = z.object({
  gradeId: z.string().min(1),
  classId: z.string().min(1).nullable().optional(),
  state: z.enum(["pending", "auto_linked", "confirmed", "history_only"]).optional(),
});
const updateSchema = z.object({
  expectedRevision: z.number().int().min(0),
  autoLink: z.boolean().optional().default(false),
  mappings: z.array(mappingSchema).max(500).optional().default([]),
});
const completeSchema = z.object({
  expectedRevision: z.number().int().min(0),
  classModelAcknowledged: z.literal(true),
});
const singleMappingSchema = z.discriminatedUnion("action", [
  z.object({
    expectedRevision: z.number().int().min(0),
    action: z.literal("link"),
    classpilotGroupId: z.string().min(1),
  }),
  z.object({
    expectedRevision: z.number().int().min(0),
    action: z.literal("history_only"),
    classpilotGroupId: z.string().nullable().optional(),
  }),
]);

function responseInventory(inventory: PasspilotClassMigrationInventory) {
  const items = inventory.legacyGrades.map((grade) => {
    const comparisonTargetId = grade.classpilotGroupId || grade.suggestedClasspilotGroupId;
    const comparisonTarget = inventory.canonicalClasses.find(
      (group) => group.id === comparisonTargetId
    );
    const legacyStudents = new Set(grade.studentIds);
    const legacyTeachers = new Set(grade.teacherIds);
    const compareTarget = (target: PasspilotClassMigrationInventory["canonicalClasses"][number]) => {
      const targetStudents = new Set(target.studentIds);
      const targetTeachers = new Set(target.teacherIds);
      const targetStudentMembers = new Map(target.studentMembers.map((member) => [member.id, member]));
      const legacyStudentMembers = new Map(grade.studentMembers.map((member) => [member.id, member]));
      const targetTeacherMembers = new Map(target.teacherMembers.map((member) => [member.id, member]));
      const legacyTeacherMembers = new Map(grade.teacherMembers.map((member) => [member.id, member]));
      const rosterAddedIds = [...targetStudents].filter((id) => !legacyStudents.has(id));
      const rosterRemovedIds = [...legacyStudents].filter((id) => !targetStudents.has(id));
      const teacherAddedIds = [...targetTeachers].filter((id) => !legacyTeachers.has(id));
      const teacherRemovedIds = [...legacyTeachers].filter((id) => !targetTeachers.has(id));
      return {
        classpilotGroupId: target.id,
        className: target.name,
        rosterAddedCount: rosterAddedIds.length,
        rosterRemovedCount: rosterRemovedIds.length,
        teacherAddedCount: teacherAddedIds.length,
        teacherRemovedCount: teacherRemovedIds.length,
        rosterAdded: rosterAddedIds.map((id) => targetStudentMembers.get(id) ?? { id, name: "Student record", detail: null }),
        rosterRemoved: rosterRemovedIds.map((id) => legacyStudentMembers.get(id) ?? { id, name: "Student record", detail: null }),
        teacherAdded: teacherAddedIds.map((id) => targetTeacherMembers.get(id) ?? { id, name: "Staff record", detail: null }),
        teacherRemoved: teacherRemovedIds.map((id) => legacyTeacherMembers.get(id) ?? { id, name: "Staff record", detail: null }),
      };
    };
    const comparisons = inventory.canonicalClasses.map(compareTarget);
    return ({
    id: grade.id,
    legacyGradeId: grade.id,
    name: grade.name,
    classpilotGroupId: grade.classpilotGroupId,
    migrationState: grade.migrationState,
    mappingRevision: grade.mappingRevision,
    mappingMethod: grade.mappingMethod,
    mappingReviewerId: grade.mappingReviewerId,
    mappedAt: grade.mappedAt,
    studentCount: grade.studentIds.length,
    teacherCount: grade.teacherIds.length,
    teacherNames: grade.teacherMembers.map((member) => member.name),
    historicalPassCount: grade.historicalPassCount,
    activePassCount: grade.activePassCount,
    suggestedClasspilotGroupId: grade.suggestedClasspilotGroupId,
    suggestedClassName: inventory.canonicalClasses.find(
      (group) => group.id === grade.suggestedClasspilotGroupId
    )?.name ?? null,
    autoLinkEligible: grade.autoLinkEligible,
    conflictReasons: grade.conflictReasons,
    comparison: comparisonTarget ? compareTarget(comparisonTarget) : null,
    comparisons,
  });
  });
  return {
    source: inventory.source,
    cutoverAt: inventory.cutoverAt,
    canonicalWritesAt: inventory.canonicalWritesAt,
    revision: inventory.revision,
    kioskGradeId: inventory.kioskGradeId,
    kioskClasspilotGroupId: inventory.kioskClasspilotGroupId,
    items,
    legacyGrades: items,
    canonicalClasses: inventory.canonicalClasses.map((group) => ({
      id: group.id,
      name: group.name,
      description: group.description,
      periodLabel: group.periodLabel,
      gradeLevel: group.gradeLevel,
      status: group.status,
      studentCount: group.studentIds.length,
      teacherCount: group.teacherIds.length,
    })),
  };
}

router.use(
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireProductLicense("PASSPILOT"),
  requirePassPilotRole("admin", "school_admin"),
  (req, res, next) => {
    if (hasPasspilotCanonicalClassCapability(req)) return next();
    return res.status(426).json({
      error: "Update PassPilot before reviewing or switching ClassPilot classes.",
      code: "PASSPILOT_CLASS_MODEL_UPGRADE_REQUIRED",
      requiredClassModel: PASSPILOT_CANONICAL_CLASS_MODEL,
    });
  }
);

router.get("/", async (req, res, next) => {
  try {
    return res.json(responseInventory(await initializePasspilotClassMigrationInventory(
      res.locals.schoolId!,
      req.authUser!.id
    )));
  } catch (err) {
    next(err);
  }
});

router.put("/:legacyGradeId", async (req, res, next) => {
  try {
    const parsed = singleMappingSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid mapping" });
    const legacyGradeId = String(req.params.legacyGradeId ?? "");
    const input = parsed.data.action === "link"
      ? {
          gradeId: legacyGradeId,
          classId: parsed.data.classpilotGroupId,
          state: "confirmed" as const,
        }
      : {
          gradeId: legacyGradeId,
          classId: null,
          state: "history_only" as const,
        };
    const inventory = await updatePasspilotClassMappings(
      res.locals.schoolId!,
      req.authUser!.id,
      parsed.data.expectedRevision,
      [input],
      false
    );
    return res.json(responseInventory(inventory));
  } catch (err) {
    next(err);
  }
});

router.put("/", async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid mapping" });
    const inventory = await updatePasspilotClassMappings(
      res.locals.schoolId!,
      req.authUser!.id,
      parsed.data.expectedRevision,
      parsed.data.mappings,
      parsed.data.autoLink
    );
    return res.json(responseInventory(inventory));
  } catch (err) {
    next(err);
  }
});

router.post("/complete", async (req, res, next) => {
  try {
    const parsed = completeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid migration request" });
    const inventory = await completePasspilotClassMigration(
      res.locals.schoolId!,
      req.authUser!.id,
      parsed.data.expectedRevision,
      parsed.data.classModelAcknowledged
    );
    return res.json(responseInventory(inventory));
  } catch (err) {
    next(err);
  }
});

export default router;
