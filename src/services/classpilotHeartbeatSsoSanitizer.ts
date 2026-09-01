import type { ClasspilotSsoPolicy } from "./classpilotSsoPolicy.js";

export type ClasspilotHeartbeatNavigationProjection = {
  activeTabUrl: unknown;
  activeTabTitle: unknown;
  favicon: unknown;
  allOpenTabs?: unknown;
  authHostMatched: boolean;
};

const AUTH_CALLBACK_QUERY_KEYS = new Set([
  "access_token",
  "code",
  "id_token",
  "oauth_token",
  "samlresponse",
  "state",
  "token",
]);

function authCallbackTelemetryShouldBeRedacted(
  parsed: URL,
  restrictionAuthState: unknown,
  authRelevantRestrictionActive: boolean
): boolean {
  if (
    !authRelevantRestrictionActive
    && restrictionAuthState !== "in_progress"
    && restrictionAuthState !== "returning"
  ) {
    return false;
  }
  if (authRelevantRestrictionActive && (parsed.search || parsed.hash)) return true;
  if (parsed.hash) return true;
  return [...parsed.searchParams.keys()].some((key) =>
    AUTH_CALLBACK_QUERY_KEYS.has(key.trim().toLowerCase())
  );
}

function canonicalObservedHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.+$/, "");
}

function approvedAuthenticationHostname(
  hostname: string,
  policy: ClasspilotSsoPolicy
): boolean {
  const candidate = canonicalObservedHostname(hostname);
  if (!candidate) return false;
  return policy.profiles.some((profile) => profile.hostRules.some((rule) => {
    const approved = canonicalObservedHostname(rule.hostname);
    return candidate === approved
      || (rule.includeSubdomains && candidate.endsWith(`.${approved}`));
  }));
}

export function classpilotSsoPolicyApprovesObservedUrl(
  value: unknown,
  policy: ClasspilotSsoPolicy
): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && approvedAuthenticationHostname(parsed.hostname, policy);
  } catch {
    return false;
  }
}

/**
 * Remove authentication redirect paths, queries, fragments, titles, and
 * favicons before any heartbeat persistence, cache, realtime projection, or
 * classification. The projection is deliberately driven only by the
 * canonical school policy's configured provider hosts, independent of whether
 * delivery is enabled. Authorization remains gated elsewhere, but privacy
 * redaction cannot become weaker merely because the operator or school policy
 * is currently inert. Lookalikes and unrelated destinations remain ordinary
 * monitoring telemetry.
 */
export function sanitizeClasspilotHeartbeatNavigationForSso(options: {
  activeTabUrl: unknown;
  activeTabTitle: unknown;
  favicon: unknown;
  allOpenTabs?: unknown;
  policy: ClasspilotSsoPolicy;
  restrictionAuthState?: unknown;
  authRelevantRestrictionActive?: boolean;
}): ClasspilotHeartbeatNavigationProjection {
  const sanitizedTabs = Array.isArray(options.allOpenTabs)
    ? options.allOpenTabs.map((tab) => {
        if (!tab || typeof tab !== "object" || Array.isArray(tab)) return tab;
        const source = tab as Record<string, unknown>;
        const sanitized = sanitizeClasspilotHeartbeatNavigationForSso({
          activeTabUrl: source.url,
          activeTabTitle: source.title,
          favicon: source.favicon,
          policy: options.policy,
          restrictionAuthState: options.restrictionAuthState,
          authRelevantRestrictionActive: options.authRelevantRestrictionActive,
        });
        return sanitized.authHostMatched
          ? {
              ...source,
              url: sanitized.activeTabUrl,
              title: sanitized.activeTabTitle,
              favicon: sanitized.favicon,
            }
          : tab;
      })
    : options.allOpenTabs;
  const base = {
    ...(options.allOpenTabs !== undefined ? { allOpenTabs: sanitizedTabs } : {}),
  };
  if (typeof options.activeTabUrl !== "string" || !options.activeTabUrl.trim()) {
    return {
      activeTabUrl: options.activeTabUrl,
      activeTabTitle: options.activeTabTitle,
      favicon: options.favicon,
      ...base,
      authHostMatched: false,
    };
  }
  try {
    const parsed = new URL(options.activeTabUrl);
    const authHostMatched = classpilotSsoPolicyApprovesObservedUrl(
      options.activeTabUrl,
      options.policy
    );
    const authCallbackMatched = parsed.protocol === "https:"
      && authCallbackTelemetryShouldBeRedacted(
        parsed,
        options.restrictionAuthState,
        options.authRelevantRestrictionActive === true
      );
    if (!authHostMatched && !authCallbackMatched) {
      return {
        activeTabUrl: options.activeTabUrl,
        activeTabTitle: options.activeTabTitle,
        favicon: options.favicon,
        ...base,
        authHostMatched: false,
      };
    }
    const hostname = canonicalObservedHostname(parsed.hostname);
    return {
      activeTabUrl: authHostMatched
        ? `${parsed.protocol}//${hostname}${parsed.port ? `:${parsed.port}` : ""}`
        : `${parsed.protocol}//${hostname}${parsed.port ? `:${parsed.port}` : ""}${parsed.pathname}`,
      activeTabTitle: "Signing in",
      favicon: null,
      ...base,
      authHostMatched: true,
    };
  } catch {
    return {
      activeTabUrl: options.activeTabUrl,
      activeTabTitle: options.activeTabTitle,
      favicon: options.favicon,
      ...base,
      authHostMatched: false,
    };
  }
}
