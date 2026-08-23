const SENSITIVE_API_PREFIXES = [
  "/api/auth",
  "/api/classpilot",
  "/api/device",
  "/api/tiles",
  "/api/student",
  "/api/passpilot/kiosk",
  "/api/kiosk",
  "/api/chat",
  "/api/ai-chat",
] as const;

export function isSensitiveNoStorePath(path: string): boolean {
  return SENSITIVE_API_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`)
  );
}
