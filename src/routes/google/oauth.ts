import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import {
  getGoogleOAuthToken,
  upsertGoogleOAuthToken,
  deleteGoogleOAuthToken,
} from "../../services/storage.js";

const router = Router();

function getOAuth2Client() {
  const { google } = require("googleapis");
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.PUBLIC_BASE_URL || "http://localhost:4000"}/api/google/callback`
  );
}

const SCOPES = [
  "https://www.googleapis.com/auth/classroom.courses.readonly",
  "https://www.googleapis.com/auth/classroom.rosters.readonly",
  "https://www.googleapis.com/auth/admin.directory.user.readonly",
  "https://www.googleapis.com/auth/admin.directory.orgunit.readonly",
];

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

    await upsertGoogleOAuthToken(userId, {
      refreshToken: tokens.refresh_token || "",
      scope: tokens.scope || SCOPES.join(" "),
      tokenType: tokens.token_type || "Bearer",
      expiryDate: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
    });

    // Redirect back to the frontend that initiated the OAuth flow
    const allowlist = (process.env.CORS_ALLOWLIST || "").split(",").map((s) => s.trim());
    let frontendUrl = allowlist[0] || "http://localhost:5173";

    // Use returnTo if it matches an allowed origin
    if (returnTo) {
      try {
        const origin = new URL(returnTo).origin;
        if (allowlist.includes(origin)) {
          frontendUrl = origin;
        }
      } catch {}
    }

    return res.redirect(`${frontendUrl}/settings/google?connected=true`);
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
