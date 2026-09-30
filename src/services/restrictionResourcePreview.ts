import { z } from "zod";
import {
  classroomImportLinkUrls,
  classroomImportResourceEntries,
  normalizeFlightPathResourcesInput,
  requirePreciseRestrictionResourcesActive,
} from "./classpilotPreciseRestrictions.js";
import { validateClasspilotCommandPayload } from "./classpilotCommandValidation.js";
import { resolveRestrictionResourceInputs, type ShortLinkFetch } from "./restrictionResourceResolver.js";
import { canonicalUrlForResource, RestrictionResourceError, type PreciseAllowedResource } from "./restrictionResources.js";

const link = z.string().trim().min(1).max(4_096);
const requestSchema = z.discriminatedUnion("purpose", [
  z.object({
    purpose: z.literal("flight_path"),
    allowedDomains: z.array(link).max(1_000).default([]),
    resources: z.array(z.unknown()).max(200).default([]),
  }).strict(),
  z.object({ purpose: z.literal("waypoint"), url: link, boundary: z.enum(["website", "resource"]) }).strict(),
  z.object({
    purpose: z.literal("classroom"),
    boundary: z.enum(["website", "resource"]),
    resources: z.array(z.object({
      id: z.string().trim().min(1).max(128),
      links: z.array(z.object({ url: link }).strict()).max(1_000),
    }).strict()).max(200).default([]),
    selectedResourceIds: z.array(z.string().trim().min(1).max(128)).max(200).optional(),
    resourceLinks: z.array(link).max(1_000).default([]),
  }).strict(),
]);

export type RestrictionScopePreview = {
  type: "website" | "section" | "resource";
  hostname: string;
  url: string;
  label: string;
  description: string;
};

export type RestrictionResourcePreview = {
  schemaVersion: 1;
  purpose: "flight_path" | "waypoint" | "classroom";
  boundary?: "website" | "resource";
  scopes: RestrictionScopePreview[];
  warnings: Array<{ code: "BROADER_WEBSITE"; hostname: string; message: string }>;
  skipped: Array<{ url: string; code: string }>;
  /** Canonical authoring inputs, not a command or client-supplied wire resource. */
  authoring: { allowedDomains: string[]; resources: Array<{ url: string }>; resourceLinks?: string[]; url?: string };
};

const providerLabels = {
  youtube: "YouTube video", google_docs: "Google Doc", google_slides: "Google Slides",
  google_sheets: "Google Sheet", google_forms: "Google Form", google_drive: "Drive file",
} as const;

/** The legacy extension's host normalization, with invalid inputs made visible. */
function websiteHostname(value: string): string {
  try {
    const raw = value.trim().toLowerCase();
    const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) throw new Error();
    const host = parsed.hostname.replace(/^www\./, "").replace(/\.$/, "");
    if (!host || host.length > 253) throw new Error();
    return host;
  } catch {
    throw new RestrictionResourceError("RESOURCE_URL_INVALID", "Enter a valid website hostname or HTTP(S) link without credentials");
  }
}

function buildPreview(
  purpose: RestrictionResourcePreview["purpose"], hosts: string[], resources: PreciseAllowedResource[],
): RestrictionResourcePreview {
  const allowedDomains = [...new Set(hosts.map(websiteHostname))];
  const scopes: RestrictionScopePreview[] = allowedDomains.map(hostname => ({
    type: "website", hostname, url: `https://${hostname}`, label: "Entire website",
    description: `Every page on ${hostname} and its subdomains is allowed.`,
  }));
  for (const resource of resources) scopes.push({
    type: resource.type, hostname: resource.hostname, url: canonicalUrlForResource(resource),
    label: resource.type === "section" ? "Section" : providerLabels[resource.provider],
    description: resource.type === "section"
      ? `${resource.hostname}${resource.pathPrefix} and paths below that section; other sections and subdomains are excluded.`
      : `Only this ${providerLabels[resource.provider].toLowerCase()} is allowed.`,
  });
  const warnings = allowedDomains.map(hostname => {
    const overlaps = resources.some(resource => {
      const family = resource.type === "resource" && resource.provider === "youtube"
        ? ["youtube.com", "m.youtube.com", "youtube-nocookie.com", "youtu.be"] : [resource.hostname];
      return family.some(host => host === hostname || host.endsWith(`.${hostname}`));
    });
    return {
      code: "BROADER_WEBSITE" as const, hostname,
      message: overlaps
        ? `${hostname} also allows other pages or items on that website. Specific entries alongside it do not narrow that broader access.`
        : `${hostname} allows the entire website and its subdomains, rather than one section or item.`,
    };
  });
  return {
    schemaVersion: 1, purpose, scopes, warnings, skipped: [],
    authoring: { allowedDomains, resources: resources.map(resource => ({ url: canonicalUrlForResource(resource) })) },
  };
}

/** Read-only, tenant-authorized route helper. Uses the same save/command normalizers. */
export async function previewRestrictionResources(
  schoolId: string, body: unknown, options: { env?: NodeJS.ProcessEnv; fetch?: ShortLinkFetch } = {},
): Promise<RestrictionResourcePreview> {
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    throw Object.assign(new Error("Scope preview request is invalid"), { status: 400, code: "RESOURCE_PREVIEW_INVALID", expose: true });
  }
  const input = parsed.data;
  if (input.purpose === "flight_path") {
    const normalized = await normalizeFlightPathResourcesInput(input.resources, schoolId, options);
    return buildPreview(input.purpose, [...input.allowedDomains, ...normalized.websiteHosts], normalized.resources);
  }
  if (input.purpose === "waypoint") {
    if (input.url === "CURRENT_URL") {
      throw new RestrictionResourceError("RESOURCE_INPUT_INVALID", "Choose a specific link to preview its normalized scope");
    }
    let url = input.url;
    if (input.boundary === "resource") {
      requirePreciseRestrictionResourcesActive(schoolId, options.env);
      const resolved = await resolveRestrictionResourceInputs([{ url }], options);
      if (!Array.isArray(resolved)) throw new RestrictionResourceError("RESOURCE_INPUT_INVALID", "Link resolution failed");
      url = z.object({ url: link }).strict().parse(resolved[0]).url;
    }
    const command = validateClasspilotCommandPayload("lock-screen", { url, boundary: input.boundary });
    const resource = command.resource as PreciseAllowedResource | undefined;
    const preview = buildPreview(input.purpose, resource ? [] : [String(command.url)], resource ? [resource] : []);
    preview.boundary = input.boundary;
    preview.authoring.url = String(command.url);
    preview.scopes[0]!.url = String(command.url);
    return preview;
  }
  const selected = input.selectedResourceIds ? new Set(input.selectedResourceIds) : null;
  const resources = selected ? input.resources.filter(resource => selected.has(resource.id)) : input.resources;
  if (selected && [...selected].some(id => !resources.some(resource => resource.id === id))) {
    throw new RestrictionResourceError("RESOURCE_INPUT_INVALID", "Every selected Classroom item must be included");
  }
  const urls = classroomImportLinkUrls(resources, input.resourceLinks);
  let preview: RestrictionResourcePreview;
  if (input.boundary === "resource") {
    requirePreciseRestrictionResourcesActive(schoolId, options.env);
    const normalized = await classroomImportResourceEntries(urls, options);
    preview = buildPreview(input.purpose, normalized.websiteHosts, normalized.resources);
    preview.skipped = normalized.skipped;
  } else {
    const hosts: string[] = [], skipped: RestrictionResourcePreview["skipped"] = [];
    for (const url of urls) {
      try { hosts.push(websiteHostname(url)); }
      catch { skipped.push({ url, code: "RESOURCE_URL_INVALID" }); }
    }
    preview = buildPreview(input.purpose, hosts, []);
    preview.skipped = skipped;
  }
  preview.boundary = input.boundary;
  preview.authoring.resourceLinks = preview.scopes.map(scope => scope.url);
  return preview;
}
