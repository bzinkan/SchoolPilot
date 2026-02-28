/**
 * Strip password hash from a user object before returning it in API responses.
 * Centralizes the pattern to prevent accidental password leaks.
 */
export function toSafeUser<T extends { password?: unknown }>(
  user: T
): Omit<T, "password"> {
  const { password: _, ...safe } = user;
  return safe;
}
