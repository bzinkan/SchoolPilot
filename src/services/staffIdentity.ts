import type { Response } from "express";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import db from "../db.js";
import {
  schoolMemberships,
  users,
  type SchoolMembership,
  type User,
} from "../schema/core.js";
import { hashPassword } from "../util/password.js";
import { invalidateUserCredentialConnections } from "../realtime/cacheInvalidation.js";
import { isDatabaseErrorCode } from "../util/databaseError.js";
import {
  getMembershipsByUserAndSchoolIncludingInactive,
  getStaffBySchool,
  getStudentByEmail,
  getUserById,
  getUserByEmail,
  getUserByGoogleId,
  invalidateClasspilotPassiveAuthorization,
  insertStaffIdentityAudit,
  isStaffMembershipRole,
  reactivateStaffMembershipForSchool,
  staffIdentityEmailLockKey,
  staffIdentityGoogleLockKey,
  staffIdentityNameLockKey,
  staffIdentityUserLockKey,
  takeStaffIdentityLocks,
  updateStaffEmailIdentity,
  validateStaffEmailDomainForSchool,
  type StaffIdentityAuditActor,
} from "./storage.js";

export class StaffIdentityError extends Error {
  readonly expose = true;

  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "StaffIdentityError";
  }
}

export function isStaffIdentityError(error: unknown): error is StaffIdentityError {
  return error instanceof StaffIdentityError;
}

export function sendStaffIdentityError(
  res: Response,
  error: unknown
): boolean {
  if (!isStaffIdentityError(error)) return false;
  res.status(error.status).json({
    error: error.message,
    code: error.code,
    ...error.details,
  });
  return true;
}

export function normalizeStaffEmail(email: string): string {
  return email.trim().toLowerCase();
}

const staffEmailSchema = z.string().trim().email();

export function normalizeStaffName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

type StaffNameCandidate = {
  membershipId: string;
  userId: string;
  status: string;
  role: string;
  user: Pick<User, "id" | "email" | "firstName" | "lastName" | "displayName">;
};

function displayNameForUser(user: Pick<User, "firstName" | "lastName" | "displayName">): string {
  return user.displayName?.trim()
    || [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
}

async function sameNameCandidates(
  schoolId: string,
  name: string,
  email: string,
  dbInstance: typeof db = db
): Promise<StaffNameCandidate[]> {
  const normalizedName = normalizeStaffName(name);
  if (!normalizedName) return [];
  const normalizedEmail = normalizeStaffEmail(email);
  const rows = await getStaffBySchool(schoolId, "all", dbInstance);
  return rows
    .filter((row) =>
      normalizeStaffEmail(row.user.email) !== normalizedEmail
      && normalizeStaffName(displayNameForUser(row.user)) === normalizedName
    )
    .map((row) => ({
      membershipId: row.id,
      userId: row.userId,
      status: row.status,
      role: row.role,
      user: {
        id: row.user.id,
        email: row.user.email,
        firstName: row.user.firstName,
        lastName: row.user.lastName,
        displayName: row.user.displayName,
      },
    }));
}

function nameParts(options: {
  email: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
}) {
  const suppliedDisplay = options.displayName?.trim();
  const split = suppliedDisplay?.split(/\s+/) ?? [];
  const firstName = options.firstName?.trim() || split[0] || options.email.split("@")[0] || "";
  const lastName = options.lastName?.trim() || split.slice(1).join(" ");
  const displayName = suppliedDisplay || [firstName, lastName].filter(Boolean).join(" ");
  return { firstName, lastName, displayName };
}

async function assertStaffEmailAllowed(
  email: string,
  schoolId: string,
  dbInstance: typeof db = db
): Promise<void> {
  if (!staffEmailSchema.safeParse(email).success) {
    throw new StaffIdentityError(
      "STAFF_EMAIL_INVALID",
      "Enter a valid staff email address.",
      422
    );
  }
  const validation = await validateStaffEmailDomainForSchool(email, schoolId, dbInstance);
  if (!validation.ok) {
    throw new StaffIdentityError(
      validation.code || "STAFF_EMAIL_DOMAIN_MISMATCH",
      validation.message || "Staff email is not valid for this school.",
      422,
      {
        expectedDomain: validation.expectedDomain ?? null,
        actualDomain: validation.actualDomain ?? null,
      }
    );
  }
  const studentClash = await getStudentByEmail(
    schoolId,
    normalizeStaffEmail(email),
    dbInstance
  );
  if (studentClash) {
    throw new StaffIdentityError(
      "EMAIL_IN_USE_BY_STUDENT",
      "This email is already assigned to a student in this school. Each person needs a unique email.",
      409
    );
  }
}

function isUniqueViolation(error: unknown): boolean {
  return isDatabaseErrorCode(error, "23505");
}

function membershipConflict(memberships: SchoolMembership[]): StaffIdentityError | null {
  const active = memberships.find((membership) => membership.status === "active");
  if (active) {
    return new StaffIdentityError(
      "STAFF_MEMBERSHIP_ALREADY_ACTIVE",
      "This person already has an active membership in this school.",
      409,
      { membershipId: active.id, userId: active.userId, status: active.status }
    );
  }
  const inactive = memberships[0];
  if (inactive) {
    return new StaffIdentityError(
      "STAFF_REACTIVATION_REQUIRED",
      "This person already has an inactive school membership. Reactivate it instead of creating a new identity.",
      409,
      { membershipId: inactive.id, userId: inactive.userId, status: inactive.status }
    );
  }
  return null;
}

function centralAttachmentError(): StaffIdentityError {
  return new StaffIdentityError(
    "STAFF_IDENTITY_CENTRAL_REVIEW_REQUIRED",
    "This identity has central or other-school access. A Super Admin must use the central staff workflow to change it.",
    409
  );
}

async function assertGlobalIdentityAttachmentAllowed(options: {
  dbInstance: typeof db;
  user: Pick<User, "id" | "isSuperAdmin">;
  schoolId: string;
  allowGlobalIdentityAttachment?: boolean;
  rejectGlobalIdentityEvenWhenCurrent?: boolean;
}): Promise<void> {
  if (options.allowGlobalIdentityAttachment === true) return;
  const memberships = await options.dbInstance
    .select()
    .from(schoolMemberships)
    .where(eq(schoolMemberships.userId, options.user.id));
  const hasCurrentSchoolStaffMembership = memberships.some(
    (membership) =>
      membership.schoolId === options.schoolId
      && isStaffMembershipRole(membership)
  );
  if (hasCurrentSchoolStaffMembership && !options.rejectGlobalIdentityEvenWhenCurrent) return;
  if (
    options.user.isSuperAdmin
    || memberships.some((membership) => membership.schoolId !== options.schoolId)
  ) {
    throw centralAttachmentError();
  }
}

export async function createStaffIdentityForSchool(options: {
  schoolId: string;
  email: string;
  role: string;
  gopilotRole?: string | null;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  password?: string | null;
  confirmDistinctPerson?: boolean;
  /** True only from an explicitly authorized Super Admin central route. */
  allowGlobalIdentityAttachment?: boolean;
  audit: StaffIdentityAuditActor;
  auditAction?: string;
}): Promise<{
  user: User;
  membership: SchoolMembership;
  createdUser: boolean;
  distinctIdentityConfirmed: boolean;
  candidateUserIds: string[];
}> {
  const email = normalizeStaffEmail(options.email);
  const names = nameParts({ ...options, email });
  const password = options.password ? await hashPassword(options.password) : null;
  try {
    const result = await db.transaction(async (tx) => {
      const transactionDb = tx as unknown as typeof db;
      await takeStaffIdentityLocks(transactionDb, [
        staffIdentityNameLockKey(options.schoolId, normalizeStaffName(names.displayName)),
        staffIdentityEmailLockKey(email),
      ]);
      await assertStaffEmailAllowed(email, options.schoolId, transactionDb);

      let user = await getUserByEmail(email, transactionDb);
      let createdUser = false;
      let candidates: StaffNameCandidate[] = [];
      if (!user) {
        candidates = await sameNameCandidates(
          options.schoolId,
          names.displayName,
          email,
          transactionDb
        );
        if (candidates.length > 0 && !options.confirmDistinctPerson) {
          throw new StaffIdentityError(
            "POSSIBLE_DUPLICATE_STAFF",
            "A staff account with this name already exists. Correct or reactivate that identity, or explicitly confirm this is a different person.",
            409,
            { candidates }
          );
        }
        const [created] = await tx
          .insert(users)
          .values({
            email,
            password,
            firstName: names.firstName,
            lastName: names.lastName,
            displayName: names.displayName,
          })
          .returning();
        user = created!;
        createdUser = true;
      } else {
        await takeStaffIdentityLocks(transactionDb, [staffIdentityUserLockKey(user.id)]);
      }

      const existingMemberships = await getMembershipsByUserAndSchoolIncludingInactive(
        user.id,
        options.schoolId,
        transactionDb
      );
      const conflict = membershipConflict(existingMemberships);
      if (conflict) throw conflict;
      await assertGlobalIdentityAttachmentAllowed({
        dbInstance: transactionDb,
        user,
        schoolId: options.schoolId,
        allowGlobalIdentityAttachment: options.allowGlobalIdentityAttachment,
        rejectGlobalIdentityEvenWhenCurrent: true,
      });

      const [membership] = await tx
        .insert(schoolMemberships)
        .values({
          userId: user.id,
          schoolId: options.schoolId,
          role: options.role,
          gopilotRole: options.gopilotRole ?? null,
          status: "active",
        })
        .returning();
      if (!membership) throw new Error("Staff membership could not be created.");

      await insertStaffIdentityAudit(transactionDb, {
        schoolId: options.schoolId,
        actor: options.audit,
        action: options.auditAction ?? "school.staff.created",
        entityType: "school_membership",
        entityId: membership.id,
        fields: ["role", ...(options.gopilotRole ? ["gopilotRole"] : [])],
        metadata: {
          targetUserId: user.id,
          identityCreated: createdUser,
          distinctIdentityConfirmed:
            candidates.length > 0 && options.confirmDistinctPerson === true,
        },
      });
      if (candidates.length > 0 && options.confirmDistinctPerson === true) {
        await insertStaffIdentityAudit(transactionDb, {
          schoolId: options.schoolId,
          actor: options.audit,
          action: "school.staff.distinct_identity_confirmed",
          entityType: "school_membership",
          entityId: membership.id,
          fields: ["confirmDistinctPerson"],
          metadata: {
            targetUserId: user.id,
            candidateUserIds: candidates.map((candidate) => candidate.userId),
          },
        });
      }

      return {
        user,
        membership,
        createdUser,
        distinctIdentityConfirmed:
          candidates.length > 0 && options.confirmDistinctPerson === true,
        candidateUserIds: candidates.map((candidate) => candidate.userId),
      };
    });
    await invalidateClasspilotPassiveAuthorization(options.schoolId);
    return result;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const existingUser = await getUserByEmail(email);
    if (existingUser) {
      const raced = await getMembershipsByUserAndSchoolIncludingInactive(
        existingUser.id,
        options.schoolId
      );
      const conflict = membershipConflict(raced);
      if (conflict) throw conflict;
    }
    throw new StaffIdentityError(
      "STAFF_EMAIL_IN_USE",
      "This email is already assigned to another account.",
      409
    );
  }
}

function emailMutationError(
  result: Exclude<Awaited<ReturnType<typeof updateStaffEmailIdentity>>, { outcome: "updated" | "unchanged" }>
): StaffIdentityError {
  switch (result.outcome) {
    case "not_found":
      return new StaffIdentityError("STAFF_MEMBERSHIP_NOT_FOUND", "Staff membership not found.", 404);
    case "stale":
      return new StaffIdentityError(
        "STAFF_EMAIL_STALE",
        "The staff email changed after this form was opened. Refresh and try again.",
        409,
        { currentEmail: result.currentEmail }
      );
    case "central_review_required":
      return new StaffIdentityError(
        "STAFF_EMAIL_CENTRAL_REVIEW_REQUIRED",
        "This identity belongs to more than one school. A Super Admin must review the global email change.",
        409,
        { affectedSchoolCount: result.otherSchoolIds.length + 1 }
      );
    case "central_attachment_required":
      return centralAttachmentError();
    case "domain_error":
      return new StaffIdentityError(
        result.code,
        result.code === "SCHOOL_DOMAIN_REQUIRED"
          ? "Every affected school must have a domain before this email can be changed."
          : "The new email must match every affected school's Google Workspace domain.",
        422,
        {
          expectedDomain: result.expectedDomain,
          actualDomain: result.actualDomain,
          affectedSchoolId: result.schoolId,
        }
      );
    case "student_collision":
      return new StaffIdentityError(
        "EMAIL_IN_USE_BY_STUDENT",
        "This email is already assigned to a student in an affected school. Each person needs a unique email.",
        409
      );
    case "email_in_use":
      return new StaffIdentityError(
        "STAFF_EMAIL_IN_USE",
        "This email is already assigned to another account. Identities are never merged automatically.",
        409
      );
    case "reactivation_required":
      return new StaffIdentityError(
        "STAFF_REACTIVATION_REQUIRED",
        "This person already has an inactive school membership. Reactivate it before importing identity changes.",
        409,
        {
          membershipId: result.membership.id,
          userId: result.user.id,
          status: result.membership.status,
        }
      );
  }
}

export async function changeStaffEmailForMembership(options: {
  schoolId: string;
  membershipId: string;
  expectedEmail: string;
  email: string;
  allowMultiSchool: boolean;
  allowCentralIdentityMutation?: boolean;
  audit: StaffIdentityAuditActor;
}): Promise<{ user: User; membership: SchoolMembership }> {
  let result;
  try {
    result = await updateStaffEmailIdentity(options);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new StaffIdentityError(
        "STAFF_EMAIL_IN_USE",
        "This email is already assigned to another account. Identities are never merged automatically.",
        409
      );
    }
    throw error;
  }
  if (result.outcome !== "updated" && result.outcome !== "unchanged") {
    throw emailMutationError(result);
  }
  if (!result.membership) {
    throw new StaffIdentityError("STAFF_MEMBERSHIP_NOT_FOUND", "Staff membership not found.", 404);
  }
  return { user: result.user, membership: result.membership };
}

export async function reactivateStaffIdentity(options: {
  schoolId: string;
  membershipId: string;
  allowCentralIdentityMutation?: boolean;
  audit: StaffIdentityAuditActor;
}): Promise<{ user: User; membership: SchoolMembership }> {
  const result = await reactivateStaffMembershipForSchool(
    options.membershipId,
    options.schoolId,
    options.audit,
    options.allowCentralIdentityMutation === true
  );
  switch (result.outcome) {
    case "reactivated":
      return { user: result.user, membership: result.membership };
    case "not_found":
      throw new StaffIdentityError("STAFF_MEMBERSHIP_NOT_FOUND", "Staff membership not found.", 404);
    case "already_active":
      throw new StaffIdentityError(
        "STAFF_MEMBERSHIP_ALREADY_ACTIVE",
        "This staff membership is already active.",
        409,
        { membershipId: result.membership.id, userId: result.user.id }
      );
    case "central_review_required":
      throw centralAttachmentError();
    case "domain_error":
      throw new StaffIdentityError(
        result.code,
        result.code === "SCHOOL_DOMAIN_REQUIRED"
          ? "School domain is required before reactivating staff accounts."
          : "The staff email must match the school's Google Workspace domain before reactivation.",
        422,
        {
          expectedDomain: result.expectedDomain,
          actualDomain: result.actualDomain,
        }
      );
    case "student_collision":
      throw new StaffIdentityError(
        "EMAIL_IN_USE_BY_STUDENT",
        "This email is already assigned to a student in this school. Each person needs a unique email.",
        409
      );
  }
}

export async function resolveWorkspaceStaffUserForSchool(options: {
  schoolId: string;
  email: string;
  googleId?: string | null;
  firstName?: string;
  lastName?: string;
  allowMultiSchoolEmailChange: boolean;
  /** True only after explicit Super Admin confirmation for this import. */
  allowGlobalIdentityAttachment?: boolean;
  audit: StaffIdentityAuditActor;
}): Promise<{ user: User; createdUser: boolean; emailChanged: boolean }> {
  const email = normalizeStaffEmail(options.email);
  if (!staffEmailSchema.safeParse(email).success) {
    throw new StaffIdentityError(
      "STAFF_EMAIL_INVALID",
      "Enter a valid staff email address.",
      422
    );
  }
  const googleId = options.googleId?.trim() || null;
  const [byGoogleId, byEmail] = await Promise.all([
    googleId ? getUserByGoogleId(googleId) : Promise.resolve(undefined),
    getUserByEmail(email),
  ]);
  if (byGoogleId && byEmail && byGoogleId.id !== byEmail.id) {
    throw new StaffIdentityError(
      "GOOGLE_STAFF_IDENTITY_CONFLICT",
      "Google identity and email resolve to different SchoolPilot accounts. Review the identities manually; they will not be merged.",
      409
    );
  }

  if (byGoogleId) {
    let result;
    try {
      result = await updateStaffEmailIdentity({
        schoolId: options.schoolId,
        userId: byGoogleId.id,
        expectedEmail: byGoogleId.email,
        email,
        allowMultiSchool: options.allowMultiSchoolEmailChange,
        allowGlobalIdentityAttachment: options.allowGlobalIdentityAttachment,
        rejectGlobalIdentityEvenWhenCurrent: true,
        rejectInactiveCurrentSchoolMembership: true,
        audit: options.audit,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new StaffIdentityError(
          "GOOGLE_STAFF_IDENTITY_CONFLICT",
          "The new Google email is already assigned to another SchoolPilot identity. Review it manually; identities will not be merged.",
          409
        );
      }
      throw error;
    }
    if (result.outcome !== "updated" && result.outcome !== "unchanged") {
      throw emailMutationError(result);
    }
    return { user: result.user, createdUser: false, emailChanged: result.outcome === "updated" };
  }

  let resolvedByEmail = byEmail;
  if (resolvedByEmail?.googleId && googleId && resolvedByEmail.googleId !== googleId) {
    throw new StaffIdentityError(
      "GOOGLE_STAFF_IDENTITY_CONFLICT",
      "This email is already bound to a different Google identity. Review it manually; identities will not be merged.",
      409
    );
  }

  // Normalize a legacy mixed-case/whitespace email under the same user lock
  // before binding Google identity. The inactive-membership precondition is in
  // that transaction, so a skipped import cannot change identity state.
  if (resolvedByEmail && resolvedByEmail.email !== email) {
    const normalized = await updateStaffEmailIdentity({
      schoolId: options.schoolId,
      userId: resolvedByEmail.id,
      expectedEmail: resolvedByEmail.email,
      email,
      allowMultiSchool: options.allowMultiSchoolEmailChange,
      allowGlobalIdentityAttachment: options.allowGlobalIdentityAttachment,
      rejectGlobalIdentityEvenWhenCurrent: true,
      rejectInactiveCurrentSchoolMembership: true,
      audit: options.audit,
    });
    if (normalized.outcome !== "updated" && normalized.outcome !== "unchanged") {
      throw emailMutationError(normalized);
    }
    resolvedByEmail = normalized.user;
  }

  const names = nameParts({
    email,
    firstName: options.firstName,
    lastName: options.lastName,
  });
  try {
    const result = await db.transaction(async (tx) => {
      const transactionDb = tx as unknown as typeof db;
      await takeStaffIdentityLocks(transactionDb, [
        staffIdentityNameLockKey(options.schoolId, normalizeStaffName(names.displayName)),
        staffIdentityEmailLockKey(email),
        ...(googleId ? [staffIdentityGoogleLockKey(googleId)] : []),
      ]);
      await assertStaffEmailAllowed(email, options.schoolId, transactionDb);

      const [currentByGoogleId, currentByEmail] = await Promise.all([
        googleId ? getUserByGoogleId(googleId, transactionDb) : Promise.resolve(undefined),
        getUserByEmail(email, transactionDb),
      ]);
      if (
        currentByGoogleId
        && currentByEmail
        && currentByGoogleId.id !== currentByEmail.id
      ) {
        throw new StaffIdentityError(
          "GOOGLE_STAFF_IDENTITY_CONFLICT",
          "Google identity and email resolve to different SchoolPilot accounts. Review the identities manually; they will not be merged.",
          409
        );
      }
      // A Google identity appearing after the initial read may require a
      // multi-school email correction. Fail closed and retry the row instead of
      // taking a partial shortcut inside this binding transaction.
      if (currentByGoogleId && !currentByEmail) {
        throw new StaffIdentityError(
          "GOOGLE_STAFF_IDENTITY_CONFLICT",
          "The Google identity changed while the import was running. Refresh the Workspace data and review the account.",
          409
        );
      }

      let user = currentByEmail;
      let createdUser = false;
      if (user) {
        await takeStaffIdentityLocks(transactionDb, [staffIdentityUserLockKey(user.id)]);
        const memberships = await getMembershipsByUserAndSchoolIncludingInactive(
          user.id,
          options.schoolId,
          transactionDb
        );
        const hasActive = memberships.some(
          (membership) => membership.status === "active" && isStaffMembershipRole(membership)
        );
        const inactive = memberships.find(
          (membership) => membership.status !== "active" && isStaffMembershipRole(membership)
        );
        if (!hasActive && inactive) {
          throw new StaffIdentityError(
            "STAFF_REACTIVATION_REQUIRED",
            "This person already has an inactive school membership. Reactivate it before importing identity changes.",
            409,
            { membershipId: inactive.id, userId: user.id, status: inactive.status }
          );
        }
        await assertGlobalIdentityAttachmentAllowed({
          dbInstance: transactionDb,
          user,
          schoolId: options.schoolId,
          allowGlobalIdentityAttachment: options.allowGlobalIdentityAttachment,
          rejectGlobalIdentityEvenWhenCurrent: true,
        });
        if (googleId && user.googleId && user.googleId !== googleId) {
          throw new StaffIdentityError(
            "GOOGLE_STAFF_IDENTITY_CONFLICT",
            "This email is already bound to a different Google identity. Review it manually; identities will not be merged.",
            409
          );
        }
        if (googleId && !user.googleId) {
          const [updated] = await tx
            .update(users)
            .set({ googleId, updatedAt: new Date() })
            .where(eq(users.id, user.id))
            .returning();
          if (!updated) {
            throw new StaffIdentityError("STAFF_IDENTITY_NOT_FOUND", "Staff identity not found.", 404);
          }
          user = updated;
          await insertStaffIdentityAudit(transactionDb, {
            schoolId: options.schoolId,
            actor: options.audit,
            action: "school.staff.google_identity_bound",
            entityType: "user",
            entityId: user.id,
            fields: ["googleId"],
            metadata: { targetUserId: user.id },
          });
        }
      } else {
        const candidates = await sameNameCandidates(
          options.schoolId,
          names.displayName,
          email,
          transactionDb
        );
        if (candidates.length > 0) {
          throw new StaffIdentityError(
            "POSSIBLE_DUPLICATE_STAFF",
            "A staff account with this name already exists. Review it before importing another identity.",
            409,
            { candidates }
          );
        }
        const [created] = await tx
          .insert(users)
          .values({
            email,
            firstName: names.firstName,
            lastName: names.lastName,
            displayName: names.displayName,
            googleId,
          })
          .returning();
        user = created!;
        createdUser = true;
        await insertStaffIdentityAudit(transactionDb, {
          schoolId: options.schoolId,
          actor: options.audit,
          action: "school.staff.workspace_identity_created",
          entityType: "user",
          entityId: user.id,
          fields: ["identity", ...(googleId ? ["googleId"] : [])],
          metadata: { targetUserId: user.id },
        });
      }
      return { user, createdUser, emailChanged: false };
    });
    return result;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    throw new StaffIdentityError(
      googleId ? "GOOGLE_STAFF_IDENTITY_CONFLICT" : "STAFF_EMAIL_IN_USE",
      "The staff identity changed while it was being imported. Refresh the Workspace data and review the account.",
      409
    );
  }
}

/**
 * Attach a Workspace-resolved identity to one school. The global-identity
 * check and membership insert share the canonical user lock, so an
 * other-school membership or Super Admin promotion cannot win the race.
 */
export async function attachWorkspaceStaffMembershipForSchool(options: {
  schoolId: string;
  userId: string;
  role: string;
  gopilotRole?: string | null;
  allowGlobalIdentityAttachment?: boolean;
  audit: StaffIdentityAuditActor;
}): Promise<{ membership: SchoolMembership; created: boolean }> {
  const preliminaryUser = await getUserById(options.userId);
  if (!preliminaryUser) {
    throw new StaffIdentityError("STAFF_IDENTITY_NOT_FOUND", "Staff identity not found.", 404);
  }
  const result = await db.transaction(async (tx) => {
    const transactionDb = tx as unknown as typeof db;
    await takeStaffIdentityLocks(transactionDb, [
      staffIdentityEmailLockKey(preliminaryUser.email),
      staffIdentityUserLockKey(options.userId),
    ]);
    const [lockedUser] = await tx
      .select()
      .from(users)
      .where(eq(users.id, options.userId))
      .limit(1)
      .for("update");
    if (
      !lockedUser
      || normalizeStaffEmail(lockedUser.email) !== normalizeStaffEmail(preliminaryUser.email)
    ) {
      throw new StaffIdentityError(
        "STAFF_IDENTITY_STALE",
        "The staff identity changed while it was being imported. Refresh the Workspace data and try again.",
        409
      );
    }
    await assertStaffEmailAllowed(lockedUser.email, options.schoolId, transactionDb);
    const currentMemberships = await getMembershipsByUserAndSchoolIncludingInactive(
      lockedUser.id,
      options.schoolId,
      transactionDb
    );
    const active = currentMemberships.find(
      (membership) => membership.status === "active" && isStaffMembershipRole(membership)
    );
    if (active) return { membership: active, created: false } as const;
    const inactive = currentMemberships.find(isStaffMembershipRole);
    if (inactive) {
      throw new StaffIdentityError(
        "STAFF_REACTIVATION_REQUIRED",
        "This person already has an inactive school membership. Reactivate it instead of creating another identity.",
        409,
        { membershipId: inactive.id, userId: inactive.userId, status: inactive.status }
      );
    }
    await assertGlobalIdentityAttachmentAllowed({
      dbInstance: transactionDb,
      user: lockedUser,
      schoolId: options.schoolId,
      allowGlobalIdentityAttachment: options.allowGlobalIdentityAttachment,
    });
    const [membership] = await tx
      .insert(schoolMemberships)
      .values({
        userId: lockedUser.id,
        schoolId: options.schoolId,
        role: options.role,
        gopilotRole: options.gopilotRole ?? null,
        status: "active",
      })
      .returning();
    if (!membership) throw new Error("Staff membership could not be created.");
    await insertStaffIdentityAudit(transactionDb, {
      schoolId: options.schoolId,
      actor: options.audit,
      action: "school.staff.workspace_membership_created",
      entityType: "school_membership",
      entityId: membership.id,
      fields: ["role", ...(options.gopilotRole ? ["gopilotRole"] : [])],
      metadata: { targetUserId: lockedUser.id },
    });
    return { membership, created: true } as const;
  });
  if (result.created) await invalidateClasspilotPassiveAuthorization(options.schoolId);
  return result;
}

/**
 * Update global profile fields from a school-scoped editor without allowing a
 * tenant administrator to rename a central or other-school identity.
 */
export async function updateSchoolScopedStaffProfile(options: {
  schoolId: string;
  membershipId: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  allowCentralIdentityMutation?: boolean;
}): Promise<{ user: User; membership: SchoolMembership }> {
  const [preliminaryMembership] = await db
    .select()
    .from(schoolMemberships)
    .where(
      and(
        eq(schoolMemberships.id, options.membershipId),
        eq(schoolMemberships.schoolId, options.schoolId)
      )
    )
    .limit(1);
  if (!preliminaryMembership || !isStaffMembershipRole(preliminaryMembership)) {
    throw new StaffIdentityError("STAFF_MEMBERSHIP_NOT_FOUND", "Staff membership not found.", 404);
  }
  const preliminaryUser = await getUserById(preliminaryMembership.userId);
  if (!preliminaryUser) {
    throw new StaffIdentityError("STAFF_IDENTITY_NOT_FOUND", "Staff identity not found.", 404);
  }

  return db.transaction(async (tx) => {
    const transactionDb = tx as unknown as typeof db;
    await takeStaffIdentityLocks(transactionDb, [
      staffIdentityEmailLockKey(preliminaryUser.email),
      staffIdentityUserLockKey(preliminaryUser.id),
    ]);
    const [membership] = await tx
      .select()
      .from(schoolMemberships)
      .where(
        and(
          eq(schoolMemberships.id, options.membershipId),
          eq(schoolMemberships.schoolId, options.schoolId)
        )
      )
      .limit(1)
      .for("update");
    if (
      !membership
      || membership.userId !== preliminaryUser.id
      || !isStaffMembershipRole(membership)
    ) {
      throw new StaffIdentityError("STAFF_MEMBERSHIP_NOT_FOUND", "Staff membership not found.", 404);
    }
    const [user] = await tx
      .select()
      .from(users)
      .where(eq(users.id, membership.userId))
      .limit(1)
      .for("update");
    if (
      !user
      || normalizeStaffEmail(user.email) !== normalizeStaffEmail(preliminaryUser.email)
    ) {
      throw new StaffIdentityError(
        "STAFF_IDENTITY_STALE",
        "The staff identity changed concurrently. Refresh and try again.",
        409
      );
    }
    const memberships = await tx
      .select({ schoolId: schoolMemberships.schoolId })
      .from(schoolMemberships)
      .where(eq(schoolMemberships.userId, user.id));
    if (
      (user.isSuperAdmin || memberships.some((row) => row.schoolId !== options.schoolId))
      && options.allowCentralIdentityMutation !== true
    ) {
      throw centralAttachmentError();
    }

    const clean = (
      value: string | undefined,
      label: string,
      allowEmpty = false
    ): string | undefined => {
      if (value === undefined) return undefined;
      if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
        throw new StaffIdentityError(
          "STAFF_PROFILE_INVALID",
          `${label} must not be empty.`,
          422
        );
      }
      return value.trim();
    };
    const requestedFirstName = clean(options.firstName, "First name");
    const requestedLastName = clean(options.lastName, "Last name", true);
    const requestedDisplayName = clean(options.displayName, "Display name");
    const firstName = requestedFirstName ?? user.firstName;
    const lastName = requestedLastName ?? user.lastName;
    const displayName = requestedDisplayName
      ?? (requestedFirstName !== undefined || requestedLastName !== undefined
        ? [firstName, lastName].filter(Boolean).join(" ").trim()
        : user.displayName);
    const [updated] = await tx
      .update(users)
      .set({ firstName, lastName, displayName, updatedAt: new Date() })
      .where(eq(users.id, user.id))
      .returning();
    if (!updated) {
      throw new StaffIdentityError("STAFF_IDENTITY_NOT_FOUND", "Staff identity not found.", 404);
    }
    return { user: updated, membership };
  });
}

/**
 * A school administrator may rotate credentials only for an identity owned by
 * exactly that school. Super Admin and multi-school credentials require the
 * central workflow so a tenant administrator cannot take over global access.
 */
export async function resetSchoolScopedStaffPassword(options: {
  schoolId: string;
  membershipId: string;
  password: string;
  audit: StaffIdentityAuditActor;
}): Promise<{ user: User; membership: SchoolMembership }> {
  const password = await hashPassword(options.password);
  const [preliminaryMembership] = await db
    .select()
    .from(schoolMemberships)
    .where(eq(schoolMemberships.id, options.membershipId))
    .limit(1);
  if (!preliminaryMembership || preliminaryMembership.schoolId !== options.schoolId) {
    throw new StaffIdentityError("STAFF_MEMBERSHIP_NOT_FOUND", "Staff membership not found.", 404);
  }
  const preliminaryUser = await getUserById(preliminaryMembership.userId);
  if (!preliminaryUser) {
    throw new StaffIdentityError("STAFF_IDENTITY_NOT_FOUND", "Staff identity not found.", 404);
  }
  const result = await db.transaction(async (tx) => {
    const transactionDb = tx as unknown as typeof db;
    await takeStaffIdentityLocks(transactionDb, [
      staffIdentityEmailLockKey(preliminaryUser.email),
      staffIdentityUserLockKey(preliminaryUser.id),
    ]);
    const [membership] = await tx
      .select()
      .from(schoolMemberships)
      .where(eq(schoolMemberships.id, options.membershipId))
      .limit(1)
      .for("update");
    if (
      !membership
      || membership.schoolId !== options.schoolId
      || membership.userId !== preliminaryUser.id
      || !isStaffMembershipRole(membership)
    ) {
      throw new StaffIdentityError("STAFF_MEMBERSHIP_NOT_FOUND", "Staff membership not found.", 404);
    }
    const [user] = await tx
      .select()
      .from(users)
      .where(eq(users.id, membership.userId))
      .limit(1)
      .for("update");
    if (
      !user
      || normalizeStaffEmail(user.email) !== normalizeStaffEmail(preliminaryUser.email)
    ) {
      throw new StaffIdentityError(
        "STAFF_IDENTITY_STALE",
        "The staff identity changed concurrently. Refresh and try again.",
        409
      );
    }
    const memberships = await tx
      .select({ schoolId: schoolMemberships.schoolId })
      .from(schoolMemberships)
      .where(eq(schoolMemberships.userId, user.id));
    if (
      user.isSuperAdmin
      || memberships.some((row) => row.schoolId !== options.schoolId)
    ) {
      throw new StaffIdentityError(
        "STAFF_PASSWORD_CENTRAL_REVIEW_REQUIRED",
        "This identity has central or multi-school access. Its password can only be changed through the Super Admin workflow.",
        409
      );
    }
    const [updated] = await tx
      .update(users)
      .set({
        password,
        authVersion: sql`${users.authVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id))
      .returning();
    if (!updated) {
      throw new StaffIdentityError("STAFF_IDENTITY_NOT_FOUND", "Staff identity not found.", 404);
    }
    await insertStaffIdentityAudit(transactionDb, {
      schoolId: options.schoolId,
      actor: options.audit,
      action: "school.staff.password_reset",
      entityType: "user",
      entityId: updated.id,
      fields: ["password", "authVersion"],
      metadata: { targetUserId: updated.id },
    });
    return { user: updated, membership };
  });
  await invalidateUserCredentialConnections(result.user.id);
  return result;
}
