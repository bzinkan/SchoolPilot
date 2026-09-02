import { runWithTenantContext } from "../middleware/tenantContext.js";
import { getSettingsForSchool, getStudentById } from "./storage.js";

export type ClasspilotSafetyContext = {
  /** School-wide Allowed Domains (already validated on write). */
  allowedDomains: string[];
  /** When false the school wants alerts without automatic tab closing. */
  autoBlockUnsafeUrls: boolean;
  aiSafetyEmailsEnabled: boolean;
  /** Display name for staff surfaces; null when the student row is unavailable. */
  studentName: string | null;
};

const FAIL_SAFE_CONTEXT: ClasspilotSafetyContext = {
  allowedDomains: [],
  autoBlockUnsafeUrls: true,
  aiSafetyEmailsEnabled: true,
  studentName: null,
};

/**
 * Loaded once per AI safety hit, never per heartbeat. Safety hits are rare, so
 * one short tenant-scoped read is acceptable; the heartbeat hot path itself
 * keeps using the cached tracking projection. Any failure degrades to the
 * fail-safe posture (no exemption, auto-close on, no name).
 */
export async function loadClasspilotSafetyContext(options: {
  schoolId: string;
  studentId: string;
}): Promise<ClasspilotSafetyContext> {
  try {
    return await runWithTenantContext({ schoolId: options.schoolId }, async () => {
      const [settingsRow, student] = await Promise.all([
        getSettingsForSchool(options.schoolId),
        getStudentById(options.studentId),
      ]);
      const studentName = [student?.firstName, student?.lastName]
        .filter(Boolean)
        .join(" ")
        .trim() || null;
      return {
        allowedDomains: Array.isArray(settingsRow?.allowedDomains) ? settingsRow.allowedDomains : [],
        autoBlockUnsafeUrls: settingsRow?.autoBlockUnsafeUrls !== false,
        aiSafetyEmailsEnabled: settingsRow?.aiSafetyEmailsEnabled !== false,
        studentName,
      };
    });
  } catch {
    return { ...FAIL_SAFE_CONTEXT };
  }
}
