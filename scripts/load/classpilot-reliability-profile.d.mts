export const RELIABILITY_WORKLOAD_VERSION: 'classpilot-reliability-v1';
export const RELIABILITY_ENDPOINT_SHAPE: string;
export const RELIABILITY_ENDPOINT_SHA256: string;
export const RELIABILITY_CAPABILITIES: readonly string[];
export function reliabilityScreenshotBindingMatches(tile: unknown): boolean;
export function minimumReliabilitySamples(options: { durationMs: number; intervalMs: number; warmupMs?: number; spreadMs?: number; timeoutMs: number; scale?: number }): number;
export interface ReliabilityProfile {
  version: typeof RELIABILITY_WORKLOAD_VERSION;
  primaryDevices: number;
  canaryDevices: number;
  classrooms: number;
  studentsPerClass: number;
  durationSeconds: number;
  heartbeatIntervalMs: number;
  screenshotIntervalMs: number;
  screenshotReadIntervalMs: number;
  historyReadIntervalMs: number;
  socketProbeIntervalMs: number;
  deviceIngestPerFiveMinutes: number;
  deviceIngestLimit: number;
  generalApiLimit: number;
  screenshotBytes: number;
}
export function reliabilityProfile(primaryDevices: number): Readonly<ReliabilityProfile>;
export function validateReliabilityEnvironment(env: Record<string, string | undefined>, target: string):
  (ReliabilityProfile & { smoke: boolean; productionAccepted: false; managedDevicesValidated: false }) | null;
