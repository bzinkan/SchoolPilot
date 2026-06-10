/**
 * Strip secret-bearing columns from a school row before returning it in an
 * API response. The kiosk PIN hash must never leave the server: bcrypt or
 * not, exposing it enables offline brute-force of a 4-8 digit PIN.
 */
export function sanitizeSchool<T extends { kioskPinHash?: string | null }>(
  school: T
): Omit<T, "kioskPinHash"> {
  const { kioskPinHash: _omit, ...rest } = school;
  return rest;
}
