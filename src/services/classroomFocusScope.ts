import {
  assertRestrictionResourceLimits, canonicalRestrictionHostname, isUrlAllowedByResources,
  MAX_RESTRICTION_RESOURCES, MAX_RESTRICTION_RESOURCES_BYTES,
  restrictionResourceIdentityKey, validateAllowedResource, type PreciseAllowedResource,
} from "./restrictionResources.js";

export const CLASSROOM_FOCUS_SCOPE_CAPABILITY = "classroomFocusScopeV1" as const;
export const CLASSROOM_FOCUS_BASE_DOMAINS = ["classroom.google.com", "docs.google.com", "drive.google.com",
  "sheets.google.com", "slides.google.com", "forms.google.com", "forms.gle"] as const;
const FORBIDDEN_DOMAIN_ROOTS = ["youtube.com", "youtube-nocookie.com", "youtu.be", "accounts.google.com",
  "login.microsoftonline.com", "accounts.youtube.com"];

export type ClassroomFocusScope = {
  schemaVersion: 1;
  sourceRevision: string;
  allowedDomains: string[];
  resources: PreciseAllowedResource[];
};

export function isClassroomFocusWebsiteUrl(value: unknown): boolean {
  if (typeof value !== "string" || value === "CURRENT_URL") return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.port
      && url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "") === "classroom.google.com";
  } catch { return false; }
}

/** Source validation is separate: this only validates the exact delivered policy. */
export function validateClassroomFocusScope(value: unknown): ClassroomFocusScope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const scope = value as Record<string, unknown>;
  const keys = Object.keys(scope);
  if (keys.length !== 4 || !["schemaVersion", "sourceRevision", "allowedDomains", "resources"].every(key => keys.includes(key))
    || scope.schemaVersion !== 1 || typeof scope.sourceRevision !== "string" || !/^[a-f0-9]{64}$/.test(scope.sourceRevision)
    || !Array.isArray(scope.allowedDomains) || !Array.isArray(scope.resources)
    || scope.allowedDomains.length + scope.resources.length > MAX_RESTRICTION_RESOURCES) return null;
  try {
    if (Buffer.byteLength(JSON.stringify(scope), "utf8") > MAX_RESTRICTION_RESOURCES_BYTES) return null;
    const domains: string[] = [];
    for (const raw of scope.allowedDomains) {
      if (typeof raw !== "string" || canonicalRestrictionHostname(raw) !== raw || domains.includes(raw)
        || raw === "google.com" || FORBIDDEN_DOMAIN_ROOTS.some(root => raw === root || raw.endsWith(`.${root}`))) return null;
      domains.push(raw);
    }
    if (!CLASSROOM_FOCUS_BASE_DOMAINS.every(host => domains.includes(host))) return null;
    const resources: PreciseAllowedResource[] = [];
    const identities = new Set<string>();
    for (const raw of scope.resources) {
      const resource = validateAllowedResource(raw);
      if (!resource || resource.type === "website"
        || (resource.type === "section" && FORBIDDEN_DOMAIN_ROOTS.some(root =>
          resource.hostname === root || resource.hostname.endsWith(`.${root}`)))) return null;
      const identity = restrictionResourceIdentityKey(resource);
      if (identities.has(identity)) return null;
      identities.add(identity);
      resources.push(resource);
    }
    assertRestrictionResourceLimits([...domains.map(hostname => ({ type: "website" as const, hostname,
      includeSubdomains: true as const })), ...resources]);
    return { schemaVersion: 1, sourceRevision: scope.sourceRevision, allowedDomains: domains, resources };
  } catch { return null; }
}

export function normalizeClassroomFocusScope(value: unknown): ClassroomFocusScope {
  const scope = validateClassroomFocusScope(value);
  if (!scope) throw Object.assign(new Error("The reviewed Classroom Focus scope is invalid or too large"), {
    status: 400, code: "CLASSROOM_FOCUS_SCOPE_INVALID", expose: true,
  });
  return scope;
}

export function classroomFocusScopeAllowsUrl(value: unknown, rawUrl: unknown): boolean {
  const scope = validateClassroomFocusScope(value);
  if (!scope || typeof rawUrl !== "string") return false;
  try {
    const url = new URL(rawUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return false;
    const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
    return scope.allowedDomains.some(domain => host === domain || host.endsWith(`.${domain}`))
      || isUrlAllowedByResources(rawUrl, scope.resources);
  } catch { return false; }
}
