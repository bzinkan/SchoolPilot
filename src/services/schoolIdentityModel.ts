export const SCHOOL_ROLES = [
  "admin",
  "school_admin",
  "office_staff",
  "teacher",
  "parent",
] as const;

export type SchoolRole = (typeof SCHOOL_ROLES)[number];

const ROLE_PRIORITY = new Map<SchoolRole, number>(
  SCHOOL_ROLES.map((role, index) => [role, index])
);

export type SchoolIdentityMembership = {
  id: string;
  userId: string;
  schoolId: string;
  role: string;
  status: string;
  createdAt: Date;
};

export type SchoolIdentitySchool = {
  id: string;
  deletedAt: Date | null;
};

export type MembershipWithSchool<
  Membership extends SchoolIdentityMembership = SchoolIdentityMembership,
  School extends SchoolIdentitySchool = SchoolIdentitySchool,
> = {
  membership: Membership;
  school: School;
};

export type VerifiedSchoolIdentity<
  Membership extends SchoolIdentityMembership = SchoolIdentityMembership,
  School extends SchoolIdentitySchool = SchoolIdentitySchool,
> = {
  userId: string;
  schoolId: string;
  roles: SchoolRole[];
  primaryRole: SchoolRole;
  memberships: Membership[];
  primaryMembership: Membership;
  school: School;
};

function asSchoolRole(value: string): SchoolRole | null {
  return (SCHOOL_ROLES as readonly string[]).includes(value)
    ? (value as SchoolRole)
    : null;
}

export function primaryRoleFromRoles(roles: readonly SchoolRole[]): SchoolRole {
  if (roles.length === 0) {
    throw new Error("At least one verified school role is required");
  }
  return [...roles].sort(
    (left, right) => ROLE_PRIORITY.get(left)! - ROLE_PRIORITY.get(right)!
  )[0]!;
}

export function buildVerifiedSchoolIdentities<
  Membership extends SchoolIdentityMembership,
  School extends SchoolIdentitySchool,
>(
  rows: readonly MembershipWithSchool<Membership, School>[]
): VerifiedSchoolIdentity<Membership, School>[] {
  const grouped = new Map<
    string,
    Array<MembershipWithSchool<Membership, School>>
  >();
  for (const row of rows) {
    const role = asSchoolRole(row.membership.role);
    if (!role || row.membership.status !== "active" || row.school.deletedAt) continue;
    const current = grouped.get(row.membership.schoolId) ?? [];
    current.push(row);
    grouped.set(row.membership.schoolId, current);
  }

  const identities: Array<VerifiedSchoolIdentity<Membership, School>> = [];
  for (const schoolRows of grouped.values()) {
    const roles = [...new Set(
      schoolRows
        .map(({ membership }) => asSchoolRole(membership.role))
        .filter((role): role is SchoolRole => role !== null)
    )].sort((left, right) => ROLE_PRIORITY.get(left)! - ROLE_PRIORITY.get(right)!);
    if (roles.length === 0) continue;
    const primaryRole = primaryRoleFromRoles(roles);
    const orderedRows = [...schoolRows].sort((left, right) => {
      const roleDelta =
        ROLE_PRIORITY.get(asSchoolRole(left.membership.role)!)! -
        ROLE_PRIORITY.get(asSchoolRole(right.membership.role)!)!;
      if (roleDelta !== 0) return roleDelta;
      const createdDelta =
        left.membership.createdAt.getTime() - right.membership.createdAt.getTime();
      return createdDelta || left.membership.id.localeCompare(right.membership.id);
    });
    const primary = orderedRows.find(
      ({ membership }) => membership.role === primaryRole
    ) ?? orderedRows[0]!;
    identities.push({
      userId: primary.membership.userId,
      schoolId: primary.membership.schoolId,
      roles,
      primaryRole,
      memberships: orderedRows.map(({ membership }) => membership),
      primaryMembership: primary.membership,
      school: primary.school,
    });
  }

  return identities.sort((left, right) => {
    const createdDelta =
      Math.min(...left.memberships.map((membership) => membership.createdAt.getTime())) -
      Math.min(...right.memberships.map((membership) => membership.createdAt.getTime()));
    return createdDelta || left.schoolId.localeCompare(right.schoolId);
  });
}

export function identityHasAnyRole(
  identity: Pick<VerifiedSchoolIdentity, "roles">,
  roles: readonly SchoolRole[]
): boolean {
  return roles.some((role) => identity.roles.includes(role));
}
