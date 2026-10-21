export function formatLivePassDuration(issuedAt, nowMs = Date.now()) {
  if (!issuedAt || !Number.isFinite(nowMs)) return '—';
  const issuedMs = new Date(issuedAt).getTime();
  if (!Number.isFinite(issuedMs)) return '—';
  const elapsedMs = Math.max(0, nowMs - issuedMs);
  const minutes = Math.floor(elapsedMs / 60_000);
  return minutes === 0 ? '<1 min' : `${minutes} min`;
}
