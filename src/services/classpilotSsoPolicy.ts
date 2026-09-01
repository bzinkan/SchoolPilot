import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { parse as parseDomain } from "tldts";

export const CLASSPILOT_SSO_POLICY_SCHEMA_VERSION = 1 as const;
export const CLASSPILOT_SSO_ATTEMPT_TTL_SECONDS = 300 as const;
export const CLASSPILOT_SSO_POLICY_MAX_PROFILES = 12 as const;
export const CLASSPILOT_SSO_POLICY_MAX_HOST_RULES = 12 as const;

export type ClasspilotSsoHostRule = {
  hostname: string;
  includeSubdomains: boolean;
};

export type ClasspilotSsoProfile = {
  id: string;
  name: string;
  startUrl: string;
  hostRules: ClasspilotSsoHostRule[];
};

export type ClasspilotSsoPolicy = {
  schemaVersion: typeof CLASSPILOT_SSO_POLICY_SCHEMA_VERSION;
  enabled: boolean;
  defaultProfileId: string | null;
  attemptTtlSeconds: typeof CLASSPILOT_SSO_ATTEMPT_TTL_SECONDS;
  profiles: ClasspilotSsoProfile[];
};

export type ClasspilotSsoPolicyRecord = {
  policy: ClasspilotSsoPolicy;
  revision: number;
  valid: boolean;
};

export type ClasspilotSsoPolicyIssue = {
  path: string;
  code: string;
  message: string;
};

export type ClasspilotSsoPolicyBlockConflict = {
  profileId: string;
  hostname: string;
  blockedDomain: string;
};

export class ClasspilotSsoPolicyValidationError extends Error {
  readonly code = "CLASSPILOT_SSO_POLICY_INVALID";
  readonly status = 400;

  constructor(readonly issues: ClasspilotSsoPolicyIssue[]) {
    super("Student sign-in policy is invalid.");
    this.name = "ClasspilotSsoPolicyValidationError";
  }
}

const GOOGLE_PROFILE: ClasspilotSsoProfile = {
  id: "google",
  name: "Google",
  startUrl: "https://accounts.google.com/",
  hostRules: [
    { hostname: "accounts.google.com", includeSubdomains: false },
  ],
};

const CLEVER_PROFILE: ClasspilotSsoProfile = {
  id: "clever",
  name: "Clever",
  startUrl: "https://clever.com/",
  hostRules: [
    { hostname: "accounts.google.com", includeSubdomains: false },
    { hostname: "clever.com", includeSubdomains: true },
  ],
};

function cloneProfile(profile: ClasspilotSsoProfile): ClasspilotSsoProfile {
  return {
    ...profile,
    hostRules: profile.hostRules.map((rule) => ({ ...rule })),
  };
}

export function builtInClasspilotSsoProfiles(): ClasspilotSsoProfile[] {
  return [cloneProfile(CLEVER_PROFILE), cloneProfile(GOOGLE_PROFILE)];
}

export function disabledClasspilotSsoPolicy(): ClasspilotSsoPolicy {
  return {
    schemaVersion: CLASSPILOT_SSO_POLICY_SCHEMA_VERSION,
    enabled: false,
    defaultProfileId: "clever",
    attemptTtlSeconds: CLASSPILOT_SSO_ATTEMPT_TTL_SECONDS,
    profiles: builtInClasspilotSsoProfiles(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addIssue(
  issues: ClasspilotSsoPolicyIssue[],
  path: string,
  code: string,
  message: string
): void {
  issues.push({ path, code, message });
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: ClasspilotSsoPolicyIssue[]
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      addIssue(issues, `${path}.${key}`, "unknown_field", "Unknown field.");
    }
  }
}

function canonicalHostname(
  value: unknown,
  path: string,
  issues: ClasspilotSsoPolicyIssue[]
): string | null {
  if (typeof value !== "string") {
    addIssue(issues, path, "invalid_hostname", "Hostname must be a string.");
    return null;
  }
  const raw = value.trim();
  if (
    raw.length === 0
    || raw.length > 253
    // Authentication authority is too sensitive to accept a hostname whose
    // display form depends on IDNA rendering. A vetted confusable-skeleton
    // implementation could relax this later; for now fail closed on both
    // Unicode input and already-punycoded labels.
    || /[^\x00-\x7f]/.test(raw)
    || raw.endsWith(".")
    || raw.includes("*")
    || raw.includes(":")
    || /[/?#@\\]/.test(raw)
  ) {
    addIssue(issues, path, "invalid_hostname", "Enter a complete hostname without a wildcard, port, path, or trailing dot.");
    return null;
  }
  const ascii = domainToASCII(raw.toLowerCase());
  if (
    !ascii
    || ascii.length > 253
    || isIP(ascii) !== 0
    || ascii === "localhost"
    || !ascii.includes(".")
    || ascii.split(".").some((label) => (
      !label
      || label.length > 63
      || label.startsWith("-")
      || label.endsWith("-")
      || !/^[a-z0-9-]+$/.test(label)
    ))
  ) {
    addIssue(issues, path, "invalid_hostname", "Hostname is not a valid public DNS name.");
    return null;
  }
  const labels = ascii.split(".");
  if (labels.some((label) => label.startsWith("xn--"))) {
    addIssue(issues, path, "invalid_hostname", "Internationalized hostnames cannot be used for authentication authority.");
    return null;
  }
  const approvedCleverAuthority = ascii === "clever.com" || ascii.endsWith(".clever.com");
  const approvedGoogleAuthority = ascii === "accounts.google.com";
  if (
    (!approvedCleverAuthority && labels.some((label) => label.includes("clever")))
    || (!approvedGoogleAuthority && labels.some((label) => label.includes("google")))
  ) {
    addIssue(issues, path, "provider_lookalike", "Hostname resembles a built-in provider but is outside its approved authentication authority.");
    return null;
  }
  const parsed = parseDomain(ascii, { allowPrivateDomains: true });
  if (!parsed.domain || parsed.publicSuffix === ascii) {
    addIssue(issues, path, "public_suffix", "A public suffix cannot be used as an identity-provider host.");
    return null;
  }
  return ascii;
}

function canonicalStartUrl(
  value: unknown,
  path: string,
  issues: ClasspilotSsoPolicyIssue[]
): { url: string; hostname: string } | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    addIssue(issues, path, "invalid_url", "Start URL must be between 1 and 2,048 characters.");
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    addIssue(issues, path, "invalid_url", "Start URL must be a valid HTTPS URL.");
    return null;
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.port
    || parsed.hash
    || value.includes("#")
  ) {
    addIssue(issues, path, "invalid_url", "Start URL must use HTTPS without credentials, a fragment, or a non-default port.");
    return null;
  }
  const hostname = canonicalHostname(parsed.hostname, `${path}.hostname`, issues);
  if (!hostname) return null;
  parsed.hostname = hostname;
  return { url: parsed.toString(), hostname };
}

function hostnameMatchesRule(hostname: string, rule: ClasspilotSsoHostRule): boolean {
  return hostname === rule.hostname
    || (rule.includeSubdomains && hostname.endsWith(`.${rule.hostname}`));
}

function canonicalHostRule(
  value: unknown,
  path: string,
  issues: ClasspilotSsoPolicyIssue[]
): ClasspilotSsoHostRule | null {
  if (!isRecord(value)) {
    addIssue(issues, path, "invalid_rule", "Host rule must be an object.");
    return null;
  }
  rejectUnknownKeys(value, ["hostname", "includeSubdomains"], path, issues);
  const hostname = canonicalHostname(value.hostname, `${path}.hostname`, issues);
  if (typeof value.includeSubdomains !== "boolean") {
    addIssue(issues, `${path}.includeSubdomains`, "invalid_boolean", "Subdomain matching must be true or false.");
  }
  if (!hostname || typeof value.includeSubdomains !== "boolean") return null;
  if (hostname === "accounts.google.com" && value.includeSubdomains) {
    addIssue(
      issues,
      `${path}.includeSubdomains`,
      "google_accounts_must_be_exact",
      "Google Accounts authentication must match exact accounts.google.com."
    );
    return null;
  }
  return { hostname, includeSubdomains: value.includeSubdomains };
}

function canonicalProfile(
  value: unknown,
  index: number,
  issues: ClasspilotSsoPolicyIssue[]
): ClasspilotSsoProfile | null {
  const path = `policy.profiles[${index}]`;
  if (!isRecord(value)) {
    addIssue(issues, path, "invalid_profile", "Profile must be an object.");
    return null;
  }
  rejectUnknownKeys(value, ["id", "name", "startUrl", "hostRules"], path, issues);

  const id = typeof value.id === "string" ? value.id.trim().toLowerCase() : "";
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
    addIssue(issues, `${path}.id`, "invalid_profile_id", "Profile ID must use 1–64 lowercase letters, numbers, underscores, or hyphens.");
  }
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name || name.length > 80) {
    addIssue(issues, `${path}.name`, "invalid_profile_name", "Profile name must be between 1 and 80 characters.");
  }
  const start = canonicalStartUrl(value.startUrl, `${path}.startUrl`, issues);
  if (!Array.isArray(value.hostRules) || value.hostRules.length < 1 || value.hostRules.length > CLASSPILOT_SSO_POLICY_MAX_HOST_RULES) {
    addIssue(issues, `${path}.hostRules`, "invalid_host_rules", `Each profile needs 1–${CLASSPILOT_SSO_POLICY_MAX_HOST_RULES} host rules.`);
  }
  const rules = Array.isArray(value.hostRules)
    ? value.hostRules.slice(0, CLASSPILOT_SSO_POLICY_MAX_HOST_RULES).map(
      (rule, ruleIndex) => canonicalHostRule(rule, `${path}.hostRules[${ruleIndex}]`, issues)
    ).filter((rule): rule is ClasspilotSsoHostRule => Boolean(rule))
    : [];
  const duplicateRules = new Set<string>();
  const ruleKeys = new Set<string>();
  for (const rule of rules) {
    const key = `${rule.hostname}\u0000${rule.includeSubdomains}`;
    if (ruleKeys.has(key)) duplicateRules.add(rule.hostname);
    ruleKeys.add(key);
  }
  if (duplicateRules.size > 0) {
    addIssue(issues, `${path}.hostRules`, "duplicate_host_rule", "Duplicate host rules are not allowed.");
  }
  if (start && rules.length > 0 && !rules.some((rule) => hostnameMatchesRule(start.hostname, rule))) {
    addIssue(issues, `${path}.startUrl`, "start_url_not_allowed", "Start URL must match one of this profile’s host rules.");
  }

  if (id === "google") {
    const validRules = rules.length === 1
      && rules[0]?.hostname === "accounts.google.com"
      && rules[0]?.includeSubdomains === false;
    if (start?.hostname !== "accounts.google.com" || !validRules) {
      addIssue(issues, path, "invalid_google_profile", "The built-in Google profile is restricted to exact accounts.google.com authentication.");
    }
  }
  if (id === "clever") {
    const cleverStart = Boolean(
      start
      && (start.hostname === "clever.com" || start.hostname.endsWith(".clever.com"))
    );
    const cleverRule = rules.some((rule) => rule.hostname === "clever.com" && rule.includeSubdomains);
    const googleRule = rules.some((rule) => rule.hostname === "accounts.google.com" && !rule.includeSubdomains);
    if (!cleverStart || rules.length !== 2 || !cleverRule || !googleRule) {
      addIssue(issues, path, "invalid_clever_profile", "The built-in Clever profile must use clever.com (including subdomains) and exact accounts.google.com authentication.");
    }
  }

  if (!id || !name || !start || rules.length === 0) return null;
  return {
    id,
    name: id === "google" ? "Google" : id === "clever" ? "Clever" : name,
    startUrl: start.url,
    hostRules: [...rules].sort((a, b) => (
      a.hostname.localeCompare(b.hostname)
      || Number(a.includeSubdomains) - Number(b.includeSubdomains)
    )),
  };
}

export function canonicalizeClasspilotSsoPolicy(input: unknown): ClasspilotSsoPolicy {
  const issues: ClasspilotSsoPolicyIssue[] = [];
  if (!isRecord(input)) {
    throw new ClasspilotSsoPolicyValidationError([
      { path: "policy", code: "invalid_policy", message: "Policy must be an object." },
    ]);
  }
  rejectUnknownKeys(
    input,
    ["schemaVersion", "enabled", "defaultProfileId", "attemptTtlSeconds", "profiles"],
    "policy",
    issues
  );
  if (input.schemaVersion !== CLASSPILOT_SSO_POLICY_SCHEMA_VERSION) {
    addIssue(issues, "policy.schemaVersion", "unsupported_schema", "Policy schemaVersion must be 1.");
  }
  if (typeof input.enabled !== "boolean") {
    addIssue(issues, "policy.enabled", "invalid_boolean", "Enabled must be true or false.");
  }
  if (input.attemptTtlSeconds !== CLASSPILOT_SSO_ATTEMPT_TTL_SECONDS) {
    addIssue(issues, "policy.attemptTtlSeconds", "invalid_ttl", "Authentication attempts use a fixed five-minute timeout.");
  }
  if (!Array.isArray(input.profiles) || input.profiles.length > CLASSPILOT_SSO_POLICY_MAX_PROFILES) {
    addIssue(issues, "policy.profiles", "invalid_profiles", `Policy supports at most ${CLASSPILOT_SSO_POLICY_MAX_PROFILES} profiles.`);
  }
  const profiles = Array.isArray(input.profiles)
    ? input.profiles.slice(0, CLASSPILOT_SSO_POLICY_MAX_PROFILES).map(
      (profile, index) => canonicalProfile(profile, index, issues)
    ).filter((profile): profile is ClasspilotSsoProfile => Boolean(profile))
    : [];
  const profileIds = new Set<string>();
  for (const profile of profiles) {
    if (profileIds.has(profile.id)) {
      addIssue(issues, "policy.profiles", "duplicate_profile_id", "Profile IDs must be unique.");
    }
    profileIds.add(profile.id);
  }
  const defaultProfileId = input.defaultProfileId === null
    ? null
    : typeof input.defaultProfileId === "string"
      ? input.defaultProfileId.trim().toLowerCase()
      : "";
  if (defaultProfileId && !profileIds.has(defaultProfileId)) {
    addIssue(issues, "policy.defaultProfileId", "unknown_default_profile", "Default provider must reference an included profile.");
  }
  if (!defaultProfileId && input.enabled === true) {
    addIssue(issues, "policy.defaultProfileId", "default_profile_required", "An enabled policy requires a default provider.");
  }
  if (profiles.length === 0 && defaultProfileId !== null) {
    addIssue(issues, "policy.defaultProfileId", "default_profile_without_profiles", "Default provider must be null when no profiles are configured.");
  }
  if (issues.length > 0) throw new ClasspilotSsoPolicyValidationError(issues);
  return {
    schemaVersion: CLASSPILOT_SSO_POLICY_SCHEMA_VERSION,
    enabled: input.enabled as boolean,
    defaultProfileId: defaultProfileId || null,
    attemptTtlSeconds: CLASSPILOT_SSO_ATTEMPT_TTL_SECONDS,
    profiles: [...profiles].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function classpilotSsoPolicyFromSettings(row: {
  classpilotSsoPolicy?: unknown;
  classpilotSsoPolicyRevision?: unknown;
} | null | undefined): ClasspilotSsoPolicyRecord {
  const revision = Number.isSafeInteger(row?.classpilotSsoPolicyRevision)
    && Number(row?.classpilotSsoPolicyRevision) >= 0
    ? Number(row?.classpilotSsoPolicyRevision)
    : 0;
  if (!row || row.classpilotSsoPolicy === undefined || row.classpilotSsoPolicy === null) {
    return { policy: disabledClasspilotSsoPolicy(), revision, valid: true };
  }
  try {
    return {
      policy: canonicalizeClasspilotSsoPolicy(row.classpilotSsoPolicy),
      revision,
      valid: true,
    };
  } catch {
    return { policy: disabledClasspilotSsoPolicy(), revision, valid: false };
  }
}

function canonicalConfiguredDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .split(/[/?#]/, 1)[0]
    ?.replace(/^www\./, "")
    .replace(/\.$/, "");
  if (!candidate || candidate.includes(":")) return null;
  const ascii = domainToASCII(candidate);
  return ascii && isIP(ascii) === 0 ? ascii : null;
}

export function findClasspilotSsoPolicyBlockConflicts(
  policy: ClasspilotSsoPolicy,
  blockedDomains: readonly unknown[] | null | undefined
): ClasspilotSsoPolicyBlockConflict[] {
  const blocked = [...new Set((blockedDomains ?? [])
    .map(canonicalConfiguredDomain)
    .filter((value): value is string => Boolean(value)))];
  const conflicts: ClasspilotSsoPolicyBlockConflict[] = [];
  for (const profile of policy.profiles) {
    for (const rule of profile.hostRules) {
      for (const blockedDomain of blocked) {
        if (
          rule.hostname === blockedDomain
          || rule.hostname.endsWith(`.${blockedDomain}`)
          || (rule.includeSubdomains && blockedDomain.endsWith(`.${rule.hostname}`))
        ) {
          conflicts.push({
            profileId: profile.id,
            hostname: rule.hostname,
            blockedDomain,
          });
        }
      }
    }
  }
  return conflicts.sort((a, b) => (
    a.profileId.localeCompare(b.profileId)
    || a.hostname.localeCompare(b.hostname)
    || a.blockedDomain.localeCompare(b.blockedDomain)
  ));
}
