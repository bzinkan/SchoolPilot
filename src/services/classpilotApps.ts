import { z } from "zod";
import { canonicalRestrictionHostname } from "./restrictionResources.js";
import { effectiveFlightPathAllowedDomains } from "./classpilotFlightPathDomains.js";

export type AppButtonActor = { teacherId: string; isAdmin: boolean };
export type AppButtonView = {
  key: string;
  kind: "app" | "bundle";
  source: "common" | "personal" | "school";
  name: string;
  launchUrl: string | null;
  allowedDomains: string[];
  effectiveAllowedDomains?: string[];
  iconKey: string;
  saved: boolean;
  favorite: boolean;
  canEdit: boolean;
  revision: number;
  includedApps?: string[];
};

type CommonApp = Omit<AppButtonView, "saved" | "favorite" | "canEdit" | "revision">;
const classroomDomains = effectiveFlightPathAllowedDomains(["classroom.google.com"]);
const googleProduct = (slug: string, name: string, path: string): CommonApp => ({
  key: `builtin:${slug}`, kind: "app", source: "common", name,
  launchUrl: `https://docs.google.com/${path}/`, allowedDomains: ["docs.google.com"], iconKey: slug,
});

/** Launch shortcuts and website-level scopes; never interpret a name as a filter. */
export const commonClasspilotApps: readonly CommonApp[] = [
  { key: "builtin:classroom", kind: "app", source: "common", name: "Google Classroom", launchUrl: "https://classroom.google.com/", allowedDomains: ["classroom.google.com"], effectiveAllowedDomains: classroomDomains, iconKey: "classroom" },
  { key: "builtin:classroom-bundle", kind: "bundle", source: "common", name: "Google Classroom bundle", launchUrl: null,
    allowedDomains: classroomDomains, iconKey: "classroom",
    includedApps: ["Google Classroom", "Google Docs", "Google Slides", "Google Sheets", "Google Forms", "Google Drive"] },
  googleProduct("docs", "Google Docs", "document"),
  googleProduct("slides", "Google Slides", "presentation"),
  googleProduct("sheets", "Google Sheets", "spreadsheets"),
  googleProduct("forms", "Google Forms", "forms"),
  { key: "builtin:drive", kind: "app", source: "common", name: "Google Drive", launchUrl: "https://drive.google.com/", allowedDomains: ["drive.google.com"], iconKey: "drive" },
  { key: "builtin:ixl", kind: "app", source: "common", name: "IXL", launchUrl: "https://www.ixl.com/", allowedDomains: ["ixl.com"], iconKey: "ixl" },
  { key: "builtin:quill", kind: "app", source: "common", name: "Quill", launchUrl: "https://www.quill.org/", allowedDomains: ["quill.org"], iconKey: "quill" },
];

const name = z.string().trim().min(1).max(120);
const launchUrl = z.string().trim().min(1).max(4_096);
export const appButtonInput = z.object({ scope: z.enum(["personal", "school"]), name, launchUrl }).strict();
const expectedRevision = z.number().int().positive();
export const appButtonEditInput = z.object({ name, launchUrl, expectedRevision }).strict();
export const appButtonDeleteInput = z.object({ expectedRevision }).strict();
export const appButtonPreferenceInput = z.object({ saved: z.boolean(), favorite: z.boolean() }).strict()
  .refine(input => !input.favorite || input.saved, "Favorites must be saved to My Apps");

/** No network access: the launch path stays intact; only its host grants website access. */
export function normalizeAppWebsite(value: string): { launchUrl: string; allowedDomains: string[] } {
  const raw = launchUrl.parse(value);
  // A colon is allowed only as part of an explicit HTTP(S) scheme or host port.
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(raw) && !/^[^/?#]+:\d+(?:[/?#]|$)/.test(raw)
    ? raw : `https://${raw}`;
  let url: URL;
  try { url = new URL(candidate); } catch { throw new z.ZodError([{ code: "custom", path: ["launchUrl"], message: "Enter a valid HTTP or HTTPS website address" }]); }
  const hostname = canonicalRestrictionHostname(url.hostname);
  if (!hostname || !["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new z.ZodError([{ code: "custom", path: ["launchUrl"], message: "Enter a public HTTP or HTTPS website address without credentials" }]);
  }
  return { launchUrl: launchUrl.parse(url.href), allowedDomains: [hostname] };
}

type CustomButton = { id: string; schoolId: string; ownerTeacherId: string | null; scope: "personal" | "school"; name: string; launchUrl: string; revision: number };
type Preference = { saved: boolean; favorite: boolean };
export function appButtonView(button: CustomButton, preference: Preference | null | undefined, actor: AppButtonActor): AppButtonView {
  const website = normalizeAppWebsite(button.launchUrl);
  const effective = effectiveFlightPathAllowedDomains(website.allowedDomains);
  return {
    key: `saved:${button.id}`, kind: "app", source: button.scope, name: button.name,
    ...website, ...(effective.length > website.allowedDomains.length ? { effectiveAllowedDomains: effective } : {}), iconKey: "website",
    saved: preference?.saved ?? false, favorite: preference?.favorite ?? false,
    canEdit: button.scope === "school" ? actor.isAdmin : button.ownerTeacherId === actor.teacherId,
    revision: button.revision,
  };
}

export class AppButtonError extends Error {
  readonly expose = true;
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
