import type { ErrorRequestHandler } from "express";
import errorMonitor from "../services/errorMonitor.js";
import { safeErrorMetadata } from "../util/safeLogging.js";
import { getDatabaseErrorDetails } from "../util/databaseError.js";

const DATABASE_CONTRACT_ERRORS: Record<string, { status: number; code: string; message: string }> = {
  classpilot_active_staff_assignment_membership: {
    status: 409,
    code: "STAFF_ASSIGNMENTS_REQUIRE_REASSIGNMENT",
    message: "Resolve or reassign this staff member's active responsibilities before changing teaching access.",
  },
  staff_live_teaching_dependency_membership: {
    status: 409,
    code: "STAFF_ASSIGNMENTS_REQUIRE_REASSIGNMENT",
    message: "Resolve or reassign this staff member's live teaching responsibilities before changing teaching access.",
  },
  staff_live_active_dependency_membership: {
    status: 409,
    code: "STAFF_ASSIGNMENTS_REQUIRE_REASSIGNMENT",
    message: "Resolve or reassign this staff member's active responsibilities before removing access.",
  },
  staff_live_dependency_tenant_scope: {
    status: 409,
    code: "STAFF_DEPENDENCY_SCHOOL_MISMATCH",
    message: "This staff responsibility does not belong to the expected school.",
  },
  staff_live_dependency_teaching_membership: {
    status: 409,
    code: "STAFF_ASSIGNMENT_INELIGIBLE",
    message: "This responsibility requires an active teaching membership at the same school.",
  },
  staff_live_dependency_active_membership: {
    status: 409,
    code: "STAFF_ASSIGNMENT_INELIGIBLE",
    message: "This responsibility requires an active staff membership at the same school.",
  },
  classpilot_active_schedule_change_ownership: {
    status: 409,
    code: "STAFF_ACTIVE_SCHEDULE_CHANGE_OWNERSHIP_LOCKED",
    message: "Resolve the active class schedule change before changing class ownership.",
  },
  gopilot_homeroom_primary_teacher_mirror: {
    status: 409,
    code: "GOPILOT_HOMEROOM_PRIMARY_MIRROR_MISMATCH",
    message: "The homeroom's primary teacher relationships changed concurrently. Refresh and try again.",
  },
  classpilot_active_primary_teacher_membership: {
    status: 409,
    code: "STAFF_CLASS_ASSIGNMENT_INELIGIBLE",
    message: "The primary teacher must be active teaching staff at this school.",
  },
  classpilot_active_group_teacher_membership: {
    status: 409,
    code: "STAFF_CLASS_ASSIGNMENT_INELIGIBLE",
    message: "Every active class teacher must be active teaching staff at this school.",
  },
  classpilot_admin_class_primary_teacher_mirror: {
    status: 409,
    code: "STAFF_CLASS_PRIMARY_MIRROR_MISMATCH",
    message: "The class's primary teacher relationships changed concurrently. Refresh and try again.",
  },
  gopilot_active_staff_assignment_membership: {
    status: 409,
    code: "STAFF_ASSIGNMENTS_REQUIRE_REASSIGNMENT",
    message: "Resolve or reassign this staff member's active GoPilot responsibilities before changing teaching access.",
  },
  gopilot_active_homeroom_teacher_membership: {
    status: 409,
    code: "GOPILOT_HOMEROOM_TEACHER_INELIGIBLE",
    message: "A homeroom teacher must have an active GoPilot teacher role at this school.",
  },
  gopilot_homeroom_teacher_same_school: {
    status: 409,
    code: "GOPILOT_HOMEROOM_SCHOOL_MISMATCH",
    message: "A homeroom teacher relationship must belong to the same school as its homeroom.",
  },
  users_email_normalized_unique: {
    status: 409,
    code: "STAFF_EMAIL_IN_USE",
    message: "This email is already assigned to another account.",
  },
  users_email_unique: {
    status: 409,
    code: "STAFF_EMAIL_IN_USE",
    message: "This email is already assigned to another account.",
  },
  users_email_key: {
    status: 409,
    code: "STAFF_EMAIL_IN_USE",
    message: "This email is already assigned to another account.",
  },
  users_google_id_unique: {
    status: 409,
    code: "GOOGLE_STAFF_IDENTITY_CONFLICT",
    message: "This Google identity is already assigned to another account.",
  },
  users_google_id_key: {
    status: 409,
    code: "GOOGLE_STAFF_IDENTITY_CONFLICT",
    message: "This Google identity is already assigned to another account.",
  },
  school_memberships_user_school_role_unique: {
    status: 409,
    code: "STAFF_MEMBERSHIP_CONFLICT",
    message: "This staff membership already exists or changed concurrently.",
  },
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const reqId = req.requestId;
  // Prefix the log with the correlation id so it's greppable in CloudWatch.
  console.error(`Error [req:${reqId ?? "n/a"}]:`, safeErrorMetadata(err));

  // Track in error monitor for alerting
  const databaseError = getDatabaseErrorDetails(err);
  const databaseContract = databaseError.constraint
    ? DATABASE_CONTRACT_ERRORS[databaseError.constraint]
    : undefined;
  const status = databaseContract?.status || err.status || err.statusCode || 500;
  const errMsg = String(err?.message || err);

  // Ignore client-side network noise — not actionable server errors:
  // - "request aborted" = client disconnected mid-request (WiFi drop, sleep)
  // - "ECONNRESET" / "socket hang up" = transient TCP issues
  const isClientNetworkNoise = /request aborted|ECONNRESET|socket hang up|aborted/i.test(errMsg);

  // Shared correlation context recorded on the durable error_logs row.
  const ctx = {
    requestId: reqId,
    method: req.method,
    path: req.path,
    status,
    userId: req.authUser?.id,
    schoolId: res.locals?.schoolId,
  };

  if (status >= 500) {
    errorMonitor.trackError("api_error", err, ctx);
  } else if (status >= 400 && !isClientNetworkNoise) {
    errorMonitor.trackError("client_error", err, ctx);
  }

  if (res.headersSent) {
    return;
  }

  const message =
    databaseContract?.message ||
    (status < 500 || err.expose || process.env.NODE_ENV === "development"
      ? err.message
      : "Internal server error");

  // Return the requestId so a user/IT admin can quote it when reporting an
  // issue — it ties directly to the error_logs row + CloudWatch line.
  res.status(status).json({
    error: message,
    code: databaseContract?.code || err.code,
    requestId: reqId,
    ...(err?.details?.assignmentImpactRequired === true
      ? { assignmentImpactRequired: true }
      : {}),
    ...(typeof err.managementUrl === "string" ? { managementUrl: err.managementUrl } : {}),
    ...(res.locals?.managedDeviceContinuityAccepted === true
      ? { managedDeviceContinuityAccepted: true }
      : {}),
  });
};
