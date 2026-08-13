import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { requireSchoolContext } from "../middleware/requireSchoolContext.js";
import { requireRole } from "../middleware/requireRole.js";
import { requireActiveSchool } from "../middleware/requireActiveSchool.js";
import {
  createTeacherSchema,
  updateUserSchema,
  updateMembershipSchema,
} from "../schema/validation.js";
import { hashPassword } from "../util/password.js";
import { logAuditStrict } from "../services/audit.js";
import { disabledGoPilotParentPortalHandler } from "../util/gopilotParentContainment.js";
import {
  isDisabledGoPilotParentRole,
  sendGoPilotParentPortalDisabled,
} from "../util/gopilotParentContainment.js";
import {
  getRequestGoPilotRole,
  hasActiveGoPilotLicense,
} from "../services/gopilotAccess.js";
import {
  getUserByEmail,
  createUser,
  updateUser,
  getStaffBySchool,
  getUsersBySchool,
  getMembershipsBySchool,
  getMembershipByUserAndSchool,
  createMembership,
  updateMembershipForSchool,
  deleteMembershipForSchool,
  getMembershipsWithSchool,
  validateStaffEmailDomainForSchool,
  getProductLicenses,
} from "../services/storage.js";

const router = Router();

function param(req: { params: Record<string, unknown> }, key: string): string {
  return String(req.params[key] ?? "");
}

function staffUserDto(user: any, goPilotSetup: boolean) {
  const { password: _password, ...legacy } = user;
  if (!goPilotSetup) return legacy;
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    displayName: user.displayName,
    profileImageUrl: user.profileImageUrl,
  };
}

router.use(authenticate);

const schoolContext = [requireSchoolContext, requireActiveSchool] as const;
const requireBaseAdmin = requireRole("admin");
const requireBaseStaff = requireRole("admin", "school_admin", "teacher", "office_staff");

function isGoPilotSetupRequest(res: import("express").Response): boolean {
  return res.locals.goPilotSetup === true;
}

function rejectCrossProductGoPilotRoleMutation(
  req: import("express").Request,
  res: import("express").Response
): boolean {
  if (
    !isGoPilotSetupRequest(res)
    && Object.prototype.hasOwnProperty.call(req.body ?? {}, "gopilotRole")
  ) {
    res.status(400).json({
      error: "GoPilot roles must be changed from GoPilot staff setup.",
      code: "GOPILOT_ROLE_CONTEXT_REQUIRED",
    });
    return true;
  }
  return false;
}

async function hasActiveIndependentStaffProduct(schoolId: string): Promise<boolean> {
  const now = Date.now();
  const licenses = await getProductLicenses(schoolId);
  return licenses.some((license) =>
    (license.product === "CLASSPILOT" || license.product === "PASSPILOT")
    && license.status === "active"
    && (!license.expiresAt || new Date(license.expiresAt).getTime() > now)
  );
}

/** GoPilot setup aliases use the product override role, not the shared base role. */
const requireStaffManagementRole: import("express").RequestHandler = async (req, res, next) => {
  const schoolId = res.locals.schoolId!;
  const role = await getRequestGoPilotRole(req, res);
  if (isGoPilotSetupRequest(res)) {
    if (isDisabledGoPilotParentRole(role)) return sendGoPilotParentPortalDisabled(res);
    if (!(await hasActiveGoPilotLicense(schoolId))) {
      return res.status(403).json({ error: "Product license required" });
    }
    if (role !== "super_admin" && role !== "admin" && role !== "school_admin") {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    return next();
  }

  // The canonical shared endpoint is available only through an independently
  // licensed staff product. A GoPilot-only historical parent cannot omit the
  // setup alias/header and recover an old base-admin capability.
  if (!(await hasActiveIndependentStaffProduct(schoolId))) {
    if (isDisabledGoPilotParentRole(role) && await hasActiveGoPilotLicense(schoolId)) {
      return sendGoPilotParentPortalDisabled(res);
    }
    return res.status(403).json({ error: "Product license required" });
  }
  return requireBaseAdmin(req, res, next);
};

const requireSharedStaffDirectoryRole: import("express").RequestHandler = async (req, res, next) => {
  const schoolId = res.locals.schoolId!;
  if (!(await hasActiveIndependentStaffProduct(schoolId))) {
    const role = await getRequestGoPilotRole(req, res);
    if (isDisabledGoPilotParentRole(role) && await hasActiveGoPilotLicense(schoolId)) {
      return sendGoPilotParentPortalDisabled(res);
    }
    return res.status(403).json({ error: "Product license required" });
  }
  return requireBaseStaff(req, res, next);
};

// ============================================================================
// Current user profile
// ============================================================================

// PUT /api/users/me - Update own profile
router.put("/me", async (req, res, next) => {
  try {
    const parsed = updateUserSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: parsed.error.errors[0]?.message || "Invalid input" });
    }

    const user = await updateUser(req.authUser!.id, {
      ...parsed.data,
      displayName:
        parsed.data.displayName ||
        `${parsed.data.firstName || req.authUser!.firstName} ${parsed.data.lastName || req.authUser!.lastName}`,
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const { password: _, ...safeUser } = user;
    return res.json({ user: safeUser });
  } catch (err) {
    next(err);
  }
});

// GET /api/users/me/memberships
router.get("/me/memberships", async (req, res, next) => {
  try {
    const membershipsWithSchool = await getMembershipsWithSchool(
      req.authUser!.id
    );
    return res.json({
      memberships: membershipsWithSchool.map((m) => ({
        id: m.membership.id,
        schoolId: m.membership.schoolId,
        role: m.membership.role,
        gopilotRole: m.membership.gopilotRole,
        schoolName: m.school.name,
        schoolTimezone: m.school.schoolTimezone,
        kioskEnabled: m.school.kioskEnabled,
        kioskRequiresApproval: m.school.kioskRequiresApproval,
        defaultPassDuration: m.school.defaultPassDuration,
        activeGradeLevels: m.school.activeGradeLevels,
        kioskName: m.membership.kioskName,
        ...((m.membership.gopilotRole || m.membership.role) !== "parent"
          ? {
              carNumber: m.membership.carNumber,
              dismissalTime: m.school.dismissalTime,
            }
          : {}),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Parent features (GoPilot: /me/children, /me/join-school)
// ============================================================================

// GET /api/users/me/children
router.get("/me/children", disabledGoPilotParentPortalHandler);

// POST /api/users/me/children/link
router.post("/me/children/link", disabledGoPilotParentPortalHandler);

// POST /api/users/me/children/link-by-car
router.post("/me/children/link-by-car", disabledGoPilotParentPortalHandler);

// POST /api/users/me/join-school
router.post("/me/join-school", disabledGoPilotParentPortalHandler);

// ============================================================================
// Staff management (school-scoped)
// ============================================================================

// GET /api/users/staff
router.get(
  "/staff",
  ...schoolContext,
  requireStaffManagementRole,
  async (req, res, next) => {
    try {
      const staff = await getStaffBySchool(res.locals.schoolId!);
      const goPilotSetup = isGoPilotSetupRequest(res);
      return res.json({
        staff: staff.map((s) => {
          return {
            id: s.id,
            userId: s.userId,
            role: s.role,
            gopilotRole: s.gopilotRole,
            kioskName: s.kioskName,
            carNumber: s.carNumber,
            user: staffUserDto(s.user, goPilotSetup),
          };
        }),
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/users/teachers
router.get("/teachers", ...schoolContext, requireSharedStaffDirectoryRole, async (req, res, next) => {
  try {
    const teachers = await getUsersBySchool(res.locals.schoolId!, "teacher");
    return res.json({
      teachers: teachers.map((t) => {
        const { password: _, ...safeUser } = t.user;
        return {
          membershipId: t.id,
          userId: t.userId,
          role: t.role,
          kioskName: t.kioskName,
          user: safeUser,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/users/staff - Create staff member
router.post(
  "/staff",
  ...schoolContext,
  requireStaffManagementRole,
  async (req, res, next) => {
    try {
      if (rejectCrossProductGoPilotRoleMutation(req, res)) return;
      const parsed = createTeacherSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: parsed.error.errors[0]?.message || "Invalid input" });
      }

      const role = parsed.data.role || "teacher";
      const domainValidation = await validateStaffEmailDomainForSchool(
        parsed.data.email,
        res.locals.schoolId!
      );
      if (!domainValidation.ok) {
        return res.status(400).json({
          error: domainValidation.message,
          code: domainValidation.code,
          expectedDomain: domainValidation.expectedDomain,
          actualDomain: domainValidation.actualDomain,
        });
      }

      let user = await getUserByEmail(parsed.data.email);

      if (!user) {
        const hashedPassword = parsed.data.password
          ? await hashPassword(parsed.data.password)
          : null;

        // Support both displayName and firstName/lastName from frontend
        const firstName = parsed.data.firstName || parsed.data.displayName?.split(/\s+/)[0] || "";
        const lastName = parsed.data.lastName || parsed.data.displayName?.split(/\s+/).slice(1).join(" ") || "";
        const displayName = parsed.data.displayName || `${firstName} ${lastName}`.trim();

        user = await createUser({
          email: parsed.data.email.toLowerCase(),
          password: hashedPassword,
          firstName,
          lastName,
          displayName,
        });
      }

      const existing = await getMembershipByUserAndSchool(
        user.id,
        res.locals.schoolId!
      );
      if (existing) {
        return res
          .status(409)
          .json({ error: "User already has a membership in this school" });
      }

      const membership = await createMembership({
        userId: user.id,
        schoolId: res.locals.schoolId!,
        role,
        gopilotRole: parsed.data.gopilotRole || null,
      });

      await logAuditStrict({
        schoolId: res.locals.schoolId!,
        userId: req.authUser!.id,
        userEmail: req.authUser!.email,
        userRole: isGoPilotSetupRequest(res) ? res.locals.gopilotRole : res.locals.membershipRole,
        action: isGoPilotSetupRequest(res) ? "gopilot.staff.created" : "school.staff.created",
        entityType: "school_membership",
        entityId: membership.id,
        changes: { fields: ["role", ...(parsed.data.gopilotRole ? ["gopilotRole"] : [])] },
        metadata: { userId: user.id },
      });

      return res.status(201).json({
        user: staffUserDto(user, isGoPilotSetupRequest(res)),
        membership,
      });
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/users/staff/:membershipId
router.put(
  "/staff/:membershipId",
  ...schoolContext,
  requireStaffManagementRole,
  async (req, res, next) => {
    try {
      if (rejectCrossProductGoPilotRoleMutation(req, res)) return;
      const parsed = updateMembershipSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: parsed.error.errors[0]?.message || "Invalid input" });
      }

      const membership = await updateMembershipForSchool(
        param(req, "membershipId"),
        res.locals.schoolId!,
        parsed.data
      );
      if (!membership) {
        return res.status(404).json({ error: "Membership not found" });
      }

      // Also update user fields (name, password) if provided
      const { firstName, lastName, password } = req.body;
      if (membership.userId && (firstName || lastName || password)) {
        const userUpdates: Record<string, any> = {};
        if (firstName) userUpdates.firstName = firstName;
        if (lastName) userUpdates.lastName = lastName;
        if (firstName || lastName) {
          userUpdates.displayName = `${firstName || ""} ${lastName || ""}`.trim();
        }
        if (password && password.length >= 8) {
          userUpdates.password = await hashPassword(password);
        }
        if (Object.keys(userUpdates).length > 0) {
          await updateUser(membership.userId, userUpdates);
        }
      }

      const changedFields = ["role", "gopilotRole", "status", "firstName", "lastName", "password"]
        .filter((field) => Object.prototype.hasOwnProperty.call(req.body ?? {}, field))
        .map((field) => field === "password" ? "passwordChanged" : field);
      await logAuditStrict({
        schoolId: res.locals.schoolId!,
        userId: req.authUser!.id,
        userEmail: req.authUser!.email,
        userRole: isGoPilotSetupRequest(res) ? res.locals.gopilotRole : res.locals.membershipRole,
        action: isGoPilotSetupRequest(res) ? "gopilot.staff.updated" : "school.staff.updated",
        entityType: "school_membership",
        entityId: membership.id,
        changes: { fields: changedFields },
        metadata: { userId: membership.userId },
      });

      return res.json({ membership });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/users/staff/:membershipId
router.delete(
  "/staff/:membershipId",
  ...schoolContext,
  requireStaffManagementRole,
  async (req, res, next) => {
    try {
      const deleted = await deleteMembershipForSchool(
        param(req, "membershipId"),
        res.locals.schoolId!
      );
      if (!deleted) {
        return res.status(404).json({ error: "Membership not found" });
      }
      await logAuditStrict({
        schoolId: res.locals.schoolId!,
        userId: req.authUser!.id,
        userEmail: req.authUser!.email,
        userRole: isGoPilotSetupRequest(res) ? res.locals.gopilotRole : res.locals.membershipRole,
        action: isGoPilotSetupRequest(res) ? "gopilot.staff.removed" : "school.staff.removed",
        entityType: "school_membership",
        entityId: param(req, "membershipId"),
        changes: { fields: ["status"] },
      });
      return res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

// ============================================================================
// Members (all roles)
// ============================================================================

// GET /api/users/members
router.get(
  "/members",
  ...schoolContext,
  requireStaffManagementRole,
  async (req, res, next) => {
    try {
      const role = req.query.role as string | undefined;
      const members = role
        ? await getUsersBySchool(res.locals.schoolId!, role)
        : await getMembershipsBySchool(res.locals.schoolId!);

      return res.json({
        members: members.map((m) => {
          return {
            membershipId: m.id,
            userId: m.userId,
            schoolId: m.schoolId,
            role: m.role,
            status: m.status,
            carNumber: m.carNumber,
            kioskName: m.kioskName,
            user: staffUserDto(m.user, isGoPilotSetupRequest(res)),
          };
        }),
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
