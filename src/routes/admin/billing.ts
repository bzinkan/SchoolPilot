import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { getSchoolById, updateSchool } from "../../services/storage.js";
import { logAudit } from "../../services/audit.js";
import db from "../../db.js";
import { schools } from "../../schema/core.js";
import { eq, sql } from "drizzle-orm";

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

// POST /api/checkout/create-session - Create Stripe checkout session
router.post("/checkout/create-session", async (req, res, next) => {
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
            unit_amount: 500,
            recurring: { interval: "month" },
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

      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object as any;
          const schoolId = session.metadata?.schoolId;
          const studentCount = parseInt(session.metadata?.studentCount || "0", 10);
          const amountPaid = session.amount_total || 0;

          if (schoolId) {
            const now = new Date();
            const activeUntil = new Date(now);
            activeUntil.setFullYear(activeUntil.getFullYear() + 1);

            await db
              .update(schools)
              .set({
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
              })
              .where(eq(schools.id, schoolId));

            await logAudit({
              schoolId,
              userId: "system",
              action: "billing.checkout_completed",
              entityType: "school",
              entityId: schoolId,
              metadata: { sessionId: session.id, amountPaid, studentCount },
            });

            console.log(`[Stripe] Checkout completed for school ${schoolId}: $${(amountPaid / 100).toFixed(2)}, ${studentCount} students`);
          }
          break;
        }

        case "invoice.paid": {
          const invoice = event.data.object as any;
          const schoolId = invoice.metadata?.schoolId;
          const studentCount = parseInt(invoice.metadata?.studentCount || "0", 10);
          const amountPaid = invoice.amount_paid || 0;

          if (schoolId) {
            const now = new Date();
            const activeUntil = new Date(now);
            activeUntil.setFullYear(activeUntil.getFullYear() + 1);

            await db
              .update(schools)
              .set({
                status: "active",
                planTier: "basic",
                planStatus: "active",
                activeUntil,
                maxLicenses: studentCount || undefined,
                stripeSubscriptionId: invoice.subscription || invoice.id,
                lastPaymentAmount: amountPaid,
                lastPaymentDate: now,
                totalPaid: sql`COALESCE(${schools.totalPaid}, 0) + ${amountPaid}`,
                updatedAt: now,
              })
              .where(eq(schools.id, schoolId));

            await logAudit({
              schoolId,
              userId: "system",
              action: "billing.invoice_paid",
              entityType: "school",
              entityId: schoolId,
              metadata: { invoiceId: invoice.id, amountPaid, studentCount },
            });

            console.log(`[Stripe] Invoice paid for school ${schoolId}: $${(amountPaid / 100).toFixed(2)}`);
          } else {
            console.log(`[Stripe] Invoice paid (no schoolId): customer ${invoice.customer}`);
          }
          break;
        }

        case "invoice.payment_failed": {
          const invoice = event.data.object as any;
          const schoolId = invoice.metadata?.schoolId;

          if (schoolId) {
            await updateSchool(schoolId, { planStatus: "past_due" });

            await logAudit({
              schoolId,
              userId: "system",
              action: "billing.payment_failed",
              entityType: "school",
              entityId: schoolId,
              metadata: { invoiceId: invoice.id },
            });

            console.log(`[Stripe] Payment failed for school ${schoolId}`);
          }
          break;
        }

        case "customer.subscription.deleted": {
          const subscription = event.data.object as any;
          const schoolId = subscription.metadata?.schoolId;

          if (schoolId) {
            await updateSchool(schoolId, {
              planStatus: "canceled",
              stripeSubscriptionId: null,
            });

            await logAudit({
              schoolId,
              userId: "system",
              action: "billing.subscription_canceled",
              entityType: "school",
              entityId: schoolId,
            });
          }

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

// POST /api/admin/billing/schools/:id/send-invoice - Create and send a Stripe invoice
// Frontend calls: POST /api/super-admin/billing/schools/:id/send-invoice
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
        basePrice = 500,
        perStudentPrice = 2,
        description,
        daysUntilDue = 30,
        billingEmail,
      } = req.body;

      if (!studentCount || studentCount < 1) {
        return res.status(400).json({ error: "studentCount required" });
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

      const baseCents = Math.round(basePrice * 100);
      const perStudentCents = Math.round(perStudentPrice * 100);
      const totalStudentCents = perStudentCents * studentCount;

      // Create invoice
      const invoice = await stripe.invoices.create({
        customer: customerId,
        collection_method: "send_invoice",
        days_until_due: daysUntilDue,
        metadata: {
          schoolId: school.id,
          studentCount: String(studentCount),
        },
        custom_fields: [
          { name: "School", value: school.name },
        ],
      });

      // Add line items
      await stripe.invoiceItems.create({
        customer: customerId,
        invoice: invoice.id,
        amount: baseCents,
        currency: "usd",
        description: description || "SchoolPilot Annual Platform Fee",
      });

      if (studentCount > 0 && perStudentCents > 0) {
        await stripe.invoiceItems.create({
          customer: customerId,
          invoice: invoice.id,
          amount: totalStudentCents,
          currency: "usd",
          description: `Per-student license (${studentCount} students × $${perStudentPrice}/student)`,
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
          amount: baseCents + totalStudentCents,
          studentCount,
        },
      });

      return res.json({
        success: true,
        invoiceId: invoice.id,
        invoiceUrl: finalizedInvoice.hosted_invoice_url || "",
        customerId,
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
            limit: 10,
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
