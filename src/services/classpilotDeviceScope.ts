import {
  getActiveSessionByDevice,
  getActiveSupervisionForStudent,
  getDeviceById,
  getDevicesBySchool,
  getStudentDevices,
} from "./storage.js";

function normalizeDeviceIds(deviceIds: unknown): string[] {
  if (!Array.isArray(deviceIds)) return [];
  return [...new Set(deviceIds.map((id) => String(id || "").trim()).filter(Boolean))];
}

export async function devicesInSchool(deviceIds: unknown, schoolId: string): Promise<string[]> {
  const ids = normalizeDeviceIds(deviceIds);
  if (ids.length === 0) return [];
  const schoolDevices = await getDevicesBySchool(schoolId);
  const allowed = new Set(schoolDevices.map((d) => d.deviceId));
  return ids.filter((id) => allowed.has(id));
}

export async function scopedDeviceTargets(
  deviceIds: unknown,
  schoolId: string
): Promise<{ deviceIds: string[]; rejectedDeviceCount: number }> {
  const requested = normalizeDeviceIds(deviceIds);
  const scoped = await devicesInSchool(requested, schoolId);
  const controllable: string[] = [];
  for (const deviceId of scoped) {
    const activeSession = await getActiveSessionByDevice(deviceId);
    if (activeSession?.studentId) {
      const supervision = await getActiveSupervisionForStudent(schoolId, activeSession.studentId);
      if (supervision) continue;
    }
    controllable.push(deviceId);
  }
  return {
    deviceIds: controllable,
    rejectedDeviceCount: Math.max(0, requested.length - controllable.length),
  };
}

export async function deviceBelongsToSchoolAndStudent(
  deviceId: unknown,
  schoolId: string,
  studentId?: string | null
): Promise<string | undefined> {
  const normalized = String(deviceId || "").trim();
  if (!normalized) return undefined;

  const device = await getDeviceById(normalized);
  if (!device || device.schoolId !== schoolId) return undefined;

  if (studentId) {
    const studentDevices = await getStudentDevices(studentId);
    if (!studentDevices.some((row) => row.deviceId === normalized)) {
      return undefined;
    }
  }

  return normalized;
}
