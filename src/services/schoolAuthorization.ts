import {
  identityHasAnyRole,
  type SchoolRole,
} from "./schoolIdentity.js";

type CanonicalSchoolAuthorizationIdentity = {
  userId: string;
  schoolId: string;
  roles: SchoolRole[];
};

type SchoolIdentityLocals = {
  schoolId?: string;
  schoolIdentity?: CanonicalSchoolAuthorizationIdentity;
  verifiedSchoolIdentity?: CanonicalSchoolAuthorizationIdentity;
  membershipRole?: SchoolRole | "super_admin";
};

type SchoolAuthorizationRequest = {
  authUser?: { id: string; isSuperAdmin?: boolean };
};

type SchoolAuthorizationResponse = {
  locals: SchoolIdentityLocals;
};

/**
 * Returns the canonical, request-local identity only when its provenance
 * agrees with the authenticated user and selected tenant. The singular
 * membershipRole is intentionally never consulted: it is display-only.
 */
export function requestSchoolIdentity(
  req: SchoolAuthorizationRequest,
  res: SchoolAuthorizationResponse
): CanonicalSchoolAuthorizationIdentity | null {
  const locals = res.locals;
  const identity = locals.schoolIdentity ?? locals.verifiedSchoolIdentity;
  if (
    !identity ||
    !req.authUser ||
    identity.userId !== req.authUser.id ||
    identity.schoolId !== locals.schoolId
  ) {
    return null;
  }
  return identity;
}

/** Authorize when any active role in the selected school satisfies the gate. */
export function requestHasAnySchoolRole(
  req: SchoolAuthorizationRequest,
  res: SchoolAuthorizationResponse,
  roles: readonly SchoolRole[]
): boolean {
  if (req.authUser?.isSuperAdmin) return true;
  const identity = requestSchoolIdentity(req, res);
  return identity ? identityHasAnyRole(identity, roles) : false;
}

/**
 * Selects an operation-specific role from the complete active role set. This
 * must be used only for downstream APIs that still require one role value;
 * membershipRole remains the stable legacy display role.
 */
export function selectRequestSchoolRole(
  req: SchoolAuthorizationRequest,
  res: SchoolAuthorizationResponse,
  priority: readonly SchoolRole[]
): SchoolRole | null {
  if (req.authUser?.isSuperAdmin) return priority[0] ?? null;
  const identity = requestSchoolIdentity(req, res);
  if (!identity) return null;
  return priority.find((role) => identity.roles.includes(role)) ?? null;
}
