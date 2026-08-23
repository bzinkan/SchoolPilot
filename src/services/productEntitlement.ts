export type ProductEntitlementSchool = {
  status: string;
  isActive: boolean;
  planStatus: string | null;
  activeUntil: Date | null;
  disabledAt: Date | null;
  deletedAt: Date | null;
};

export type ProductEntitlementLicense = {
  product: string;
  status: string;
  expiresAt: Date | null;
};

export function activeEntitledProducts(options: {
  school: ProductEntitlementSchool | null | undefined;
  licenses: readonly ProductEntitlementLicense[];
  now?: Date;
}): string[] {
  const now = options.now ?? new Date();
  const school = options.school;
  if (
    !school
    || school.status !== "active"
    || school.isActive !== true
    || school.disabledAt
    || school.deletedAt
    || school.planStatus === "canceled"
    || (school.activeUntil && school.activeUntil <= now)
  ) return [];

  return [...new Set(options.licenses
    .filter((license) => (
      license.status === "active"
      && (!license.expiresAt || license.expiresAt > now)
    ))
    .map((license) => license.product))]
    .sort();
}
