import { z } from "zod";
import errorMonitor, { type ErrorMonitor } from "./errorMonitor.js";

const safeString = (max: number) => z.string().trim().min(1).max(max);
const optionalSafeString = (max: number) => z.string().trim().max(max).optional();

export const browserTelemetrySchema = z
  .object({
    source: z.literal("schoolpilot-web").optional().default("schoolpilot-web"),
    eventType: z.enum(["error", "unhandledrejection", "resource", "react-boundary"]),
    message: safeString(4000),
    stack: optionalSafeString(8000),
    path: optionalSafeString(1000),
    surface: optionalSafeString(120),
    component: optionalSafeString(160),
    errorCode: optionalSafeString(120),
    release: optionalSafeString(120),
    browserName: optionalSafeString(80),
    browserVersion: optionalSafeString(80),
  })
  .strict();

export const extensionRuntimeTelemetrySchema = z
  .object({
    source: z.literal("classpilot-extension").optional().default("classpilot-extension"),
    eventType: safeString(120),
    message: safeString(4000),
    stack: optionalSafeString(8000),
    surface: optionalSafeString(120),
    component: optionalSafeString(160),
    errorCode: optionalSafeString(120),
    extensionVersion: optionalSafeString(80),
    chromeVersion: optionalSafeString(80),
  })
  .strict();

export type BrowserTelemetryPayload = z.infer<typeof browserTelemetrySchema>;
export type ExtensionRuntimeTelemetryPayload = z.infer<typeof extensionRuntimeTelemetrySchema>;

type TelemetryCorrelation = {
  requestId?: string;
  userId?: string;
  schoolId?: string;
};

function telemetryError(name: string, message: string, stack?: string): Error {
  const err = new Error(message);
  err.name = name || "RuntimeTelemetryError";
  if (stack) err.stack = stack;
  return err;
}

function browserClientVersion(payload: BrowserTelemetryPayload): string | undefined {
  if (!payload.browserName && !payload.browserVersion) return undefined;
  const version = payload.browserVersion ? versionLabel(payload.browserVersion) : undefined;
  return [payload.browserName, version].filter(Boolean).join("/");
}

function versionLabel(value: string): string {
  return value.startsWith("v") ? value : `v${value}`;
}

export function trackBrowserTelemetry(
  payload: BrowserTelemetryPayload,
  correlation: TelemetryCorrelation = {},
  monitor: ErrorMonitor = errorMonitor
): void {
  monitor.trackError(
    "browser_runtime_error",
    telemetryError(payload.errorCode || payload.eventType, payload.message, payload.stack),
    {
      requestId: correlation.requestId,
      userId: correlation.userId,
      schoolId: correlation.schoolId,
      path: payload.path,
      source: payload.source,
      surface: payload.surface,
      component: payload.component,
      eventType: payload.eventType,
      messageType: payload.eventType,
      errorCode: payload.errorCode,
      release: payload.release,
      clientVersion: browserClientVersion(payload),
    },
    { priority: "normal" }
  );
}

export function trackExtensionRuntimeTelemetry(
  payload: ExtensionRuntimeTelemetryPayload,
  correlation: TelemetryCorrelation = {},
  monitor: ErrorMonitor = errorMonitor
): void {
  monitor.trackError(
    "extension_runtime_error",
    telemetryError(payload.errorCode || payload.eventType, payload.message, payload.stack),
    {
      requestId: correlation.requestId,
      schoolId: correlation.schoolId,
      source: payload.source,
      surface: payload.surface,
      component: payload.component,
      eventType: payload.eventType,
      messageType: payload.eventType,
      errorCode: payload.errorCode,
      extensionVersion: payload.extensionVersion,
      chromeVersion: payload.chromeVersion ? versionLabel(payload.chromeVersion) : undefined,
    },
    { priority: "normal" }
  );
}
