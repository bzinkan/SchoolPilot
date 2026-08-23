export function formatLivePassDuration(issuedAt, nowMs = Date.now()) {
  const issuedMs = new Date(issuedAt).getTime();
  if (!Number.isFinite(issuedMs)) return '0 min';
  const minutes = Math.floor((nowMs - issuedMs) / 60_000);
  return `${Math.max(1, minutes)} min`;
}
