import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import {
  createMembership,
  createProductLicense,
  createSchool,
  createStudent,
  createUser,
} from "../dist/services/storage.js";
import {
  checkStudentEmail,
  duplicateEmailError,
  existingEmailSets,
  studentEmailRules,
  studentEmailTaken,
  validateStaffImportEmailForSchool,
} from "../dist/services/studentEmailPolicy.js";
import db, { pool } from "../dist/db.js";
import { runWithTenantContext } from "../dist/middleware/tenantContext.js";

const TAG = `email_policy_${Date.now()}`;
let classSchool: any;
let passSchool: any;

function inSchool<T>(schoolId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ schoolId }, fn);
}

function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuper: true }, fn);
}

before(async () => {
  classSchool = await createSchool({
    name: `${TAG}_Class`,
    domain: `${TAG}-class.example.edu`,
    slug: `${TAG}-class`,
  } as any);
  passSchool = await createSchool({
    name: `${TAG}_Pass`,
    domain: `${TAG}-pass.example.edu`,
    slug: `${TAG}-pass`,
  } as any);
  await createProductLicense({
    schoolId: classSchool.id,
    product: "CLASSPILOT",
    status: "active",
  } as any);
  await createProductLicense({
    schoolId: passSchool.id,
    product: "PASSPILOT",
    status: "active",
  } as any);
});

after(async () => {
  try {
    await asSystem(async () => {
      await db.execute(sql`DELETE FROM product_licenses WHERE school_id IN (${classSchool.id}, ${passSchool.id})`);
      await db.execute(sql`DELETE FROM school_memberships WHERE school_id IN (${classSchool.id}, ${passSchool.id})`);
      await db.execute(sql`DELETE FROM students WHERE school_id IN (${classSchool.id}, ${passSchool.id})`);
      await db.execute(sql`DELETE FROM schools WHERE id IN (${classSchool.id}, ${passSchool.id})`);
      await db.execute(sql`DELETE FROM users WHERE email LIKE ${`${TAG}%@%`}`);
    });
  } catch {
    /* ignore cleanup errors */
  }
  await pool.end();
});

describe("student email policy", () => {
  it("requires school-domain student email only for active ClassPilot schools", async () => {
    const classRules = await studentEmailRules(classSchool.id);
    assert.equal(classRules.requireEmail, true);
    assert.equal(checkStudentEmail(null, classRules)?.code, "STUDENT_EMAIL_REQUIRED");
    assert.equal(
      checkStudentEmail(`kid@outside.example.edu`, classRules)?.code,
      "STUDENT_EMAIL_DOMAIN_MISMATCH"
    );
    assert.equal(checkStudentEmail(`kid@${TAG}-class.example.edu`, classRules), null);

    const passRules = await studentEmailRules(passSchool.id);
    assert.equal(passRules.requireEmail, false);
    assert.equal(checkStudentEmail(null, passRules), null);
  });

  it("treats school_admin as staff for student-email uniqueness", async () => {
    const adminEmail = `${TAG}-school-admin@${TAG}-class.example.edu`;
    const admin = await createUser({
      email: adminEmail,
      firstName: "School",
      lastName: "Admin",
    } as any);
    await inSchool(classSchool.id, () =>
      createMembership({
        userId: admin.id,
        schoolId: classSchool.id,
        role: "school_admin",
        status: "active",
      } as any)
    );

    const taken = await inSchool(classSchool.id, () =>
      studentEmailTaken(classSchool.id, adminEmail)
    );
    assert.match(taken || "", /staff account/);

    const sets = await inSchool(classSchool.id, () => existingEmailSets(classSchool.id));
    assert.match(
      duplicateEmailError(adminEmail, sets, new Set<string>()) || "",
      /staff account/
    );
  });

  it("flags Workspace staff import emails that already belong to students", async () => {
    const studentEmail = `${TAG}-student@${TAG}-class.example.edu`;
    await inSchool(classSchool.id, () =>
      createStudent({
        schoolId: classSchool.id,
        firstName: "Stu",
        lastName: "Dent",
        email: studentEmail,
        status: "active",
      } as any)
    );

    const validation = await inSchool(classSchool.id, () =>
      validateStaffImportEmailForSchool(studentEmail, classSchool.id)
    );
    assert.equal(validation?.code, "EMAIL_IN_USE_BY_STUDENT");
  });
});
