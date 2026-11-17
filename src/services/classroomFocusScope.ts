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
// Google's published Search domain inventory, pinned 2026-11-16. Brand sites such
// as google.org/google.dev are not Search roots and must not be inferred from a TLD.
// Source: https://www.google.com/supported_domains
const GOOGLE_SEARCH_ROOTS = new Set(`
google.com google.ad google.ae google.com.af google.com.ag google.al google.am google.co.ao google.com.ar
google.as google.at google.com.au google.az google.ba google.com.bd google.be google.bf google.bg
google.com.bh google.bi google.bj google.com.bn google.com.bo google.com.br google.bs google.bt google.co.bw
google.by google.com.bz google.ca google.cd google.cf google.cg google.ch google.ci google.co.ck google.cl
google.cm google.cn google.com.co google.co.cr google.com.cu google.cv google.com.cy google.cz google.de
google.dj google.dk google.dm google.com.do google.dz google.com.ec google.ee google.com.eg google.es
google.com.et google.fi google.com.fj google.fm google.fr google.ga google.ge google.gg google.com.gh
google.com.gi google.gl google.gm google.gr google.com.gt google.gy google.com.hk google.hn google.hr
google.ht google.hu google.co.id google.ie google.co.il google.im google.co.in google.iq google.is google.it
google.je google.com.jm google.jo google.co.jp google.co.ke google.com.kh google.ki google.kg google.co.kr
google.com.kw google.kz google.la google.com.lb google.li google.lk google.co.ls google.lt google.lu google.lv
google.com.ly google.co.ma google.md google.me google.mg google.mk google.ml google.com.mm google.mn
google.com.mt google.mu google.mv google.mw google.com.mx google.com.my google.co.mz google.com.na
google.com.ng google.com.ni google.ne google.nl google.no google.com.np google.nr google.nu google.co.nz
google.com.om google.com.pa google.com.pe google.com.pg google.com.ph google.com.pk google.pl google.pn
google.com.pr google.ps google.pt google.com.py google.com.qa google.ro google.ru google.rw google.com.sa
google.com.sb google.sc google.se google.com.sg google.sh google.si google.sk google.com.sl google.sn
google.so google.sm google.sr google.st google.com.sv google.td google.tg google.co.th google.com.tj google.tl
google.tm google.tn google.to google.com.tr google.tt google.com.tw google.co.tz google.com.ua google.co.ug
google.co.uk google.com.uy google.co.uz google.com.vc google.co.ve google.co.vi google.com.vn google.vu
google.ws google.rs google.co.za google.co.zm google.co.zw google.cat
`.trim().split(/\s+/));
/** Published Google Search roots and explicit Search aliases cannot be assignment website grants. */
export function isGoogleSearchHostname(hostname: string): boolean {
  const host = hostname.replace(/^www\./, "");
  return GOOGLE_SEARCH_ROOTS.has(host)
    || ["images", "image", "video", "videos", "search", "encrypted"].some(alias =>
      host.startsWith(`${alias}.`) && GOOGLE_SEARCH_ROOTS.has(host.slice(alias.length + 1)));
}

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
        || isGoogleSearchHostname(raw) || FORBIDDEN_DOMAIN_ROOTS.some(root => raw === root || raw.endsWith(`.${root}`))) return null;
      domains.push(raw);
    }
    if (!CLASSROOM_FOCUS_BASE_DOMAINS.every(host => domains.includes(host))) return null;
    const resources: PreciseAllowedResource[] = [];
    const identities = new Set<string>();
    for (const raw of scope.resources) {
      const resource = validateAllowedResource(raw);
      if (!resource || resource.type === "website" || isGoogleSearchHostname(resource.hostname)
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
