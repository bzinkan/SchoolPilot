import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  varchar,
  timestamp,
  boolean,
  integer,
  index,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ============================================================================
// Schools - Unified across all products
// ============================================================================
export const schools = pgTable("schools", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  domain: text("domain").unique(), // Google Workspace domain
  slug: text("slug").unique(), // URL-friendly identifier (from GoPilot)
  address: text("address"),
  phone: text("phone"),

  // Status & plan
  status: text("status").notNull().default("trial"), // trial | active | suspended
  isActive: boolean("is_active").notNull().default(true),
  planTier: text("plan_tier").notNull().default("trial"), // trial | basic | pro | enterprise
  planStatus: text("plan_status").notNull().default("active"), // active | past_due | canceled
  activeUntil: timestamp("active_until"),
  trialEndsAt: timestamp("trial_ends_at"),

  // Billing (Stripe)
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  billingEmail: text("billing_email"),
  totalPaid: integer("total_paid").notNull().default(0), // cents
  lastPaymentAmount: integer("last_payment_amount"),
  lastPaymentDate: timestamp("last_payment_date"),

  // Licensing
  maxTeachers: integer("max_teachers").default(50),
  maxLicenses: integer("max_licenses").default(100), // ClassPilot student seats
  usedLicenses: integer("used_licenses").notNull().default(0),

  // PassPilot settings
  kioskEnabled: boolean("kiosk_enabled").notNull().default(true),
  kioskRequiresApproval: boolean("kiosk_requires_approval").notNull().default(false),
  defaultPassDuration: integer("default_pass_duration").notNull().default(5),
  kioskGradeId: varchar("kiosk_grade_id"),
  kioskActivatedByUserId: varchar("kiosk_activated_by_user_id"),
  activeGradeLevels: text("active_grade_levels"), // JSON array

  // GoPilot settings
  dismissalTime: text("dismissal_time"), // HH:MM format
  dismissalMode: text("dismissal_mode").notNull().default("no_app"), // app | no_app
  maxStudents: integer("max_students"),

  // ClassPilot settings
  trackingStartHour: integer("tracking_start_hour").notNull().default(7),
  trackingEndHour: integer("tracking_end_hour").notNull().default(17),
  is24HourEnabled: boolean("is_24_hour_enabled").notNull().default(false),
  disabledAt: timestamp("disabled_at"),
  disabledReason: text("disabled_reason"),
  lastActivityAt: timestamp("last_activity_at"),

  // Common
  schoolTimezone: text("school_timezone").notNull().default("America/New_York"),
  schoolSessionVersion: integer("school_session_version").notNull().default(1),
  settings: text("settings"), // JSON blob for misc settings

  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
  deletedAt: timestamp("deleted_at"),
});

export type School = typeof schools.$inferSelect;
export type InsertSchool = typeof schools.$inferInsert;

// ============================================================================
// Product Licenses - Which products a school has access to
// ============================================================================
export const productLicenses = pgTable(
  "product_licenses",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    product: text("product").notNull(), // PASSPILOT | GOPILOT | CLASSPILOT
    status: text("status").notNull().default("active"), // active | suspended | expired
    activatedAt: timestamp("activated_at").notNull().default(sql`now()`),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
  },
  (table) => [
    unique("product_licenses_school_product_unique").on(
      table.schoolId,
      table.product
    ),
    index("product_licenses_school_id_idx").on(table.schoolId),
  ]
);

export type ProductLicense = typeof productLicenses.$inferSelect;
export type InsertProductLicense = typeof productLicenses.$inferInsert;

// ============================================================================
// Users - Unified (supports teachers, admins, parents, super admins)
// ============================================================================
export const users = pgTable(
  "users",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    email: text("email").notNull().unique(),
    password: text("password"), // Nullable for OAuth users
    googleId: text("google_id").unique(),
    firstName: text("first_name").notNull().default(""),
    lastName: text("last_name").notNull().default(""),
    displayName: text("display_name"),
    phone: text("phone"),
    profileImageUrl: text("profile_image_url"),
    isSuperAdmin: boolean("is_super_admin").notNull().default(false),
    checkInMethod: text("check_in_method").default("app"), // GoPilot: app | manual
    notificationPrefs: text("notification_prefs"), // JSON from GoPilot
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
    lastLoginAt: timestamp("last_login_at"),
    updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
  },
  (table) => [
    index("users_google_id_idx").on(table.googleId),
    index("users_email_idx").on(table.email),
  ]
);

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// ============================================================================
// School Memberships - Users belong to schools with roles (from GoPilot model)
// ============================================================================
export const schoolMemberships = pgTable(
  "school_memberships",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: text("user_id").notNull(),
    schoolId: text("school_id").notNull(),
    role: text("role").notNull(), // admin | teacher | office_staff | parent
    status: text("status").notNull().default("active"),
    carNumber: text("car_number"), // GoPilot family car number
    kioskName: text("kiosk_name"), // PassPilot per-teacher kiosk name
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
  },
  (table) => [
    unique("school_memberships_user_school_role_unique").on(
      table.userId,
      table.schoolId,
      table.role
    ),
    index("school_memberships_user_id_idx").on(table.userId),
    index("school_memberships_school_id_idx").on(table.schoolId),
    uniqueIndex("school_memberships_car_number_unique")
      .on(table.schoolId, table.carNumber)
      .where(sql`car_number IS NOT NULL`),
  ]
);

export type SchoolMembership = typeof schoolMemberships.$inferSelect;
export type InsertSchoolMembership = typeof schoolMemberships.$inferInsert;
