import { google } from "googleapis";
import {
  getGoogleRosterConnector,
  getSchoolById,
  getEmailDomain,
  markGoogleRosterConnectorSynced,
  normalizeDomain,
  updateGoogleRosterConnector,
} from "./storage.js";

export const GOOGLE_ROSTER_SCOPES = [
  "https://www.googleapis.com/auth/admin.directory.user.readonly",
  "https://www.googleapis.com/auth/admin.directory.orgunit.readonly",
  "https://www.googleapis.com/auth/classroom.courses.readonly",
  "https://www.googleapis.com/auth/classroom.rosters.readonly",
  "https://www.googleapis.com/auth/classroom.profile.emails",
] as const;

const TOKEN_URL = "https://oauth2.googleapis.com/token";

type RosterSaCredentials = {
  client_email: string;
  private_key: string;
  client_id?: string;
};

let cachedSaCredentials: RosterSaCredentials | null = null;

function routeError(message: string, status = 400, code?: string) {
  return Object.assign(new Error(message), { status, code, expose: true });
}

function loadRosterServiceAccountKey(): RosterSaCredentials | null {
  if (cachedSaCredentials) return cachedSaCredentials;
  const raw = process.env.GOOGLE_ROSTER_SA_KEY_JSON;
  if (!raw) return null;

  let jsonText = raw.trim();
  if (!jsonText.startsWith("{")) {
    jsonText = Buffer.from(jsonText, "base64").toString("utf8");
  }

  const parsed = JSON.parse(jsonText);
  if (!parsed.client_email || !parsed.private_key) {
    throw routeError(
      "GOOGLE_ROSTER_SA_KEY_JSON missing client_email or private_key",
      503,
      "GOOGLE_ROSTER_CONNECTOR_NOT_CONFIGURED"
    );
  }

  cachedSaCredentials = {
    client_email: parsed.client_email,
    private_key: String(parsed.private_key).replace(/\\n/g, "\n"),
    client_id: parsed.client_id,
  };
  return cachedSaCredentials;
}

export function getRosterServiceAccountInfo() {
  const key = loadRosterServiceAccountKey();
  const email = key?.client_email || process.env.GOOGLE_ROSTER_SA_EMAIL || null;
  const clientId = key?.client_id || process.env.GOOGLE_ROSTER_SA_CLIENT_ID || null;
  const authMode = key ? "service_account_key" : email ? "workload_identity_federation" : "not_configured";

  return {
    configured: !!email && !!clientId,
    clientId,
    email,
    authMode,
    scopes: [...GOOGLE_ROSTER_SCOPES],
  };
}

function assertRosterServiceAccountConfigured() {
  const info = getRosterServiceAccountInfo();
  if (!info.configured) {
    throw routeError(
      "Google Workspace Roster Connector is not configured on the SchoolPilot server.",
      503,
      "GOOGLE_ROSTER_CONNECTOR_NOT_CONFIGURED"
    );
  }
  return info;
}

function buildDwdClaims(serviceAccountEmail: string, delegatedAdminEmail: string, scopes: readonly string[]) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: serviceAccountEmail,
    scope: scopes.join(" "),
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
    sub: delegatedAdminEmail,
  };
}

async function exchangeJwtForAccessToken(assertion: string) {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const detail = data.error_description || data.error || response.statusText;
    throw routeError(
      `Google roster connector token exchange failed: ${detail}`,
      response.status === 400 || response.status === 401 ? 400 : response.status,
      "GOOGLE_ROSTER_CONNECTOR_AUTH_FAILED"
    );
  }
  if (!data.access_token) {
    throw routeError(
      "Google roster connector token exchange returned no access token.",
      400,
      "GOOGLE_ROSTER_CONNECTOR_AUTH_FAILED"
    );
  }
  return {
    accessToken: String(data.access_token),
    expiryDate: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : undefined,
  };
}

async function getKeylessDwdAuthClient(delegatedAdminEmail: string, scopes: readonly string[]) {
  const info = assertRosterServiceAccountConfigured();
  if (!info.email) {
    throw routeError(
      "GOOGLE_ROSTER_SA_EMAIL is required for keyless roster connector auth.",
      503,
      "GOOGLE_ROSTER_CONNECTOR_NOT_CONFIGURED"
    );
  }

  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const iam = google.iamcredentials({ version: "v1", auth });
  const payload = JSON.stringify(buildDwdClaims(info.email, delegatedAdminEmail, scopes));
  const response = await iam.projects.serviceAccounts.signJwt({
    name: `projects/-/serviceAccounts/${info.email}`,
    requestBody: { payload },
  });
  const signedJwt = response.data.signedJwt;
  if (!signedJwt) {
    throw routeError(
      "Google IAM signJwt returned no signed assertion for roster connector auth.",
      503,
      "GOOGLE_ROSTER_CONNECTOR_AUTH_FAILED"
    );
  }

  const token = await exchangeJwtForAccessToken(signedJwt);
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({
    access_token: token.accessToken,
    expiry_date: token.expiryDate,
    token_type: "Bearer",
  });
  return oauth2Client;
}

export async function getRosterDwdAuthClient(delegatedAdminEmail: string, scopes: readonly string[] = GOOGLE_ROSTER_SCOPES) {
  const key = loadRosterServiceAccountKey();
  if (key) {
    return new google.auth.JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: [...scopes],
      subject: delegatedAdminEmail,
    });
  }
  return getKeylessDwdAuthClient(delegatedAdminEmail, scopes);
}

export async function getVerifiedRosterConnectorForSchool(schoolId: string) {
  const connector = await getGoogleRosterConnector(schoolId);
  if (!connector || connector.status !== "verified" || !connector.delegatedAdminEmail) {
    throw routeError(
      "GOOGLE_CONNECTOR_REQUIRED: Connect the Google Workspace Roster Connector before importing roster data.",
      400,
      "GOOGLE_CONNECTOR_REQUIRED"
    );
  }

  const school = await getSchoolById(schoolId);
  const schoolDomain = normalizeDomain(school?.domain);
  const connectorDomain = normalizeDomain(connector.domain);
  const delegatedDomain = normalizeDomain(getEmailDomain(connector.delegatedAdminEmail));
  if (!schoolDomain || connectorDomain !== schoolDomain || delegatedDomain !== schoolDomain) {
    throw routeError(
      "GOOGLE_DOMAIN_MISMATCH: Reconnect the Google Workspace Roster Connector with an admin account from this school's domain.",
      400,
      "GOOGLE_DOMAIN_MISMATCH"
    );
  }

  return connector;
}

export async function getRosterDirectoryClientForSchool(schoolId: string) {
  const connector = await getVerifiedRosterConnectorForSchool(schoolId);
  const auth = await getRosterDwdAuthClient(connector.delegatedAdminEmail!, GOOGLE_ROSTER_SCOPES);
  return {
    connector,
    auth,
    admin: google.admin({ version: "directory_v1", auth }),
  };
}

export async function getRosterClassroomClientForSchool(schoolId: string) {
  const connector = await getVerifiedRosterConnectorForSchool(schoolId);
  const auth = await getRosterDwdAuthClient(connector.delegatedAdminEmail!, GOOGLE_ROSTER_SCOPES);
  return {
    connector,
    auth,
    classroom: google.classroom({ version: "v1", auth }),
  };
}

export async function recordRosterConnectorSync(schoolId: string) {
  await markGoogleRosterConnectorSynced(schoolId);
}

export async function recordRosterConnectorError(schoolId: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  await updateGoogleRosterConnector(schoolId, {
    status: "error",
    lastError: message,
  });
}
