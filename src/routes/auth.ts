import { Router } from "express";
import crypto from "crypto";
import { google } from "googleapis";
import { loginSchema, registerSchema } from "../schema/validation.js";
import { hashPassword, comparePassword } from "../util/password.js";
import { signUserToken } from "../services/jwt.js";
import {
  getUserByEmail,
  createUser,
  createSchool,
  createMembership,
  getMembershipsWithSchool,
  getEmailDomain,
  getProductLicenses,
  normalizeDomain,
  updateUser,
  IdentityEmailConflictError,
  GoogleIdentityConflictError,
  resolveGoogleLoginIdentity,
} from "../services/storage.js";
import { authenticate } from "../middleware/authenticate.js";
import { authLimiter } from "../middleware/rateLimiter.js";
import { sendEmail } from "../services/email.js";
import { isLocked, recordFailedAttempt, clearAttempts } from "../services/accountLockout.js";
import { issueAuthCode, consumeAuthCode } from "../services/authCodeExchange.js";
import { logAudit } from "../services/audit.js";
import {
  exchangeGoogleAuthCode,
} from "../util/googleOAuthTokenExchange.js";
import { establishWebSession } from "../services/webSession.js";
import { clearSessionCookie } from "../config/sessionCookie.js";
import {
  isDisabledNativeGoPilotOAuthRedirect,
  rejectGoPilotParentRegistration,
} from "../util/gopilotParentContainment.js";
import {
  buildVerifiedSchoolIdentities,
  type VerifiedSchoolIdentity,
} from "../services/schoolIdentity.js";

const GOPILOT_ROLE_PRIORITY = [
  "admin",
  "school_admin",
  "office_staff",
  "teacher",
  "parent",
] as const;

function clientIp(req: any): string | undefined {
  // Trust proxy is set by the app — this gives us the client IP, not ALB
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip;
}

function headerString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function serializeSchoolIdentity(identity: VerifiedSchoolIdentity) {
  const goPilotRoles = [...new Set(identity.memberships.map((membership) =>
    membership.gopilotRole || membership.role
  ))].sort((left, right) =>
    GOPILOT_ROLE_PRIORITY.indexOf(left as typeof GOPILOT_ROLE_PRIORITY[number])
    - GOPILOT_ROLE_PRIORITY.indexOf(right as typeof GOPILOT_ROLE_PRIORITY[number])
  );
  const effectiveGoPilotRole = goPilotRoles[0] || identity.primaryRole;
  return {
    id: identity.primaryMembership.id,
    schoolId: identity.schoolId,
    role: identity.primaryRole,
    roles: identity.roles,
    primaryRole: identity.primaryRole,
    gopilotRole: effectiveGoPilotRole,
    gopilotRoles: goPilotRoles,
    schoolName: identity.school.name,
    schoolTimezone: identity.school.schoolTimezone,
    kioskEnabled: identity.school.kioskEnabled,
    kioskRequiresApproval: identity.school.kioskRequiresApproval,
    defaultPassDuration: identity.school.defaultPassDuration,
    activeGradeLevels: identity.school.activeGradeLevels,
    mailpilotEntitled: identity.school.mailpilotEntitled,
    classpilotEmailMonitoring: identity.school.classpilotEmailMonitoring,
    ...(effectiveGoPilotRole !== "parent"
      ? {
          dismissalTime: identity.school.dismissalTime,
          carNumber:
            identity.memberships.find((membership) => membership.carNumber)
              ?.carNumber ?? null,
        }
      : {}),
    kioskName:
      identity.memberships.find((membership) => membership.kioskName)
        ?.kioskName ?? null,
  };
}

const router = Router();
const NO_ACTIVE_SCHOOL_ERROR =
  "Your account does not have access to an active school. Contact your school administrator.";

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
        console.warn("[Security] Account locked after repeated failed attempts");
      }
      return res.status(401).json({ error: "Invalid email or password" });
    }

    // Success — clear any failed attempt tracking
    await clearAttempts(email);

    // Get memberships
    const membershipsWithSchool = await getMembershipsWithSchool(user.id);
    const schoolIdentities = buildVerifiedSchoolIdentities(membershipsWithSchool);
    const selectedIdentity = schoolIdentities.length === 1
      ? schoolIdentities[0]
      : undefined;
    if (!user.isSuperAdmin && schoolIdentities.length === 0) {
      await logAudit({
        userId: user.id,
        userEmail: user.email,
        action: "auth.rejected",
        metadata: { reason: "no_active_school", method: "password" },
      });
      return res.status(403).json({ error: NO_ACTIVE_SCHOOL_ERROR });
    }

    // Start a fresh session so an expired/stale browser cookie cannot carry
    // idle metadata into the newly authenticated login.
    await establishWebSession(req, {
      userId: user.id,
      email: user.email,
      role: user.isSuperAdmin
        ? "super_admin"
        : selectedIdentity?.primaryRole || schoolIdentities[0]?.primaryRole || "teacher",
      schoolId: selectedIdentity?.schoolId || null,
      schoolSessionVersion: selectedIdentity?.school.schoolSessionVersion,
      authVersion: user.authVersion,
    });

    // Generate JWT (for GoPilot clients)
    const token = signUserToken({
      userId: user.id,
      email: user.email,
      isSuperAdmin: user.isSuperAdmin,
      authVersion: user.authVersion,
    });

    // Persist session to PostgreSQL before responding
    await new Promise<void>((resolve, reject) => {
      req.session.save((err) => (err ? reject(err) : resolve()));
    });

    // Update last login
    await updateUser(user.id, { lastLoginAt: new Date() });

    // Audit: successful login
    await logAudit({
      schoolId: selectedIdentity?.schoolId ?? null,
      userId: user.id,
      userEmail: user.email,
      userRole: user.isSuperAdmin ? "super_admin" : selectedIdentity?.primaryRole,
      action: "auth.login.success",
      metadata: { ip: clientIp(req), method: "password" },
    });

    const { password: _, ...safeUser } = user;

    return res.json({
      token,
      user: safeUser,
      activeSchoolId: selectedIdentity?.schoolId ?? null,
      schoolSelectionRequired: !user.isSuperAdmin && schoolIdentities.length > 1,
      roles: selectedIdentity?.roles ?? [],
      primaryRole: selectedIdentity?.primaryRole ?? null,
      memberships: schoolIdentities.map(serializeSchoolIdentity),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/register
// GoPilot-style: creates user + optionally a school
router.post("/register", rejectGoPilotParentRegistration, authLimiter, async (req, res, next) => {
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

    if (schoolName) {
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

    }

    await establishWebSession(req, {
      userId: user.id,
      email: user.email,
      role: membership?.role || "teacher",
      schoolId: membership?.schoolId || null,
      schoolSessionVersion: school?.schoolSessionVersion,
      authVersion: user.authVersion,
    });

    // Persist session to PostgreSQL before responding
    await new Promise<void>((resolve, reject) => {
      req.session.save((err) => (err ? reject(err) : resolve()));
    });

    const token = signUserToken({
      userId: user.id,
      email: user.email,
      isSuperAdmin: false,
      authVersion: user.authVersion,
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
    if (!req.authUser.isSuperAdmin && membershipsWithSchool.length === 0) {
      return res.status(403).json({ error: NO_ACTIVE_SCHOOL_ERROR });
    }

    const { password: _, ...safeUser } = req.authUser;
    const isImpersonating = Boolean(
      (req.session as any)?.impersonating &&
      (req.session as any).originalUserId
    );

    const schoolIdentities = buildVerifiedSchoolIdentities(membershipsWithSchool);
    const requestedSchoolId = headerString(req.headers["x-school-id"]);
    const requestedIdentity = requestedSchoolId
      ? schoolIdentities.find((identity) => identity.schoolId === requestedSchoolId)
      : undefined;
    if (requestedSchoolId && !requestedIdentity && !req.authUser.isSuperAdmin) {
      return res.status(403).json({ error: "No access to this school" });
    }
    const sessionIdentity = req.session?.schoolId
      ? schoolIdentities.find((identity) => identity.schoolId === req.session.schoolId)
      : undefined;
    const schoolSelectionRequired = Boolean(
      !requestedIdentity && !sessionIdentity && schoolIdentities.length > 1
    );
    const activeIdentity = schoolSelectionRequired
      ? undefined
      : requestedIdentity || sessionIdentity || schoolIdentities[0];

    if (req.authMethod === "session" && activeIdentity) {
      req.session.schoolId = activeIdentity.schoolId;
      req.session.role = activeIdentity.primaryRole;
      req.session.schoolSessionVersion =
        activeIdentity.school.schoolSessionVersion ?? 1;
    }

    // Resolve product licenses for the verified active school.
    const schoolId = activeIdentity?.schoolId;
    let licenses = { classPilot: false, passPilot: false, goPilot: false };
    if (schoolId) {
      const productLicenses = await getProductLicenses(schoolId);
      for (const pl of productLicenses) {
        const unexpired = !pl.expiresAt || pl.expiresAt.getTime() > Date.now();
        if (pl.product === "CLASSPILOT" && pl.status === "active" && unexpired)
          licenses.classPilot = true;
        if (pl.product === "PASSPILOT" && pl.status === "active" && unexpired)
          licenses.passPilot = true;
        if (pl.product === "GOPILOT" && pl.status === "active" && unexpired)
          licenses.goPilot = true;
      }
    }

    // Generate JWT so clients can use it for Socket.io and API calls
    const token = isImpersonating
      ? null
      : signUserToken({
          userId: req.authUser.id,
          email: req.authUser.email,
          isSuperAdmin: req.authUser.isSuperAdmin,
          authVersion: req.authUser.authVersion,
        });

    return res.json({
      user: {
        ...safeUser,
        impersonating: isImpersonating,
      },
      token,
      activeSchoolId: schoolId || null,
      schoolSelectionRequired,
      roles: activeIdentity?.roles ?? [],
      primaryRole: activeIdentity?.primaryRole ?? null,
      licenses,
      memberships: schoolIdentities.map(serializeSchoolIdentity),
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
    getLoginRedirectUri()
  );
}

function getLoginRedirectUri(): string {
  return (
    process.env.GOOGLE_CALLBACK_URL ||
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

/**
 * The legacy GoPilot Android OAuth callback used an unverified custom URI
 * scheme. Another installed app could claim that scheme and race the
 * single-use code, so native GoPilot OAuth stays disabled until a verified
 * HTTPS App Link is shipped. Staff can still use password authentication.
 */
// GET /api/auth/google — Initiate identity-only Google OIDC login
// Accepts optional ?redirect= to return the user to a specific path after login
router.get("/google", (req, res, next) => {
  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.status(503).json({ error: "Google OAuth not configured" });
  }

  const requestedRedirect = String(req.query.redirect || "");
  if (isDisabledNativeGoPilotOAuthRedirect(requestedRedirect)) {
    return res.status(410).json({
      error: "Google sign-in is unavailable in the GoPilot staff app. Use your school account password.",
      code: "GOPILOT_NATIVE_OAUTH_DISABLED",
    });
  }
  const redirectPath = requestedRedirect.startsWith("/") ? requestedRedirect : "";
  const state = crypto.randomBytes(32).toString("base64url");
  const nonce = crypto.randomBytes(32).toString("base64url");
  req.session.googleOAuthState = state;
  req.session.googleOAuthNonce = nonce;
  req.session.googleOAuthRedirect = redirectPath;

  const oauth2Client = getLoginOAuth2Client();
  const url = oauth2Client.generateAuthUrl({
    access_type: "online",
    scope: ["openid", "profile", "email"],
    state,
    nonce,
  });

  req.session.save((err) => {
    if (err) return next(err);
    return res.redirect(url);
  });
});

// GET /api/auth/google/callback — Handle Google OAuth callback
router.get("/google/callback", async (req, res, next) => {
  try {
    const code = req.query.code as string;
    const state = req.query.state as string;
    const frontendUrl = getFrontendUrl();

    if (!code) {
      return res.redirect(`${frontendUrl}/login?error=no_code`);
    }
    if (!state || state !== req.session.googleOAuthState || !req.session.googleOAuthNonce) {
      await logAudit({
        action: "auth.rejected",
        metadata: { reason: "invalid_oauth_state", method: "google" },
      });
      return res.redirect(`${frontendUrl}/login?error=oauth_failed`);
    }

    const oauth2Client = getLoginOAuth2Client();
    const tokens = await exchangeGoogleAuthCode({
      code,
      redirectUri: getLoginRedirectUri(),
      context: "auth-login",
    });
    if (!tokens.id_token) {
      await logAudit({
        action: "auth.rejected",
        metadata: { reason: "missing_id_token", method: "google" },
      });
      return res.redirect(`${frontendUrl}/login?error=oauth_failed`);
    }

    const ticket = await oauth2Client.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload || payload.iss !== "https://accounts.google.com" && payload.iss !== "accounts.google.com") {
      await logAudit({
        action: "auth.rejected",
        metadata: { reason: "invalid_id_token_issuer", method: "google" },
      });
      return res.redirect(`${frontendUrl}/login?error=oauth_failed`);
    }
    if (payload.nonce !== req.session.googleOAuthNonce) {
      await logAudit({
        action: "auth.rejected",
        metadata: { reason: "invalid_oauth_nonce", method: "google" },
      });
      return res.redirect(`${frontendUrl}/login?error=oauth_failed`);
    }

    const profile = {
      id: payload.sub,
      email: payload.email,
      picture: payload.picture,
      hostedDomain: payload.hd,
    };
    const savedRedirect = req.session.googleOAuthRedirect || "";
    req.session.googleOAuthState = undefined;
    req.session.googleOAuthNonce = undefined;
    req.session.googleOAuthRedirect = undefined;

    if (!profile.email) {
      // Durable record of the silent failure (otherwise just a redirect).
      await logAudit({
        action: "auth.rejected",
        metadata: { reason: "no_email", method: "google" },
      });
      return res.redirect(`${frontendUrl}/login?error=no_email`);
    }

    // Resolve immutable Google subject and email together. Email fallback may
    // first-bind an unbound identity, but it can never cross an existing
    // Google binding or select a different email-owned user.
    const user = await resolveGoogleLoginIdentity({
      email: profile.email,
      googleId: profile.id,
      profileImageUrl: profile.picture,
      lastLoginAt: new Date(),
    });

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

    // Get memberships for session
    const membershipsWithSchool = await getMembershipsWithSchool(user.id);
    const schoolIdentities = buildVerifiedSchoolIdentities(membershipsWithSchool);
    const selectedIdentity = schoolIdentities.length === 1
      ? schoolIdentities[0]
      : undefined;
    const firstIdentity = schoolIdentities[0];
    if (!user.isSuperAdmin && schoolIdentities.length === 0) {
      await logAudit({
        userId: user.id,
        userEmail: user.email,
        action: "auth.rejected",
        metadata: { reason: "no_active_school", method: "google" },
      });
      return res.redirect(`${frontendUrl}/login?error=no_school`);
    }
    const emailDomain = getEmailDomain(profile.email);
    const hostedDomain = normalizeDomain(payload.hd);
    const expectedHostedDomain = membershipsWithSchool
      .map((m) => normalizeDomain(m.school.domain))
      .find((domain) => !!domain && domain === emailDomain);
    if (!user.isSuperAdmin && expectedHostedDomain && hostedDomain !== expectedHostedDomain) {
      await logAudit({
        schoolId: selectedIdentity?.schoolId ?? null,
        action: "auth.rejected",
        userEmail: profile.email,
        metadata: {
          reason: "invalid_hosted_domain",
          method: "google",
          expectedDomain: expectedHostedDomain,
          hostedDomain,
        },
      });
      return res.redirect(`${frontendUrl}/login?error=domain_mismatch`);
    }

    await establishWebSession(req, {
      userId: user.id,
      email: user.email,
      role: user.isSuperAdmin
        ? "super_admin"
        : selectedIdentity?.primaryRole || firstIdentity?.primaryRole || "teacher",
      schoolId: selectedIdentity?.schoolId || null,
      schoolSessionVersion: selectedIdentity?.school.schoolSessionVersion,
      authVersion: user.authVersion,
    });

    // Generate JWT so the frontend can authenticate immediately
    // (Session cookies don't work behind CloudFront→ALB HTTP proxy)
    const token = signUserToken({
      userId: user.id,
      email: user.email,
      isSuperAdmin: user.isSuperAdmin,
      authVersion: user.authVersion,
    });

    // Save session best-effort (for cookie-based clients)
    await new Promise<void>((resolve, reject) => {
      req.session.save((err) => (err ? reject(err) : resolve()));
    });

    let redirectAfter = savedRedirect;

    const firstProductMembership = firstIdentity
      ? firstIdentity.memberships.find((membership) => membership.gopilotRole) ??
        firstIdentity.primaryMembership
      : undefined;
    const gopilotRole =
      firstProductMembership?.gopilotRole || firstIdentity?.primaryRole;

    // Resolve /gopilot to the correct role-based path. Historical parent
    // accounts remain valid identities for unrelated products, but may not be
    // routed into the retired GoPilot parent portal.
    if (redirectAfter === "/gopilot") {
      if (gopilotRole === "teacher") redirectAfter = "/gopilot/teacher";
      // else stays /gopilot (office/admin dashboard)
    }
    if (gopilotRole === "parent" && redirectAfter.startsWith("/gopilot")) {
      redirectAfter = "/gopilot/unavailable";
    }

    // Never revive the retired unverified custom-scheme callback for an OAuth
    // session that began before this server version was deployed.
    if (isDisabledNativeGoPilotOAuthRedirect(redirectAfter)) {
      return res.redirect(`${frontendUrl}/login?error=native_oauth_disabled`);
    }

    // Issue a one-time code (60s TTL, single-use) and put THAT in the URL
    // instead of the JWT. Client exchanges the code via POST /auth/exchange-code.
    // Avoids leaking JWTs to browser history, Referer headers, server logs,
    // and native deep-link logs.
    const oneTimeCode = await issueAuthCode(token);

    // Web login: go to /login as usual
    return res.redirect(`${frontendUrl}/login?code=${encodeURIComponent(oneTimeCode)}`);
  } catch (err) {
    console.error("[auth] Google OAuth callback failed");
    const frontendUrl = getFrontendUrl();
    if (err instanceof IdentityEmailConflictError || err instanceof GoogleIdentityConflictError) {
      await logAudit({
        action: "auth.rejected",
        metadata: {
          reason: err instanceof GoogleIdentityConflictError
            ? "google_identity_conflict"
            : "identity_email_conflict",
          method: "google",
        },
      });
      return res.redirect(`${frontendUrl}/login?error=identity_conflict`);
    }
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
    clearSessionCookie(res);
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
router.post("/exchange-code", async (req, res, next) => {
  const { code } = req.body || {};
  if (typeof code !== "string" || !code) {
    return res.status(400).json({ error: "code required" });
  }
  try {
    const token = await consumeAuthCode(code);
    if (!token) {
      return res.status(400).json({ error: "Invalid or expired code" });
    }
    return res.json({ token });
  } catch (error) {
    return next(error);
  }
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
