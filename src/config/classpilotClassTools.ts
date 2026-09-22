/** Fail closed, school-scoped staged enablement. Phase one uses existing APIs. */
export function classToolsPhase(schoolId: string): number {
  try {
    const value: unknown = JSON.parse(process.env.CLASSPILOT_CLASS_TOOLS_SCHOOLS_JSON || "{}");
    if (!value || Array.isArray(value) || typeof value !== "object") return 0;
    const phase = (value as Record<string, unknown>)[schoolId];
    return Number.isInteger(phase) && Number(phase) >= 0 && Number(phase) <= 5 ? Number(phase) : 0;
  } catch { return 0; }
}
export function requireClassToolsPhase(schoolId: string, phase: number) {
  if (classToolsPhase(schoolId) < phase) throw Object.assign(new Error("This Class tools feature is not enabled for this school"), { status: 409, code: "CLASS_TOOLS_NOT_ENABLED", expose: true });
}
