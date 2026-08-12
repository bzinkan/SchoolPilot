import type { RequestHandler, Response } from "express";

export const GOPILOT_PARENT_PORTAL_DISABLED =
  "GOPILOT_PARENT_PORTAL_DISABLED" as const;

export type AuthorizedPickupStatus = "pending" | "approved" | "revoked";

const AUTHORIZED_PICKUP_STATUSES = new Set<AuthorizedPickupStatus>([
  "pending",
  "approved",
  "revoked",
]);

export function sendGoPilotParentPortalDisabled(res: Response) {
  return res.status(410).json({ code: GOPILOT_PARENT_PORTAL_DISABLED });
}

/**
 * Terminal handler for retired, authenticated GoPilot parent surfaces.
 * Keeping the response independent of request data prevents child, school, or
 * invitation existence from being inferred through the disabled endpoints.
 */
export const disabledGoPilotParentPortalHandler: RequestHandler = (_req, res) =>
  sendGoPilotParentPortalDisabled(res);

/**
 * Public registration remains available for staff-created schools, while the
 * retired school-slug parent-registration path fails before validation or any
 * user/school lookup can occur.
 */
export const rejectGoPilotParentRegistration: RequestHandler = (req, res, next) => {
  const schoolSlug = req.body?.schoolSlug;
  if (typeof schoolSlug === "string" && schoolSlug.trim().length > 0) {
    return sendGoPilotParentPortalDisabled(res);
  }
  return next();
};

export function isDisabledGoPilotParentRole(role: string | null | undefined): boolean {
  return role === "parent";
}

/** The retired custom-scheme native OAuth callback is not an accepted target. */
export function isDisabledNativeGoPilotOAuthRedirect(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return value === "/gopilot" || value.startsWith("/gopilot/");
}

export function isAuthorizedPickupManagerRole(
  role: string | null | undefined
): boolean {
  return role === "admin" || role === "school_admin" || role === "office_staff";
}

export function isAuthorizedPickupStatus(value: unknown): value is AuthorizedPickupStatus {
  return typeof value === "string" && AUTHORIZED_PICKUP_STATUSES.has(value as AuthorizedPickupStatus);
}

/**
 * Authorized-pickup review is monotonic. A pending record can be approved or
 * revoked; an approved record can only be revoked; revoked records are final.
 * Repeating the current status is accepted so staff retries are idempotent.
 */
export function canTransitionAuthorizedPickup(
  from: AuthorizedPickupStatus,
  to: AuthorizedPickupStatus
): boolean {
  if (from === to) return true;
  if (from === "pending") return to === "approved" || to === "revoked";
  if (from === "approved") return to === "revoked";
  return false;
}

type PickupRecord = {
  id: string;
  studentId: string;
  name: string;
  relationship: string;
  phone?: string | null;
  photoUrl?: string | null;
  status: string;
  createdAt: Date | string;
};

/** Explicit staff DTO: additional database fields are intentionally dropped. */
export function toAuthorizedPickupDto(pickup: PickupRecord) {
  return {
    id: pickup.id,
    studentId: pickup.studentId,
    name: pickup.name,
    relationship: pickup.relationship,
    phone: pickup.phone ?? null,
    photoUrl: pickup.photoUrl ?? null,
    status: isAuthorizedPickupStatus(pickup.status) ? pickup.status : "pending",
    createdAt: pickup.createdAt,
  };
}
