import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireRole } from "../../middleware/requireRole.js";
import {
  getSubstitutionsBySchool,
  getActiveSubstitutionsBySchool,
  getActiveSubstitutionsForUser,
  createSubstituteAssignment,
  cancelSubstituteAssignment,
  getUserById,
  getUserByEmail,
  createUser,
  createMembership,
  getMembershipByUserAndSchool,
} from "../../services/storage.js";

const router = Router();

function param(req: { params: Record<string, unknown> }, key: string): string {
  return String(req.params[key] ?? "");
}

const schoolAuth = [
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
] as const;

const adminAuth = [...schoolAuth, requireRole("admin")] as const;

// ============================================================================
// Substitute's own view (any authenticated teacher)
// ============================================================================

// GET /api/admin/substitutes/mine — sub sees their own active assignments
router.get("/mine", ...schoolAuth, async (req, res, next) => {
  try {
    const subs = await getActiveSubstitutionsForUser(
      req.authUser!.id,
      res.locals.schoolId!
    );
    const enriched = await Promise.all(
      subs.map(async (s) => {
        const teacher = await getUserById(s.absentTeacherId);
        return {
          ...s,
          absentTeacher: teacher
            ? {
                id: teacher.id,
                name:
                  teacher.displayName ||
                  `${teacher.firstName} ${teacher.lastName}`,
                email: teacher.email,
              }
            : null,
        };
      })
    );
    return res.json({ substitutions: enriched });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Admin management
// ============================================================================

// GET /api/admin/substitutes — list all substitute assignments
router.get("/", ...adminAuth, async (req, res, next) => {
  try {
    const { active } = req.query;
    const assignments =
      active === "true"
        ? await getActiveSubstitutionsBySchool(res.locals.schoolId!)
        : await getSubstitutionsBySchool(res.locals.schoolId!);

    const enriched = await Promise.all(
      assignments.map(async (a) => {
        const [sub, teacher] = await Promise.all([
          getUserById(a.substituteUserId),
          getUserById(a.absentTeacherId),
        ]);
        return {
          ...a,
          substitute: sub
            ? {
                id: sub.id,
                name:
                  sub.displayName || `${sub.firstName} ${sub.lastName}`,
                email: sub.email,
              }
            : null,
          absentTeacher: teacher
            ? {
                id: teacher.id,
                name:
                  teacher.displayName ||
                  `${teacher.firstName} ${teacher.lastName}`,
                email: teacher.email,
              }
            : null,
        };
      })
    );

    return res.json({ assignments: enriched });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/substitutes — create a substitute assignment
router.post("/", ...adminAuth, async (req, res, next) => {
  try {
    const {
      substituteUserId,
      substituteEmail,
      substituteName,
      absentTeacherId,
      startDate,
      endDate,
      notes,
    } = req.body;

    if (!absentTeacherId) {
      return res.status(400).json({ error: "absentTeacherId is required" });
    }
    if (!startDate || !endDate) {
      return res
        .status(400)
        .json({ error: "startDate and endDate are required" });
    }

    let subUserId = substituteUserId;

    // Handle external substitute: create user + membership if needed
    if (!subUserId && substituteEmail) {
      let user = await getUserByEmail(substituteEmail.toLowerCase());
      if (!user) {
        const nameParts = (
          substituteName || substituteEmail.split("@")[0]
        ).split(/\s+/);
        const { createUser: createUserFn } = await import(
          "../../services/storage.js"
        );
        user = await createUserFn({
          email: substituteEmail.toLowerCase(),
          firstName: nameParts[0] || "",
          lastName: nameParts.slice(1).join(" ") || "",
          displayName:
            substituteName || substituteEmail.split("@")[0],
        });
      }
      subUserId = user.id;

      // Ensure they have a teacher membership in this school
      const existing = await getMembershipByUserAndSchool(
        subUserId,
        res.locals.schoolId!
      );
      if (!existing) {
        await createMembership({
          userId: subUserId,
          schoolId: res.locals.schoolId!,
          role: "teacher",
        });
      }
    }

    if (!subUserId) {
      return res.status(400).json({
        error: "Either substituteUserId or substituteEmail is required",
      });
    }

    const assignment = await createSubstituteAssignment({
      schoolId: res.locals.schoolId!,
      substituteUserId: subUserId,
      absentTeacherId,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      notes: notes || null,
      status: "active",
      createdBy: req.authUser!.id,
    });

    return res.status(201).json({ assignment });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/substitutes/:id — cancel a substitute assignment
router.delete("/:id", ...adminAuth, async (req, res, next) => {
  try {
    const canceled = await cancelSubstituteAssignment(param(req, "id"));
    if (!canceled) {
      return res.status(404).json({ error: "Assignment not found" });
    }
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
