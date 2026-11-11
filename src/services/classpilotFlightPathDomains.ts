const GOOGLE_CLASSROOM_WORK_DOMAINS = [
  "docs.google.com", "drive.google.com", "sheets.google.com",
  "slides.google.com", "forms.google.com", "forms.gle",
] as const;

function websiteHost(value: string): string | null {
  try {
    const raw = value.trim();
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    return url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  } catch {
    return null;
  }
}

/** Apply-time website projection only; never mutate saved selections or precise resources. */
export function effectiveFlightPathAllowedDomains(domains: readonly string[] | null | undefined): string[] {
  const result = [...(domains ?? [])];
  const hosts = new Set(result.map(websiteHost));
  if (!hosts.has("classroom.google.com")) return result;
  for (const host of GOOGLE_CLASSROOM_WORK_DOMAINS) {
    if (!hosts.has(host)) {
      result.push(host);
      hosts.add(host);
    }
  }
  return result;
}
