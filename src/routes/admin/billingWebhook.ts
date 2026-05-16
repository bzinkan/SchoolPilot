import { and, eq, sql } from "drizzle-orm";
import db from "../../db.js";
import { schools, productLicenses } from "../../schema/core.js";
import { updateSchool } from "../../services/storage.js";
import { logAudit } from "../../services/audit.js";

export interface StripeWebhookEventLike {
  type: string;
  data: { object: any };
}

export type PlanTier = "basic" | "pro" | "enterprise";

export function parsePositiveInt(value: unknown): number {
  const parsed = parseInt(String(value ?? "0"), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function parseProductMetadata(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

export function planTierForProducts(products: readonly string[]): PlanTier {
  if (products.length >= 3) return "enterprise";
  if (products.length >= 2) return "pro";
  return "basic";
}

export function oneYearFrom(now: Date): Date {
  const activeUntil = new Date(now);
  activeUntil.setFullYear(activeUntil.getFullYear() + 1);
  return activeUntil;
}

interface BillingWebhookDeps {
  now: () => Date;
  updateSchoolRecord: (schoolId: string, values: Record<string, unknown>) => Promise<void>;
  updateProductLicenseExpiry: (
    schoolId: string,
    product: string,
    expiresAt: Date
  ) => Promise<void>;
  updateSchoolPlan: typeof updateSchool;
  logAuditEvent: typeof logAudit;
  logger: Pick<Console, "log">;
}

function defaultDeps(): BillingWebhookDeps {
  return {
    now: () => new Date(),
    updateSchoolRecord: async (schoolId, values) => {
      await db.update(schools).set(values as any).where(eq(schools.id, schoolId));
    },
    updateProductLicenseExpiry: async (schoolId, product, expiresAt) => {
      await db
        .update(productLicenses)
        .set({ expiresAt })
        .where(
          and(
            eq(productLicenses.schoolId, schoolId),
            eq(productLicenses.product, product),
            eq(productLicenses.status, "active")
          )
        );
    },
    updateSchoolPlan: updateSchool,
    logAuditEvent: logAudit,
    logger: console,
  };
}

export async function handleBillingWebhookEvent(
  event: StripeWebhookEventLike,
  deps: BillingWebhookDeps = defaultDeps()
): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const schoolId = session.metadata?.schoolId;
      const studentCount = parsePositiveInt(session.metadata?.studentCount);
      const amountPaid = session.amount_total || 0;

      if (schoolId) {
        const now = deps.now();
        const activeUntil = oneYearFrom(now);

        await deps.updateSchoolRecord(schoolId, {
          stripeCustomerId: session.customer,
          status: "active",
          planTier: "basic",
          planStatus: "active",
          activeUntil,
          maxLicenses: studentCount || undefined,
          lastPaymentAmount: amountPaid,
          lastPaymentDate: now,
          totalPaid: sql`COALESCE(${schools.totalPaid}, 0) + ${amountPaid}`,
          updatedAt: now,
        });

        await deps.logAuditEvent({
          schoolId,
          userId: "system",
          action: "billing.checkout_completed",
          entityType: "school",
          entityId: schoolId,
          metadata: { sessionId: session.id, amountPaid, studentCount },
        });

        deps.logger.log(
          `[Stripe] Checkout completed for school ${schoolId}: $${(amountPaid / 100).toFixed(2)}, ${studentCount} students`
        );
      }
      return;
    }

    case "invoice.paid": {
      const invoice = event.data.object;
      const schoolId = invoice.metadata?.schoolId;
      const studentCount = parsePositiveInt(invoice.metadata?.studentCount);
      const amountPaid = invoice.amount_paid || 0;
      const products = parseProductMetadata(invoice.metadata?.products);

      if (schoolId) {
        const now = deps.now();
        const activeUntil = oneYearFrom(now);
        const planTier = planTierForProducts(products);

        await deps.updateSchoolRecord(schoolId, {
          status: "active",
          planTier,
          planStatus: "active",
          activeUntil,
          maxLicenses: studentCount || undefined,
          stripeSubscriptionId: invoice.subscription || invoice.id,
          lastPaymentAmount: amountPaid,
          lastPaymentDate: now,
          totalPaid: sql`COALESCE(${schools.totalPaid}, 0) + ${amountPaid}`,
          updatedAt: now,
        });

        for (const product of products) {
          await deps.updateProductLicenseExpiry(schoolId, product, activeUntil);
        }

        await deps.logAuditEvent({
          schoolId,
          userId: "system",
          action: "billing.invoice_paid",
          entityType: "school",
          entityId: schoolId,
          metadata: { invoiceId: invoice.id, amountPaid, studentCount, products },
        });

        deps.logger.log(
          `[Stripe] Invoice paid for school ${schoolId}: $${(amountPaid / 100).toFixed(2)} (${products.join(", ")})`
        );
      } else {
        deps.logger.log(`[Stripe] Invoice paid (no schoolId): customer ${invoice.customer}`);
      }
      return;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object;
      const schoolId = invoice.metadata?.schoolId;

      if (schoolId) {
        await deps.updateSchoolPlan(schoolId, { planStatus: "past_due" });

        await deps.logAuditEvent({
          schoolId,
          userId: "system",
          action: "billing.payment_failed",
          entityType: "school",
          entityId: schoolId,
          metadata: { invoiceId: invoice.id },
        });

        deps.logger.log(`[Stripe] Payment failed for school ${schoolId}`);
      }
      return;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object;
      const schoolId = subscription.metadata?.schoolId;

      if (schoolId) {
        await deps.updateSchoolPlan(schoolId, {
          planStatus: "canceled",
          stripeSubscriptionId: null,
        });

        await deps.logAuditEvent({
          schoolId,
          userId: "system",
          action: "billing.subscription_canceled",
          entityType: "school",
          entityId: schoolId,
        });
      }

      deps.logger.log(`[Stripe] Subscription cancelled: ${subscription.customer}`);
      return;
    }

    default:
      return;
  }
}
