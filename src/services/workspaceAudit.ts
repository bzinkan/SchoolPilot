import { google } from "googleapis";
import { getGoogleOAuthToken } from "./storage.js";

export type Severity = "critical" | "high" | "medium" | "low";
export type Status = "ok" | "warning" | "critical" | "unknown";

export interface AuditFinding {
  id: string;
  title: string;
  description: string;
  severity: Severity;
  status: Status;
  currentValue: string;
  recommendedValue: string;
  fixUrl: string;
  fixInstructions?: string;
}

export interface WorkspaceAuditReport {
  scannedAt: string;
  customerDomain: string | null;
  deviceCount: number | null;
  orgUnitsCount: number | null;
  extensionId: string | null;
  findings: AuditFinding[];
  scoreOk: number;
  scoreTotal: number;
  errors: string[];
}

const ADMIN_BASE = "https://admin.google.com/ac";

function getAuthedClient(refreshToken: string) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return oauth2Client;
}

interface ResolvedPolicy {
  value: unknown;
  sourceKey?: string;
  raw: unknown;
  error?: string;
}

export class WorkspaceAuditPermissionError extends Error {
  code = "INSUFFICIENT_PERMISSIONS";
  statusCode = 403;

  constructor(message = "Workspace admin permissions required to run the audit.") {
    super(message);
    this.name = "WorkspaceAuditPermissionError";
  }
}

function getGoogleErrorStatus(err: unknown): number | undefined {
  const e = err as {
    code?: number;
    status?: number;
    response?: { status?: number };
  };
  return e.response?.status ?? e.status ?? e.code;
}

function getGoogleErrorMessage(err: unknown): string {
  const e = err as {
    message?: string;
    errors?: Array<{ message?: string }>;
    response?: { data?: { error?: string; error_description?: string } };
  };
  return e.response?.data?.error_description
    ?? e.response?.data?.error
    ?? e.errors?.find((item) => item.message)?.message
    ?? e.message
    ?? "Unknown Google API error";
}

function assertNotPermissionError(err: unknown): void {
  const status = getGoogleErrorStatus(err);
  if (status === 401 || status === 403) {
    throw new WorkspaceAuditPermissionError();
  }
}

async function resolvePolicy(
  auth: ReturnType<typeof getAuthedClient>,
  schemaName: string,
  orgUnitId: string
): Promise<ResolvedPolicy | null> {
  try {
    const chromepolicy = google.chromepolicy({ version: "v1", auth });
    const resp = await chromepolicy.customers.policies.resolve({
      customer: "customers/my_customer",
      requestBody: {
        policySchemaFilter: schemaName,
        policyTargetKey: { targetResource: `orgunits/${orgUnitId}` },
      },
    });
    const resolved = resp.data.resolvedPolicies?.[0];
    if (!resolved) return null;
    const policyValue = resolved.value?.value as Record<string, unknown> | undefined;
    return {
      value: policyValue ?? null,
      sourceKey: resolved.sourceKey?.targetResource ?? undefined,
      raw: resolved,
    };
  } catch (err) {
    assertNotPermissionError(err);
    return {
      value: null,
      raw: null,
      error: getGoogleErrorMessage(err),
    };
  }
}

function findingOk(
  id: string,
  title: string,
  description: string,
  severity: Severity,
  currentValue: string,
  recommendedValue: string,
  fixUrl: string
): AuditFinding {
  return { id, title, description, severity, status: "ok", currentValue, recommendedValue, fixUrl };
}

function findingProblem(
  id: string,
  title: string,
  description: string,
  severity: Severity,
  status: "warning" | "critical",
  currentValue: string,
  recommendedValue: string,
  fixUrl: string,
  fixInstructions?: string
): AuditFinding {
  return { id, title, description, severity, status, currentValue, recommendedValue, fixUrl, fixInstructions };
}

function findingUnknown(
  id: string,
  title: string,
  description: string,
  severity: Severity,
  fixUrl: string,
  currentValue = "Unable to read this policy"
): AuditFinding {
  return {
    id, title, description, severity,
    status: "unknown",
    currentValue,
    recommendedValue: "See admin console",
    fixUrl,
  };
}

export async function runWorkspaceAudit(userId: string): Promise<WorkspaceAuditReport> {
  const token = await getGoogleOAuthToken(userId);
  if (!token?.refreshToken) {
    throw new Error("Google not connected");
  }

  const auth = getAuthedClient(token.refreshToken);
  const errors: string[] = [];

  let customerDomain: string | null = null;
  let rootOrgUnitId: string | null = null;
  let orgUnitsCount: number | null = null;
  let deviceCount: number | null = null;

  try {
    const directory = google.admin({ version: "directory_v1", auth });
    const customer = await directory.customers.get({ customerKey: "my_customer" });
    customerDomain = customer.data.customerDomain ?? null;
  } catch (err: unknown) {
    assertNotPermissionError(err);
    errors.push(`Could not read customer info: ${(err as Error).message}`);
  }

  try {
    const directory = google.admin({ version: "directory_v1", auth });
    const ous = await directory.orgunits.list({ customerId: "my_customer", type: "all" });
    orgUnitsCount = ous.data.organizationUnits?.length ?? 0;

    // The root OU itself is NOT returned in the list — only its descendants.
    // Derive root's orgUnitId from any direct child's parentOrgUnitId. Direct
    // children all have parentOrgUnitPath === "/" and parentOrgUnitId set to
    // the root OU's ID. Fall back to ANY OU's parent chain if no direct child
    // is found (very unusual but defends against deeper-only structures).
    const childOfRoot = ous.data.organizationUnits?.find(
      (ou) => ou.parentOrgUnitPath === "/" && ou.parentOrgUnitId
    );
    const anyParent = ous.data.organizationUnits?.find((ou) => ou.parentOrgUnitId);
    const candidate = childOfRoot?.parentOrgUnitId ?? anyParent?.parentOrgUnitId ?? "";
    rootOrgUnitId = candidate.replace(/^id:/, "") || null;
  } catch (err: unknown) {
    assertNotPermissionError(err);
    errors.push(`Could not list org units: ${(err as Error).message}`);
  }

  try {
    const directory = google.admin({ version: "directory_v1", auth });
    const devices = await directory.chromeosdevices.list({
      customerId: "my_customer",
      maxResults: 1,
      projection: "BASIC",
    });
    deviceCount = (devices.data as { totalResults?: number }).totalResults
      ?? devices.data.chromeosdevices?.length
      ?? 0;
  } catch (err: unknown) {
    assertNotPermissionError(err);
    errors.push(`Could not list Chrome devices: ${(err as Error).message}`);
  }

  const findings: AuditFinding[] = [];
  const expectedExtensionId = process.env.CLASSPILOT_EXTENSION_ID || null;
  const deviceSettingsUrl = `${ADMIN_BASE}/chrome/devices/settings`;
  const userSettingsUrl = `${ADMIN_BASE}/chrome/userdevicesettings`;
  const appsUrl = `${ADMIN_BASE}/chrome/apps/user`;

  if (!rootOrgUnitId) {
    errors.push("Could not determine root org unit — policy checks skipped.");
    return {
      scannedAt: new Date().toISOString(),
      customerDomain, deviceCount, orgUnitsCount,
      extensionId: expectedExtensionId,
      findings, scoreOk: 0, scoreTotal: 0,
      errors,
    };
  }

  // 1. Sign-in restriction — restrict logins to school domain
  {
    const policy = await resolvePolicy(auth, "chrome.devices.SignInRestriction", rootOrgUnitId);
    const restriction = (policy?.value as { signInRestriction?: string } | null)?.signInRestriction || "";
    const restricted = !!restriction && restriction.trim() !== "" && restriction !== "any_user";
    if (policy?.error) {
      findings.push(findingUnknown(
        "sign_in_restriction",
        "Sign-in restriction setting",
        "Couldn't read this policy. Without sign-in restriction, students may use personal Google accounts to bypass monitoring.",
        "critical",
        deviceSettingsUrl,
        policy.error
      ));
    } else {
      findings.push(
        restricted
          ? findingOk(
              "sign_in_restriction",
              "Sign-in restricted to school domain",
              "Chromebooks only allow users matching your domain pattern to log in.",
              "critical",
              restriction,
              customerDomain ? `*@${customerDomain}` : "*@yourdomain.org",
              deviceSettingsUrl
            )
          : findingProblem(
              "sign_in_restriction",
              "Sign-in is NOT restricted to your school domain",
              "Anyone with any Google account can log into your Chromebooks. Students can bypass monitoring by signing in with a personal Gmail.",
              "critical", "critical",
              restriction || "Not configured (any user)",
              customerDomain ? `*@${customerDomain}` : "*@yourdomain.org",
              deviceSettingsUrl,
              `In Admin Console → Devices → Chrome → Settings → Device → Sign-in settings, set "Sign-in restriction" to *@${customerDomain || "yourdomain.org"}.`
            )
      );
    }
  }

  // 2. Guest mode disabled
  {
    const policy = await resolvePolicy(auth, "chrome.devices.GuestModeEnabled", rootOrgUnitId);
    const enabled = (policy?.value as { guestModeEnabled?: boolean } | null)?.guestModeEnabled;
    if (enabled === undefined || policy === null) {
      findings.push(findingUnknown(
        "guest_mode", "Guest mode setting",
        "Couldn't read this policy. Guest mode lets anyone bypass all monitoring with one click.",
        "critical", deviceSettingsUrl, policy?.error
      ));
    } else if (enabled === true) {
      findings.push(findingProblem(
        "guest_mode",
        "Guest mode is ENABLED",
        "A 'Browse as Guest' button appears on the login screen. Students can use it to bypass all monitoring and content filtering.",
        "critical", "critical",
        "Enabled", "Disabled", deviceSettingsUrl,
        "In Admin Console → Devices → Chrome → Settings → Device → Sign-in settings, disable 'Guest mode'."
      ));
    } else {
      findings.push(findingOk(
        "guest_mode", "Guest mode disabled",
        "The 'Browse as Guest' button is hidden from the login screen.",
        "critical", "Disabled", "Disabled", deviceSettingsUrl
      ));
    }
  }

  // 3. Add user disabled (prevents adding new Google accounts at login)
  {
    const policy = await resolvePolicy(auth, "chrome.devices.ShowAddUser", rootOrgUnitId);
    const show = (policy?.value as { showAddUser?: boolean } | null)?.showAddUser;
    if (show === undefined || policy === null) {
      findings.push(findingUnknown(
        "show_add_user", "'Add user' button setting",
        "Couldn't read this policy. The 'Add person' button at login lets students add personal Google accounts.",
        "high", deviceSettingsUrl, policy?.error
      ));
    } else if (show === true) {
      findings.push(findingProblem(
        "show_add_user",
        "'Add user' button is enabled at login",
        "Students can click 'Add person' on the login screen to add a personal Google account that bypasses monitoring.",
        "high", "warning",
        "Enabled", "Disabled", deviceSettingsUrl,
        "In Admin Console → Devices → Chrome → Settings → Device → Sign-in settings, disable 'Show user names and photos on the sign-in screen' → 'Allow adding new users'."
      ));
    } else {
      findings.push(findingOk(
        "show_add_user", "'Add user' button hidden",
        "Students cannot add new accounts at the login screen.",
        "high", "Disabled", "Disabled", deviceSettingsUrl
      ));
    }
  }

  // 4. Incognito mode disabled for users
  {
    const policy = await resolvePolicy(auth, "chrome.users.IncognitoModeAvailability", rootOrgUnitId);
    const value = (policy?.value as { incognitoModeAvailability?: string } | null)?.incognitoModeAvailability;
    if (!value) {
      findings.push(findingUnknown(
        "incognito_mode", "Incognito mode setting",
        "Couldn't read this policy. Incognito mode hides browsing activity from the extension.",
        "high", userSettingsUrl, policy?.error
      ));
    } else if (value === "INCOGNITO_MODE_DISABLED") {
      findings.push(findingOk(
        "incognito_mode", "Incognito mode disabled",
        "Students cannot open Incognito tabs to hide browsing.",
        "high", "Disabled", "Disabled", userSettingsUrl
      ));
    } else {
      findings.push(findingProblem(
        "incognito_mode",
        "Incognito mode is allowed",
        "Students can open Incognito windows where the extension cannot see their browsing.",
        "high", "warning",
        value, "Disabled", userSettingsUrl,
        "In Admin Console → Devices → Chrome → Settings → Users & browsers → Security, set 'Incognito mode' to 'Disallow incognito mode'."
      ));
    }
  }

  // 5. Developer tools blocked
  {
    const policy = await resolvePolicy(auth, "chrome.users.DeveloperToolsAvailability", rootOrgUnitId);
    const value = (policy?.value as { developerToolsAvailability?: string } | null)?.developerToolsAvailability;
    if (!value) {
      findings.push(findingUnknown(
        "developer_tools", "Developer tools setting",
        "Couldn't read this policy. DevTools lets students disable the extension or modify pages.",
        "medium", userSettingsUrl, policy?.error
      ));
    } else if (value === "DEVELOPER_TOOLS_DISALLOWED") {
      findings.push(findingOk(
        "developer_tools", "Developer tools blocked",
        "Students cannot use DevTools to tamper with monitoring.",
        "medium", "Blocked", "Blocked", userSettingsUrl
      ));
    } else {
      findings.push(findingProblem(
        "developer_tools",
        "Developer tools are allowed",
        "Tech-savvy students can use DevTools (F12) to disable the ClassPilot extension or modify page content.",
        "medium", "warning",
        value, "Blocked", userSettingsUrl,
        "In Admin Console → Devices → Chrome → Settings → Users & browsers → User experience, set 'Developer tools' to 'Never allow use of built-in developer tools'."
      ));
    }
  }

  // 6. ClassPilot extension force-installed
  {
    const policy = await resolvePolicy(auth, "chrome.users.ExtensionInstallForcelist", rootOrgUnitId);
    const list = (policy?.value as { extensionInstallForcelist?: string[] } | null)?.extensionInstallForcelist ?? [];
    const containsClassPilot = expectedExtensionId
      ? list.some((entry) => entry.includes(expectedExtensionId))
      : list.length > 0;

    if (!expectedExtensionId) {
      findings.push(findingUnknown(
        "extension_forcelist", "ClassPilot extension force-installed",
        "CLASSPILOT_EXTENSION_ID is not configured on the server. Set this env var to enable the check.",
        "high", appsUrl
      ));
    } else if (policy?.error) {
      findings.push(findingUnknown(
        "extension_forcelist",
        "ClassPilot extension force-installed",
        "Couldn't read the force-install policy. Without it, students may remove the extension or never receive it.",
        "high",
        appsUrl,
        policy.error
      ));
    } else if (containsClassPilot) {
      findings.push(findingOk(
        "extension_forcelist", "ClassPilot extension force-installed",
        "Every signed-in student gets the ClassPilot extension automatically.",
        "high",
        `${list.length} extension(s) force-installed (ClassPilot included)`,
        "ClassPilot present", appsUrl
      ));
    } else {
      findings.push(findingProblem(
        "extension_forcelist",
        "ClassPilot extension is NOT force-installed",
        "Students can remove the extension or it may never install. Without it, ClassPilot cannot monitor activity.",
        "high", "critical",
        list.length === 0 ? "No extensions force-installed" : `${list.length} extension(s), ClassPilot not included`,
        `Include ${expectedExtensionId}`, appsUrl,
        `In Admin Console → Devices → Chrome → Apps & extensions → Users & browsers, add the ClassPilot extension (${expectedExtensionId}) and set it to 'Force install'.`
      ));
    }
  }

  // 7. Browser sign-in / SAML — make sure user data syncs to your domain
  {
    const policy = await resolvePolicy(auth, "chrome.users.BrowserSignin", rootOrgUnitId);
    const value = (policy?.value as { browserSignin?: string } | null)?.browserSignin;
    if (!value) {
      findings.push(findingUnknown(
        "browser_signin", "Browser sign-in setting",
        "Couldn't read this policy.",
        "low", userSettingsUrl, policy?.error
      ));
    } else if (value === "FORCE") {
      findings.push(findingOk(
        "browser_signin", "Browser sign-in forced",
        "Students must sign into Chrome with their school account.",
        "low", "Forced", "Forced", userSettingsUrl
      ));
    } else {
      findings.push(findingProblem(
        "browser_signin",
        "Browser sign-in not enforced",
        "Students may use Chrome without signing in, which can sidestep some user-level policies.",
        "low", "warning",
        value, "FORCE", userSettingsUrl,
        "In Admin Console → Devices → Chrome → Settings → Users & browsers → Sign-in settings, set 'Browser sign-in settings' to 'Force users to sign-in to use the browser'."
      ));
    }
  }

  const scoreOk = findings.filter((f) => f.status === "ok").length;
  const scoreTotal = findings.length;

  return {
    scannedAt: new Date().toISOString(),
    customerDomain,
    deviceCount,
    orgUnitsCount,
    extensionId: expectedExtensionId,
    findings,
    scoreOk,
    scoreTotal,
    errors,
  };
}
