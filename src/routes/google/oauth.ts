import { Router } from "express";
import { google } from "googleapis";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import {
  getGoogleOAuthToken,
  getSchoolById,
  getEmailDomain,
  normalizeDomain,
  upsertGoogleOAuthToken,
  deleteGoogleOAuthToken,
} from "../../services/storage.js";
import {
  exchangeGoogleAuthCode,
  fetchGoogleUserInfo,
} from "../../util/googleOAuthTokenExchange.js";

const router = Router();

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    getRedirectUri()
  );
}

function getRedirectUri(): string {
  return `${process.env.PUBLIC_BASE_URL || "http://localhost:4000"}/api/google/callback`;
}

const CORE_SCOPES = ["openid", "email"];

const WORKSPACE_IMPORT_SCOPES = [
  "https://www.googleapis.com/auth/classroom.courses.readonly",
  "https://www.googleapis.com/auth/classroom.rosters.readonly",
  "https://www.googleapis.com/auth/classroom.profile.emails",
  "https://www.googleapis.com/auth/classroom.coursework.students.readonly",
  "https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly",
  "https://www.googleapis.com/auth/admin.directory.user.readonly",
  "https://www.googleapis.com/auth/admin.directory.orgunit.readonly",
  // Workspace Security Audit scopes intentionally omitted until that feature
  // is re-enabled and Google verification of the new scopes completes:
  //   admin.directory.device.chromeos.readonly
  //   chrome.management.policy.readonly
  // Backend service + route remain at src/services/workspaceAudit.ts and
  // src/routes/google/workspaceAudit.ts for easy re-activation.
];

const CLASSROOM_RESOURCE_SCOPES = [
  "https://www.googleapis.com/auth/classroom.courses.readonly",
  "https://www.googleapis.com/auth/classroom.coursework.students.readonly",
  "https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly",
];

type GooglePurpose = "workspace_import" | "classroom_resources";

function normalizePurpose(value: unknown): GooglePurpose {
  return value === "classroom_resources" ? "classroom_resources" : "workspace_import";
}

function scopesForPurpose(purpose: GooglePurpose): string[] {
  const scopes = purpose === "classroom_resources" ? CLASSROOM_RESOURCE_SCOPES : WORKSPACE_IMPORT_SCOPES;
  return [...new Set([...CORE_SCOPES, ...scopes])];
}

function roleCanRequestPurpose(role: string | null | undefined, purpose: GooglePurpose): boolean {
  if (role === "super_admin") return true;
  if (purpose === "workspace_import") return role === "admin" || role === "school_admin";
  return role === "teacher" || role === "admin" || role === "school_admin";
}

function missingScopes(tokenScope: string | null | undefined, required: string[]): string[] {
  const granted = new Set((tokenScope || "").split(/\s+/).filter(Boolean));
  return required.filter((scope) => !granted.has(scope));
}

function getAllowedReturnUrl(returnTo: string | undefined, allowlist: string[]): URL | null {
  if (!returnTo) return null;
  try {
    const url = new URL(returnTo);
    return allowlist.includes(url.origin) ? url : null;
  } catch {
    return null;
  }
}

// GET /api/google/auth-url - Get Google OAuth URL
router.get("/auth-url", authenticate, requireSchoolContext, requireActiveSchool, async (req, res, next) => {
  try {
    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(503).json({ error: "Google OAuth not configured" });
    }

    const oauth2Client = getOAuth2Client();
    const schoolId = res.locals.schoolId!;
    const purpose = normalizePurpose(req.query.purpose);
    if (purpose === "workspace_import") {
      return res.status(409).json({
        error:
          "GOOGLE_CONNECTOR_REQUIRED: Google Workspace roster import now uses the IT-approved Roster Connector.",
        code: "GOOGLE_CONNECTOR_REQUIRED",
        setupPath: "/api/google/roster-connector/setup-info",
      });
    }
    if (!roleCanRequestPurpose(res.locals.membershipRole, purpose)) {
      return res.status(403).json({
        error: "INSUFFICIENT_GOOGLE_ROLE: You do not have permission to connect Google for this workflow.",
        code: "INSUFFICIENT_GOOGLE_ROLE",
      });
    }

    const url = oauth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: scopesForPurpose(purpose),
      state: JSON.stringify({
        userId: req.authUser!.id,
        schoolId,
        purpose,
        returnTo: (req.query.returnTo as string) || req.headers.referer || "",
      }),
    });

    return res.json({ url });
  } catch (err) {
    next(err);
  }
});

// GET /api/google/callback - OAuth callback
router.get("/callback", async (req, res, next) => {
  try {
    const code = req.query.code as string;
    const state = req.query.state as string;

    if (!code || !state) {
      return res.status(400).json({ error: "Missing code or state" });
    }

    const { userId, schoolId, purpose, returnTo } = JSON.parse(state);
    const oauth2Client = getOAuth2Client();
    const tokens = await exchangeGoogleAuthCode({
      code,
      redirectUri: getRedirectUri(),
      context: "google-connect",
    });
    oauth2Client.setCredentials(tokens);

    let connectedEmail: string | null = null;
    try {
      const profile = await fetchGoogleUserInfo(tokens.access_token, "google-connect");
      connectedEmail = profile.email?.trim().toLowerCase() || null;
    } catch (err) {
      console.warn("[google-oauth] unable to read connected account email:", (err as Error).message);
    }

    // Preserve the existing refresh_token on re-consent: Google sometimes
    // omits refresh_token from the response when the user has already
    // granted offline access, even though `access_type=offline + prompt=consent`
    // normally forces it. If the response doesn't include a refresh_token,
    // keep the one we already have rather than wiping it.
    const existing = await getGoogleOAuthToken(userId);
    const refreshToken = tokens.refresh_token || existing?.refreshToken || "";
    connectedEmail = connectedEmail || existing?.connectedEmail || null;
    const connectedDomain = getEmailDomain(connectedEmail) || existing?.connectedDomain || null;
    const selectedScopes = scopesForPurpose(normalizePurpose(purpose));

    await upsertGoogleOAuthToken(userId, {
      refreshToken,
      scope: tokens.scope || existing?.scope || selectedScopes.join(" "),
      tokenType: tokens.token_type || "Bearer",
      connectedEmail,
      connectedDomain,
      expiryDate: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
    });

    const allowlist = (process.env.CORS_ALLOWLIST || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const allowedReturnUrl = getAllowedReturnUrl(returnTo, allowlist);

    if (allowedReturnUrl) {
      allowedReturnUrl.searchParams.set("connected", "true");
      if (schoolId) {
        const school = await getSchoolById(schoolId);
        const schoolDomain = normalizeDomain(school?.domain);
        if (schoolDomain && connectedDomain && connectedDomain !== schoolDomain) {
          allowedReturnUrl.searchParams.set("googleDomainMismatch", "true");
        }
      }
      return res.redirect(allowedReturnUrl.toString());
    }

    const fallbackOrigin = allowlist[0] || "http://localhost:5173";
    return res.redirect(`${fallbackOrigin}/settings/google?connected=true`);
  } catch (err) {
    next(err);
  }
});

// GET /api/google/status - Check Google connection status
router.get("/status", authenticate, requireSchoolContext, async (req, res, next) => {
  try {
    const token = await getGoogleOAuthToken(req.authUser!.id);
    const school = res.locals.schoolId ? await getSchoolById(res.locals.schoolId) : undefined;
    const schoolDomain = normalizeDomain(school?.domain);
    const connectedEmail = token?.connectedEmail || null;
    const connectedDomain = normalizeDomain(token?.connectedDomain || getEmailDomain(connectedEmail));
    const domainVerified = !!token && !!schoolDomain && !!connectedDomain && connectedDomain === schoolDomain;
    const requiresReconnect = !!token && (!connectedEmail || !connectedDomain);
    const classroomResourceMissingScopes = missingScopes(token?.scope, scopesForPurpose("classroom_resources"));

    let errorCode: string | null = null;
    if (token && !schoolDomain) errorCode = "SCHOOL_DOMAIN_REQUIRED";
    else if (requiresReconnect) errorCode = "GOOGLE_RECONNECT_REQUIRED";
    else if (token && !domainVerified) errorCode = "GOOGLE_DOMAIN_MISMATCH";

    return res.json({
      connected: !!token,
      connectedEmail,
      connectedDomain,
      schoolDomain,
      domainVerified,
      requiresReconnect,
      errorCode,
      workspaceImportDisabled: true,
      classroomResourceMissingScopes,
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/google/disconnect - Disconnect Google
router.delete("/disconnect", authenticate, async (req, res, next) => {
  try {
    await deleteGoogleOAuthToken(req.authUser!.id);
    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
