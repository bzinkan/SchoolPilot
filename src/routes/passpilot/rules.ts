import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import { requirePassPilotRole } from "../../services/passpilotAccess.js";
import { logAuditStrict } from "../../services/audit.js";
import { readPasspilotRulesMode } from "../../config/passpilotRulesMode.js";
import { PASSPILOT_RULE_DESTINATIONS } from "../../schema/passpilot.js";
import {
  createPasspilotEncounterRestriction,
  deletePasspilotDestinationPolicy,
  deletePasspilotEncounterRestriction,
  deletePasspilotPassLimit,
  findActivePasspilotRuleStudents,
  getPasspilotRules,
  getPasspilotStudentRuleRecords,
  setPasspilotEncounterRestrictionEnabled,
  upsertPasspilotDestinationPolicy,
  upsertPasspilotPassLimit,
} from "../../services/passpilotRulesAdmin.js";

/**
 * /api/passpilot/admin/rules — administrator configuration for PassPilot
 * issuance rules. With PASSPILOT_RULES_MODE off (or its RLS tables not yet
 * admitted) this router steps aside before authentication, so every request
 * receives the same JSON 404 as any unknown API path.
 */
const router = Router();

router.use((_req, _res, next) => {
  if (readPasspilotRulesMode() !== "on") return next("router");
  return next();
});

router.use(
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireProductLicense("PASSPILOT"),
  requirePassPilotRole("admin", "school_admin")
);

const destinationParamSchema = z.enum(PASSPILOT_RULE_DESTINATIONS);
const destinationBodySchema = z
  .object({
    maxConcurrent: z
      .number()
      .int("Capacity must be a whole number")
      .min(1, "Capacity must be at least 1")
      .max(500, "Capacity must be no more than 500"),
    enabled: z.boolean(),
  })
  .strict();
const limitValueSchema = z
  .number()
  .int("Limits must be whole numbers")
  .min(0, "Limits cannot be negative")
  .max(50, "Limits must be no more than 50")
  .nullable();
const limitBodySchema = z
  .object({ dailyLimit: limitValueSchema, periodLimit: limitValueSchema, enabled: z.boolean() })
  .strict()
  .refine((value) => value.dailyLimit !== null || value.periodLimit !== null, {
    message: "Set a daily or period limit, or remove the limit.",
  });
const studentIdSchema = z.string().trim().min(1).max(128);
const encounterBodySchema = z
  .object({
    studentIdA: studentIdSchema,
    studentIdB: studentIdSchema,
    reasonNote: z.string().trim().max(500, "Keep the note under 500 characters").nullable().optional(),
  })
  .strict();
const encounterPatchSchema = z.object({ enabled: z.boolean() }).strict();

function invalid(res: Response, error: z.ZodError | string) {
  return res.status(400).json({
    error: typeof error === "string" ? error : error.errors[0]?.message || "Invalid rule",
    code: "PASSPILOT_RULES_INVALID",
  });
}

function notFound(res: Response, error = "Rule not found.") {
  return res.status(404).json({ error, code: "PASSPILOT_RULES_NOT_FOUND" });
}

function studentNotFound(res: Response) {
  return res.status(400).json({
    error: "Choose active students from this school.",
    code: "PASSPILOT_RULES_STUDENT_NOT_FOUND",
  });
}

function param(req: Request, key: string): string {
  return String(req.params[key] ?? "");
}

/** Every rule write is audited before the response claims success. */
async function auditRules(
  req: Request,
  res: Response,
  entry: { entityId: string; changes?: unknown; metadata: Record<string, unknown> }
) {
  await logAuditStrict({
    schoolId: res.locals.schoolId!,
    userId: req.authUser!.id,
    userEmail: req.authUser!.email,
    userRole: res.locals.membershipRole ?? res.locals.passpilotRole,
    action: "passpilot.rules.update",
    entityType: "passpilot_rule",
    entityId: entry.entityId,
    changes: entry.changes,
    metadata: entry.metadata,
  });
}

router.get("/", async (_req, res, next) => {
  try {
    return res.json(await getPasspilotRules(res.locals.schoolId!));
  } catch (error) {
    next(error);
  }
});

router.put("/destinations/:destination", async (req, res, next) => {
  try {
    const destination = destinationParamSchema.safeParse(param(req, "destination"));
    if (!destination.success) return invalid(res, "Choose a supported destination.");
    const body = destinationBodySchema.safeParse(req.body);
    if (!body.success) return invalid(res, body.error);
    const schoolId = res.locals.schoolId!;
    const change = await upsertPasspilotDestinationPolicy(schoolId, destination.data, body.data, req.authUser!.id);
    await auditRules(req, res, {
      entityId: `destination:${destination.data}`,
      changes: change,
      metadata: { rule: "destination_capacity", operation: "upsert", destination: destination.data },
    });
    return res.json(await getPasspilotRules(schoolId));
  } catch (error) {
    next(error);
  }
});

router.delete("/destinations/:destination", async (req, res, next) => {
  try {
    const destination = destinationParamSchema.safeParse(param(req, "destination"));
    if (!destination.success) return invalid(res, "Choose a supported destination.");
    const schoolId = res.locals.schoolId!;
    const deleted = await deletePasspilotDestinationPolicy(schoolId, destination.data);
    if (!deleted) return notFound(res);
    await auditRules(req, res, {
      entityId: `destination:${destination.data}`,
      changes: { before: deleted, after: null },
      metadata: { rule: "destination_capacity", operation: "delete", destination: destination.data },
    });
    return res.json(await getPasspilotRules(schoolId));
  } catch (error) {
    next(error);
  }
});

router.put("/limits/default", async (req, res, next) => {
  try {
    const body = limitBodySchema.safeParse(req.body);
    if (!body.success) return invalid(res, body.error);
    const schoolId = res.locals.schoolId!;
    const change = await upsertPasspilotPassLimit(schoolId, null, body.data, req.authUser!.id);
    await auditRules(req, res, {
      entityId: "limits:default",
      changes: change,
      metadata: { rule: "pass_limits", operation: "upsert", scope: "school_default" },
    });
    return res.json(await getPasspilotRules(schoolId));
  } catch (error) {
    next(error);
  }
});

router.delete("/limits/default", async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const deleted = await deletePasspilotPassLimit(schoolId, null);
    if (!deleted) return notFound(res);
    await auditRules(req, res, {
      entityId: "limits:default",
      changes: { before: deleted, after: null },
      metadata: { rule: "pass_limits", operation: "delete", scope: "school_default" },
    });
    return res.json(await getPasspilotRules(schoolId));
  } catch (error) {
    next(error);
  }
});

router.put("/limits/students/:studentId", async (req, res, next) => {
  try {
    const studentId = studentIdSchema.safeParse(param(req, "studentId"));
    if (!studentId.success) return invalid(res, "Choose a student.");
    const body = limitBodySchema.safeParse(req.body);
    if (!body.success) return invalid(res, body.error);
    const schoolId = res.locals.schoolId!;
    // Validate before the same-school foreign key so a foreign id is a 400.
    const active = await findActivePasspilotRuleStudents(schoolId, [studentId.data]);
    if (!active.has(studentId.data)) return studentNotFound(res);
    const change = await upsertPasspilotPassLimit(schoolId, studentId.data, body.data, req.authUser!.id);
    await auditRules(req, res, {
      entityId: `limits:student:${studentId.data}`,
      changes: change,
      metadata: { rule: "pass_limits", operation: "upsert", scope: "student", studentId: studentId.data },
    });
    return res.json(await getPasspilotRules(schoolId));
  } catch (error) {
    next(error);
  }
});

router.delete("/limits/students/:studentId", async (req, res, next) => {
  try {
    const studentId = studentIdSchema.safeParse(param(req, "studentId"));
    if (!studentId.success) return invalid(res, "Choose a student.");
    const schoolId = res.locals.schoolId!;
    const deleted = await deletePasspilotPassLimit(schoolId, studentId.data);
    if (!deleted) return notFound(res);
    await auditRules(req, res, {
      entityId: `limits:student:${studentId.data}`,
      changes: { before: deleted, after: null },
      metadata: { rule: "pass_limits", operation: "delete", scope: "student", studentId: studentId.data },
    });
    return res.json(await getPasspilotRules(schoolId));
  } catch (error) {
    next(error);
  }
});

router.get("/students/:studentId/records", async (req, res, next) => {
  try {
    const studentId = studentIdSchema.safeParse(param(req, "studentId"));
    if (!studentId.success) return invalid(res, "Choose a student.");
    const schoolId = res.locals.schoolId!;
    const records = await getPasspilotStudentRuleRecords(schoolId, studentId.data);
    if (!records) return notFound(res, "Student not found.");
    await logAuditStrict({
      schoolId,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.membershipRole ?? res.locals.passpilotRole,
      action: "passpilot.rules.records.export",
      entityType: "student",
      entityId: studentId.data,
      metadata: { denialCount: records.denials.length },
    });
    res.setHeader("Cache-Control", "no-store");
    return res.json(records);
  } catch (error) {
    next(error);
  }
});

router.post("/encounters", async (req, res, next) => {
  try {
    const body = encounterBodySchema.safeParse(req.body);
    if (!body.success) return invalid(res, body.error);
    const { studentIdA, studentIdB } = body.data;
    if (studentIdA === studentIdB) return invalid(res, "Choose two different students.");
    const schoolId = res.locals.schoolId!;
    const active = await findActivePasspilotRuleStudents(schoolId, [studentIdA, studentIdB]);
    if (!active.has(studentIdA) || !active.has(studentIdB)) return studentNotFound(res);
    const reasonNote = body.data.reasonNote ? body.data.reasonNote : null;
    const created = await createPasspilotEncounterRestriction(
      schoolId,
      { studentIdA, studentIdB, reasonNote },
      req.authUser!.id
    );
    if (created.status === "duplicate") {
      return res.status(409).json({
        error: "These students already have an encounter restriction.",
        code: "PASSPILOT_RULES_ENCOUNTER_EXISTS",
      });
    }
    await auditRules(req, res, {
      entityId: `encounter:${created.id}`,
      changes: { after: { studentAId: created.studentAId, studentBId: created.studentBId, enabled: true } },
      metadata: { rule: "encounter", operation: "create", reasonNoteProvided: reasonNote !== null },
    });
    return res.status(201).json(await getPasspilotRules(schoolId));
  } catch (error) {
    next(error);
  }
});

router.patch("/encounters/:id", async (req, res, next) => {
  try {
    const body = encounterPatchSchema.safeParse(req.body);
    if (!body.success) return invalid(res, body.error);
    const schoolId = res.locals.schoolId!;
    const updated = await setPasspilotEncounterRestrictionEnabled(schoolId, param(req, "id"), body.data.enabled);
    if (!updated) return notFound(res);
    await auditRules(req, res, {
      entityId: `encounter:${updated.id}`,
      changes: { after: { enabled: updated.enabled } },
      metadata: { rule: "encounter", operation: "update" },
    });
    return res.json(await getPasspilotRules(schoolId));
  } catch (error) {
    next(error);
  }
});

router.delete("/encounters/:id", async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const deleted = await deletePasspilotEncounterRestriction(schoolId, param(req, "id"));
    if (!deleted) return notFound(res);
    await auditRules(req, res, {
      entityId: `encounter:${deleted.id}`,
      changes: { after: null },
      metadata: { rule: "encounter", operation: "delete" },
    });
    return res.json(await getPasspilotRules(schoolId));
  } catch (error) {
    next(error);
  }
});

export default router;
