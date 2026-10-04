import { parse as parseDomain } from "tldts";

/**
 * Precise restriction resources: the wire contract shared with ClassPilot
 * 2.9.7 (capability `preciseRestrictionResourcesV1`).
 *
 * Pure: no I/O, no clock, no environment. The extension ports
 * `isUrlAllowedByResource`, `extractRestrictionResourceIdentity` and
 * `validateAllowedResource` (without the public-suffix check, which only the
 * server performs) and asserts the shared case file
 * tests/fixtures/restriction-resource-matcher-cases.json, whose SHA-256 is
 * pinned in docs/CLASSPILOT_PRECISE_RESTRICTIONS_CONTRACT.md and in both
 * repositories' tests. Change a rule here only together with the case file.
 *
 * Safety invariants:
 * - A section or resource is never widened to its hostname. Only `website`
 *   entries have a legacy (ClassPilot 2.9.x) projection.
 * - A `website` entry always includes subdomains, exactly like a legacy
 *   Flight Path domain; an exact-host website is not expressible.
 * - Provider, resource id and canonical URL are always computed here from a
 *   URL. Client-supplied values are rejected, never trusted.
 * - Every matcher fails closed: anything it cannot parse is not allowed.
 */

export const PRECISE_RESTRICTION_RESOURCES_CAPABILITY = "preciseRestrictionResourcesV1" as const;

export const RESTRICTION_RESOURCE_PROVIDERS = [
  "youtube",
  "google_docs",
  "google_slides",
  "google_sheets",
  "google_forms",
  "google_drive",
] as const;

export type RestrictionResourceProvider = (typeof RESTRICTION_RESOURCE_PROVIDERS)[number];

export type WebsiteAllowedResource = {
  type: "website";
  hostname: string;
  includeSubdomains: true;
};

export type SectionAllowedResource = {
  type: "section";
  hostname: string;
  includeSubdomains: false;
  /** Starts with "/", no query, fragment or trailing "/", at most 512 characters. */
  pathPrefix: string;
};

export type ResourceAllowedResource = {
  type: "resource";
  hostname: string;
  includeSubdomains: false;
  provider: RestrictionResourceProvider;
  resourceId: string;
  canonicalUrl: string;
};

export type AllowedResource =
  | WebsiteAllowedResource
  | SectionAllowedResource
  | ResourceAllowedResource;

export type PreciseAllowedResource = SectionAllowedResource | ResourceAllowedResource;

/** The only accepted authoring shapes. Everything else is computed. */
export type AllowedResourceInput = { url: string } | { type: "website"; hostname: string };

export type RestrictionResourceIdentity = {
  provider: RestrictionResourceProvider;
  resourceId: string;
};

/** Entries per Flight Path, counting website, section and resource entries. */
export const MAX_RESTRICTION_RESOURCES = 200;
/**
 * Rule ids 3..999 of the extension's classroom DNR range (id 1 is the block
 * rule and id 2 the Waypoint domain allow). The sum of
 * `restrictionResourceRuleCount` over a list must fit.
 */
export const RESTRICTION_RESOURCE_RULE_ID_BUDGET = 997;
export const MAX_SECTION_PATH_PREFIX_LENGTH = 512;
export const MAX_RESTRICTION_RESOURCE_URL_LENGTH = 2_048;
/**
 * Serialized (JSON.stringify) size of one resources list. 200 Google Docs
 * entries are about 46 KB. The database CHECK on the jsonb text is the 64 KiB
 * backstop; this tighter authoring limit leaves room for the rest of a
 * Flight Path inside the 64 KiB desired-state budget.
 */
export const MAX_RESTRICTION_RESOURCES_BYTES = 49_152;

export type RestrictionResourceErrorCode =
  | "RESOURCE_INPUT_INVALID"
  | "RESOURCE_URL_INVALID"
  | "RESOURCE_URL_UNSUPPORTED"
  | "RESOURCE_URL_TOO_BROAD"
  | "RESOURCE_SHORT_LINK_UNRESOLVED"
  | "RESOURCE_LIMIT_EXCEEDED"
  | "RESOURCE_RULE_BUDGET_EXCEEDED"
  | "RESOURCE_LIST_TOO_LARGE";

export class RestrictionResourceError extends Error {
  readonly status = 400;
  readonly expose = true;
  readonly code: RestrictionResourceErrorCode;
  /** Position of the offending entry in the submitted list, when known. */
  readonly index?: number;

  constructor(code: RestrictionResourceErrorCode, message: string, index?: number) {
    super(message);
    this.name = "RestrictionResourceError";
    this.code = code;
    if (index !== undefined) this.index = index;
  }
}

function resourceError(code: RestrictionResourceErrorCode, message: string): never {
  throw new RestrictionResourceError(code, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

// ---------------------------------------------------------------------------
// Hostnames
// ---------------------------------------------------------------------------

const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The host form every matcher compares: lower case, one trailing "." and one
 * leading "www." removed. `new URL()` has already lower-cased and punycoded it.
 */
export function restrictionMatchHostname(hostname: string): string {
  let host = hostname.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.startsWith("www.")) host = host.slice(4);
  return host;
}

/**
 * Restriction-specific hostname canonicalizer. Unlike the SSO policy's private
 * canonicalizer it accepts Google product hosts (docs, drive, classroom) and
 * internationalized names, but it still rejects IP addresses, single labels
 * and public suffixes (tldts, private suffixes included). Server-only: the
 * extension receives hostnames already in this form.
 */
export function canonicalRestrictionHostname(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.length > 253 || /[\s/?#@:\\*[\]%]/.test(raw)) return null;
  let ascii: string;
  try {
    ascii = new URL(`https://${raw}`).hostname;
  } catch {
    return null;
  }
  const host = restrictionMatchHostname(ascii);
  if (!host || host.length > 253) return null;
  const labels = host.split(".");
  if (labels.length < 2 || labels.some((label) => !HOSTNAME_LABEL.test(label))) return null;
  if (/^[0-9]+$/.test(labels[labels.length - 1]!)) return null;
  const parsed = parseDomain(host, { allowPrivateDomains: true });
  if (parsed.isIp || !parsed.domain || !parsed.publicSuffix || parsed.publicSuffix === host) return null;
  return host;
}

// ---------------------------------------------------------------------------
// Provider identity
// ---------------------------------------------------------------------------

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const GOOGLE_FILE_ID = /^[A-Za-z0-9_-]{20,128}$/;
const YOUTUBE_HOSTS = new Set(["youtube.com", "m.youtube.com", "youtube-nocookie.com"]);
const YOUTUBE_SHORT_HOST = "youtu.be";
const DOCS_HOST = "docs.google.com";
const DRIVE_HOST = "drive.google.com";
const CLASSROOM_HOST = "classroom.google.com";
const FORMS_SHORT_LINK_HOST = "forms.gle";
/**
 * A path tail below a section prefix or after a provider resource id. It may
 * not hide a separator or a dot segment from the WHATWG parser: servers such
 * as nginx decode `%2F` before resolving `..`; Tomcat, Spring and Jetty treat
 * `..;` as `..`; some decode overlong UTF-8 (`%C0%AE`) or fold fullwidth forms
 * (`%EF%BC%8E`) into `.`, `/` and `\`. So `;` is refused, and so is every
 * escape except ordinary ones: `%2E`, `%2F`, `%25`, `%5C`, `%C0`, `%C1`, `%E0`
 * followed by `%80`-`%9F`, `%EF%BC%8E`, `%EF%BC%8F`, `%EF%BC%BC` (any case)
 * and a `%` that does not start a two-digit escape. The text is RE2-compatible:
 * the contract's DNR shapes use it verbatim, so the browser layer and this
 * matcher agree byte for byte.
 */
export const RESTRICTION_PATH_TAIL_PATTERN =
  "(?:/(?:[^?#%;]|%(?:[013-46-9abdfABDF][0-9a-fA-F]|2[0-46-9a-dA-D]|5[0-9abd-fABD-F]|[Cc][2-9a-fA-F]"
  + "|[Ee][1-9a-eA-E]|[Ee]0%[AaBb][0-9a-fA-F]|[Ee][Ff]%(?:[0-9ac-fAC-F][0-9a-fA-F]|[Bb][0-9abd-fABD-F]"
  + "|[Bb][Cc]%(?:[0-79ac-fAC-F][0-9a-fA-F]|8[0-9a-dA-D]|[Bb][0-9abd-fABD-F]))))*)?";
const RESTRICTION_PATH_TAIL = new RegExp(`^${RESTRICTION_PATH_TAIL_PATTERN}$`);

function safePathTail(tail: string | undefined): boolean {
  return RESTRICTION_PATH_TAIL.test(tail ?? "");
}

// Page paths: moving to another video changes the page URL, which the
// extension's navigation and SPA listeners re-check.
const YOUTUBE_PAGE_PATH = /^\/(?:shorts|live)\/([A-Za-z0-9_-]{11})(\/.*)?$/;
// Player paths: an embedded player can move through other videos without
// changing its URL, so only exactly `/embed/<id>` or `/v/<id>` with harmless
// player parameters identifies one video (see YOUTUBE_PLAYER_PARAMETERS).
const YOUTUBE_PLAYER_PATH = /^\/(?:embed|v)\/([A-Za-z0-9_-]{11})\/?$/;
const YOUTU_BE_PATH = /^\/([A-Za-z0-9_-]{11})\/?$/;
/**
 * The only query parameters an embedded player link may carry and still
 * identify one video. `list`, `playlist` and `listType` (and anything else)
 * are refused: they let the player continue into other videos.
 */
export const YOUTUBE_PLAYER_PARAMETERS: readonly string[] = [
  "autoplay", "cc_lang_pref", "cc_load_policy", "color", "controls", "disablekb", "enablejsapi",
  "end", "feature", "fs", "hl", "iv_load_policy", "loop", "modestbranding", "mute", "origin",
  "playsinline", "rel", "si", "start", "t", "widget_referrer",
];
const YOUTUBE_PLAYER_PARAMETER_SET = new Set(YOUTUBE_PLAYER_PARAMETERS);
/**
 * The raw value of an allowlisted player parameter. `;`, `&`-smuggled or
 * encoded separators and any other punctuation are refused, so a value can
 * never carry a second parameter (`autoplay=1;playlist=A,B`).
 */
export const YOUTUBE_PLAYER_VALUE_PATTERN = "[A-Za-z0-9._:/-]*";
const YOUTUBE_PLAYER_VALUE = new RegExp(`^${YOUTUBE_PLAYER_VALUE_PATTERN}$`);
/** Eleven-character path words YouTube uses for playlists and channel streams, never videos. */
export const YOUTUBE_RESERVED_IDS: readonly string[] = ["videoseries", "live_stream"];
const YOUTUBE_RESERVED_ID_SET = new Set(YOUTUBE_RESERVED_IDS);
const DOCS_PATH =
  /^\/(?:u\/[0-9]{1,2}\/)?(document|presentation|spreadsheets|forms)\/(?:u\/[0-9]{1,2}\/)?d\/(e\/)?([A-Za-z0-9_-]{20,128})(\/.*)?$/;
const DRIVE_FILE_PATH = /^\/(?:u\/[0-9]{1,2}\/)?file\/(?:u\/[0-9]{1,2}\/)?d\/([A-Za-z0-9_-]{20,128})(\/.*)?$/;
const DRIVE_ID_PATH = /^\/(?:u\/[0-9]{1,2}\/)?(?:open|uc)$/;
const CLASSROOM_ACCOUNT_PREFIX = /^\/u\/[0-9]{1,2}(?=\/|$)/;
const CLASSROOM_COURSE_PATH = /^\/c\/([A-Za-z0-9_-]{1,128})(?:\/(a|m)\/([A-Za-z0-9_-]{1,128}))?(?:\/.*)?$/;

const DOCS_KIND_PROVIDER: Record<string, RestrictionResourceProvider> = {
  document: "google_docs",
  presentation: "google_slides",
  spreadsheets: "google_sheets",
  forms: "google_forms",
};

const PROVIDER_DOCS_KIND: Partial<Record<RestrictionResourceProvider, string>> = {
  google_docs: "document",
  google_slides: "presentation",
  google_sheets: "spreadsheets",
  google_forms: "forms",
};

/**
 * Provider families whose links must identify exactly one resource. Anything
 * else there (a home page, a search, a channel, music.youtube.com, a Drive
 * folder) is refused rather than turned into a section: a "/watch" section
 * would admit every video on that host.
 */
function isProviderFamilyHost(hostname: string): boolean {
  return hostname === "youtube.com"
    || hostname.endsWith(".youtube.com")
    || hostname === YOUTUBE_SHORT_HOST
    || hostname === "youtube-nocookie.com"
    || hostname.endsWith(".youtube-nocookie.com")
    || hostname === DOCS_HOST
    || hostname === DRIVE_HOST;
}

export function restrictionResourceProviderHostname(provider: RestrictionResourceProvider): string {
  if (provider === "youtube") return "youtube.com";
  if (provider === "google_drive") return DRIVE_HOST;
  return DOCS_HOST;
}

function youtubeVideoId(value: string | undefined): string | null {
  return typeof value === "string" && YOUTUBE_ID.test(value) && !YOUTUBE_RESERVED_ID_SET.has(value)
    ? value
    : null;
}

function validResourceId(provider: RestrictionResourceProvider, resourceId: unknown): resourceId is string {
  if (typeof resourceId !== "string") return false;
  if (provider === "youtube") return youtubeVideoId(resourceId) !== null;
  if (provider === "google_drive") return GOOGLE_FILE_ID.test(resourceId);
  const published = resourceId.startsWith("e/");
  return GOOGLE_FILE_ID.test(published ? resourceId.slice(2) : resourceId);
}

/**
 * The landing URL for a resource. Forms land on the respondent view; a
 * published ("e/") Doc, Slides or Sheet lands on its published page.
 */
export function canonicalRestrictionResourceUrl(
  provider: RestrictionResourceProvider,
  resourceId: string
): string {
  if (provider === "youtube") return `https://www.youtube.com/watch?v=${resourceId}`;
  if (provider === "google_drive") return `https://drive.google.com/file/d/${resourceId}/view`;
  const kind = PROVIDER_DOCS_KIND[provider]!;
  if (provider === "google_forms") return `https://docs.google.com/forms/d/${resourceId}/viewform`;
  if (resourceId.startsWith("e/")) {
    return `https://docs.google.com/${kind}/d/${resourceId}/${provider === "google_sheets" ? "pubhtml" : "pub"}`;
  }
  return `https://docs.google.com/${kind}/d/${resourceId}/edit`;
}

/** A URL the section and resource matchers may inspect: https, no credentials, default port. */
function parseHttpsUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.length > MAX_RESTRICTION_RESOURCE_URL_LENGTH * 4) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return null;
  return parsed;
}

/** Every raw `name[=value]` segment of a player link's query is allowlisted. */
function youtubePlayerQueryHarmless(search: string): boolean {
  if (search === "") return true;
  return search.slice(1).split("&").every((segment) => {
    if (segment === "") return true;
    const separator = segment.indexOf("=");
    const name = separator === -1 ? segment : segment.slice(0, separator);
    const value = separator === -1 ? "" : segment.slice(separator + 1);
    return YOUTUBE_PLAYER_PARAMETER_SET.has(name) && YOUTUBE_PLAYER_VALUE.test(value);
  });
}

function youtubeHostVideoId(parsed: URL): string | null {
  if (parsed.pathname === "/watch") {
    // Exactly one decoded "v" parameter: an ambiguous query never matches.
    const ids = parsed.searchParams.getAll("v");
    return ids.length === 1 ? youtubeVideoId(ids[0]) : null;
  }
  const player = YOUTUBE_PLAYER_PATH.exec(parsed.pathname);
  if (player) return youtubePlayerQueryHarmless(parsed.search) ? youtubeVideoId(player[1]) : null;
  const page = YOUTUBE_PAGE_PATH.exec(parsed.pathname);
  return page && safePathTail(page[2]) ? youtubeVideoId(page[1]) : null;
}

function identityFromParsedUrl(parsed: URL): RestrictionResourceIdentity | null {
  const host = restrictionMatchHostname(parsed.hostname);
  if (YOUTUBE_HOSTS.has(host)) {
    const id = youtubeHostVideoId(parsed);
    return id ? { provider: "youtube", resourceId: id } : null;
  }
  if (host === YOUTUBE_SHORT_HOST) {
    const id = youtubeVideoId(YOUTU_BE_PATH.exec(parsed.pathname)?.[1]);
    return id ? { provider: "youtube", resourceId: id } : null;
  }
  if (host === DOCS_HOST) {
    const match = DOCS_PATH.exec(parsed.pathname);
    if (!match || !safePathTail(match[4])) return null;
    return {
      provider: DOCS_KIND_PROVIDER[match[1]!]!,
      resourceId: `${match[2] ?? ""}${match[3]!}`,
    };
  }
  if (host === DRIVE_HOST) {
    const file = DRIVE_FILE_PATH.exec(parsed.pathname);
    if (file) return safePathTail(file[2]) ? { provider: "google_drive", resourceId: file[1]! } : null;
    if (DRIVE_ID_PATH.test(parsed.pathname)) {
      const ids = parsed.searchParams.getAll("id");
      return ids.length === 1 && GOOGLE_FILE_ID.test(ids[0]!)
        ? { provider: "google_drive", resourceId: ids[0]! }
        : null;
    }
    return null;
  }
  return null;
}

/**
 * The provider resource a URL points at, or null. Only https URLs with no
 * credentials and the default port can identify a resource. Resource ids are
 * case-sensitive; Forms edit ids and published ("e/") ids are distinct.
 */
export function extractRestrictionResourceIdentity(url: unknown): RestrictionResourceIdentity | null {
  const parsed = parseHttpsUrl(url);
  return parsed ? identityFromParsedUrl(parsed) : null;
}

// ---------------------------------------------------------------------------
// Validation of stored and wire entries (strict, never throws)
// ---------------------------------------------------------------------------

function validSectionPathPrefix(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < 2 || value.length > MAX_SECTION_PATH_PREFIX_LENGTH) return false;
  if (!value.startsWith("/") || value.endsWith("/") || value.includes("//")) return false;
  if (/[?#\\\s]/.test(value)) return false;
  // The same tail rule the matcher applies below a prefix: a teacher-authored
  // prefix cannot carry `;`, an encoded separator or dot, or an unsafe escape.
  if (!RESTRICTION_PATH_TAIL.test(value)) return false;
  try {
    return new URL(`https://example.com${value}`).pathname === value;
  } catch {
    return false;
  }
}

/**
 * Re-validates one stored or received entry. Returns a fresh canonical copy,
 * or null when anything is out of contract (unknown keys, a non-canonical
 * hostname, a client-chosen canonical URL, a malformed id or path). Callers
 * must treat null as "withhold", never as "drop this entry".
 */
export function validateAllowedResource(value: unknown): AllowedResource | null {
  if (!isPlainObject(value)) return null;
  const hostname = canonicalRestrictionHostname(value.hostname);
  if (!hostname || hostname !== value.hostname) return null;
  if (value.type === "website") {
    if (!hasExactKeys(value, ["type", "hostname", "includeSubdomains"])) return null;
    if (value.includeSubdomains !== true) return null;
    return { type: "website", hostname, includeSubdomains: true };
  }
  if (value.type === "section") {
    if (!hasExactKeys(value, ["type", "hostname", "includeSubdomains", "pathPrefix"])) return null;
    if (value.includeSubdomains !== false || !validSectionPathPrefix(value.pathPrefix)) return null;
    return { type: "section", hostname, includeSubdomains: false, pathPrefix: value.pathPrefix };
  }
  if (value.type === "resource") {
    if (!hasExactKeys(value, [
      "type", "hostname", "includeSubdomains", "provider", "resourceId", "canonicalUrl",
    ])) return null;
    const provider = value.provider;
    if (
      value.includeSubdomains !== false
      || typeof provider !== "string"
      || !(RESTRICTION_RESOURCE_PROVIDERS as readonly string[]).includes(provider)
    ) return null;
    const typedProvider = provider as RestrictionResourceProvider;
    if (!validResourceId(typedProvider, value.resourceId)) return null;
    if (hostname !== restrictionResourceProviderHostname(typedProvider)) return null;
    const canonicalUrl = canonicalRestrictionResourceUrl(typedProvider, value.resourceId);
    if (value.canonicalUrl !== canonicalUrl) return null;
    return {
      type: "resource",
      hostname,
      includeSubdomains: false,
      provider: typedProvider,
      resourceId: value.resourceId,
      canonicalUrl,
    };
  }
  return null;
}

export function restrictionResourceIdentityKey(resource: AllowedResource): string {
  if (resource.type === "website") return `website:${resource.hostname}`;
  if (resource.type === "section") return `section:${resource.hostname}${resource.pathPrefix}`;
  return `resource:${resource.provider}:${resource.resourceId}`;
}

/** Classroom DNR rules one entry needs in ClassPilot 2.9.7 (websites share rule 1). */
export function restrictionResourceRuleCount(resource: AllowedResource): number {
  if (resource.type === "website") return 0;
  if (resource.type === "resource" && resource.provider === "youtube") return 2;
  return 1;
}

export function restrictionResourcesRuleCount(resources: readonly AllowedResource[]): number {
  return resources.reduce((sum, resource) => sum + restrictionResourceRuleCount(resource), 0);
}

function restrictionResourcesBytes(resources: readonly AllowedResource[]): number {
  return new TextEncoder().encode(JSON.stringify(resources)).length;
}

/**
 * Validates a whole stored or received list: an array of valid, distinct
 * entries within every limit. Returns canonical copies or null; one bad entry
 * invalidates the list (fail closed, never a partial list).
 */
export function validateAllowedResourceList(value: unknown): AllowedResource[] | null {
  if (!Array.isArray(value) || value.length > MAX_RESTRICTION_RESOURCES) return null;
  const seen = new Set<string>();
  const resources: AllowedResource[] = [];
  for (const entry of value) {
    const resource = validateAllowedResource(entry);
    if (!resource) return null;
    const key = restrictionResourceIdentityKey(resource);
    if (seen.has(key)) return null;
    seen.add(key);
    resources.push(resource);
  }
  if (restrictionResourcesRuleCount(resources) > RESTRICTION_RESOURCE_RULE_ID_BUDGET) return null;
  if (restrictionResourcesBytes(resources) > MAX_RESTRICTION_RESOURCES_BYTES) return null;
  return resources;
}

// ---------------------------------------------------------------------------
// Authoring (throws RestrictionResourceError with an HTTP 400 status)
// ---------------------------------------------------------------------------

function websiteResource(hostname: string): WebsiteAllowedResource {
  return { type: "website", hostname, includeSubdomains: true };
}

function sectionResource(hostname: string, pathPrefix: string): SectionAllowedResource {
  if (!validSectionPathPrefix(pathPrefix)) {
    resourceError(
      "RESOURCE_URL_INVALID",
      `Section paths must be a normal URL path of at most ${MAX_SECTION_PATH_PREFIX_LENGTH} characters, without ";" or encoded separators`
    );
  }
  return { type: "section", hostname, includeSubdomains: false, pathPrefix };
}

function resourceFromIdentity(identity: RestrictionResourceIdentity): ResourceAllowedResource {
  return {
    type: "resource",
    hostname: restrictionResourceProviderHostname(identity.provider),
    includeSubdomains: false,
    provider: identity.provider,
    resourceId: identity.resourceId,
    canonicalUrl: canonicalRestrictionResourceUrl(identity.provider, identity.resourceId),
  };
}

function trimmedPathPrefix(pathname: string): string | null {
  let path = pathname;
  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path === "/" || path === "" ? null : path;
}

function requireHttps(parsed: URL, kind: "Section" | "Resource"): void {
  if (parsed.protocol !== "https:") {
    resourceError("RESOURCE_URL_INVALID", `${kind} links must use https://`);
  }
}

function classroomResource(parsed: URL): AllowedResource {
  // Classroom account switching (/u/N) is dropped so the section covers the
  // course for whichever account the student is signed in with at index 0.
  const withoutAccount = parsed.pathname.replace(CLASSROOM_ACCOUNT_PREFIX, "") || "/";
  const course = CLASSROOM_COURSE_PATH.exec(withoutAccount);
  const pathPrefix = course
    ? `/c/${course[1]}${course[2] ? `/${course[2]}/${course[3]}` : ""}`
    : trimmedPathPrefix(withoutAccount);
  if (!pathPrefix) return websiteResource(CLASSROOM_HOST);
  requireHttps(parsed, "Section");
  return sectionResource(CLASSROOM_HOST, pathPrefix);
}

function resourceFromUrl(value: unknown): AllowedResource {
  if (typeof value !== "string") resourceError("RESOURCE_URL_INVALID", "Resource url must be a string");
  const raw = value.trim();
  if (!raw || raw.length > MAX_RESTRICTION_RESOURCE_URL_LENGTH) {
    resourceError("RESOURCE_URL_INVALID", `Resource url must be 1 to ${MAX_RESTRICTION_RESOURCE_URL_LENGTH} characters`);
  }
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return resourceError("RESOURCE_URL_INVALID", "Resource url must be a valid web link");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    resourceError("RESOURCE_URL_INVALID", "Resource url must be an https:// link");
  }
  if (parsed.username || parsed.password) resourceError("RESOURCE_URL_INVALID", "Resource url cannot include credentials");
  if (parsed.port) resourceError("RESOURCE_URL_INVALID", "Resource url cannot include a port");
  const hostname = canonicalRestrictionHostname(parsed.hostname);
  if (!hostname) resourceError("RESOURCE_URL_INVALID", "Resource url must use a public website name");
  if (hostname === FORMS_SHORT_LINK_HOST) {
    resourceError("RESOURCE_SHORT_LINK_UNRESOLVED", "Use the full Google Form link (docs.google.com/forms/...)");
  }
  if (isProviderFamilyHost(hostname)) {
    const identity = identityFromParsedUrl(parsed);
    if (!identity) {
      resourceError(
        "RESOURCE_URL_UNSUPPORTED",
        "Use a link to one YouTube video, Google Doc, Slides, Sheet, Form or Drive file"
      );
    }
    requireHttps(parsed, "Resource");
    return resourceFromIdentity(identity);
  }
  if (hostname === CLASSROOM_HOST) return classroomResource(parsed);
  const pathPrefix = trimmedPathPrefix(parsed.pathname);
  if (!pathPrefix) return websiteResource(hostname);
  requireHttps(parsed, "Section");
  if (parsed.search) {
    // A section is a path and ignores the query. Turning a query-identified
    // page into its path would silently admit every page at that path.
    resourceError(
      "RESOURCE_URL_UNSUPPORTED",
      "Links that depend on a ?query can't be limited precisely; remove the query to allow this page and everything under it, or use Entire website"
    );
  }
  return sectionResource(hostname, pathPrefix);
}

/**
 * Normalizes one authoring input. `{url}` becomes a resource (YouTube, Docs,
 * Slides, Sheets, Forms, Drive), a section (any other page path, including a
 * Google Classroom course or post) or a website (a bare site). `{type:
 * "website", hostname}` becomes a website. Any other shape, including
 * client-supplied provider, resourceId, canonicalUrl, pathPrefix or
 * includeSubdomains, is rejected. forms.gle short links must be resolved by
 * restrictionResourceResolver.ts before this runs.
 */
export function normalizeAllowedResource(input: unknown): AllowedResource {
  if (!isPlainObject(input)) {
    resourceError("RESOURCE_INPUT_INVALID", "Each resource must be {url} or {type: \"website\", hostname}");
  }
  if (hasExactKeys(input, ["url"])) return resourceFromUrl(input.url);
  if (hasExactKeys(input, ["type", "hostname"]) && input.type === "website") {
    const hostname = canonicalRestrictionHostname(input.hostname);
    if (!hostname) resourceError("RESOURCE_URL_INVALID", "Website hostname must be a public website name");
    return websiteResource(hostname);
  }
  return resourceError(
    "RESOURCE_INPUT_INVALID",
    "Each resource must be {url} or {type: \"website\", hostname}; provider, resource ids and canonical URLs are computed by the server"
  );
}

export function assertRestrictionResourceLimits(resources: readonly AllowedResource[]): void {
  // The rule-id budget is checked first: it is the extension's hard limit and
  // stays meaningful if a provider ever needs more rules per entry.
  if (restrictionResourcesRuleCount(resources) > RESTRICTION_RESOURCE_RULE_ID_BUDGET) {
    resourceError(
      "RESOURCE_RULE_BUDGET_EXCEEDED",
      `These resources need more than ${RESTRICTION_RESOURCE_RULE_ID_BUDGET} browser rules; remove some videos or pages`
    );
  }
  if (resources.length > MAX_RESTRICTION_RESOURCES) {
    resourceError("RESOURCE_LIMIT_EXCEEDED", `A Flight Path can hold at most ${MAX_RESTRICTION_RESOURCES} resources`);
  }
  if (restrictionResourcesBytes(resources) > MAX_RESTRICTION_RESOURCES_BYTES) {
    resourceError("RESOURCE_LIST_TOO_LARGE", "These resources are too large to save; remove some entries");
  }
}

/**
 * Normalizes a submitted list: every entry through `normalizeAllowedResource`
 * (errors carry the entry index), duplicates collapsed in first-seen order,
 * then the entry, rule-id and size limits.
 */
export function normalizeAllowedResourceList(inputs: unknown): AllowedResource[] {
  if (!Array.isArray(inputs)) resourceError("RESOURCE_INPUT_INVALID", "resources must be an array");
  if (inputs.length > MAX_RESTRICTION_RESOURCES) {
    resourceError("RESOURCE_LIMIT_EXCEEDED", `A Flight Path can hold at most ${MAX_RESTRICTION_RESOURCES} resources`);
  }
  const seen = new Set<string>();
  const resources: AllowedResource[] = [];
  inputs.forEach((input, index) => {
    let resource: AllowedResource;
    try {
      resource = normalizeAllowedResource(input);
    } catch (error) {
      if (error instanceof RestrictionResourceError) {
        throw new RestrictionResourceError(error.code, `Resource ${index + 1}: ${error.message}`, index);
      }
      throw error;
    }
    const key = restrictionResourceIdentityKey(resource);
    if (seen.has(key)) return;
    seen.add(key);
    resources.push(resource);
  });
  assertRestrictionResourceLimits(resources);
  return resources;
}

/**
 * The single destination of a "This resource only" Waypoint: a resource or a
 * section. A bare website is refused because it is exactly the "Entire website"
 * boundary; the teacher must choose that explicitly.
 */
export function normalizePreciseWaypointResource(url: unknown): PreciseAllowedResource {
  const resource = normalizeAllowedResource({ url });
  if (resource.type === "website") {
    resourceError(
      "RESOURCE_URL_TOO_BROAD",
      "This resource only needs a link to one page, video or document; use Entire website for a whole site"
    );
  }
  return resource;
}

// ---------------------------------------------------------------------------
// Matching and projections
// ---------------------------------------------------------------------------

/**
 * Normative matcher. `website`: http(s), host equal to or below the hostname.
 * `section`: https, default port, the exact host, and the path equal to the
 * prefix or below it at a "/" boundary (case-sensitive; query and fragment
 * ignored), with the part below the prefix a safe path tail (see
 * RESTRICTION_PATH_TAIL_PATTERN). `resource`: the URL identifies the same
 * provider resource. Credentials, unparsable input and out-of-contract
 * entries are never allowed.
 */
export function isUrlAllowedByResource(url: unknown, resource: unknown): boolean {
  const entry = validateAllowedResource(resource);
  if (!entry || typeof url !== "string") return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  const host = restrictionMatchHostname(parsed.hostname);
  if (entry.type === "website") {
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    return host === entry.hostname || host.endsWith(`.${entry.hostname}`);
  }
  if (parsed.protocol !== "https:" || parsed.port) return false;
  if (entry.type === "section") {
    return host === entry.hostname
      && (parsed.pathname === entry.pathPrefix || parsed.pathname.startsWith(`${entry.pathPrefix}/`))
      && safePathTail(parsed.pathname.slice(entry.pathPrefix.length));
  }
  const identity = identityFromParsedUrl(parsed);
  return !!identity && identity.provider === entry.provider && identity.resourceId === entry.resourceId;
}

export function isUrlAllowedByResources(url: unknown, resources: readonly unknown[]): boolean {
  return resources.some((resource) => isUrlAllowedByResource(url, resource));
}

/** True when a list needs the precise capability: any section or resource. */
export function resourcesRequirePreciseCapability(resources: readonly AllowedResource[]): boolean {
  return resources.some((resource) => resource.type !== "website");
}

/**
 * The only part of a list ClassPilot 2.9.x may see: website hostnames, in
 * first-seen order. Section and resource hosts are never projected.
 */
export function legacyHostProjection(resources: readonly AllowedResource[]): string[] {
  return [...new Set(resources.flatMap((resource) => resource.type === "website" ? [resource.hostname] : []))];
}

export function preciseRestrictionResources(resources: readonly AllowedResource[]): PreciseAllowedResource[] {
  return resources.filter((resource): resource is PreciseAllowedResource => resource.type !== "website");
}

/** The landing target for an entry: canonical URL, section URL or site root. */
export function canonicalUrlForResource(resource: AllowedResource): string {
  if (resource.type === "resource") return resource.canonicalUrl;
  if (resource.type === "section") return `https://${resource.hostname}${resource.pathPrefix}`;
  return `https://${resource.hostname}`;
}

function wwwSectionUrl(resource: SectionAllowedResource): string {
  return `https://www.${resource.hostname}${resource.pathPrefix}`;
}

/**
 * The landing URL of a "This resource only" Waypoint. A section keeps the
 * `www.` host its teacher typed, because some sites answer only there; the
 * matcher treats both hosts alike. Everything else lands on its canonical URL.
 */
export function waypointLandingUrl(authoredUrl: unknown, resource: PreciseAllowedResource): string {
  if (resource.type !== "section" || typeof authoredUrl !== "string") return canonicalUrlForResource(resource);
  const raw = authoredUrl.trim();
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return canonicalUrlForResource(resource);
  }
  if (host.endsWith(".")) host = host.slice(0, -1);
  return host === `www.${resource.hostname}` ? wwwSectionUrl(resource) : canonicalUrlForResource(resource);
}

/** Whether `url` is a landing URL a Waypoint may carry for this resource. */
export function isWaypointLandingUrl(url: unknown, resource: PreciseAllowedResource): boolean {
  return url === canonicalUrlForResource(resource)
    || (resource.type === "section" && url === wwwSectionUrl(resource));
}
