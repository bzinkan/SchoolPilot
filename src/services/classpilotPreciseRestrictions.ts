import { isClasspilotCapabilityActive } from "./classpilotProtocol.js";
import {
  PRECISE_RESTRICTION_RESOURCES_CAPABILITY,
  RestrictionResourceError,
  assertRestrictionResourceLimits,
  isWaypointLandingUrl,
  legacyHostProjection,
  normalizeAllowedResource,
  normalizeAllowedResourceList,
  preciseRestrictionResources,
  restrictionResourceIdentityKey,
  validateAllowedResource,
  validateAllowedResourceList,
  type AllowedResource,
  type PreciseAllowedResource,
} from "./restrictionResources.js";
import {
  MAX_FORMS_SHORT_LINKS_PER_REQUEST,
  isFormsShortLink,
  resolveFormsShortLink,
  resolveRestrictionResourceInputs,
  type ShortLinkFetch,
} from "./restrictionResourceResolver.js";

/**
 * Server-side (environment-aware) rules for precise restriction resources.
 * The wire contract itself is the pure src/services/restrictionResources.ts.
 */

export const PRECISE_RESTRICTION_RESOURCES_DISABLED = "PRECISE_RESTRICTION_RESOURCES_DISABLED";

/**
 * Whether this school may author and apply precise restrictions. Uses the
 * same activation as negotiation (protocol v3, the capability flag and the
 * rollout entry), so a school that cannot author them also has no client
 * that could accept them.
 */
export function preciseRestrictionResourcesActive(
  schoolId: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return isClasspilotCapabilityActive(PRECISE_RESTRICTION_RESOURCES_CAPABILITY, { schoolId }, env);
}

export function requirePreciseRestrictionResourcesActive(
  schoolId: string,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (!preciseRestrictionResourcesActive(schoolId, env)) {
    throw Object.assign(
      new Error("This resource only, sections and resources are not turned on for this school"),
      { status: 409, code: PRECISE_RESTRICTION_RESOURCES_DISABLED, expose: true }
    );
  }
}

function flightPathError(message: string, code: string): Error {
  return Object.assign(new Error(message), { status: 409, code, expose: true });
}

/**
 * The apply-flight-path payload for a stored Flight Path. Website hosts ride
 * in `allowedDomains` (today's list, unchanged in order and content when the
 * path has no resources); section and resource entries ride in `resources`,
 * which is omitted when there are none so website-only paths stay
 * byte-identical. A stored list that no longer validates is refused (409),
 * never dropped to its websites.
 */
export function classpilotFlightPathApplyPayload(options: {
  schoolId: string;
  flightPath: {
    id: string;
    flightPathName: string;
    allowedDomains: string[] | null;
    resources?: unknown;
  };
  env?: NodeJS.ProcessEnv;
}): {
  flightPathId: string;
  flightPathName: string;
  allowedDomains: string[];
  resources?: PreciseAllowedResource[];
} {
  const stored = options.flightPath.resources ?? [];
  const resources = validateAllowedResourceList(stored);
  if (!resources) {
    throw flightPathError(
      "This Flight Path's resources could not be verified; open it in Teaching tools and save it again",
      "FLIGHT_PATH_RESOURCES_INVALID"
    );
  }
  const allowedDomains = [...(options.flightPath.allowedDomains ?? [])];
  for (const hostname of legacyHostProjection(resources)) {
    if (!allowedDomains.includes(hostname)) allowedDomains.push(hostname);
  }
  const precise = preciseRestrictionResources(resources);
  if (allowedDomains.length === 0 && precise.length === 0) {
    throw flightPathError("Flight Path has no allowed domains", "FLIGHT_PATH_EMPTY");
  }
  if (precise.length > 0) requirePreciseRestrictionResourcesActive(options.schoolId, options.env);
  return {
    flightPathId: options.flightPath.id,
    flightPathName: options.flightPath.flightPathName,
    allowedDomains,
    ...(precise.length > 0 ? { resources: precise } : {}),
  };
}

/**
 * Whether a Waypoint or Flight Path command payload's precise entries all
 * re-validate. Live payloads are built from validated input; this guards
 * replayed payloads (routine retries) and anything written by another image.
 */
export function classpilotPreciseCommandPayloadValid(commandType: string, payload: unknown): boolean {
  const data = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  if (commandType === "lock-screen") {
    const resource = validateAllowedResource(data.resource);
    return !!resource && resource.type !== "website" && isWaypointLandingUrl(data.url, resource);
  }
  if (commandType === "apply-flight-path") {
    const resources = validateAllowedResourceList(data.resources);
    return !!resources && resources.length > 0;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Flight Path authoring (routes)
// ---------------------------------------------------------------------------

/**
 * Flight Path responses keep their previous shape while the capability is off
 * for the school: an empty `resources` list is omitted. A path that still
 * holds entries (for example after a rollout was turned off) always shows
 * them, so its owner is never misled about what it contains.
 */
export function withFlightPathResourcesVisibility<Row extends { resources?: unknown }>(
  row: Row,
  preciseActive: boolean
): Row | Omit<Row, "resources"> {
  if (preciseActive || (Array.isArray(row.resources) && row.resources.length > 0)) return row;
  const { resources: _resources, ...rest } = row;
  return rest;
}

/**
 * A POST/PATCH `resources` field: `{url}` or `{type:"website", hostname}`
 * entries only. Website entries are returned as hosts for allowed_domains (the
 * list ClassPilot 2.9.x enforces); section and resource entries are the new
 * `resources` column. Authoring needs the school's rollout, except clearing
 * an existing list with `[]`, which is always allowed. forms.gle links are
 * resolved here (save time) before normalization.
 */
export async function normalizeFlightPathResourcesInput(
  value: unknown,
  schoolId: string,
  options: { fetch?: ShortLinkFetch; env?: NodeJS.ProcessEnv } = {}
): Promise<{ resources: PreciseAllowedResource[]; websiteHosts: string[] }> {
  if (!Array.isArray(value)) {
    throw new RestrictionResourceError("RESOURCE_INPUT_INVALID", "resources must be an array");
  }
  if (value.length > 0) requirePreciseRestrictionResourcesActive(schoolId, options.env);
  const resolved = await resolveRestrictionResourceInputs(value, { fetch: options.fetch });
  const normalized = normalizeAllowedResourceList(resolved);
  return {
    resources: preciseRestrictionResources(normalized),
    websiteHosts: legacyHostProjection(normalized),
  };
}

/** Classroom material link URLs, fallback links first, each once, bounded. */
export function classroomImportLinkUrls(selectedResources: unknown[], fallbackLinks: unknown[]): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== "string" || !value.trim() || seen.has(value)) return;
    seen.add(value);
    urls.push(value);
  };
  fallbackLinks.forEach(add);
  for (const resource of selectedResources) {
    const links = resource && typeof resource === "object" && Array.isArray((resource as { links?: unknown }).links)
      ? (resource as { links: unknown[] }).links
      : [];
    for (const link of links) {
      add(link && typeof link === "object" ? (link as { url?: unknown }).url : undefined);
    }
  }
  if (urls.length > MAX_CLASSROOM_IMPORT_LINKS) {
    throw new RestrictionResourceError(
      "RESOURCE_LIMIT_EXCEEDED",
      `Select fewer Classroom items; at most ${MAX_CLASSROOM_IMPORT_LINKS} links can be imported at once`
    );
  }
  return urls;
}

export const MAX_CLASSROOM_IMPORT_LINKS = 1_000;

/**
 * A Classroom import at the "resource" boundary. Every link becomes its own
 * resource or section (a Classroom post, a YouTube video, a Doc, a Form) or,
 * for a bare site, a website host. A link that cannot be limited precisely is
 * left out and reported, never widened to its host. Up to
 * MAX_FORMS_SHORT_LINKS_PER_REQUEST forms.gle links are resolved in parallel.
 */
export async function classroomImportResourceEntries(
  urls: readonly string[],
  options: { fetch?: ShortLinkFetch } = {}
): Promise<{
  resources: PreciseAllowedResource[];
  websiteHosts: string[];
  skipped: Array<{ url: string; code: string }>;
}> {
  const shortLinks = urls.filter((url) => isFormsShortLink(url)).slice(0, MAX_FORMS_SHORT_LINKS_PER_REQUEST);
  const resolvedShortLinks = new Map<string, string>();
  await Promise.all(shortLinks.map(async (url) => {
    try {
      resolvedShortLinks.set(url, await resolveFormsShortLink(url, { fetch: options.fetch }));
    } catch (error) {
      if (!(error instanceof RestrictionResourceError)) throw error;
    }
  }));
  const entries: AllowedResource[] = [];
  const seen = new Set<string>();
  const skipped: Array<{ url: string; code: string }> = [];
  for (const url of urls) {
    const candidate = isFormsShortLink(url) ? resolvedShortLinks.get(url) : url;
    if (!candidate) {
      skipped.push({ url, code: "RESOURCE_SHORT_LINK_UNRESOLVED" });
      continue;
    }
    try {
      const entry = normalizeAllowedResource({ url: candidate });
      const key = restrictionResourceIdentityKey(entry);
      if (!seen.has(key)) {
        seen.add(key);
        entries.push(entry);
      }
    } catch (error) {
      if (!(error instanceof RestrictionResourceError)) throw error;
      skipped.push({ url, code: error.code });
    }
  }
  assertRestrictionResourceLimits(entries);
  return {
    resources: preciseRestrictionResources(entries),
    websiteHosts: legacyHostProjection(entries),
    skipped,
  };
}
