export function nextPickupZoneId(zones) {
  const existing = new Set((zones || []).map((zone) => String(zone.id).toLowerCase()));
  // The API caps IDs at 16 characters and a school can configure at most 12
  // zones. Short monotonic IDs are deterministic, readable, and always leave
  // ample room inside the contract.
  for (let index = 1; index <= 100; index += 1) {
    const candidate = `zone_${index}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error('Unable to allocate a pickup zone identifier.');
}
