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
import { safeErrorMetadata } from "../util/safeLogging.js";

let enabled = false;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const TOKEN_RE = /\b(eyJ[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._-]+)\b/g;
const URL_RE = /https?:\/\/[^\s"'<>]+/gi;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const SECRET_ASSIGNMENT_RE = /\b(token|secret|password|pin|code|authorization|api[_-]?key)=([^\s&"'<>]+)/gi;

export function scrubSentryText(s: string): string {
  return s
    .replace(EMAIL_RE, "[email]")
    .replace(TOKEN_RE, "[redacted]")
    .replace(URL_RE, "[url]")
    .replace(UUID_RE, "[identifier]")
    .replace(SECRET_ASSIGNMENT_RE, "$1=[redacted]")
    .slice(0, 4_096);
}

/** Recursively scrub strings inside an arbitrary value (bounded depth). */
function scrubDeep(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (value == null) return value;
  if (typeof value === "string") return scrubSentryText(value);
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

function allowlistedObject(
  value: Record<string, unknown> | undefined,
  keys: readonly string[]
): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const safe: Record<string, unknown> = {};
  for (const key of keys) {
    if (value[key] !== undefined) safe[key] = scrubDeep(value[key]);
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
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
      // Request URLs, query strings, bodies, headers, cookies and environment
      // can all contain tenant/student authority. Keep only the HTTP method.
      if (event.request) {
        event.request = event.request.method
          ? { method: scrubSentryText(event.request.method).slice(0, 16) }
          : undefined;
      }
      // The telemetry contract permits no user object or breadcrumbs.
      delete event.user;
      delete event.breadcrumbs;
      delete event.transaction;
      // Scrub message + exception text + stack-frame text.
      if (event.message) event.message = scrubSentryText(event.message);
      if (event.exception?.values) {
        for (const ex of event.exception.values) {
          if (ex.value) ex.value = scrubSentryText(ex.value);
          const frames = ex.stacktrace?.frames;
          if (frames) {
            for (const frame of frames) {
              if (frame.vars) frame.vars = scrubDeep(frame.vars) as Record<string, unknown>;
              if (frame.context_line) frame.context_line = scrubSentryText(frame.context_line);
              if (Array.isArray(frame.pre_context)) frame.pre_context = frame.pre_context.map(scrubSentryText);
              if (Array.isArray(frame.post_context)) frame.post_context = frame.post_context.map(scrubSentryText);
            }
          }
        }
      }
      // Strict allowlists prevent a future integration from adding prompts,
      // URLs, command payloads or opaque tenant/student identifiers.
      event.tags = allowlistedObject(
        event.tags as Record<string, unknown> | undefined,
        ["category", "release", "environment"]
      ) as Record<string, string> | undefined;
      event.extra = allowlistedObject(
        event.extra as Record<string, unknown> | undefined,
        ["errorCode", "job", "messageType"]
      );
      event.contexts = undefined;
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
        release: context?.release,
      },
    });
  } catch (err) {
    console.error("[Sentry] captureException failed:", safeErrorMetadata(err));
  }
}

export async function flushSentry(timeoutMs = 5000): Promise<boolean> {
  if (!enabled) return true;
  try {
    return await Sentry.flush(timeoutMs);
  } catch (err) {
    console.error("[Sentry] flush failed:", safeErrorMetadata(err));
    return false;
  }
}
