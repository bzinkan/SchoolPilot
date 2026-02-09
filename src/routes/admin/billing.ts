import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { getSchoolById, updateSchool } from "../../services/storage.js";
import { logAudit } from "../../services/audit.js";

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

// POST /api/checkout/create-session - Create Stripe checkout session
router.post("/checkout/create-session", async (req, res, next) => {
  try {
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
      return res.status(503).json({ error: "Stripe not configured" });
    }

    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(stripeKey);

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
            unit_amount: 500,
            recurring: { interval: "month" },
          },
          quantity: studentCount || 100,
        },
      ],
      metadata: {
        schoolId: schoolId || "",
        schoolName: schoolName || "",
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
      const stripeKey = process.env.STRIPE_SECRET_KEY;
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

      if (!stripeKey || !webhookSecret) {
        return res.status(503).json({ error: "Stripe not configured" });
      }

      const Stripe = (await import("stripe")).default;
      const stripe = new Stripe(stripeKey);

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

      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object as any;
          const schoolId = session.metadata?.schoolId;
          if (schoolId) {
            await updateSchool(schoolId, {
              stripeCustomerId: session.customer,
              planStatus: "active",
              status: "active",
            });
            await logAudit({
              schoolId,
              userId: "system",
              action: "billing.checkout_completed",
              entityType: "school",
              entityId: schoolId,
              metadata: { sessionId: session.id },
            });
          }
          break;
        }
        case "invoice.paid": {
          const invoice = event.data.object as any;
          const customerId = invoice.customer;
          // Could look up school by stripeCustomerId
          console.log(`[Stripe] Invoice paid: ${customerId}`);
          break;
        }
        case "customer.subscription.deleted": {
          const subscription = event.data.object as any;
          console.log(`[Stripe] Subscription cancelled: ${subscription.customer}`);
          break;
        }
      }

      return res.json({ received: true });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/super-admin/schools/:id/billing - Get billing info
router.get(
  "/super-admin/schools/:id/billing",
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
      };

      // If Stripe is configured and customer exists, fetch invoices
      const stripeKey = process.env.STRIPE_SECRET_KEY;
      if (stripeKey && school.stripeCustomerId) {
        try {
          const Stripe = (await import("stripe")).default;
          const stripe = new Stripe(stripeKey);
          const invoices = await stripe.invoices.list({
            customer: school.stripeCustomerId,
            limit: 10,
          });
          return res.json({
            ...billing,
            invoices: invoices.data.map((inv) => ({
              id: inv.id,
              amount: inv.amount_paid,
              status: inv.status,
              created: inv.created,
              hostedUrl: inv.hosted_invoice_url,
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
