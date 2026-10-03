import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { and, eq, sql } from "drizzle-orm";

process.env.NODE_ENV = "test";
process.env.SCHEDULER_ENABLED = "false";
process.env.RLS_GUC_ENABLED = "true";
process.env.REDIS_URL = "";

test("heartbeat persistence context preserves fresh scoped read semantics in one statement", async (t) => {
  const { db, pool, sessionPool } = await import("../src/db.js");
  const { runWithTenantContext, drainTenantContextReleases } = await import("../src/middleware/tenantContext.js");
  const { getTenantStore } = await import("../src/db/tenantContext.js");
  const storage = await import("../src/services/storage.js");
  const schema = await import("../src/schema/index.js");
  const { classpilotSsoPolicyFromSettings, builtInClasspilotSsoProfiles } = await import("../src/services/classpilotSsoPolicy.js");
  const { sanitizeClasspilotHeartbeatNavigationForSso } = await import("../src/services/classpilotHeartbeatSsoSanitizer.js");
  const { classpilotControlStateHasAuthRelevantRestriction } = await import("../src/services/classpilotClassroomState.js");
  const rollbackFixture = new Error("rollback complete heartbeat context fixture");
  const schoolA = randomUUID(), schoolB = randomUUID(), missingSchool = randomUUID();
  const studentA = randomUUID(), studentB = randomUUID();
  const userId = randomUUID(), groupId = randomUUID(), teachingSessionId = randomUUID();
  const policy = { schemaVersion: 1, enabled: true, defaultProfileId: "google", attemptTtlSeconds: 300,
    profiles: builtInClasspilotSsoProfiles() };

  try {
    await assert.rejects(runWithTenantContext({ isSuper: true }, () => db.transaction(async (tx) => {
      const role = (await tx.execute<{ restricted: boolean }>(sql`
        SELECT NOT (rolsuper OR rolbypassrls) AS restricted FROM pg_roles WHERE rolname=current_user
      `)).rows[0]!;
      t.diagnostic(role.restricted ? "Restricted role with FORCE RLS" : "Owner role with explicit school/student predicates");
      if (role.restricted) {
        const rls = await tx.execute<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(sql`
          SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class
          WHERE oid IN ('settings'::regclass,'classpilot_student_control_states'::regclass)
          ORDER BY relname
        `);
        assert.equal(rls.rows.length, 2);
        assert.ok(rls.rows.every(row => row.relrowsecurity && row.relforcerowsecurity));
      }
      await tx.insert(schema.schools).values([
        { id: schoolA, name: `Heartbeat Context A ${schoolA}`, domain: "context-a.example.invalid", planStatus: "past_due" },
        { id: schoolB, name: `Heartbeat Context B ${schoolB}`, domain: "context-b.example.invalid" },
      ]);
      await tx.insert(schema.students).values([
        { id: studentA, schoolId: schoolA, firstName: "Context", lastName: "A", status: "active" },
        { id: studentB, schoolId: schoolB, firstName: "Context", lastName: "B", status: "active" },
      ]);
      await tx.insert(schema.users).values({ id: userId, email: `${userId}@example.invalid`, firstName: "Context", lastName: "Teacher" });
      await tx.insert(schema.groups).values({ id: groupId, schoolId: schoolA, teacherId: userId, name: "Context class" });
      await tx.insert(schema.teachingSessions).values({ id: teachingSessionId, schoolId: schoolA, teacherId: userId, groupId });
      await tx.insert(schema.settings).values({ schoolId: schoolA, schoolName: "Context A", wsSharedKey: "synthetic",
        classpilotSsoPolicy: policy, classpilotSsoPolicyRevision: 7 });
      await tx.insert(schema.classpilotStudentControlStates).values([
        { schoolId: schoolA, studentId: studentA, teachingSessionId, revision: 7,
          desiredState: { screenLocked: true, flightPath: { id: "fixture", urls: ["https://example.invalid/"] } },
          scheduledEndAt: new Date("2026-11-01T01:30:00.123-04:00"),
          hardExpiresAt: new Date("2026-11-01T01:30:00.456-05:00"),
          enforcementHealth: "failed", appliedRevision: 6, lastOutcome: "failed", lastError: "fixture error",
          lastAcknowledgedAt: new Date("2026-03-08T03:00:00.789-04:00"),
          createdAt: new Date("2026-01-01T00:00:00.001Z"), updatedAt: new Date("2026-02-01T00:00:00.002Z") },
        { schoolId: schoolB, studentId: studentB, revision: 2, desiredState: { screenLocked: false } },
      ]);

      const scope = (schoolId: string, isSuper = false) => tx.execute(sql`
        SELECT set_config('app.school_id',${schoolId},true),set_config('app.is_super',${isSuper ? "on" : "off"},true)
      `);
      // The ordinary three helpers use the same ALS-bound physical client as
      // this transaction. They are the behavioral reference, never new-query output.
      const previousReads = async (schoolId: string, studentId: string) => {
        const [school, ssoPolicy, privacyControlState] = await Promise.all([
          storage.getSchoolById(schoolId), storage.getClasspilotSsoPolicyForSchool(schoolId),
          storage.getClasspilotStudentControlState(schoolId, studentId),
        ]);
        return { school: school ? { status: school.status, planStatus: school.planStatus, domain: school.domain } : undefined,
          ssoPolicy, privacyControlState };
      };

      await t.test("one query matches every control column and all five timestamp decoders", async () => {
        await scope(schoolA);
        const expected = await previousReads(schoolA, studentA);
        const client = getTenantStore()!.client;
        let count = 0;
        const original = client.query;
        client.query = function (this: typeof client, ...args: unknown[]) {
          count++;
          return Reflect.apply(original, this, args);
        } as typeof client.query;
        let actual;
        try { actual = await storage.getClasspilotHeartbeatPersistenceContext(schoolA, studentA, tx); }
        finally { client.query = original; }
        assert.equal(count, 1);
        assert.deepEqual(actual, expected);
        for (const key of ["scheduledEndAt", "hardExpiresAt", "lastAcknowledgedAt", "createdAt", "updatedAt"] as const) {
          assert.ok(actual.privacyControlState?.[key] instanceof Date, `${key} is decoded`);
        }
        assert.deepEqual(Object.keys(actual.school!).sort(), ["domain", "planStatus", "status"]);
      });

      await t.test("absent policy and nullable control values match the ordinary reads", async () => {
        await scope(schoolB);
        const actual = await storage.getClasspilotHeartbeatPersistenceContext(schoolB, studentB);
        assert.deepEqual(actual, await previousReads(schoolB, studentB));
        assert.equal(actual.privacyControlState?.scheduledEndAt, null);
        assert.equal(actual.privacyControlState?.hardExpiresAt, null);
        assert.equal(actual.privacyControlState?.lastAcknowledgedAt, null);
        assert.deepEqual(actual.ssoPolicy, classpilotSsoPolicyFromSettings(undefined));
      });

      await t.test("missing school or student never substitutes another control row", async () => {
        await scope(schoolA);
        for (const [schoolId, studentId] of [[missingSchool, studentA], [schoolA, studentB], [schoolA, randomUUID()]]) {
          const actual = await storage.getClasspilotHeartbeatPersistenceContext(schoolId!, studentId!, tx);
          assert.deepEqual(actual, await previousReads(schoolId!, studentId!));
          assert.equal(actual.privacyControlState, undefined);
        }
      });

      await t.test("wrong current tenant cannot reveal foreign SSO policy or control through the joins", async () => {
        await scope(schoolB);
        const actual = await storage.getClasspilotHeartbeatPersistenceContext(schoolA, studentA, tx);
        assert.deepEqual(actual, await previousReads(schoolA, studentA));
        if (role.restricted) {
          assert.equal(actual.privacyControlState, undefined);
          assert.deepEqual(actual.ssoPolicy, classpilotSsoPolicyFromSettings(undefined));
        } else assert.equal(actual.privacyControlState?.studentId, studentA);
        await scope(schoolA);
        assert.equal((await storage.getClasspilotHeartbeatPersistenceContext(schoolA, studentA)).privacyControlState?.studentId, studentA);
      });

      await t.test("modern and legacy navigation privacy matches the existing three-read projection", async () => {
        await scope(schoolA);
        const prior = await previousReads(schoolA, studentA);
        const current = await storage.getClasspilotHeartbeatPersistenceContext(schoolA, studentA, tx);
        for (const payload of [
          { activeTabUrl: "https://accounts.google.com/login?code=secret", activeTabTitle: "Account", favicon: "secret" },
          { activeTabUrl: "https://classroom.google.com/c/class?code=secret", activeTabTitle: "Callback", favicon: "secret", restrictionAuthState: "returning" },
          { activeTabUrl: "https://ordinary.example.invalid/lesson", activeTabTitle: "Lesson", favicon: "lesson-icon", restrictionAuthState: "idle" },
        ]) {
          const project = (context: typeof current) => sanitizeClasspilotHeartbeatNavigationForSso({ ...payload,
            policy: context.ssoPolicy.policy, authRelevantRestrictionActive: context.ssoPolicy.policy.enabled
              && !!context.privacyControlState && classpilotControlStateHasAuthRelevantRestriction(context.privacyControlState.desiredState) });
          const actual = project(current);
          assert.deepEqual(actual, project(prior));
          if (payload.activeTabUrl.includes("code=secret")) {
            assert.ok(!String(actual.activeTabUrl).includes("secret"));
            assert.equal(actual.activeTabTitle, "Signing in");
            assert.equal(actual.favicon, null);
          } else assert.equal(actual.activeTabUrl, payload.activeTabUrl);
        }
      });

      await t.test("fresh caller-transaction updates are visible without reusing prior results", async () => {
        await scope(schoolA);
        const before = await storage.getClasspilotHeartbeatPersistenceContext(schoolA, studentA, tx);
        await tx.update(schema.schools).set({ domain: "updated.example.invalid", planStatus: "active" }).where(eq(schema.schools.id, schoolA));
        await tx.update(schema.settings).set({ classpilotSsoPolicy: { ...policy, enabled: false, defaultProfileId: null }, classpilotSsoPolicyRevision: 8 })
          .where(eq(schema.settings.schoolId, schoolA));
        await tx.update(schema.classpilotStudentControlStates).set({ revision: 8, desiredState: { screenLocked: false } })
          .where(and(eq(schema.classpilotStudentControlStates.schoolId, schoolA), eq(schema.classpilotStudentControlStates.studentId, studentA)));
        const after = await storage.getClasspilotHeartbeatPersistenceContext(schoolA, studentA, tx);
        assert.deepEqual(after, await previousReads(schoolA, studentA));
        assert.equal(before.ssoPolicy.revision, 7);
        assert.equal(after.ssoPolicy.revision, 8);
        assert.equal(after.privacyControlState?.revision, 8);
        assert.equal(after.school?.domain, "updated.example.invalid");
      });

      await t.test("malformed and subsequently absent policy preserve canonical fallback semantics", async () => {
        await scope(schoolA);
        await tx.update(schema.settings).set({ classpilotSsoPolicy: { malformed: true }, classpilotSsoPolicyRevision: 9 })
          .where(eq(schema.settings.schoolId, schoolA));
        let actual = await storage.getClasspilotHeartbeatPersistenceContext(schoolA, studentA, tx);
        assert.deepEqual(actual, await previousReads(schoolA, studentA));
        assert.equal(actual.ssoPolicy.valid, false);
        assert.equal(actual.ssoPolicy.revision, 9);
        // SQL/JSON null is prohibited by the persisted policy constraints;
        // a missing LEFT JOIN row is the supported null/default projection.
        await tx.delete(schema.settings).where(eq(schema.settings.schoolId, schoolA));
        actual = await storage.getClasspilotHeartbeatPersistenceContext(schoolA, studentA, tx);
        assert.deepEqual(actual, await previousReads(schoolA, studentA));
        assert.equal(actual.ssoPolicy.valid, true);
      });
      throw rollbackFixture;
    })), error => error === rollbackFixture);
  } finally {
    await drainTenantContextReleases();
    const { default: errorMonitor } = await import("../src/services/errorMonitor.js");
    await errorMonitor.disposeAndWait();
    await Promise.all([pool.end(), sessionPool.end()]);
  }
});
