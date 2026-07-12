import type { RequestHandler } from "express";
import { eq, and } from "drizzle-orm";
import { productLicenses } from "../schema/core.js";
import db from "../db.js";
import { createSingleFlight } from "../util/singleFlight.js";

type Product = "PASSPILOT" | "GOPILOT" | "CLASSPILOT";

const loadLicensesSingleFlight = createSingleFlight<
  string,
  Array<typeof productLicenses.$inferSelect>
>({ maxPendingKeys: 2_048 });

function loadActiveLicenses(schoolId: string) {
  return loadLicensesSingleFlight(schoolId, () =>
    db
      .select()
      .from(productLicenses)
      .where(
        and(
          eq(productLicenses.schoolId, schoolId),
          eq(productLicenses.status, "active")
        )
      )
  );
}

/**
 * Checks that the school has an active license for the specified product(s).
 * At least one of the specified products must be licensed.
 * Super admins bypass this check.
 */
export function requireProductLicense(...products: Product[]): RequestHandler {
  const checkLicense: RequestHandler = async (req, res, next) => {
    // Super admins bypass
    if (req.authUser?.isSuperAdmin) {
      return next();
    }

    const schoolId = res.locals.schoolId;
    if (!schoolId) {
      return res.status(400).json({ error: "School context required" });
    }

    const licenses = await loadActiveLicenses(schoolId);

    const hasLicense = products.some((p) =>
      licenses.find((l) => l.product === p)
    );

    if (!hasLicense) {
      return res.status(403).json({
        error: "Product license required",
        required: products,
      });
    }

    return next();
  };
  return (req, res, next) => {
    void Promise.resolve(checkLicense(req, res, next)).catch(next);
  };
}
