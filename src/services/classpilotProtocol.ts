import { createHash } from "node:crypto";

export const CLASSPILOT_SERVER_PROTOCOL_VERSION = 3 as const;

export const CLASSPILOT_PROTOCOL_V3_CAPABILITIES = [
  "authBoundTelemetryV1",
  "exactBindingAckV2",
  "exactTabCloseV2",
  "studentChatIdempotencyV1",
  "screenshotObservationLeaseV1",
  "safetyEvidenceCaptureV1",
  "liveViewIceServersV1",
  "kioskLaunchTicketV1",
] as const;

export type ClasspilotProtocolCapability =
  typeof CLASSPILOT_PROTOCOL_V3_CAPABILITIES[number];

const CAPABILITY_FLAGS: Record<ClasspilotProtocolCapability, string> = {
  authBoundTelemetryV1: "CLASSPILOT_CAP_AUTH_BOUND_TELEMETRY_V1",
  exactBindingAckV2: "CLASSPILOT_CAP_EXACT_BINDING_ACK_V2",
  exactTabCloseV2: "CLASSPILOT_CAP_EXACT_TAB_CLOSE_V2",
  studentChatIdempotencyV1: "CLASSPILOT_CAP_STUDENT_CHAT_IDEMPOTENCY_V1",
  screenshotObservationLeaseV1: "CLASSPILOT_CAP_SCREENSHOT_OBSERVATION_LEASE_V1",
  safetyEvidenceCaptureV1: "CLASSPILOT_CAP_SAFETY_EVIDENCE_CAPTURE_V1",
  liveViewIceServersV1: "CLASSPILOT_CAP_LIVE_VIEW_ICE_SERVERS_V1",
  kioskLaunchTicketV1: "CLASSPILOT_CAP_KIOSK_LAUNCH_TICKET_V1",
};

function enabled(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value || "");
}

export type ClasspilotCapabilityRolloutMode = "off" | "observe" | "canary" | "on";

export type ClasspilotProtocolScope = {
  serverOrigin?: string;
  schoolId?: string;
  deviceId?: string;
  studentId?: string;
  studentSessionId?: string;
};

export type ClasspilotProtocolSurface = "registration" | "heartbeat" | "websocket_auth";

export type ClasspilotProtocolPayload = {
  clientProtocolVersion?: unknown;
  capabilities?: unknown;
  extensionCapabilities?: unknown;
};

type CapabilityRollout = {
  mode: ClasspilotCapabilityRolloutMode;
  schoolIds: ReadonlySet<string>;
  canaryPercent: number;
};

type ParsedRollouts = {
  configured: boolean;
  valid: boolean;
  rollouts: Partial<Record<ClasspilotProtocolCapability, CapabilityRollout>>;
};

let cachedRolloutSource: string | undefined;
let cachedRollouts: ParsedRollouts | undefined;

function parseCapabilityRollouts(source: string | undefined): ParsedRollouts {
  if (!source?.trim()) return { configured: false, valid: true, rollouts: {} };
  if (source === cachedRolloutSource && cachedRollouts) return cachedRollouts;

  const failClosed: ParsedRollouts = { configured: true, valid: false, rollouts: {} };
  try {
    const raw = JSON.parse(source) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      cachedRolloutSource = source;
      cachedRollouts = failClosed;
      return failClosed;
    }
    const supported = new Set<string>(CLASSPILOT_PROTOCOL_V3_CAPABILITIES);
    const rollouts: Partial<Record<ClasspilotProtocolCapability, CapabilityRollout>> = {};
    for (const [name, value] of Object.entries(raw)) {
      if (!supported.has(name) || !value || typeof value !== "object" || Array.isArray(value)) {
        cachedRolloutSource = source;
        cachedRollouts = failClosed;
        return failClosed;
      }
      const record = value as Record<string, unknown>;
      const mode = record.mode;
      if (mode !== "off" && mode !== "observe" && mode !== "canary" && mode !== "on") {
        cachedRolloutSource = source;
        cachedRollouts = failClosed;
        return failClosed;
      }
      const rawSchoolIds = record.schoolIds ?? [];
      if (!Array.isArray(rawSchoolIds) || rawSchoolIds.length > 10_000) {
        cachedRolloutSource = source;
        cachedRollouts = failClosed;
        return failClosed;
      }
      const schoolIds = rawSchoolIds.map((schoolId) => String(schoolId).trim());
      if (schoolIds.some((schoolId) => !schoolId || schoolId.length > 128)) {
        cachedRolloutSource = source;
        cachedRollouts = failClosed;
        return failClosed;
      }
      const canaryPercent = record.canaryPercent === undefined
        ? 0
        : Number(record.canaryPercent);
      if (!Number.isFinite(canaryPercent) || canaryPercent < 0 || canaryPercent > 100) {
        cachedRolloutSource = source;
        cachedRollouts = failClosed;
        return failClosed;
      }
      rollouts[name as ClasspilotProtocolCapability] = {
        mode,
        schoolIds: new Set(schoolIds),
        canaryPercent,
      };
    }
    const parsed: ParsedRollouts = { configured: true, valid: true, rollouts };
    cachedRolloutSource = source;
    cachedRollouts = parsed;
    return parsed;
  } catch {
    cachedRolloutSource = source;
    cachedRollouts = failClosed;
    return failClosed;
  }
}

function schoolCanaryBucket(capability: ClasspilotProtocolCapability, schoolId: string): number {
  const digest = createHash("sha256")
    .update("classpilot:capability-rollout:v1")
    .update("\u0000")
    .update(capability)
    .update("\u0000")
    .update(schoolId)
    .digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000 * 100;
}

export function classpilotCapabilityRolloutMode(
  capability: ClasspilotProtocolCapability,
  env: NodeJS.ProcessEnv = process.env
): ClasspilotCapabilityRolloutMode {
  const parsed = parseCapabilityRollouts(env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON);
  if (!parsed.configured) {
    return enabled(env[CAPABILITY_FLAGS[capability]]) ? "on" : "off";
  }
  if (!parsed.valid) return "off";
  return parsed.rollouts[capability]?.mode ?? "off";
}

export function isClasspilotCapabilityActive(
  capability: ClasspilotProtocolCapability,
  scope: ClasspilotProtocolScope,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!enabled(env.CLASSPILOT_PROTOCOL_V3_ENABLED)) return false;
  if (!enabled(env[CAPABILITY_FLAGS[capability]])) return false;

  const parsed = parseCapabilityRollouts(env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON);
  if (!parsed.configured) return true;
  if (!parsed.valid) return false;
  const rollout = parsed.rollouts[capability];
  const schoolId = scope.schoolId?.trim();
  if (!rollout || !schoolId) return false;
  if (rollout.schoolIds.size > 0 && !rollout.schoolIds.has(schoolId)) return false;
  if (rollout.mode === "off" || rollout.mode === "observe") return false;
  if (rollout.mode === "on") return true;
  return schoolCanaryBucket(capability, schoolId) < rollout.canaryPercent;
}

export function enabledClasspilotProtocolCapabilities(
  env: NodeJS.ProcessEnv = process.env,
  scope: ClasspilotProtocolScope = {}
): Set<ClasspilotProtocolCapability> {
  if (!enabled(env.CLASSPILOT_PROTOCOL_V3_ENABLED)) return new Set();
  return new Set(CLASSPILOT_PROTOCOL_V3_CAPABILITIES.filter(
    (capability) => isClasspilotCapabilityActive(capability, scope, env)
  ));
}

export function negotiateClasspilotProtocol(options: {
  clientProtocolVersion: unknown;
  advertisedCapabilities: unknown;
  scope?: ClasspilotProtocolScope;
  env?: NodeJS.ProcessEnv;
}): {
  serverProtocolVersion: typeof CLASSPILOT_SERVER_PROTOCOL_VERSION;
  acceptedCapabilities: ClasspilotProtocolCapability[];
} {
  const clientProtocolVersion = Number(options.clientProtocolVersion);
  if (clientProtocolVersion !== CLASSPILOT_SERVER_PROTOCOL_VERSION) {
    return {
      serverProtocolVersion: CLASSPILOT_SERVER_PROTOCOL_VERSION,
      acceptedCapabilities: [],
    };
  }
  const advertised = new Set(
    Array.isArray(options.advertisedCapabilities)
      ? options.advertisedCapabilities.filter((value): value is string => typeof value === "string")
      : []
  );
  const serverEnabled = enabledClasspilotProtocolCapabilities(options.env, options.scope);
  return {
    serverProtocolVersion: CLASSPILOT_SERVER_PROTOCOL_VERSION,
    acceptedCapabilities: CLASSPILOT_PROTOCOL_V3_CAPABILITIES.filter(
      (capability) => advertised.has(capability) && serverEnabled.has(capability)
    ),
  };
}

/**
 * Shared adapter used by all three extension handshake surfaces. Keeping the
 * payload interpretation here lets archived clients be replayed against the
 * same executable contract used by registration, heartbeat, and WebSocket
 * authentication instead of testing a standalone version helper only.
 */
export function negotiateClasspilotSurfaceProtocol(options: {
  surface: ClasspilotProtocolSurface;
  payload: ClasspilotProtocolPayload;
  scope?: ClasspilotProtocolScope;
  env?: NodeJS.ProcessEnv;
}): ReturnType<typeof negotiateClasspilotProtocol> {
  if (
    options.surface !== "registration"
    && options.surface !== "heartbeat"
    && options.surface !== "websocket_auth"
  ) {
    throw new Error("Unsupported ClassPilot protocol surface");
  }
  return negotiateClasspilotProtocol({
    clientProtocolVersion: options.payload.clientProtocolVersion,
    advertisedCapabilities:
      options.payload.extensionCapabilities ?? options.payload.capabilities,
    scope: options.scope,
    env: options.env,
  });
}
