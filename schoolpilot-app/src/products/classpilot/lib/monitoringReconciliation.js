export function classpilotReconciliationIntervalMs(scopeKey) {
  let hash = 2166136261;
  for (const character of String(scopeKey || 'classpilot')) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return 25_000 + (Math.abs(hash) % 10_001);
}
