/**
 * In-memory real-time student/device status store.
 * Updated by the heartbeat route, queried by /students-aggregated.
 */

export interface DeviceRealtimeStatus {
  deviceId: string;
  studentId: string;
  studentEmail?: string;
  schoolId: string;
  activeTabUrl: string;
  activeTabTitle: string;
  favicon?: string;
  screenLocked: boolean;
  flightPathActive: boolean;
  activeFlightPathName?: string;
  isSharing: boolean;
  cameraActive: boolean;
  lastSeenAt: number;
  allOpenTabs?: Array<{ url: string; title: string; favicon?: string }>;
  extensionVersion?: string;
  chromeVersion?: string;
  aiClassification?: { category: string; safetyAlert: string | null };
  screenshotHealth?: {
    lastSuccessAt: number;
    lastErrorAt: number;
    lastError: string;
    attempts: number;
    successes: number;
    alarmActive: boolean;
  };
}

export const DEVICE_STATUS_TTL_MS = 5 * 60 * 1000;
export const DEVICE_STATUS_MAX_SCHOOLS = 2_048;
export const DEVICE_STATUS_MAX_PER_SCHOOL = 2_048;
export const DEVICE_STATUS_MAX_ENTRIES = 16_384;
export const DEVICE_STATUS_MAX_BYTES = 32 * 1024 * 1024;

// schoolId → deviceId → status. This is a rendering optimization, never an
// authorization source; authoritative routes still validate tenant/binding.
const statusMap = new Map<string, Map<string, DeviceRealtimeStatus>>();
const statusBytes = new WeakMap<DeviceRealtimeStatus, number>();
let totalEntries = 0;
let totalBytes = 0;

function estimatedBytes(status: DeviceRealtimeStatus): number {
  try {
    return Math.max(256, JSON.stringify(status).length * 2);
  } catch {
    return 1_024;
  }
}

function deleteStatus(schoolMap: Map<string, DeviceRealtimeStatus>, deviceId: string): void {
  const existing = schoolMap.get(deviceId);
  if (!existing) return;
  schoolMap.delete(deviceId);
  totalEntries -= 1;
  totalBytes -= statusBytes.get(existing) ?? 0;
}

function deleteSchool(schoolId: string): void {
  const schoolMap = statusMap.get(schoolId);
  if (!schoolMap) return;
  for (const deviceId of [...schoolMap.keys()]) deleteStatus(schoolMap, deviceId);
  statusMap.delete(schoolId);
}

function pruneStatuses(now = Date.now()): void {
  const cutoff = now - DEVICE_STATUS_TTL_MS;
  for (const [schoolId, schoolMap] of statusMap) {
    for (const [deviceId, status] of schoolMap) {
      if (status.lastSeenAt < cutoff) deleteStatus(schoolMap, deviceId);
    }
    while (schoolMap.size > DEVICE_STATUS_MAX_PER_SCHOOL) {
      const oldestDeviceId = schoolMap.keys().next().value as string | undefined;
      if (!oldestDeviceId) break;
      deleteStatus(schoolMap, oldestDeviceId);
    }
    if (schoolMap.size === 0) statusMap.delete(schoolId);
  }
  while (statusMap.size > DEVICE_STATUS_MAX_SCHOOLS) {
    const oldestSchoolId = statusMap.keys().next().value as string | undefined;
    if (!oldestSchoolId) break;
    deleteSchool(oldestSchoolId);
  }
  while (totalEntries > DEVICE_STATUS_MAX_ENTRIES || totalBytes > DEVICE_STATUS_MAX_BYTES) {
    let oldest: { schoolId: string; deviceId: string; at: number } | null = null;
    for (const [schoolId, schoolMap] of statusMap) {
      const first = schoolMap.entries().next().value as [string, DeviceRealtimeStatus] | undefined;
      if (first && (!oldest || first[1].lastSeenAt < oldest.at)) {
        oldest = { schoolId, deviceId: first[0], at: first[1].lastSeenAt };
      }
    }
    if (!oldest) break;
    const schoolMap = statusMap.get(oldest.schoolId)!;
    deleteStatus(schoolMap, oldest.deviceId);
    if (schoolMap.size === 0) statusMap.delete(oldest.schoolId);
  }
}

export function updateDeviceClassification(
  schoolId: string,
  deviceId: string,
  classification: { category: string; safetyAlert: string | null }
): void {
  const schoolMap = statusMap.get(schoolId);
  if (!schoolMap) return;
  const status = schoolMap.get(deviceId);
  if (status) {
    totalBytes -= statusBytes.get(status) ?? 0;
    status.aiClassification = classification;
    const bytes = estimatedBytes(status);
    statusBytes.set(status, bytes);
    totalBytes += bytes;
    pruneStatuses();
  }
}

export function updateDeviceStatus(data: DeviceRealtimeStatus): void {
  pruneStatuses();
  let schoolMap = statusMap.get(data.schoolId);
  if (!schoolMap) {
    schoolMap = new Map();
    statusMap.set(data.schoolId, schoolMap);
  }
  deleteStatus(schoolMap, data.deviceId);
  const status = { ...data, lastSeenAt: Date.now() };
  const bytes = estimatedBytes(status);
  statusBytes.set(status, bytes);
  schoolMap.set(data.deviceId, status);
  totalEntries += 1;
  totalBytes += bytes;
  statusMap.delete(data.schoolId);
  statusMap.set(data.schoolId, schoolMap);
  pruneStatuses();
}

export function getSchoolDeviceStatuses(
  schoolId: string
): DeviceRealtimeStatus[] {
  pruneStatuses();
  const schoolMap = statusMap.get(schoolId);
  if (!schoolMap) return [];
  return Array.from(schoolMap.values());
}

export function removeDeviceStatus(
  schoolId: string,
  deviceId: string
): void {
  const schoolMap = statusMap.get(schoolId);
  if (schoolMap) {
    deleteStatus(schoolMap, deviceId);
    if (schoolMap.size === 0) statusMap.delete(schoolId);
  }
}

export function deviceStatusCacheMetrics(): { entries: number; bytes: number; schools: number } {
  pruneStatuses();
  return { entries: totalEntries, bytes: totalBytes, schools: statusMap.size };
}

export function resetDeviceStatusesForTests(): void {
  for (const schoolId of [...statusMap.keys()]) deleteSchool(schoolId);
}
