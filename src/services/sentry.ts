// Sentry error tracking — GATED OFF until SENTRY_DSN is set.
//
// IMPORTANT (FERPA/COPPA): Sentry is a third-party subprocessor. Do NOT set
// SENTRY_DSN in production until you have (1) signed Sentry's DPA and (2) added
// Sentry to the public subprocessors list. When SENTRY_DSN is unset, every
// function here is a no-op and nothing leaves the system.
//
// Even when enabled, a strict beforeSend scrubs PII (emails, names, tokens,
// request bodies, cookies, headers) so student data does not leak to Sentry.

import * as Sentry from "@sentry/node";

let enabled = false;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const TOKEN_RE = /\b(eyJ[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._-]+)\b/g;

function scrubString(s: string): string {
  return s
    .replace(EMAIL_RE, "[email]")
    .replace(TOKEN_RE, "[redacted]");
}

/** Recursively scrub strings inside an arbitrary value (bounded depth). */
function scrubDeep(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (value == null) return value;
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubDeep(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    // Gated off — no subprocessor, no data leaves the system.
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || "development",
    // Never send default PII (IP, cookies, user identifiers).
    sendDefaultPii: false,
    // No performance tracing by default — error capture only.
    tracesSampleRate: 0,
    // FERPA hardening — kill the data sources that can carry student names
    // (which regex scrubbing can't reliably catch):
    //  - includeLocalVariables: false → stack frames never carry local var values
    //  - beforeBreadcrumb → null → drop ALL breadcrumbs (console/http auto-capture)
    includeLocalVariables: false,
    beforeBreadcrumb() {
      return null;
    },
    beforeSend(event) {
      // Drop request payloads/cookies/headers entirely — they carry PII.
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        delete event.request.headers;
        if (event.request.query_string) delete event.request.query_string;
      }
      // Strip user identifiers + any breadcrumbs that slipped through.
      delete event.user;
      delete event.breadcrumbs;
      // Scrub message + exception text + stack-frame text.
      if (event.message) event.message = scrubString(event.message);
      if (event.exception?.values) {
        for (const ex of event.exception.values) {
          if (ex.value) ex.value = scrubString(ex.value);
          const frames = ex.stacktrace?.frames;
          if (frames) {
            for (const frame of frames) {
              if (frame.vars) frame.vars = scrubDeep(frame.vars) as Record<string, unknown>;
              if (frame.context_line) frame.context_line = scrubString(frame.context_line);
              if (Array.isArray(frame.pre_context)) frame.pre_context = frame.pre_context.map(scrubString);
              if (Array.isArray(frame.post_context)) frame.post_context = frame.post_context.map(scrubString);
            }
          }
        }
      }
      // Scrub every other dynamic sub-object we or integrations might populate.
      if (event.extra) event.extra = scrubDeep(event.extra) as Record<string, unknown>;
      if (event.tags) event.tags = scrubDeep(event.tags) as Record<string, string>;
      if (event.contexts) event.contexts = scrubDeep(event.contexts) as typeof event.contexts;
      return event;
    },
  });
  enabled = true;
  console.log("[Sentry] Enabled (PII scrubbing active; local vars + breadcrumbs disabled).");
}

export function isSentryEnabled(): boolean {
  return enabled;
}

/** Capture an error with category + correlation context. No-op when disabled. */
export function captureError(
  error: unknown,
  context?: {
    category?: string;
    requestId?: string;
    schoolId?: string;
    userId?: string;
    fingerprint?: string;
    release?: string;
    instanceId?: string;
  }
): void {
  if (!enabled) return;
  try {
    Sentry.captureException(error, {
      tags: {
        category: context?.category,
        requestId: context?.requestId,
        fingerprint: context?.fingerprint,
        release: context?.release,
        instanceId: context?.instanceId,
      },
      // schoolId/userId are non-PII opaque ids — safe for correlation.
      extra: {
        schoolId: context?.schoolId,
        userId: context?.userId,
      },
    });
  } catch (err) {
    console.error("[Sentry] captureException failed:", err);
  }
}

export async function flushSentry(timeoutMs = 5000): Promise<boolean> {
  if (!enabled) return true;
  try {
    return await Sentry.flush(timeoutMs);
  } catch (err) {
    console.error("[Sentry] flush failed:", err);
    return false;
  }
}
