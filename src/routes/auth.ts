import { Router } from "express";
import crypto from "crypto";
import { google } from "googleapis";
import { loginSchema, registerSchema } from "../schema/validation.js";
import { hashPassword, comparePassword } from "../util/password.js";
import { signUserToken } from "../services/jwt.js";
import {
  getUserByEmail,
  getUserByGoogleId,
  createUser,
  createSchool,
  createMembership,
  getMembershipsWithSchool,
  getProductLicenses,
  updateUser,
  getSchoolBySlug,
  upsertGoogleOAuthToken,
} from "../services/storage.js";
import { authenticate } from "../middleware/authenticate.js";
import { authLimiter } from "../middleware/rateLimiter.js";
import { sendEmail } from "../services/email.js";
import { isLocked, recordFailedAttempt, clearAttempts } from "../services/accountLockout.js";
import { issueAuthCode, consumeAuthCode } from "../services/authCodeExchange.js";
import { logAudit } from "../services/audit.js";

function clientIp(req: any): string | undefined {
  // Trust proxy is set by the app — this gives us the client IP, not ALB
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip;
}

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

    // Check account lockout before doing any work
    const lockedUntil = await isLocked(email);
    if (lockedUntil) {
      const minutesLeft = Math.ceil((lockedUntil.getTime() - Date.now()) / 60000);
      return res.status(429).json({
        error: `Account temporarily locked due to too many failed attempts. Try again in ${minutesLeft} minutes or reset your password.`,
      });
    }

    const user = await getUserByEmail(email);

    if (!user || !user.password) {
      await recordFailedAttempt(email);
      // Audit: failed login for unknown email (no user, no school context)
      await logAudit({
        action: "auth.login.failed",
        userEmail: email,
        metadata: { reason: "user_not_found", ip: clientIp(req) },
      });
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const valid = await comparePassword(password, user.password);
    if (!valid) {
      const triggered = await recordFailedAttempt(email);
      // Audit: failed login for known user (wrong password)
      await logAudit({
        userId: user.id,
        userEmail: email,
        action: "auth.login.failed",
        metadata: { reason: "bad_password", ip: clientIp(req), lockoutTriggered: triggered },
      });
      if (triggered) {
        console.warn(`[Security] Account locked after failed attempts: ${email}`);
      }
      return res.status(401).json({ error: "Invalid email or password" });
    }

    // Success — clear any failed attempt tracking
    await clearAttempts(email);

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

    // Persist session to PostgreSQL before responding
    await new Promise<void>((resolve, reject) => {
      req.session.save((err) => (err ? reject(err) : resolve()));
    });

    // Update last login
    await updateUser(user.id, { lastLoginAt: new Date() });

    // Audit: successful login
    await logAudit({
      schoolId: firstMembership?.membership.schoolId ?? null,
      userId: user.id,
      userEmail: user.email,
      userRole: user.isSuperAdmin ? "super_admin" : firstMembership?.membership.role,
      action: "auth.login.success",
      metadata: { ip: clientIp(req), method: "password" },
    });

    const { password: _, ...safeUser } = user;

    return res.json({
      token,
      user: safeUser,
      memberships: membershipsWithSchool.map((m) => ({
        id: m.membership.id,
        schoolId: m.membership.schoolId,
        role: m.membership.role,
        gopilotRole: m.membership.gopilotRole,
        schoolName: m.school.name,
        schoolTimezone: m.school.schoolTimezone,
        dismissalTime: m.school.dismissalTime,
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

    const { email, password, firstName, lastName, phone, schoolName, timezone, schoolSlug } =
      parsed.data;

    // Check if user exists
    const existing = await getUserByEmail(email);
    if (existing) {
      return res.status(409).json({ error: "Email already registered" });
    }

    // If schoolSlug provided, verify school exists (parent registration)
    let parentSchool = null;
    if (schoolSlug) {
      parentSchool = await getSchoolBySlug(schoolSlug);
      if (!parentSchool) {
        return res.status(404).json({ error: "School not found. Check the code and try again." });
      }
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

    if (parentSchool) {
      // Parent registration: join existing school
      school = parentSchool;
      membership = await createMembership({
        userId: user.id,
        schoolId: school.id,
        role: "parent",
      });

      req.session.userId = user.id;
      req.session.email = user.email;
      req.session.role = "parent";
      req.session.schoolId = school.id;
      req.session.schoolSessionVersion = school.schoolSessionVersion;
    } else if (schoolName) {
      // Admin registration: create a new school
      school = await createSchool({
        name: schoolName,
        domain: email.split("@")[1]?.toLowerCase() || null,
        status: "active",
        planTier: "basic",
        schoolTimezone: timezone || "America/New_York",
      });

      membership = await createMembership({
        userId: user.id,
        schoolId: school.id,
        role: "admin",
      });

      // Notify super admin of new school registration
      sendEmail({
        to: "support@school-pilot.net",
        subject: `New School Registration: ${schoolName}`,
        html: `<h3>New School Registered</h3>
          <p><strong>School:</strong> ${schoolName}</p>
          <p><strong>Admin:</strong> ${email}</p>
          <p><strong>Domain:</strong> ${email.split("@")[1] || "N/A"}</p>
          <p><strong>Time:</strong> ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })}</p>
          <p><a href="https://school-pilot.net/super-admin">View in Super Admin Dashboard</a></p>`,
      }).catch(() => { /* non-blocking */ });

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

    // Persist session to PostgreSQL before responding
    await new Promise<void>((resolve, reject) => {
      req.session.save((err) => (err ? reject(err) : resolve()));
    });

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

    // Generate JWT so clients can use it for Socket.io and API calls
    const token = signUserToken({
      userId: req.authUser.id,
      email: req.authUser.email,
      isSuperAdmin: req.authUser.isSuperAdmin,
    });

    return res.json({
      user: safeUser,
      token,
      licenses,
      memberships: membershipsWithSchool.map((m) => ({
        id: m.membership.id,
        schoolId: m.membership.schoolId,
        role: m.membership.role,
        gopilotRole: m.membership.gopilotRole,
        schoolName: m.school.name,
        schoolTimezone: m.school.schoolTimezone,
        dismissalTime: m.school.dismissalTime,
        kioskName: m.membership.kioskName,
        carNumber: m.membership.carNumber,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Google OAuth Login
// ============================================================================

function getLoginOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.PUBLIC_BASE_URL || "http://localhost:4000"}/api/auth/google/callback`
  );
}

function getFrontendUrl(): string {
  const allowlist = (process.env.CORS_ALLOWLIST || "")
    .split(",")
    .map((s: string) => s.trim())
    .filter(Boolean);
  return allowlist[0] || "http://localhost:5173";
}

// GET /api/auth/google — Initiate Google OAuth login
// Accepts optional ?redirect= to return the user to a specific path after login
router.get("/google", (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.status(503).json({ error: "Google OAuth not configured" });
  }

  // Encode the desired post-login redirect path into OAuth state
  const redirectPath = (req.query.redirect as string) || "";
  const state = redirectPath ? Buffer.from(redirectPath).toString("base64url") : "";

  const oauth2Client = getLoginOAuth2Client();
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: [
      "openid",
      "profile",
      "email",
      "https://www.googleapis.com/auth/admin.directory.user.readonly",
      "https://www.googleapis.com/auth/admin.directory.orgunit.readonly",
      "https://www.googleapis.com/auth/classroom.courses.readonly",
      "https://www.googleapis.com/auth/classroom.rosters.readonly",
      "https://www.googleapis.com/auth/classroom.profile.emails",
    ],
    prompt: "consent",
    ...(state ? { state } : {}),
  });

  return res.redirect(url);
});

// GET /api/auth/google/callback — Handle Google OAuth callback
router.get("/google/callback", async (req, res, next) => {
  try {
    const code = req.query.code as string;
    const frontendUrl = getFrontendUrl();

    if (!code) {
      return res.redirect(`${frontendUrl}/login?error=no_code`);
    }

    const oauth2Client = getLoginOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Get user info from Google
    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const { data: profile } = await oauth2.userinfo.get();

    if (!profile.email) {
      // Durable record of the silent failure (otherwise just a redirect).
      await logAudit({
        action: "auth.rejected",
        metadata: { reason: "no_email", method: "google" },
      });
      return res.redirect(`${frontendUrl}/login?error=no_email`);
    }

    // Find user by googleId first, then by email
    let user = profile.id ? await getUserByGoogleId(profile.id) : undefined;
    if (!user) {
      user = await getUserByEmail(profile.email);
    }

    if (!user) {
      // The "Workspace admin email isn't connecting" case — record WHO tried
      // and WHY so it can be pinpointed instead of vanishing into a redirect.
      await logAudit({
        action: "auth.rejected",
        userEmail: profile.email,
        metadata: { reason: "no_account", method: "google" },
      });
      return res.redirect(`${frontendUrl}/login?error=no_account`);
    }

    // Update googleId and profile image if needed
    const updates: Record<string, any> = { lastLoginAt: new Date() };
    if (profile.id && !user.googleId) updates.googleId = profile.id;
    if (profile.picture && profile.picture !== user.profileImageUrl)
      updates.profileImageUrl = profile.picture;
    await updateUser(user.id, updates);

    // Save Google OAuth refresh token so Workspace directory import works immediately
    if (tokens.refresh_token) {
      await upsertGoogleOAuthToken(user.id, {
        refreshToken: tokens.refresh_token,
        scope: tokens.scope || "",
        tokenType: tokens.token_type || "Bearer",
        expiryDate: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
      });
    }

    // Get memberships for session
    const membershipsWithSchool = await getMembershipsWithSchool(user.id);
    const firstMembership = membershipsWithSchool[0];

    // Set session
    req.session.userId = user.id;
    req.session.email = user.email;
    req.session.role = user.isSuperAdmin
      ? "super_admin"
      : firstMembership?.membership.role || "teacher";
    req.session.schoolId = firstMembership?.membership.schoolId || null;
    req.session.schoolSessionVersion =
      firstMembership?.school.schoolSessionVersion ?? 1;

    // Generate JWT so the frontend can authenticate immediately
    // (Session cookies don't work behind CloudFront→ALB HTTP proxy)
    const token = signUserToken({
      userId: user.id,
      email: user.email,
      isSuperAdmin: user.isSuperAdmin,
    });

    // Save session best-effort (for cookie-based clients)
    await new Promise<void>((resolve, reject) => {
      req.session.save((err) => (err ? reject(err) : resolve()));
    });

    // Decode redirect hint from OAuth state (if provided)
    const stateParam = req.query.state as string;
    let redirectAfter = "";
    if (stateParam) {
      try {
        const decoded = Buffer.from(stateParam, "base64url").toString();
        // Only allow relative paths starting with /
        if (decoded.startsWith("/")) redirectAfter = decoded;
      } catch { /* ignore invalid state */ }
    }

    // Resolve /gopilot to the correct role-based path
    if (redirectAfter === "/gopilot") {
      const gopilotRole = firstMembership?.membership.gopilotRole || firstMembership?.membership.role;
      if (gopilotRole === "parent") redirectAfter = "/gopilot/parent";
      else if (gopilotRole === "teacher") redirectAfter = "/gopilot/teacher";
      // else stays /gopilot (office/admin dashboard)
    }

    // Issue a one-time code (60s TTL, single-use) and put THAT in the URL
    // instead of the JWT. Client exchanges the code via POST /auth/exchange-code.
    // Avoids leaking JWTs to browser history, Referer headers, server logs,
    // and native deep-link logs.
    const oneTimeCode = issueAuthCode(token);

    // Native GoPilot app: redirect via deep link back into the app
    if (redirectAfter.startsWith("/gopilot")) {
      const deepLink = `com.schoolpilot.gopilot://auth/callback?code=${encodeURIComponent(oneTimeCode)}&redirect=${encodeURIComponent(redirectAfter)}`;
      return res.redirect(deepLink);
    }

    // Web login: go to /login as usual
    return res.redirect(`${frontendUrl}/login?code=${encodeURIComponent(oneTimeCode)}`);
  } catch (err) {
    console.error("[auth] Google OAuth callback error:", err);
    const frontendUrl = getFrontendUrl();
    return res.redirect(`${frontendUrl}/login?error=oauth_failed`);
  }
});

// POST /api/auth/logout
router.post("/logout", (req, res) => {
  // Capture before destroy
  const userId = req.session?.userId;
  const userEmail = req.session?.email;
  const schoolId = req.session?.schoolId;
  const role = req.session?.role;
  req.session.destroy(() => {
    res.clearCookie("schoolpilot.sid");
    if (userId) {
      logAudit({
        schoolId: schoolId ?? null,
        userId,
        userEmail,
        userRole: role,
        action: "auth.logout",
      }).catch(() => {});
    }
    res.json({ ok: true });
  });
});

// POST /api/auth/exchange-code
// Trade a one-time code (issued by Google OAuth callback) for the JWT.
// Code is single-use and expires after 60 seconds. Returns 400 if invalid/expired.
router.post("/exchange-code", (req, res) => {
  const { code } = req.body || {};
  if (typeof code !== "string" || !code) {
    return res.status(400).json({ error: "code required" });
  }
  const token = consumeAuthCode(code);
  if (!token) {
    return res.status(400).json({ error: "Invalid or expired code" });
  }
  return res.json({ token });
});

// GET /api/auth/csrf
// Returns a per-session CSRF token
router.get("/csrf", (req, res) => {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  }
  res.json({ csrfToken: req.session.csrfToken });
});

export default router;
