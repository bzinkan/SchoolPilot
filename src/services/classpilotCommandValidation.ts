import { z } from "zod";

const id = z.string().trim().min(1).max(128);
const message = z.string().trim().min(1).max(2_000);

const strictObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

function httpUrl(value: unknown, field = "url"): string {
  const raw = z.string().trim().min(1).max(4_096).parse(value);
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new z.ZodError([{ code: "custom", path: [field], message: `${field} must be a valid HTTP or HTTPS URL` }]);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new z.ZodError([{ code: "custom", path: [field], message: `${field} must be HTTP or HTTPS` }]);
  }
  return parsed.toString();
}

function domain(value: unknown): string {
  const raw = z.string().trim().min(1).max(253).parse(value).replace(/^https?:\/\//i, "");
  let parsed: URL;
  try {
    parsed = new URL(`https://${raw}`);
  } catch {
    throw new z.ZodError([{ code: "custom", path: ["domain"], message: "domain must be a valid hostname" }]);
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.port || !parsed.hostname) {
    throw new z.ZodError([{ code: "custom", path: ["domain"], message: "domain must contain only a hostname" }]);
  }
  return parsed.hostname.toLowerCase().replace(/^www\./, "");
}

export class ClasspilotCommandPayloadError extends Error {
  readonly status = 400;
  readonly code = "INVALID_COMMAND_PAYLOAD";
  readonly fieldErrors: Array<{ path: string; message: string }>;

  constructor(error: z.ZodError) {
    super("Command payload is invalid");
    this.name = "ClasspilotCommandPayloadError";
    this.fieldErrors = error.issues.map((issue) => ({
      path: issue.path.join(".") || "commandPayload",
      message: issue.message,
    }));
  }
}

export type ValidatedClasspilotCommandPayload = Record<string, unknown>;

/**
 * The sole syntactic boundary for teacher command payloads. Every schema is
 * strict so unrecognised fields cannot accidentally become extension commands.
 * Resource ownership and live-binding checks remain server-side semantic work.
 */
export function validateClasspilotCommandPayload(
  commandType: string,
  raw: unknown
): ValidatedClasspilotCommandPayload {
  try {
    switch (commandType) {
      case "open-tab": {
        const value = strictObject({ url: z.unknown() }).parse(raw);
        return { url: httpUrl(value.url) };
      }
      case "lock-screen": {
        const value = strictObject({ url: z.unknown() }).parse(raw);
        return { url: value.url === "CURRENT_URL" ? "CURRENT_URL" : httpUrl(value.url) };
      }
      case "unlock-screen": {
        // Canonical Unlock is intentionally narrower than Flight Path removal.
        // Legacy `{}` payloads used to clear both controls and are no longer
        // accepted on teacher command routes.
        return strictObject({ screenOnly: z.literal(true) }).parse(raw);
      }
      case "close-tabs": {
        const value = z.union([
          strictObject({ closeAll: z.literal(true) }),
          strictObject({
            tabsToClose: z.array(strictObject({
              studentId: id,
              tabRef: id,
              observedRevision: z.number().int().positive(),
            })).min(1).max(50),
          }).superRefine((exact, ctx) => {
            const keys = exact.tabsToClose.map((tab) => `${tab.studentId}\u0000${tab.tabRef}`);
            if (new Set(keys).size !== keys.length) {
              ctx.addIssue({ code: "custom", path: ["tabsToClose"], message: "Exact tab selections must be unique" });
            }
          }),
        ]).parse(raw);
        return value;
      }
      case "remove-flight-path":
      case "remove-block-list":
        return strictObject({}).parse(raw);
      case "apply-flight-path":
        return strictObject({ flightPathId: id }).parse(raw);
      case "apply-block-list":
        return strictObject({ blockListId: id }).parse(raw);
      case "attention-mode":
        return strictObject({ active: z.boolean(), message: z.string().trim().max(500).optional() }).parse(raw);
      case "timer": {
        const value = strictObject({
          action: z.enum(["start", "stop"]),
          seconds: z.number().int().min(1).max(3_600).optional(),
          durationSeconds: z.number().int().min(1).max(3_600).optional(),
          message: z.string().trim().max(500).optional(),
        }).superRefine((timer, ctx) => {
          if (timer.action === "start" && timer.seconds === undefined && timer.durationSeconds === undefined) {
            ctx.addIssue({ code: "custom", path: ["seconds"], message: "seconds is required when starting a timer" });
          }
        }).parse(raw);
        const seconds = value.seconds ?? value.durationSeconds;
        return value.action === "start"
          ? { action: "start", seconds, ...(value.message ? { message: value.message } : {}) }
          : { action: "stop" };
      }
      case "temp-unblock": {
        const value = strictObject({
          domain: z.unknown(),
          durationMinutes: z.number().int().min(1).max(720),
        }).parse(raw);
        return { domain: domain(value.domain), durationMinutes: value.durationMinutes };
      }
      case "limit-tabs":
        return strictObject({ maxTabs: z.number().int().min(1).max(100).nullable() }).parse(raw);
      case "student-sign-out":
        return strictObject({}).parse(raw);
      case "poll": {
        const base = z.union([
          strictObject({
            action: z.literal("start").optional(),
            question: z.string().trim().min(1).max(500),
            options: z.array(z.string().trim().min(1).max(200)).min(2).max(5),
          }),
          strictObject({ action: z.literal("close"), pollId: id }),
        ]).parse(raw);
        if ((base.action ?? "start") === "start") {
          const options = (base as { options: string[] }).options;
          if (new Set(options.map((option) => option.toLocaleLowerCase())).size !== options.length) {
            throw new z.ZodError([{ code: "custom", path: ["options"], message: "Poll options must be unique" }]);
          }
        }
        return base as ValidatedClasspilotCommandPayload;
      }
      case "teacher-message":
        return strictObject({ message }).parse(raw);
      default:
        throw Object.assign(new Error(`Unsupported commandType: ${commandType}`), {
          status: 400,
          code: "UNSUPPORTED_COMMAND_TYPE",
        });
    }
  } catch (error) {
    if (error instanceof z.ZodError) throw new ClasspilotCommandPayloadError(error);
    throw error;
  }
}
