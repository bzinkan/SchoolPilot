import { z } from "zod";

// ============================================================================
// Auth validation
// ============================================================================
export const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});
export type LoginData = z.infer<typeof loginSchema>;

export const registerSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  phone: z.string().optional(),
  // GoPilot-style: create school on register
  schoolName: z.string().optional(),
  timezone: z.string().optional(),
});
export type RegisterData = z.infer<typeof registerSchema>;

export const registerParentSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  phone: z.string().optional(),
  inviteToken: z.string().optional(),
});
export type RegisterParentData = z.infer<typeof registerParentSchema>;

// ============================================================================
// User management
// ============================================================================
export const createTeacherSchema = z.object({
  email: z.string().email("Invalid email address"),
  displayName: z.string().min(2, "Name must be at least 2 characters"),
  password: z
    .string()
    .min(6, "Password must be at least 6 characters")
    .optional(),
});
export type CreateTeacherData = z.infer<typeof createTeacherSchema>;

// ============================================================================
// Student management
// ============================================================================
export const createStudentSchema = z.object({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  email: z.string().email().optional().or(z.literal("")),
  studentIdNumber: z.string().optional().or(z.literal("")),
  gradeId: z.string().optional().or(z.literal("")),
  gradeLevel: z.string().optional().or(z.literal("")),
  homeroomId: z.string().optional().or(z.literal("")),
  dismissalType: z.string().optional(),
  busRoute: z.string().optional(),
});
export type CreateStudentData = z.infer<typeof createStudentSchema>;

// ============================================================================
// PassPilot validation
// ============================================================================
export const issuePassSchema = z.object({
  studentId: z.string().min(1),
  destination: z.enum([
    "bathroom",
    "nurse",
    "office",
    "counselor",
    "other_classroom",
    "custom",
  ]),
  customDestination: z.string().optional(),
  duration: z.number().min(1).optional(),
  gradeId: z.string().optional(),
  notes: z.string().optional(),
});
export type IssuePassData = z.infer<typeof issuePassSchema>;

export const kioskLookupSchema = z.object({
  studentIdNumber: z.string().min(1),
});

export const kioskCheckoutSchema = z.object({
  studentId: z.string().min(1),
  destination: z.enum([
    "bathroom",
    "nurse",
    "office",
    "counselor",
    "other_classroom",
    "custom",
  ]),
  customDestination: z.string().optional(),
});

export const createGradeSchema = z.object({
  name: z.string().min(1, "Class name is required"),
  displayOrder: z.number().optional(),
});
export type CreateGradeData = z.infer<typeof createGradeSchema>;

// ============================================================================
// School management
// ============================================================================
export const createSchoolSchema = z.object({
  name: z.string().min(1, "School name is required"),
  domain: z
    .string()
    .min(1, "Domain is required")
    .regex(
      /^[a-z0-9.-]+\.[a-z]{2,}$/,
      "Invalid domain format (e.g., school.org)"
    )
    .optional(),
  status: z.enum(["trial", "active", "suspended"]).optional(),
  maxLicenses: z.number().min(1).optional(),
  maxTeachers: z.number().min(1).optional(),
  timezone: z.string().optional(),
  products: z
    .array(z.enum(["PASSPILOT", "GOPILOT", "CLASSPILOT"]))
    .optional(),
});
export type CreateSchoolData = z.infer<typeof createSchoolSchema>;

export const updateSchoolSchema = z.object({
  name: z.string().min(1).optional(),
  domain: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  status: z.enum(["trial", "active", "suspended"]).optional(),
  planTier: z.enum(["trial", "basic", "pro", "enterprise"]).optional(),
  maxTeachers: z.number().min(1).optional(),
  maxLicenses: z.number().min(1).optional(),
  billingEmail: z.string().email().optional().nullable(),
  schoolTimezone: z.string().optional(),
  // PassPilot
  kioskEnabled: z.boolean().optional(),
  kioskRequiresApproval: z.boolean().optional(),
  defaultPassDuration: z.number().min(1).optional(),
  // GoPilot
  dismissalTime: z.string().optional().nullable(),
  dismissalMode: z.enum(["app", "no_app"]).optional(),
  maxStudents: z.number().min(1).optional().nullable(),
  // ClassPilot
  trackingStartHour: z.number().min(0).max(23).optional(),
  trackingEndHour: z.number().min(0).max(23).optional(),
  is24HourEnabled: z.boolean().optional(),
});
export type UpdateSchoolData = z.infer<typeof updateSchoolSchema>;

export const updateStudentSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  email: z.string().email().optional().nullable().or(z.literal("")),
  studentIdNumber: z.string().optional().nullable().or(z.literal("")),
  gradeId: z.string().optional().nullable().or(z.literal("")),
  gradeLevel: z.string().optional().nullable().or(z.literal("")),
  homeroomId: z.string().optional().nullable().or(z.literal("")),
  dismissalType: z.string().optional(),
  busRoute: z.string().optional().nullable(),
  status: z.enum(["active", "inactive"]).optional(),
});
export type UpdateStudentData = z.infer<typeof updateStudentSchema>;

export const updateUserSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  phone: z.string().optional().nullable(),
});
export type UpdateUserData = z.infer<typeof updateUserSchema>;

export const updateMembershipSchema = z.object({
  role: z.enum(["admin", "teacher", "office_staff", "parent"]).optional(),
  kioskName: z.string().optional().nullable(),
  carNumber: z.string().optional().nullable(),
});
export type UpdateMembershipData = z.infer<typeof updateMembershipSchema>;

// ============================================================================
// Trial requests
// ============================================================================
export const trialRequestSchema = z.object({
  schoolName: z.string().min(2, "School name is required"),
  domain: z.string().optional(),
  contactName: z.string().min(2, "Your name is required"),
  contactEmail: z.string().email("Valid email is required"),
  estimatedStudents: z.string().optional(),
  estimatedTeachers: z.string().optional(),
  message: z.string().optional(),
  product: z.enum(["PASSPILOT", "GOPILOT", "CLASSPILOT"]).optional(),
});
export type TrialRequestData = z.infer<typeof trialRequestSchema>;
