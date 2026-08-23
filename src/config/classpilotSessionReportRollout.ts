export type ClasspilotSessionReportV2Mode = "legacy" | "shadow" | "on";

/**
 * Report-v2 is an operator-controlled rollout. An absent or malformed value
 * deliberately selects the established v1 contract.
 */
export function classpilotSessionReportV2Mode(
  value: string | undefined = process.env.CLASSPILOT_SESSION_REPORT_V2_MODE
): ClasspilotSessionReportV2Mode {
  return value === "shadow" || value === "on" || value === "legacy"
    ? value
    : "legacy";
}

export function classpilotSessionReportVersionForNewRow(
  value: string | undefined = process.env.CLASSPILOT_SESSION_REPORT_V2_MODE
): 1 | 2 {
  return classpilotSessionReportV2Mode(value) === "on" ? 2 : 1;
}
