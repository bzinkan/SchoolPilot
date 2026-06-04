import { Router } from "express";
import { google } from "googleapis";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import {
  getGoogleOAuthToken,
  upsertGoogleOAuthToken,
  deleteGoogleOAuthToken,
} from "../../services/storage.js";

const router = Router();

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.PUBLIC_BASE_URL || "http://localhost:4000"}/api/google/callback`
  );
}

const SCOPES = [
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
router.get("/auth-url", authenticate, requireSchoolContext, async (req, res, next) => {
  try {
    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(503).json({ error: "Google OAuth not configured" });
    }

    const oauth2Client = getOAuth2Client();
    const schoolId = res.locals.schoolId!;

    const url = oauth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: SCOPES,
      state: JSON.stringify({
        userId: req.authUser!.id,
        schoolId,
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

    const { userId, returnTo } = JSON.parse(state);
    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);

    // Preserve the existing refresh_token on re-consent: Google sometimes
    // omits refresh_token from the response when the user has already
    // granted offline access, even though `access_type=offline + prompt=consent`
    // normally forces it. If the response doesn't include a refresh_token,
    // keep the one we already have rather than wiping it.
    const existing = await getGoogleOAuthToken(userId);
    const refreshToken = tokens.refresh_token || existing?.refreshToken || "";

    await upsertGoogleOAuthToken(userId, {
      refreshToken,
      scope: tokens.scope || existing?.scope || SCOPES.join(" "),
      tokenType: tokens.token_type || "Bearer",
      expiryDate: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
    });

    const allowlist = (process.env.CORS_ALLOWLIST || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const allowedReturnUrl = getAllowedReturnUrl(returnTo, allowlist);

    if (allowedReturnUrl) {
      allowedReturnUrl.searchParams.set("connected", "true");
      return res.redirect(allowedReturnUrl.toString());
    }

    const fallbackOrigin = allowlist[0] || "http://localhost:5173";
    return res.redirect(`${fallbackOrigin}/settings/google?connected=true`);
  } catch (err) {
    next(err);
  }
});

// GET /api/google/status - Check Google connection status
router.get("/status", authenticate, async (req, res, next) => {
  try {
    const token = await getGoogleOAuthToken(req.authUser!.id);
    return res.json({ connected: !!token });
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
