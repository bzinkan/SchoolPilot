import { isClasspilotCapabilityActive } from "./classpilotProtocol.js";
import {
  PRECISE_RESTRICTION_RESOURCES_CAPABILITY,
  canonicalUrlForResource,
  legacyHostProjection,
  preciseRestrictionResources,
  validateAllowedResource,
  validateAllowedResourceList,
  type PreciseAllowedResource,
} from "./restrictionResources.js";

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
    return !!resource && resource.type !== "website" && data.url === canonicalUrlForResource(resource);
  }
  if (commandType === "apply-flight-path") {
    const resources = validateAllowedResourceList(data.resources);
    return !!resources && resources.length > 0;
  }
  return false;
}
