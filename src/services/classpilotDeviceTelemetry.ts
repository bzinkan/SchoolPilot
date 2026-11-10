import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import type { Request } from "express";

export const DEVICE_TELEMETRY_CAPABILITY = "deviceTelemetryTransportV1";
export const DEVICE_TELEMETRY_MAX_BYTES = 256 * 1024;
export type DeviceTelemetryKind = "heartbeat" | "screenshot";
export type DeviceTelemetryBinding = Readonly<{
  schoolId: string; deviceId: string; studentId: string; studentSessionId: string;
}>;
export type DeviceTelemetryOutcome = {
  status: number;
  body: Record<string, any>;
  headers?: Record<string, string>;
};
export type DeviceTelemetryFrame = {
  type: "device-telemetry"; operationId: string; kind: DeviceTelemetryKind;
  studentToken: string; payload: Record<string, unknown>;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validTelemetryOperationId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
/** Same right-to-left trusted proxy depth as Express; payloads never supply IPs. */
export function deviceTelemetrySourceIp(request: Pick<IncomingMessage, "headers"> & { socket: { remoteAddress?: string } }, hops: number): string {
  const remote = request.socket.remoteAddress || "0.0.0.0";
  const raw = request.headers["x-forwarded-for"];
  const forwarded = typeof raw === "string" ? raw.split(",").map(value => value.trim()) : [];
  if (!Number.isSafeInteger(hops) || hops < 0 || forwarded.some(value => !isIP(value))) return remote;
  return [remote, ...forwarded.reverse()][Math.min(hops, forwarded.length)] || remote;
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function parseDeviceTelemetryFrame(value: unknown): DeviceTelemetryFrame | null {
  if (!object(value) || value.type !== "device-telemetry"
    || !validTelemetryOperationId(value.operationId)
    || (value.kind !== "heartbeat" && value.kind !== "screenshot")
    || typeof value.studentToken !== "string" || !value.studentToken || value.studentToken.length > 16_384
    || !object(value.payload)
    || (value.payload.telemetryOperationId !== undefined && value.payload.telemetryOperationId !== value.operationId)
    || Object.keys(value).some(key => !["type", "operationId", "kind", "studentToken", "payload"].includes(key))) return null;
  try { if (Buffer.byteLength(JSON.stringify(value), "utf8") > DEVICE_TELEMETRY_MAX_BYTES) return null; }
  catch { return null; }
  return value as DeviceTelemetryFrame;
}

/** Explicit delivery lifecycle shared by transports; this is not an Express response. */
export class DeviceTelemetryDelivery {
  finished = false;
  closed = false;
  private readonly finishListeners: Array<() => void> = [];
  private readonly closeListeners: Array<() => void> = [];
  onFinished(listener: () => void): void { if (this.finished) listener(); else if (!this.closed) this.finishListeners.push(listener); }
  onClosed(listener: () => void): void { if (this.closed) listener(); else if (!this.finished) this.closeListeners.push(listener); }
  finish(): void {
    if (this.finished || this.closed) return;
    this.finished = true;
    for (const listener of this.finishListeners.splice(0)) listener();
    this.closeListeners.length = 0;
  }
  close(): void {
    if (this.closed || this.finished) return;
    this.closed = true;
    for (const listener of this.closeListeners.splice(0)) listener();
    this.finishListeners.length = 0;
  }
}
export type DeviceTelemetryContext = {
  binding: DeviceTelemetryBinding;
  // Existing canonical handlers own payload interpretation. The adapter does
  // not introduce a second, subtly different validation schema.
  payload: Request["body"];
  sourceIp: string;
  operationId?: string;
  signal?: AbortSignal;
  delivery: DeviceTelemetryDelivery;
  reply(status: number, body?: Record<string, unknown>, headers?: Record<string, string>): DeviceTelemetryOutcome;
};
type Operation = (context: DeviceTelemetryContext) => Promise<DeviceTelemetryOutcome>;
let operations: Readonly<Record<DeviceTelemetryKind, Operation>> | undefined;
export function registerClasspilotDeviceTelemetryOperations(value: Readonly<Record<DeviceTelemetryKind, Operation>>): void {
  operations = value;
}
export async function executeRegisteredDeviceTelemetry(kind: DeviceTelemetryKind, context: DeviceTelemetryContext): Promise<DeviceTelemetryOutcome> {
  if (!operations) return context.reply(503, { code: "DEVICE_TELEMETRY_UNAVAILABLE", error: "Telemetry is unavailable" });
  return operations[kind](context);
}

function canonicalJson(value: unknown, depth = 0): unknown {
  if (depth > 32) throw new Error("Telemetry payload is too deeply nested");
  if (Array.isArray(value)) return value.map(entry => canonicalJson(entry, depth + 1));
  if (object(value)) return Object.fromEntries(Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => [key, canonicalJson(value[key], depth + 1)]));
  return value;
}
export function heartbeatTelemetryIdentity(binding: DeviceTelemetryBinding, operationId: string, payload: Record<string, unknown>): { id: string; payloadHash: string } {
  if (!validTelemetryOperationId(operationId)) throw new Error("Invalid telemetry operation ID");
  const identity = createHash("sha256").update(JSON.stringify(["classpilot:heartbeat-operation:v1", binding.schoolId,
    binding.studentId, binding.studentSessionId, binding.deviceId, operationId.toLowerCase()])).digest("hex").slice(0, 32).split("");
  identity[12] = "8"; identity[16] = ((parseInt(identity[16]!, 16) & 3) | 8).toString(16);
  const hex = identity.join("");
  const { telemetryOperationId: _operation, studentToken: _token, ...data } = payload;
  return { id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    payloadHash: createHash("sha256").update(JSON.stringify(canonicalJson(data))).digest("hex") };
}

export function createDeviceTelemetryDispatcher(dependencies: {
  verifyToken(token: string): { schoolId: string; deviceId: string; studentId: string; sessionId: string };
  allowed(binding: DeviceTelemetryBinding): boolean;
  execute(kind: DeviceTelemetryKind, context: DeviceTelemetryContext): Promise<DeviceTelemetryOutcome>;
}) {
  return async (raw: unknown, scope: {
    binding: DeviceTelemetryBinding; sourceIp: string; delivery: DeviceTelemetryDelivery; signal?: AbortSignal;
    reply(outcome: DeviceTelemetryOutcome): DeviceTelemetryOutcome;
  }): Promise<DeviceTelemetryOutcome> => {
    const fail = (status: number, code: string) => scope.reply({ status, body: { code } });
    const parsed = parseDeviceTelemetryFrame(raw);
    if (!parsed) return fail(400, "DEVICE_TELEMETRY_INVALID");
    let token;
    try { token = dependencies.verifyToken(parsed.studentToken); }
    catch { return fail(401, "DEVICE_TELEMETRY_AUTH_REQUIRED"); }
    const binding = scope.binding;
    if (token.schoolId !== binding.schoolId || token.deviceId !== binding.deviceId
      || token.studentId !== binding.studentId || token.sessionId !== binding.studentSessionId) {
      return fail(403, "DEVICE_TELEMETRY_BINDING_MISMATCH");
    }
    if (!dependencies.allowed(binding)) return fail(426, "DEVICE_TELEMETRY_UNAVAILABLE");
    if (scope.signal?.aborted || scope.delivery.closed) return fail(503, "DEVICE_TELEMETRY_UNAVAILABLE");
    return dependencies.execute(parsed.kind, {
      binding: Object.freeze({ ...binding }), payload: parsed.payload, operationId: parsed.operationId,
      sourceIp: scope.sourceIp, signal: scope.signal, delivery: scope.delivery,
      reply: (status, body = {}, headers) => scope.reply({ status, body, ...(headers ? { headers } : {}) }),
    });
  };
}

/** Single-flight per kind; no telemetry work ever joins the control-frame tail. */
export function createDeviceTelemetryLanes() {
  let stopped = false;
  const active = new Map<DeviceTelemetryKind, Promise<unknown>>();
  return {
    stop() { stopped = true; },
    async run<T>(kind: DeviceTelemetryKind, work: () => Promise<T>): Promise<T | null> {
      if (stopped || active.has(kind)) return null;
      const pending = Promise.resolve().then(work);
      active.set(kind, pending);
      try { return await pending; }
      finally { if (active.get(kind) === pending) active.delete(kind); }
    },
    async drain() { while (active.size) await Promise.allSettled([...active.values()]); },
  };
}
