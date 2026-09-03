export const CLASSPILOT_ACTIVITY_KINDS = [
  "domain",
  "google_docs",
  "google_slides",
  "google_forms",
  "google_sheets",
  "google_classroom",
  "google_drive",
  "google_search",
  "google_mail",
  "google_meet",
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
  "mail.google.com": "google_mail",
  "meet.google.com": "google_meet",
};

const GOOGLE_DOCS_PATH_KINDS: Readonly<Record<string, ClasspilotActivityKind>> = {
  document: "google_docs",
  presentation: "google_slides",
  forms: "google_forms",
  spreadsheets: "google_sheets",
};

/**
 * Search shares google.com with every other destination on that host, so the
 * app is resolved from the first path segment. An unrecognized segment stays an
 * ordinary `domain` activity rather than being claimed as Search -- naming the
 * wrong app is worse than naming none.
 */
const GOOGLE_SEARCH_PATH_KINDS: Readonly<Record<string, ClasspilotActivityKind>> = {
  search: "google_search",
  imghp: "google_search",
  imgres: "google_search",
};

/**
 * Human-readable label for each activity kind, shared by the Student Data UI
 * and the session summary email so both name an app the same way.
 *
 * `domain` deliberately has no entry: a plain website renders as its own
 * hostname, and `classpilotActivityLabel` depends on that omission. Keep this
 * in step with STUDENT_DATA_ACTIVITY_LABELS in
 * schoolpilot-app/src/products/classpilot/lib/studentData.js -- the parity is
 * enforced by tests/classpilot-activity-attribution.test.ts.
 */
export const CLASSPILOT_ACTIVITY_LABELS: Readonly<
  Partial<Record<ClasspilotActivityKind, string>>
> = {
  google_docs: "Google Docs",
  google_slides: "Google Slides",
  google_forms: "Google Forms",
  google_sheets: "Google Sheets",
  google_classroom: "Google Classroom",
  google_drive: "Google Drive",
  google_search: "Google Search",
  google_mail: "Gmail",
  google_meet: "Google Meet",
  google_workspace_unspecified: "Google Workspace (app unavailable)",
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

    if (domain === "google.com") {
      const firstPathSegment = url.pathname.split("/").find(Boolean);
      return {
        // A bare google.com load is the search page itself.
        kind: firstPathSegment
          ? GOOGLE_SEARCH_PATH_KINDS[firstPathSegment] || "domain"
          : "google_search",
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

/**
 * Resolve an activity to the string a teacher reads. Falls back to the bare
 * hostname so an unmapped kind never renders as a raw enum value.
 */
export function classpilotActivityLabel(activity: ClasspilotActivity): string {
  if (activity.kind === "domain") return activity.domain;
  return CLASSPILOT_ACTIVITY_LABELS[activity.kind] || activity.domain || "Website";
}
