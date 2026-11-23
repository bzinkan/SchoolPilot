import { Router, type Request } from "express";
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
import { requestHasAnySchoolRole } from "../../services/schoolAuthorization.js";
import { logSystemAudit } from "../../services/audit.js";
import {
  consumeGoogleConnectState,
  issueGoogleConnectState,
  type GoogleConnectPurpose,
} from "../../services/googleConnectState.js";
import {
  CLASSROOM_RESOURCE_SCOPES,
  missingGoogleOAuthScopes,
} from "../../util/googleOAuthScopes.js";

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

type GooglePurpose = GoogleConnectPurpose;

function normalizePurpose(value: unknown): GooglePurpose {
  return value === "classroom_resources" ? "classroom_resources" : "workspace_import";
}

function scopesForPurpose(purpose: GooglePurpose): string[] {
  const scopes = purpose === "classroom_resources" ? CLASSROOM_RESOURCE_SCOPES : WORKSPACE_IMPORT_SCOPES;
  return [...new Set([...CORE_SCOPES, ...scopes])];
}

function requestCanRequestPurpose(req: any, res: any, purpose: GooglePurpose): boolean {
  return requestHasAnySchoolRole(
    req,
    res,
    purpose === "workspace_import"
      ? ["admin", "school_admin"]
      : ["teacher", "admin", "school_admin"]
  );
}

function returnOriginAllowlist(): string[] {
  return (process.env.CORS_ALLOWLIST || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function getAllowedReturnUrl(returnTo: unknown, allowlist: string[]): URL | null {
  if (typeof returnTo !== "string" || !returnTo) return null;
  try {
    const url = new URL(returnTo);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    return allowlist.includes(url.origin) ? url : null;
  } catch {
    return null;
  }
}

function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
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
    if (!requestCanRequestPurpose(req, res, purpose)) {
      return res.status(403).json({
        error: "INSUFFICIENT_GOOGLE_ROLE: You do not have permission to connect Google for this workflow.",
        code: "INSUFFICIENT_GOOGLE_ROLE",
      });
    }

    // Bearer auth wins over the cookie, so the two can name different users.
    // Stop here rather than after the teacher has been through Google consent.
    if (req.session.userId && req.session.userId !== req.authUser!.id) {
      return res.status(409).json({
        error: "GOOGLE_CONNECT_SESSION_MISMATCH: Sign in again before connecting Google.",
        code: "GOOGLE_CONNECT_SESSION_MISMATCH",
      });
    }
    // A bearer-only browser has no stored session yet. The callback can only
    // recognise this browser through a session cookie, so create one now.
    if (!req.session.userId && !req.session.googleConnectBound) {
      req.session.googleConnectBound = true;
      await saveSession(req);
    }

    const requestedReturnTo =
      typeof req.query.returnTo === "string" ? req.query.returnTo : req.headers.referer;
    const state = await issueGoogleConnectState(req.sessionID, {
      userId: req.authUser!.id,
      schoolId,
      purpose,
      returnTo: getAllowedReturnUrl(requestedReturnTo, returnOriginAllowlist())?.href ?? null,
    });

    const url = oauth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: scopesForPurpose(purpose),
      state,
    });

    res.setHeader("Cache-Control", "no-store");
    return res.json({ url });
  } catch (err) {
    next(err);
  }
});

// GET /api/google/callback - OAuth callback
router.get("/callback", async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";

    if (!code || !state) {
      return res.status(400).json({ error: "Missing code or state" });
    }

    // Everything below acts on this verified grant. Nothing about the user,
    // school, purpose or destination is read from the request.
    const grant = await consumeGoogleConnectState(state, req.sessionID);
    if (!grant || (req.session.userId && req.session.userId !== grant.userId)) {
      await logSystemAudit({
        action: "auth.rejected",
        metadata: { reason: "invalid_google_connect_state", method: "google_connect" },
      });
      return res.status(400).json({
        error: "This Google connection link is invalid or has expired. Return to SchoolPilot and try connecting again.",
        code: "GOOGLE_CONNECT_STATE_INVALID",
      });
    }

    const { userId, schoolId, purpose, returnTo } = grant;
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
      console.warn("[google-oauth] unable to read connected account identity");
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
    const selectedScopes = scopesForPurpose(purpose);

    await upsertGoogleOAuthToken(userId, {
      refreshToken,
      scope: tokens.scope || existing?.scope || selectedScopes.join(" "),
      tokenType: tokens.token_type || "Bearer",
      connectedEmail,
      connectedDomain,
      expiryDate: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
    });

    const allowlist = returnOriginAllowlist();
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
    const classroomResourceMissingScopes = missingGoogleOAuthScopes(token?.scope, scopesForPurpose("classroom_resources"));

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
