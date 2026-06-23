import type { Settings } from "../schema/shared.js";

export const SHARED_CHROMEBOOK_LOGIN_METHODS = ["email_id", "name_pin"] as const;
export type SharedChromebookLoginMethod = (typeof SHARED_CHROMEBOOK_LOGIN_METHODS)[number];

export function normalizeSharedChromebookLoginMethod(
  value: unknown,
  fallback: SharedChromebookLoginMethod = "name_pin"
): SharedChromebookLoginMethod {
  return value === "name_pin" || value === "email_id" ? value : fallback;
}

export function effectiveSharedChromebookLoginMethod(
  settings: Pick<Settings, "sharedChromebookLoginMethod" | "sharedChromebookPinLoginEnabled"> | null | undefined
): SharedChromebookLoginMethod {
  return normalizeSharedChromebookLoginMethod(settings?.sharedChromebookLoginMethod, "name_pin");
}
