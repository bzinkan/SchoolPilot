import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { getSchoolById, updateSchool, getProductLicenses } from "../../services/storage.js";
import { logAudit } from "../../services/audit.js";
import { calculateInvoice, PRODUCT_PRICING, type ProductKey } from "../../config/pricing.js";
import { handleBillingWebhookEvent } from "./billingWebhook.js";

const router = Router();

function param(req: any, key: string): string {
  return String(req.params[key] ?? "");
}

function requireSuperAdmin(req: any, res: any, next: any) {
  if (!req.authUser?.isSuperAdmin) {
    return res.status(403).json({ error: "Super admin access required" });
  }
  next();
}

// Helper: lazily create a Stripe instance
async function getStripe() {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return null;
  const Stripe = (await import("stripe")).default;
  return new Stripe(stripeKey);
}

// POST /api/checkout/create-session - Create Stripe checkout session (requires auth)
router.post("/checkout/create-session", authenticate, async (req, res, next) => {
  try {
    const stripe = await getStripe();
    if (!stripe) {
      return res.status(503).json({ error: "Stripe not configured" });
    }

    const { schoolName, billingEmail, schoolId, studentCount } = req.body;

    if (!billingEmail) {
      return res.status(400).json({ error: "billingEmail required" });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      customer_email: billingEmail,
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `SchoolPilot - ${schoolName || "School"}`,
              description: `Up to ${studentCount || 100} students`,
            },
            unit_amount: 300,
            recurring: { interval: "year" },
          },
          quantity: studentCount || 100,
        },
      ],
      metadata: {
        schoolId: schoolId || "",
        schoolName: schoolName || "",
        studentCount: String(studentCount || 100),
      },
      success_url: `${process.env.PUBLIC_BASE_URL || "http://localhost:4000"}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.PUBLIC_BASE_URL || "http://localhost:4000"}/billing/cancel`,
    });

    return res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    next(err);
  }
});

// POST /api/stripe/webhook - Stripe webhook handler
router.post(
  "/stripe/webhook",
  async (req, res, next) => {
    try {
      const stripe = await getStripe();
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

      if (!stripe || !webhookSecret) {
        return res.status(503).json({ error: "Stripe not configured" });
      }

      const sig = req.headers["stripe-signature"] as string;
      const rawBody = (req as any).rawBody;

      if (!rawBody || !sig) {
        return res.status(400).json({ error: "Missing signature or body" });
      }

      let event;
      try {
        event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
      } catch (err: any) {
        console.error("[Stripe] Webhook signature verification failed:", err.message);
        return res.status(400).json({ error: "Webhook signature invalid" });
      }

      await handleBillingWebhookEvent(event);

      return res.json({ received: true });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/admin/billing/schools/:id/send-invoice - Create and send a Stripe invoice
router.post(
  "/schools/:id/send-invoice",
  authenticate,
  requireSuperAdmin,
  async (req, res, next) => {
    try {
      const stripe = await getStripe();
      if (!stripe) {
        return res.status(503).json({ error: "Stripe not configured" });
      }

      const school = await getSchoolById(param(req, "id"));
      if (!school) {
        return res.status(404).json({ error: "School not found" });
      }

      const {
        studentCount,
        products: requestedProducts,
        daysUntilDue = 30,
        billingEmail,
        has24x7Monitoring,
      } = req.body;

      if (!studentCount || studentCount < 1) {
        return res.status(400).json({ error: "studentCount required" });
      }


      // Determine which products to invoice
      let invoiceProducts: ProductKey[];
      if (Array.isArray(requestedProducts) && requestedProducts.length > 0) {
        invoiceProducts = requestedProducts.filter(
          (p: string) => p in PRODUCT_PRICING
        ) as ProductKey[];
      } else {
        const licenses = await getProductLicenses(school.id);
        invoiceProducts = licenses
          .filter((l) => l.status === "active")
          .map((l) => l.product as ProductKey)
          .filter((p) => p in PRODUCT_PRICING);
      }

      if (invoiceProducts.length === 0) {
        return res.status(400).json({ error: "No active products to invoice for" });
      }

      const email = billingEmail || school.billingEmail;
      if (!email) {
        return res.status(400).json({ error: "billingEmail required (none on school record)" });
      }

      // Create or reuse Stripe customer
      let customerId = school.stripeCustomerId;
      if (!customerId) {
        const customer = await stripe.customers.create({
          email,
          name: school.name,
          metadata: { schoolId: school.id },
        });
        customerId = customer.id;
        await updateSchool(school.id, { stripeCustomerId: customerId, billingEmail: email });
      }

      // Calculate pricing
      const pricing = calculateInvoice(invoiceProducts, studentCount, { has24x7Monitoring: !!has24x7Monitoring });

      // Create invoice
      const productLabels = invoiceProducts.map((p) => PRODUCT_PRICING[p].label).join(", ");
      const invoice = await stripe.invoices.create({
        customer: customerId,
        collection_method: "send_invoice",
        days_until_due: daysUntilDue,
        metadata: {
          schoolId: school.id,
          studentCount: String(studentCount),
          products: invoiceProducts.join(","),
        },
        custom_fields: [
          { name: "School", value: school.name.slice(0, 30) },
          { name: "Products", value: productLabels.slice(0, 30) },
        ],
      });

      // Add line items per product (linked to Stripe catalog products)
      for (const item of pricing.lineItems) {
        const productConfig = PRODUCT_PRICING[item.product as ProductKey];

        if (item.baseCents > 0) {
          await stripe.invoiceItems.create({
            customer: customerId,
            invoice: invoice.id,
            price_data: {
              product: productConfig.stripeProductId,
              currency: "usd",
              unit_amount: item.baseCents,
            },
            quantity: 1,
            description: `${item.label} — Annual Base Fee`,
          });
        }

        if (item.perStudentTotalCents > 0) {
          await stripe.invoiceItems.create({
            customer: customerId,
            invoice: invoice.id,
            price_data: {
              product: productConfig.stripeProductId,
              currency: "usd",
              unit_amount: item.perStudentCents,
            },
            quantity: studentCount,
            description: `${item.label} — Per-Student License ($${item.perStudentDollars.toFixed(2)}/student)`,
          });
        }
      }

      // 24/7 monitoring add-on
      if (pricing.addonCents > 0) {
        await stripe.invoiceItems.create({
          customer: customerId,
          invoice: invoice.id,
          price_data: {
            product: PRODUCT_PRICING.CLASSPILOT.stripeProductId,
            currency: "usd",
            unit_amount: 100,
          },
          quantity: studentCount,
          description: `24/7 Monitoring Add-On ($1.00/student)`,
        });
      }

      // Finalize and send
      const finalizedInvoice = await stripe.invoices.finalizeInvoice(invoice.id);
      await stripe.invoices.sendInvoice(invoice.id);

      await logAudit({
        schoolId: school.id,
        userId: req.authUser?.id || "system",
        action: "billing.invoice_sent",
        entityType: "school",
        entityId: school.id,
        metadata: {
          invoiceId: invoice.id,
          amount: pricing.totalCents,
          studentCount,
          products: invoiceProducts,
          discountRate: pricing.discountRate,
        },
      });

      return res.json({
        success: true,
        invoiceId: invoice.id,
        invoiceUrl: finalizedInvoice.hosted_invoice_url || "",
        customerId,
        pricing,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/admin/billing/schools/:id/billing - Get billing info with Stripe invoices
// Frontend calls: POST /api/super-admin/billing/schools/:id/billing
router.get(
  "/schools/:id/billing",
  authenticate,
  requireSuperAdmin,
  async (req, res, next) => {
    try {
      const school = await getSchoolById(param(req, "id"));
      if (!school) {
        return res.status(404).json({ error: "School not found" });
      }

      const billing = {
        billingEmail: school.billingEmail,
        stripeCustomerId: school.stripeCustomerId,
        planStatus: school.planStatus,
        planTier: school.planTier,
        status: school.status,
        activeUntil: school.activeUntil,
        trialEndsAt: school.trialEndsAt,
        totalPaid: school.totalPaid,
        lastPaymentAmount: school.lastPaymentAmount,
        lastPaymentDate: school.lastPaymentDate,
      };

      // If Stripe is configured and customer exists, fetch invoices
      const stripe = await getStripe();
      if (stripe && school.stripeCustomerId) {
        try {
          const invoices = await stripe.invoices.list({
            customer: school.stripeCustomerId,
            limit: 50,
          });
          return res.json({
            ...billing,
            invoices: invoices.data.map((inv) => ({
              id: inv.id,
              amount: inv.amount_paid || inv.total,
              status: inv.status,
              created: inv.created,
              hostedUrl: inv.hosted_invoice_url,
              dueDate: inv.due_date,
              paidAt: (inv as any).status_transitions?.paid_at || null,
              description: inv.description || null,
            })),
          });
        } catch {
          // Stripe lookup failed, return without invoices
        }
      }

      return res.json(billing);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
