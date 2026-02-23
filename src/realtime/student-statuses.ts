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
}

// schoolId → deviceId → status
const statusMap = new Map<string, Map<string, DeviceRealtimeStatus>>();

export function updateDeviceStatus(data: DeviceRealtimeStatus): void {
  let schoolMap = statusMap.get(data.schoolId);
  if (!schoolMap) {
    schoolMap = new Map();
    statusMap.set(data.schoolId, schoolMap);
  }
  schoolMap.set(data.deviceId, { ...data, lastSeenAt: Date.now() });
}

export function getSchoolDeviceStatuses(
  schoolId: string
): DeviceRealtimeStatus[] {
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
    schoolMap.delete(deviceId);
  }
}
