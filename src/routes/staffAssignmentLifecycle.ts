import { Router } from "express";
import { z } from "zod";

import { authenticate } from "../middleware/authenticate.js";
import { requireSchoolContext } from "../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../middleware/requireActiveSchool.js";
import { requireRole } from "../middleware/requireRole.js";
import {
  isDisabledGoPilotParentRole,
  sendGoPilotParentPortalDisabled,
} from "../util/gopilotParentContainment.js";
import {
  getRequestGoPilotRole,
  hasActiveGoPilotLicense,
} from "../services/gopilotAccess.js";
import { getProductLicenses } from "../services/storage.js";
import {
  getStaffAssignmentImpact,
  StaffAssignmentLifecycleError,
  transitionStaffAssignments,
} from "../services/staffAssignmentLifecycle.js";

const router = Router();

const assignmentTypeSchema = z.enum([
  "class_primary",
  "class_co_teacher",
  "passpilot_legacy_class",
  "gopilot_homeroom_primary",
  "gopilot_homeroom_co_teacher",
  "coverage_assignment",
  "teacher_student_assignment",
  "flight_path",
  "block_list",
  "student_group",
  "central_email_recipient",
]);

const transitionTargetSchema = z
  .object({
    action: z.enum(["deactivate", "change_role"]),
    newRole: z.enum(["teacher", "admin", "school_admin", "office_staff"]).optional(),
    newGopilotRole: z.enum(["teacher", "office_staff"]).nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const hasGopilotRole = Object.prototype.hasOwnProperty.call(value, "newGopilotRole");
    if (value.action === "change_role" && !value.newRole && !hasGopilotRole) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["newRole"],
        message: "newRole or newGopilotRole is required for change_role",
      });
    }
    if (
      value.action === "deactivate" &&
      (value.newRole !== undefined || hasGopilotRole)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["action"],
        message: "Role targets are not accepted for deactivate",
      });
    }
  });

const transitionSchema = z
  .object({
    expectedRevision: z.string().min(1).max(200),
    action: z.enum(["deactivate", "change_role"]),
    newRole: z.enum(["teacher", "admin", "school_admin", "office_staff"]).optional(),
    newGopilotRole: z.enum(["teacher", "office_staff"]).nullable().optional(),
    decisions: z
      .array(
        z
          .object({
            assignmentType: assignmentTypeSchema,
            assignmentId: z.string().min(1).max(200),
            operation: z.enum(["replace", "remove"]),
            replacementMembershipId: z.string().min(1).max(200).optional(),
          })
          .strict()
      )
      .max(5_000),
  })
  .strict()
  .superRefine((value, context) => {
    const hasGopilotRole = Object.prototype.hasOwnProperty.call(value, "newGopilotRole");
    if (value.action === "change_role" && !value.newRole && !hasGopilotRole) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["newRole"],
        message: "newRole or newGopilotRole is required for change_role",
      });
    }
    if (
      value.action === "deactivate" &&
      (value.newRole !== undefined || hasGopilotRole)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["action"],
        message: "Role targets are not accepted for deactivate",
      });
    }
  });

const requireBaseAdmin = requireRole("admin");

function isGoPilotSetupRequest(res: import("express").Response): boolean {
  return res.locals.goPilotSetup === true;
}

export function staffTransitionProductContextError(
  goPilotSetup: boolean,
  target: { newRole?: unknown; newGopilotRole?: unknown }
): { code: string; error: string } | null {
  if (goPilotSetup && Object.prototype.hasOwnProperty.call(target, "newRole")) {
    // GoPilot has no product-local admin override. Its setup admins already
    // hold shared base-admin authority, so the one deliberate cross-product
    // mutation is an explicit promotion to shared admin with inheritance reset.
    const explicitSharedAdminPromotion = target.newRole === "admin"
      && Object.prototype.hasOwnProperty.call(target, "newGopilotRole")
      && target.newGopilotRole === null;
    if (explicitSharedAdminPromotion) return null;
    return {
      code: "BASE_ROLE_CONTEXT_REQUIRED",
      error: "GoPilot setup may change product roles or explicitly promote a staff member to shared school admin.",
    };
  }
  if (!goPilotSetup && Object.prototype.hasOwnProperty.call(target, "newGopilotRole")) {
    return {
      code: "GOPILOT_ROLE_CONTEXT_REQUIRED",
      error: "GoPilot roles must be changed from GoPilot staff setup.",
    };
  }
  return null;
}

function rejectCrossProductTransitionTarget(
  res: import("express").Response,
  target: { newRole?: unknown; newGopilotRole?: unknown }
): boolean {
  const error = staffTransitionProductContextError(
    isGoPilotSetupRequest(res),
    target
  );
  if (!error) return false;
  res.status(400).json(error);
  return true;
}

async function hasActiveIndependentStaffProduct(schoolId: string): Promise<boolean> {
  const now = Date.now();
  const licenses = await getProductLicenses(schoolId);
  return licenses.some(
    (license) =>
      (license.product === "CLASSPILOT" || license.product === "PASSPILOT") &&
      license.status === "active" &&
      (!license.expiresAt || license.expiresAt.getTime() > now)
  );
}

const checkLifecycleManagementRole: import("express").RequestHandler = async (
  req,
  res,
  next
) => {
  const schoolId = res.locals.schoolId!;
  const effectiveRole = await getRequestGoPilotRole(req, res);
  if (isGoPilotSetupRequest(res)) {
    if (isDisabledGoPilotParentRole(effectiveRole)) {
      return sendGoPilotParentPortalDisabled(res);
    }
    if (!(await hasActiveGoPilotLicense(schoolId))) {
      return res.status(403).json({ error: "Product license required" });
    }
    if (
      effectiveRole !== "super_admin" &&
      effectiveRole !== "admin" &&
      effectiveRole !== "school_admin"
    ) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    return next();
  }
  if (!(await hasActiveIndependentStaffProduct(schoolId))) {
    if (
      isDisabledGoPilotParentRole(effectiveRole) &&
      (await hasActiveGoPilotLicense(schoolId))
    ) {
      return sendGoPilotParentPortalDisabled(res);
    }
    return res.status(403).json({ error: "Product license required" });
  }
  return requireBaseAdmin(req, res, next);
};

const requireLifecycleManagementRole: import("express").RequestHandler = (
  req,
  res,
  next
) => {
  void Promise.resolve(checkLifecycleManagementRole(req, res, next)).catch(next);
};

const auth = [
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireLifecycleManagementRole,
] as const;

function membershipId(req: { params: Record<string, unknown> }): string {
  return String(req.params.membershipId ?? "");
}

function sendLifecycleError(
  res: import("express").Response,
  error: StaffAssignmentLifecycleError
) {
  return res.status(error.status).json({
    error: error.message,
    code: error.code,
    ...(error.details ?? {}),
  });
}

router.get(
  "/staff/:membershipId/assignment-impact",
  ...auth,
  async (req, res, next) => {
    try {
      const targetPayload: Record<string, unknown> = {
        action: req.query.action ?? "deactivate",
      };
      if (req.query.newRole !== undefined) targetPayload.newRole = req.query.newRole;
      if (req.query.newGopilotRole !== undefined) {
        targetPayload.newGopilotRole = req.query.newGopilotRole === "null"
          ? null
          : req.query.newGopilotRole;
      }
      const target = transitionTargetSchema.safeParse(targetPayload);
      if (!target.success) {
        return res.status(422).json({
          error: target.error.errors[0]?.message ?? "Invalid staff impact target.",
          code: "STAFF_TRANSITION_INVALID",
        });
      }
      if (rejectCrossProductTransitionTarget(res, target.data)) return;
      const impact = await getStaffAssignmentImpact(
        res.locals.schoolId!,
        membershipId(req),
        target.data
      );
      return res.json({ impact });
    } catch (error) {
      if (error instanceof StaffAssignmentLifecycleError) {
        return sendLifecycleError(res, error);
      }
      return next(error);
    }
  }
);

router.post(
  "/staff/:membershipId/transition",
  ...auth,
  async (req, res, next) => {
    try {
      const parsed = transitionSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(422).json({
          error: parsed.error.errors[0]?.message ?? "Invalid staff transition request.",
          code: "STAFF_TRANSITION_INVALID",
        });
      }
      if (rejectCrossProductTransitionTarget(res, parsed.data)) return;
      const result = await transitionStaffAssignments({
        schoolId: res.locals.schoolId!,
        membershipId: membershipId(req),
        request: parsed.data,
        actorUserId: req.authUser!.id,
        actorRole: req.authUser!.isSuperAdmin
          ? "super_admin"
          : String(res.locals.membershipRole ?? "admin"),
      });
      return res.json(result);
    } catch (error) {
      if (error instanceof StaffAssignmentLifecycleError) {
        return sendLifecycleError(res, error);
      }
      return next(error);
    }
  }
);

export default router;
