import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import db, { pool } from "../src/db.js";
import { requireActiveSchool } from "../src/middleware/requireActiveSchool.js";
import { requireSchoolContextWithoutTenantBinding } from "../src/middleware/requireSchoolContext.js";
import { schoolMemberships, schools, users } from "../src/schema/core.js";
import {
  createMembership,
  createSchool,
  createUser,
  getMembershipByUserAndSchool,
  getMembershipsWithSchool,
  getSchoolBySlug,
  getSchoolBySlugIncludingDeleted,
  softDeleteSchool,
} from "../src/services/storage.js";

const TAG = `auth_membership_${Date.now()}_${Math.random().toString(16).slice(2)}`;

async function authorizeSchoolRequest(userId: string, schoolId: string) {
  return new Promise<{ status: number; body?: unknown }>((resolve, reject) => {
    const req = {
      authUser: { id: userId, isSuperAdmin: false },
      authMethod: "jwt",
      headers: { "x-school-id": schoolId },
      params: {},
      query: {},
      session: {},
    } as any;
    const res = {
      locals: {},
      statusCode: 200,
      status(statusCode: number) {
        this.statusCode = statusCode;
        return this;
      },
      json(body: unknown) {
        resolve({ status: this.statusCode, body });
        return this;
      },
    } as any;

    requireSchoolContextWithoutTenantBinding(req, res, (contextError?: unknown) => {
      if (contextError) return reject(contextError);
      requireActiveSchool(req, res, (activeSchoolError?: unknown) => {
        if (activeSchoolError) return reject(activeSchoolError);
        resolve({ status: 200 });
      });
    });
  });
}

after(async () => {
  await pool.end();
});

describe("authentication membership lifecycle", () => {
  it("does not bootstrap a user into a soft-deleted school", async () => {
    const user = await createUser({
      email: `${TAG}@example.invalid`,
      firstName: "Auth",
      lastName: "Lifecycle",
    });
    const activeSchool = await createSchool({
      name: `${TAG} Active`,
      domain: `${TAG}-active.example.invalid`,
      slug: `${TAG}-active`,
    });
    const deletedSchool = await createSchool({
      name: `${TAG} Deleted`,
      domain: `${TAG}-deleted.example.invalid`,
      slug: `${TAG}-deleted`,
    });

    try {
      await createMembership({
        userId: user.id,
        schoolId: activeSchool.id,
        role: "parent",
      });
      await createMembership({
        userId: user.id,
        schoolId: deletedSchool.id,
        role: "parent",
      });
      await softDeleteSchool(deletedSchool.id);

      const memberships = await getMembershipsWithSchool(user.id);
      const deletedSchoolMembership = await getMembershipByUserAndSchool(
        user.id,
        deletedSchool.id
      );
      const deletedSchoolAuthorization = await authorizeSchoolRequest(
        user.id,
        deletedSchool.id
      );
      const publicDeletedSchool = await getSchoolBySlug(deletedSchool.slug!);
      const reservedDeletedSchool = await getSchoolBySlugIncludingDeleted(
        deletedSchool.slug!
      );

      assert.deepEqual(
        memberships.map(({ school }) => school.id),
        [activeSchool.id]
      );
      assert.equal(
        deletedSchoolMembership,
        undefined,
        "staff WebSocket auth must not accept a membership in a deleted school"
      );
      assert.equal(
        deletedSchoolAuthorization.status,
        403,
        "a deleted tenant is an authorization failure, never a login-triggering 401"
      );
      assert.equal(
        publicDeletedSchool,
        undefined,
        "registration and public enrollment must not resolve deleted school slugs"
      );
      assert.equal(reservedDeletedSchool?.id, deletedSchool.id);
    } finally {
      await db
        .delete(schoolMemberships)
        .where(eq(schoolMemberships.userId, user.id));
      await db
        .delete(schools)
        .where(inArray(schools.id, [activeSchool.id, deletedSchool.id]));
      await db.delete(users).where(eq(users.id, user.id));
    }
  });
});
