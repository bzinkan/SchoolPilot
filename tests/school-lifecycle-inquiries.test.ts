import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import {
  createSchool,
  createSchoolInquiry,
  getSchoolInquiries,
  updateSchoolInquiry,
  deleteSchoolInquiry,
} from "../dist/services/storage.js";
import {
  createSchoolSchema,
  updateSchoolSchema,
  schoolInquirySchema,
} from "../dist/schema/validation.js";
import db, { pool } from "../dist/db.js";
import { runWithTenantContext } from "../dist/middleware/tenantContext.js";

const TAG = `lifecycle_${Date.now()}`;
const inquiryIds: string[] = [];

function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuper: true }, fn);
}

before(async () => {
  await asSystem(async () => {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS school_inquiries (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        school_name TEXT NOT NULL,
        domain TEXT,
        contact_name TEXT NOT NULL,
        contact_email TEXT NOT NULL,
        contact_phone TEXT,
        preferred_contact_method TEXT,
        admin_it_email TEXT,
        billing_email TEXT,
        estimated_students TEXT,
        interested_products TEXT,
        questions TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        notes TEXT,
        school_id TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMP,
        processed_by TEXT
      )
    `);
    await db.execute(sql`ALTER TABLE schools ALTER COLUMN status SET DEFAULT 'active'`);
    await db.execute(sql`ALTER TABLE schools ALTER COLUMN plan_tier SET DEFAULT 'basic'`);
  });
});

after(async () => {
  try {
    await asSystem(async () => {
      await db.execute(sql`DELETE FROM school_inquiries WHERE contact_email LIKE ${`${TAG}%`}`);
      await db.execute(sql`DELETE FROM schools WHERE slug LIKE ${`${TAG}%`}`);
    });
  } catch {
    /* ignore cleanup errors */
  }
  await pool.end();
});

describe("school lifecycle and inquiries", () => {
  it("creates schools as active/basic by default", async () => {
    const school = await createSchool({
      name: `${TAG}_School`,
      domain: `${TAG}.example.edu`,
      slug: `${TAG}-school`,
    } as any);

    assert.equal(school.status, "active");
    assert.equal(school.planTier, "basic");
  });

  it("rejects trial lifecycle values in school validation", () => {
    assert.equal(
      createSchoolSchema.safeParse({
        name: "No Trial School",
        domain: "notrial.example.edu",
        status: "trial",
      }).success,
      false
    );
    assert.equal(updateSchoolSchema.safeParse({ status: "trial" }).success, false);
    assert.equal(updateSchoolSchema.safeParse({ planTier: "trial" }).success, false);
    assert.equal(createSchoolSchema.safeParse({ name: "Active", status: "active" }).success, true);
    assert.equal(updateSchoolSchema.safeParse({ status: "suspended" }).success, true);
  });

  it("validates and stores school inquiries with independent inquiry status", async () => {
    const inquiryPayload = {
      schoolName: `${TAG} Academy`,
      domain: `${TAG}.example.edu`,
      contactName: "Avery Admin",
      contactEmail: `${TAG}@example.edu`,
      contactPhone: "555-1212",
      preferredContactMethod: "email",
      adminItEmail: `${TAG}-it@example.edu`,
      billingEmail: `${TAG}-billing@example.edu`,
      estimatedStudents: "250",
      interestedProducts: ["CLASSPILOT", "PASSPILOT"],
      questions: "Interested in onboarding timing.",
    };

    assert.equal(schoolInquirySchema.safeParse(inquiryPayload).success, true);

    const inquiry = await createSchoolInquiry({
      ...inquiryPayload,
      interestedProducts: inquiryPayload.interestedProducts.join(","),
      status: "pending",
    } as any);
    inquiryIds.push(inquiry.id);

    assert.equal(inquiry.status, "pending");
    assert.equal(inquiry.contactEmail, `${TAG}@example.edu`);

    const pending = await getSchoolInquiries({ status: "pending" });
    assert.ok(pending.some((item) => item.id === inquiry.id));

    const updated = await updateSchoolInquiry(inquiry.id, {
      status: "contacted",
      notes: "Left voicemail.",
    } as any);
    assert.equal(updated?.status, "contacted");
    assert.equal(updated?.notes, "Left voicemail.");

    assert.equal(await deleteSchoolInquiry(inquiry.id), true);
    inquiryIds.pop();
  });
});
