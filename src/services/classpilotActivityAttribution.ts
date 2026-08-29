export const CLASSPILOT_ACTIVITY_KINDS = [
  "domain",
  "google_docs",
  "google_slides",
  "google_forms",
  "google_sheets",
  "google_classroom",
  "google_drive",
  "google_workspace_unspecified",
] as const;

export type ClasspilotActivityKind = typeof CLASSPILOT_ACTIVITY_KINDS[number];

export type ClasspilotActivity = {
  kind: ClasspilotActivityKind;
  domain: string;
};

export type ClasspilotTopActivity = ClasspilotActivity & {
  seconds: number;
  visits: number;
};

const GOOGLE_APP_HOST_ALIASES: Readonly<Record<string, ClasspilotActivityKind>> = {
  "slides.google.com": "google_slides",
  "forms.google.com": "google_forms",
  "sheets.google.com": "google_sheets",
  "spreadsheets.google.com": "google_sheets",
  "classroom.google.com": "google_classroom",
  "drive.google.com": "google_drive",
};

const GOOGLE_DOCS_PATH_KINDS: Readonly<Record<string, ClasspilotActivityKind>> = {
  document: "google_docs",
  presentation: "google_slides",
  forms: "google_forms",
  spreadsheets: "google_sheets",
};

/**
 * Reduce a heartbeat URL to the privacy-safe activity dimension used in
 * analytics. The result can never contain a path, document identifier, query,
 * fragment, title, or full URL.
 */
export function classifyClasspilotActivity(
  value: string | null | undefined
): ClasspilotActivity | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return null;
    const domain = url.hostname.toLowerCase().replace(/^www\./, "");
    if (!domain) return null;

    if (domain === "docs.google.com") {
      const firstPathSegment = url.pathname.split("/").find(Boolean);
      return {
        kind: firstPathSegment
          ? GOOGLE_DOCS_PATH_KINDS[firstPathSegment] || "google_workspace_unspecified"
          : "google_workspace_unspecified",
        domain,
      };
    }

    return {
      kind: GOOGLE_APP_HOST_ALIASES[domain] || "domain",
      domain,
    };
  } catch {
    return null;
  }
}

export function classpilotActivityKey(activity: ClasspilotActivity): string {
  return `${activity.kind}\u0000${activity.domain}`;
}
