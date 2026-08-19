export const CLASSPILOT_WS_MAX_PAYLOAD_BYTES = 256 * 1024;
export const CLASSPILOT_SIGNALING_SDP_MAX_LENGTH = 128 * 1024;
export const CLASSPILOT_SIGNALING_CANDIDATE_MAX_LENGTH = 8 * 1024;
const CLASSPILOT_SIGNALING_ID_MAX_LENGTH = 128;
const CLASSPILOT_SIGNALING_METADATA_MAX_LENGTH = 256;

export function normalizeClasspilotSignalingIdentifier(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const normalized = value.trim();
  if (
    normalized !== value
    || normalized.length > CLASSPILOT_SIGNALING_ID_MAX_LENGTH
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function plainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : null;
}

function optionalBoundedString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value as null | undefined;
  return typeof value === "string" && value.length <= CLASSPILOT_SIGNALING_METADATA_MAX_LENGTH
    ? value
    : undefined;
}

export type SanitizedClasspilotSignaling =
  | { sdp: { type: "offer" | "answer"; sdp: string } }
  | {
      candidate: {
        candidate: string;
        sdpMid?: string | null;
        sdpMLineIndex?: number | null;
        usernameFragment?: string | null;
      };
    };

/** Return a bounded, known-field-only relay payload or reject it entirely. */
export function sanitizeClasspilotSignalingMessage(
  type: unknown,
  raw: Record<string, unknown>
): SanitizedClasspilotSignaling | null {
  if (type === "offer" || type === "answer") {
    const value = plainObject(raw.sdp);
    if (
      !value
      || value.type !== type
      || typeof value.sdp !== "string"
      || value.sdp.length === 0
      || value.sdp.length > CLASSPILOT_SIGNALING_SDP_MAX_LENGTH
    ) {
      return null;
    }
    return { sdp: { type, sdp: value.sdp } };
  }
  if (type !== "ice") return null;
  const value = plainObject(raw.candidate);
  if (
    !value
    || typeof value.candidate !== "string"
    || value.candidate.length === 0
    || value.candidate.length > CLASSPILOT_SIGNALING_CANDIDATE_MAX_LENGTH
  ) {
    return null;
  }
  const sdpMid = optionalBoundedString(value.sdpMid);
  const usernameFragment = optionalBoundedString(value.usernameFragment);
  if ((value.sdpMid !== undefined && sdpMid === undefined)
    || (value.usernameFragment !== undefined && usernameFragment === undefined)) {
    return null;
  }
  const rawLineIndex = value.sdpMLineIndex;
  if (
    rawLineIndex !== undefined
    && rawLineIndex !== null
    && (!Number.isInteger(rawLineIndex) || Number(rawLineIndex) < 0 || Number(rawLineIndex) > 65_535)
  ) {
    return null;
  }
  return {
    candidate: {
      candidate: value.candidate,
      ...(value.sdpMid !== undefined ? { sdpMid: sdpMid as string | null } : {}),
      ...(rawLineIndex !== undefined ? { sdpMLineIndex: rawLineIndex as number | null } : {}),
      ...(value.usernameFragment !== undefined
        ? { usernameFragment: usernameFragment as string | null }
        : {}),
    },
  };
}
