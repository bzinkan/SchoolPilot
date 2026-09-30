import { RestrictionResourceError } from "./restrictionResources.js";

/**
 * Save-time resolution of Google Forms short links (forms.gle) for precise
 * restriction resources. Never called at apply, delivery or heartbeat time.
 *
 * Bounded on purpose (it makes outbound requests from API tasks):
 * - only https://forms.gle/<token> is fetched, never a caller-chosen host;
 * - HEAD with redirect "manual", a GET only when HEAD answers 405;
 * - at most 3 redirects, each Location must be another forms.gle short link or
 *   an https://docs.google.com/forms/ page, and the first Forms page wins;
 * - 3 s per request, response bodies are never read, no cookies are sent;
 * - any other status, a missing or foreign Location, a timeout or a network
 *   error is RESOURCE_SHORT_LINK_UNRESOLVED (400). The teacher can always paste
 *   the full docs.google.com/forms link instead.
 *
 * Egress dependency: API tasks need outbound HTTPS to forms.gle. Without it a
 * short link fails closed with the same 400; nothing else depends on it.
 */

export type ShortLinkResponse = {
  status: number;
  headers: { get(name: string): string | null };
  body?: { cancel?: () => unknown } | null;
};

export type ShortLinkFetch = (
  url: string,
  init: {
    method: "HEAD" | "GET";
    redirect: "manual";
    signal: AbortSignal;
    headers: Record<string, string>;
  }
) => Promise<ShortLinkResponse>;

export const FORMS_SHORT_LINK_MAX_HOPS = 3;
export const FORMS_SHORT_LINK_REQUEST_TIMEOUT_MS = 3_000;
export const MAX_FORMS_SHORT_LINKS_PER_REQUEST = 10;

const FORMS_SHORT_LINK_HOST = "forms.gle";
const FORMS_SHORT_LINK_PATH = /^\/[A-Za-z0-9]{6,24}\/?$/;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function unresolved(message = "This forms.gle link could not be resolved; paste the full Google Form link instead"): RestrictionResourceError {
  return new RestrictionResourceError("RESOURCE_SHORT_LINK_UNRESOLVED", message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseShortLink(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.length > 256) return null;
  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.username || parsed.password || parsed.port) return null;
  if (parsed.hostname.toLowerCase() !== FORMS_SHORT_LINK_HOST) return null;
  if (!FORMS_SHORT_LINK_PATH.test(parsed.pathname) || parsed.search || parsed.hash) return null;
  // Short links are always fetched over https, whatever the teacher typed.
  return new URL(`https://${FORMS_SHORT_LINK_HOST}${parsed.pathname}`);
}

/** True for a forms.gle short link this resolver would fetch. */
export function isFormsShortLink(value: unknown): boolean {
  return parseShortLink(value) !== null;
}

function redirectKind(location: URL): "short" | "form" | null {
  if (location.protocol !== "https:" || location.username || location.password || location.port) return null;
  const host = location.hostname.toLowerCase();
  if (host === FORMS_SHORT_LINK_HOST) {
    return FORMS_SHORT_LINK_PATH.test(location.pathname) && !location.search && !location.hash ? "short" : null;
  }
  if (host === "docs.google.com" && location.pathname.startsWith("/forms/")) return "form";
  return null;
}

const defaultFetch: ShortLinkFetch = async (url, init) => {
  const response = await fetch(url, init);
  return response as unknown as ShortLinkResponse;
};

async function requestOnce(
  fetchImpl: ShortLinkFetch,
  url: URL,
  method: "HEAD" | "GET",
  timeoutMs: number
): Promise<ShortLinkResponse> {
  let response: ShortLinkResponse;
  try {
    response = await fetchImpl(url.toString(), {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "text/html" },
    });
  } catch {
    throw unresolved();
  }
  try {
    await response.body?.cancel?.();
  } catch {
    // The body is never read; a failed cancel changes nothing.
  }
  return response;
}

/**
 * Follows a forms.gle short link to its docs.google.com/forms URL, within the
 * bounds above. The result still goes through normalizeAllowedResource.
 */
export async function resolveFormsShortLink(
  value: unknown,
  options: { fetch?: ShortLinkFetch; timeoutMs?: number; maxHops?: number } = {}
): Promise<string> {
  const fetchImpl = options.fetch ?? defaultFetch;
  const timeoutMs = options.timeoutMs ?? FORMS_SHORT_LINK_REQUEST_TIMEOUT_MS;
  const maxHops = Math.min(options.maxHops ?? FORMS_SHORT_LINK_MAX_HOPS, FORMS_SHORT_LINK_MAX_HOPS);
  let current = parseShortLink(value);
  if (!current) throw unresolved("Only https://forms.gle/<code> short links can be resolved");
  for (let hop = 0; hop < maxHops; hop += 1) {
    let response = await requestOnce(fetchImpl, current, "HEAD", timeoutMs);
    if (response.status === 405) response = await requestOnce(fetchImpl, current, "GET", timeoutMs);
    if (!REDIRECT_STATUSES.has(response.status)) throw unresolved();
    const location = response.headers.get("location");
    if (!location) throw unresolved();
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw unresolved();
    }
    const kind = redirectKind(next);
    if (kind === "form") return next.toString();
    if (kind !== "short") throw unresolved();
    current = next;
  }
  throw unresolved();
}

function authoringUrl(input: unknown): unknown {
  return isPlainObject(input) && Object.keys(input).length === 1 ? input.url : undefined;
}

/** True when a list of {url} authoring inputs contains a forms.gle short link. */
export function restrictionResourceInputsNeedResolution(inputs: unknown): boolean {
  return Array.isArray(inputs) && inputs.some((input) => isFormsShortLink(authoringUrl(input)));
}

/**
 * Replaces each `{url}` forms.gle input with its resolved Forms URL, in
 * parallel and at most MAX_FORMS_SHORT_LINKS_PER_REQUEST per request. Other
 * entries (and non-array input, which normalization rejects) pass through.
 */
export async function resolveRestrictionResourceInputs(
  inputs: unknown,
  options: { fetch?: ShortLinkFetch; timeoutMs?: number } = {}
): Promise<unknown> {
  if (!Array.isArray(inputs)) return inputs;
  const shortIndexes = inputs.flatMap((input, index) => isFormsShortLink(authoringUrl(input)) ? [index] : []);
  if (shortIndexes.length === 0) return inputs;
  if (shortIndexes.length > MAX_FORMS_SHORT_LINKS_PER_REQUEST) {
    throw unresolved(
      `At most ${MAX_FORMS_SHORT_LINKS_PER_REQUEST} forms.gle links can be resolved at once; paste full Google Form links instead`
    );
  }
  const resolved = new Map<number, string>();
  await Promise.all(shortIndexes.map(async (index) => {
    try {
      resolved.set(index, await resolveFormsShortLink(authoringUrl(inputs[index]), options));
    } catch (error) {
      if (error instanceof RestrictionResourceError) {
        throw new RestrictionResourceError(error.code, `Resource ${index + 1}: ${error.message}`, index);
      }
      throw error;
    }
  }));
  return inputs.map((input, index) => resolved.has(index) ? { url: resolved.get(index)! } : input);
}

/**
 * Whether a Flight Path authoring request body would trigger short-link
 * resolution: `resources` of `{url}` inputs, or a Classroom import that asks
 * for resource-level entries. The rate limiter counts only these requests.
 */
export function restrictionResourceRequestNeedsResolution(body: unknown): boolean {
  if (!isPlainObject(body)) return false;
  if (body.purpose === "waypoint" && body.boundary === "resource" && isFormsShortLink(body.url)) return true;
  if (restrictionResourceInputsNeedResolution(body.resources)) return true;
  if (body.boundary !== "resource") return false;
  const classroomLinks = Array.isArray(body.resources)
    ? body.resources.flatMap((resource) => (
        isPlainObject(resource) && Array.isArray(resource.links)
          ? resource.links.map((link) => (isPlainObject(link) ? link.url : undefined))
          : []
      ))
    : [];
  const fallbackLinks = Array.isArray(body.resourceLinks) ? body.resourceLinks : [];
  return [...classroomLinks, ...fallbackLinks].some((url) => isFormsShortLink(url));
}
