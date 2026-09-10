/** Fixed private labels; this module has no runtime, request, database or timer dependency. */
export const STUDENT_SIGN_IN_REASON_COUNTERS = {
  GLOBAL_API_RATE_LIMIT: "studentSignInReasonGlobalApiRateLimit",
  STUDENT_LOGIN_RATE_LIMIT: "studentSignInReasonStudentLoginRateLimit",
  PIN_LOCKOUT: "studentSignInReasonPinLockout",
  MANUAL_ISSUANCE_DISABLED: "studentSignInReasonManualIssuanceDisabled",
  DEVICE_BINDING_MISSING: "studentSignInReasonDeviceBindingMissing",
  EMAIL_ID_FIELDS_MISSING: "studentSignInReasonEmailIdFieldsMissing",
  EMAIL_SCHOOL_UNRESOLVED: "studentSignInReasonEmailSchoolUnresolved",
  SCHOOL_CONTEXT_MISMATCH: "studentSignInReasonSchoolContextMismatch",
  SHARED_SIGNIN_DISABLED: "studentSignInReasonSharedSigninDisabled",
  LOGIN_METHOD_DISABLED: "studentSignInReasonLoginMethodDisabled",
  ENROLLMENT_NOT_CONFIGURED: "studentSignInReasonEnrollmentNotConfigured",
  ENROLLMENT_KEY_INVALID_OR_MISSING: "studentSignInReasonEnrollmentKeyInvalidOrMissing",
  ENTITLEMENT_DENIED: "studentSignInReasonEntitlementDenied",
  MANAGED_DEVICE_CONTINUITY_UNAUTHORIZED: "studentSignInReasonManagedDeviceContinuityUnauthorized",
  SCHOOL_CONTEXT_MISSING: "studentSignInReasonSchoolContextMissing",
  STUDENT_SELECTION_MISSING: "studentSignInReasonStudentSelectionMissing",
  PIN_FORMAT_INVALID: "studentSignInReasonPinFormatInvalid",
  STUDENT_NOT_FOUND: "studentSignInReasonStudentNotFound",
  STUDENT_SCHOOL_MISMATCH: "studentSignInReasonStudentSchoolMismatch",
  STUDENT_INACTIVE: "studentSignInReasonStudentInactive",
  PIN_NOT_CONFIGURED: "studentSignInReasonPinNotConfigured",
  PIN_MISMATCH: "studentSignInReasonPinMismatch",
  STUDENT_ID_NUMBER_MISMATCH: "studentSignInReasonStudentIdNumberMismatch",
  MANAGED_DEVICE_CONTINUITY_UNAVAILABLE: "studentSignInReasonManagedDeviceContinuityUnavailable",
  STUDENT_SESSION_TRANSFER_UNAVAILABLE: "studentSignInReasonStudentSessionTransferUnavailable",
  STUDENT_SESSION_REPLACED: "studentSignInReasonStudentSessionReplaced",
  STUDENT_SESSION_ACTIVE: "studentSignInReasonStudentSessionActive",
  STUDENT_DEVICE_UNAVAILABLE: "studentSignInReasonStudentDeviceUnavailable",
  REQUEST_BODY_INVALID: "studentSignInReasonRequestBodyInvalid",
  REQUEST_BODY_TOO_LARGE: "studentSignInReasonRequestBodyTooLarge",
  REQUEST_ENCODING_UNSUPPORTED: "studentSignInReasonRequestEncodingUnsupported",
  POOL_ACQUISITION_FAILED: "studentSignInReasonPoolAcquisitionFailed",
  QUERY_CANCELLED: "studentSignInReasonQueryCancelled",
  AUTHORITY_CONTENTION: "studentSignInReasonAuthorityContention",
  CONNECTION_RESET: "studentSignInReasonConnectionReset",
  CONNECTION_REFUSED: "studentSignInReasonConnectionRefused",
  CONNECTION_TIMEOUT: "studentSignInReasonConnectionTimeout",
  CONNECTION_UNAVAILABLE: "studentSignInReasonConnectionUnavailable",
  DATABASE_ERROR: "studentSignInReasonDatabaseError",
  INTERNAL_ERROR: "studentSignInReasonInternalError",
  UNCLASSIFIED_HTTP_FAILURE: "studentSignInReasonUnclassifiedHttpFailure",
  REQUEST_INTERRUPTED: "studentSignInReasonRequestInterrupted",
} as const;

export type StudentSignInFailureReason = keyof typeof STUDENT_SIGN_IN_REASON_COUNTERS;
export const STUDENT_SIGN_IN_STAGES = [
  "ingress", "input_validation", "request_validation", "school_resolution", "entitlement",
  "tenant_checkout", "school_policy", "school_configuration", "enrollment_key", "continuity",
  "student_lookup", "credential_validation", "pin_lockout", "credential_check",
  "session_issuance", "response_preparation",
] as const;
export type StudentSignInStage = typeof STUDENT_SIGN_IN_STAGES[number];
export type StudentSignInMethod = "name_pin" | "email_id";

export const STUDENT_SIGN_IN_COUNTER_NAMES = [
  // Completed means terminal requests, including interrupted responses.
  "studentSignInCompleted", "studentSignInSuccess", "studentSignInFailure",
  "studentSignInDiagnosticSuppressed", "studentSignInDiagnosticSinkFailure",
  ...Object.values(STUDENT_SIGN_IN_REASON_COUNTERS),
] as const;
