import { describe, expect, it, vi } from "vitest";
import {
  handleBillingWebhookEvent,
  parsePositiveInt,
  parseProductMetadata,
  planTierForProducts,
} from "../src/routes/admin/billingWebhook.js";

function deps() {
  return {
    now: () => new Date("2026-05-16T12:00:00.000Z"),
    updateSchoolRecord: vi.fn(async () => {}),
    updateProductLicenseExpiry: vi.fn(async () => {}),
    updateSchoolPlan: vi.fn(async () => undefined),
    logAuditEvent: vi.fn(async () => undefined),
    logger: { log: vi.fn() },
  };
}

describe("Stripe billing webhook handling", () => {
  it("parses defensive webhook metadata", () => {
    expect(parsePositiveInt("250")).toBe(250);
    expect(parsePositiveInt("-2")).toBe(0);
    expect(parsePositiveInt("nope")).toBe(0);
    expect(parseProductMetadata("CLASSPILOT, PASSPILOT,,")).toEqual([
      "CLASSPILOT",
      "PASSPILOT",
    ]);
    expect(planTierForProducts(["CLASSPILOT"])).toBe("basic");
    expect(planTierForProducts(["CLASSPILOT", "PASSPILOT"])).toBe("pro");
    expect(planTierForProducts(["CLASSPILOT", "PASSPILOT", "GOPILOT"])).toBe(
      "enterprise"
    );
  });

  it("activates a school and extends product licenses when an invoice is paid", async () => {
    const d = deps();

    await handleBillingWebhookEvent(
      {
        type: "invoice.paid",
        data: {
          object: {
            id: "in_123",
            subscription: "sub_123",
            amount_paid: 12345,
            metadata: {
              schoolId: "school-1",
              studentCount: "275",
              products: "CLASSPILOT,PASSPILOT",
            },
          },
        },
      },
      d
    );

    expect(d.updateSchoolRecord).toHaveBeenCalledWith(
      "school-1",
      expect.objectContaining({
        status: "active",
        planTier: "pro",
        planStatus: "active",
        maxLicenses: 275,
        stripeSubscriptionId: "sub_123",
        lastPaymentAmount: 12345,
      })
    );
    expect(d.updateProductLicenseExpiry).toHaveBeenCalledTimes(2);
    expect(d.updateProductLicenseExpiry.mock.calls[0]?.[2].toISOString()).toBe(
      "2027-05-16T12:00:00.000Z"
    );
    expect(d.logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "billing.invoice_paid",
        schoolId: "school-1",
        metadata: expect.objectContaining({
          products: ["CLASSPILOT", "PASSPILOT"],
        }),
      })
    );
  });

  it("marks failed payments and canceled subscriptions without touching license expiry", async () => {
    const d = deps();

    await handleBillingWebhookEvent(
      {
        type: "invoice.payment_failed",
        data: { object: { id: "in_fail", metadata: { schoolId: "school-1" } } },
      },
      d
    );
    await handleBillingWebhookEvent(
      {
        type: "customer.subscription.deleted",
        data: {
          object: {
            customer: "cus_123",
            metadata: { schoolId: "school-1" },
          },
        },
      },
      d
    );

    expect(d.updateSchoolPlan).toHaveBeenNthCalledWith(1, "school-1", {
      planStatus: "past_due",
    });
    expect(d.updateSchoolPlan).toHaveBeenNthCalledWith(2, "school-1", {
      planStatus: "canceled",
      stripeSubscriptionId: null,
    });
    expect(d.updateProductLicenseExpiry).not.toHaveBeenCalled();
  });
});
