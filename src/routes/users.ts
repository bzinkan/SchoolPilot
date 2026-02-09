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
import {
  getUserByEmail,
  createUser,
  updateUser,
  getStaffBySchool,
  getUsersBySchool,
  getMembershipsBySchool,
  getMembershipByUserAndSchool,
  createMembership,
  updateMembership,
  deleteMembership,
  getMembershipsWithSchool,
} from "../services/storage.js";

const router = Router();

function param(req: { params: Record<string, unknown> }, key: string): string {
  return String(req.params[key] ?? "");
}

router.use(authenticate);

const schoolContext = [requireSchoolContext, requireActiveSchool] as const;

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
        schoolName: m.school.name,
        kioskName: m.membership.kioskName,
        carNumber: m.membership.carNumber,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Staff management (school-scoped)
// ============================================================================

// GET /api/users/staff
router.get(
  "/staff",
  ...schoolContext,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const staff = await getStaffBySchool(res.locals.schoolId!);
      return res.json({
        staff: staff.map((s) => {
          const { password: _, ...safeUser } = s.user;
          return {
            id: s.id,
            userId: s.userId,
            role: s.role,
            kioskName: s.kioskName,
            carNumber: s.carNumber,
            user: safeUser,
          };
        }),
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/users/teachers
router.get("/teachers", ...schoolContext, async (req, res, next) => {
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
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const parsed = createTeacherSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: parsed.error.errors[0]?.message || "Invalid input" });
      }

      const role = req.body.role || "teacher";
      if (!["teacher", "office_staff", "admin"].includes(role)) {
        return res.status(400).json({ error: "Invalid role" });
      }

      let user = await getUserByEmail(parsed.data.email);

      if (!user) {
        const hashedPassword = parsed.data.password
          ? await hashPassword(parsed.data.password)
          : null;

        const nameParts = parsed.data.displayName.split(/\s+/);
        user = await createUser({
          email: parsed.data.email.toLowerCase(),
          password: hashedPassword,
          firstName: nameParts[0] || "",
          lastName: nameParts.slice(1).join(" ") || "",
          displayName: parsed.data.displayName,
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
      });

      const { password: _, ...safeUser } = user;
      return res.status(201).json({ user: safeUser, membership });
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/users/staff/:membershipId
router.put(
  "/staff/:membershipId",
  ...schoolContext,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const parsed = updateMembershipSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: parsed.error.errors[0]?.message || "Invalid input" });
      }

      const membership = await updateMembership(
        param(req, "membershipId"),
        parsed.data
      );
      if (!membership) {
        return res.status(404).json({ error: "Membership not found" });
      }

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
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const deleted = await deleteMembership(param(req, "membershipId"));
      if (!deleted) {
        return res.status(404).json({ error: "Membership not found" });
      }
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
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const role = req.query.role as string | undefined;
      const members = role
        ? await getUsersBySchool(res.locals.schoolId!, role)
        : await getMembershipsBySchool(res.locals.schoolId!);

      return res.json({
        members: members.map((m) => {
          const { password: _, ...safeUser } = m.user;
          return {
            membershipId: m.id,
            userId: m.userId,
            schoolId: m.schoolId,
            role: m.role,
            status: m.status,
            carNumber: m.carNumber,
            kioskName: m.kioskName,
            user: safeUser,
          };
        }),
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
