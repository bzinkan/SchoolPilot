import { Router } from "express";
import { loginSchema, registerSchema } from "../schema/validation.js";
import { hashPassword, comparePassword } from "../util/password.js";
import { signUserToken } from "../services/jwt.js";
import {
  getUserByEmail,
  createUser,
  createSchool,
  createMembership,
  getMembershipsWithSchool,
  getProductLicenses,
  updateUser,
} from "../services/storage.js";
import { authenticate } from "../middleware/authenticate.js";
import { authLimiter } from "../middleware/rateLimiter.js";

const router = Router();

// POST /api/auth/login
// Returns both session cookie AND JWT for dual-auth compatibility
router.post("/login", authLimiter, async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: parsed.error.errors[0]?.message || "Invalid input" });
    }

    const { email, password } = parsed.data;
    const user = await getUserByEmail(email);

    if (!user || !user.password) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const valid = await comparePassword(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    // Get memberships
    const membershipsWithSchool = await getMembershipsWithSchool(user.id);
    const firstMembership = membershipsWithSchool[0];

    // Set session (for PassPilot/ClassPilot web clients)
    req.session.userId = user.id;
    req.session.email = user.email;
    req.session.role = user.isSuperAdmin
      ? "super_admin"
      : firstMembership?.membership.role || "teacher";
    req.session.schoolId = firstMembership?.membership.schoolId || null;
    req.session.schoolSessionVersion =
      firstMembership?.school.schoolSessionVersion ?? 1;

    // Generate JWT (for GoPilot clients)
    const token = signUserToken({
      userId: user.id,
      email: user.email,
      isSuperAdmin: user.isSuperAdmin,
    });

    // Update last login
    await updateUser(user.id, { lastLoginAt: new Date() });

    const { password: _, ...safeUser } = user;

    return res.json({
      token,
      user: safeUser,
      memberships: membershipsWithSchool.map((m) => ({
        id: m.membership.id,
        schoolId: m.membership.schoolId,
        role: m.membership.role,
        schoolName: m.school.name,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/register
// GoPilot-style: creates user + optionally a school
router.post("/register", authLimiter, async (req, res, next) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: parsed.error.errors[0]?.message || "Invalid input" });
    }

    const { email, password, firstName, lastName, phone, schoolName, timezone } =
      parsed.data;

    // Check if user exists
    const existing = await getUserByEmail(email);
    if (existing) {
      return res.status(409).json({ error: "Email already registered" });
    }

    const hashedPassword = await hashPassword(password);

    const user = await createUser({
      email: email.toLowerCase(),
      password: hashedPassword,
      firstName,
      lastName,
      displayName: `${firstName} ${lastName}`,
      phone: phone || null,
    });

    let school = null;
    let membership = null;

    // If schoolName provided, create a school (GoPilot pattern)
    if (schoolName) {
      school = await createSchool({
        name: schoolName,
        status: "trial",
        planTier: "trial",
        schoolTimezone: timezone || "America/New_York",
      });

      membership = await createMembership({
        userId: user.id,
        schoolId: school.id,
        role: "admin",
      });

      // Set session
      req.session.userId = user.id;
      req.session.email = user.email;
      req.session.role = "admin";
      req.session.schoolId = school.id;
      req.session.schoolSessionVersion = school.schoolSessionVersion;
    } else {
      req.session.userId = user.id;
      req.session.email = user.email;
      req.session.role = "teacher";
      req.session.schoolId = null;
    }

    const token = signUserToken({
      userId: user.id,
      email: user.email,
      isSuperAdmin: false,
    });

    const { password: _, ...safeUser } = user;

    return res.status(201).json({
      token,
      user: safeUser,
      school,
      membership,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me
// Works with both session cookie and JWT
router.get("/me", authenticate, async (req, res, next) => {
  try {
    if (!req.authUser) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const membershipsWithSchool = await getMembershipsWithSchool(
      req.authUser.id
    );

    const { password: _, ...safeUser } = req.authUser;

    // Resolve product licenses for the active school
    const schoolId =
      req.session?.schoolId || membershipsWithSchool[0]?.membership.schoolId;
    let licenses = { classPilot: false, passPilot: false, goPilot: false };
    if (schoolId) {
      const productLicenses = await getProductLicenses(schoolId);
      for (const pl of productLicenses) {
        if (pl.product === "CLASSPILOT" && pl.status === "active")
          licenses.classPilot = true;
        if (pl.product === "PASSPILOT" && pl.status === "active")
          licenses.passPilot = true;
        if (pl.product === "GOPILOT" && pl.status === "active")
          licenses.goPilot = true;
      }
    }

    return res.json({
      user: safeUser,
      licenses,
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

// POST /api/auth/logout
router.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("schoolpilot.sid");
    res.json({ ok: true });
  });
});

// GET /api/auth/csrf
// Returns CSRF token for ClassPilot-style clients
router.get("/csrf", (req, res) => {
  // For now, return a simple token. Full CSRF will be added with csurf.
  res.json({ csrfToken: "ok" });
});

export default router;
