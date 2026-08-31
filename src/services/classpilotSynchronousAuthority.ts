/**
 * Values that can be produced completely inside a database-backed authority
 * interval. Objects may contain Promises for safe post-commit work, but the
 * top-level result itself must not be thenable: awaiting it would release the
 * transaction lock before the protected local send or response serialization.
 */
export type ClasspilotSynchronousAuthorityResult =
  | void
  | null
  | string
  | number
  | boolean
  | bigint
  | symbol
  | (object & { readonly then?: never });

export function assertClasspilotSynchronousAuthorityResult<T>(
  value: T
): asserts value is T & ClasspilotSynchronousAuthorityResult {
  const objectLike = value !== null
    && (typeof value === "object" || typeof value === "function");
  if (objectLike && typeof (value as { then?: unknown }).then === "function") {
    throw new TypeError("ClassPilot authority callbacks must complete synchronously");
  }
}
