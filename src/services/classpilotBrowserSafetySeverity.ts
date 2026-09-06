export type BrowserSafetySeverity = "low" | "medium" | "high" | "critical";
export const BROWSER_SAFETY_SEVERITY_VERSION = "browser-safety-severity-2026-09-05.1";

/** Browser evidence establishes concern, not imminence. Never infer critical
 * urgency from a domain or a search-rule label alone. Both collection modes
 * use this same reviewed mapping; MailPilot retains its own evidence model. */
export function classpilotBrowserSafetySeverity(classification: {
  safetyAlert?: string | null; source?: string | null; matchedTerm?: string | null;
}): BrowserSafetySeverity {
  if (!classification.safetyAlert) return "low";
  if (classification.safetyAlert === "self-harm") return "high";
  if (classification.source === "search" && [
    "school shooting plan", "make a bomb", "bomb threat", "kill someone", "kill family member",
    "weapon at school", "kill list", "hurt an animal", "conceal weapon at school",
    "weapon without background check", "hate group recruitment",
  ].includes(classification.matchedTerm ?? "")) return "high";
  return "medium";
}
