import { after, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import db, { pool, sessionPool } from "../dist/db.js";
import { runWithTenantContext } from "../dist/middleware/tenantContext.js";
import {
  createClasspilotAiDecision,
  createMembership,
  createProductLicense,
  createSchool,
  createStudent,
  createStudentTimelineEvent,
  createUser,
} from "../dist/services/storage.js";
import { signUserToken } from "../dist/services/jwt.js";

const tag = `ai-privacy-${Date.now()}`;
const deviceSentinel = `${tag}-PRIVATE-DEVICE`;
const heartbeatSentinel = `${tag}-PRIVATE-HEARTBEAT`;
const reviewerSentinel = `${tag}-PRIVATE-REVIEWER`;

let school: any;
let student: any;
let teacher: any;
let officeStaff: any;
let admin: any;
let server: Server;
let baseUrl = "";

function inSchool<T>(schoolId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ schoolId }, fn);
}

function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuper: true }, fn);
}

function authHeaders(user: any): Record<string, string> {
  return {
    authorization: `Bearer ${signUserToken({
      userId: user.id,
      email: user.email,
      isSuperAdmin: false,
    })}`,
    "x-school-id": school.id,
  };
}

async function getJson(path: string, user: any): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, { headers: authHeaders(user) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function assertNoPrivateBindings(value: unknown): void {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(deviceSentinel), false);
  assert.equal(serialized.includes(heartbeatSentinel), false);
  assert.equal(serialized.includes(reviewerSentinel), false);
  assert.doesNotMatch(serialized, /"(?:deviceId|device_id|heartbeatId|heartbeat_id|studentSessionId|student_session_id|reviewedBy|reviewed_by)"/);
}

before(async () => {
  mock.timers.enable({ apis: ["setInterval"] });

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "session" (
      "sid" varchar NOT NULL PRIMARY KEY,
      "sess" json NOT NULL,
      "expire" timestamp(6) NOT NULL
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire")`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS classpilot_ai_decisions (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      school_id TEXT NOT NULL,
      student_id TEXT,
      device_id TEXT,
      heartbeat_id TEXT,
      url TEXT,
      title TEXT,
      domain TEXT,
      category TEXT,
      safety_alert TEXT,
      confidence INTEGER,
      reasoning TEXT,
      matched_rule TEXT,
      action_taken TEXT,
      teacher_intent_source TEXT,
      review_status TEXT,
      review_note TEXT,
      reviewed_by TEXT,
      reviewed_at TIMESTAMP,
      metadata JSONB,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS student_timeline_events (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      school_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      case_id TEXT,
      event_type TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT,
      title TEXT NOT NULL,
      summary TEXT,
      severity TEXT,
      actor_user_id TEXT,
      metadata JSONB,
      occurred_at TIMESTAMP NOT NULL DEFAULT now(),
      created_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `);

  school = await createSchool({
    name: `${tag} School`,
    domain: `${tag}.example.edu`,
    slug: tag,
    status: "active",
    planStatus: "active",
  } as any);
  [teacher, officeStaff, admin] = await Promise.all([
    createUser({ email: `teacher@${school.domain}`, firstName: "Privacy", lastName: "Teacher" } as any),
    createUser({ email: `office@${school.domain}`, firstName: "Privacy", lastName: "Office" } as any),
    createUser({ email: `admin@${school.domain}`, firstName: "Privacy", lastName: "Admin" } as any),
  ]);
  await Promise.all([
    createProductLicense({ schoolId: school.id, product: "CLASSPILOT", status: "active" } as any),
    createMembership({ userId: teacher.id, schoolId: school.id, role: "teacher", status: "active" } as any),
    createMembership({ userId: officeStaff.id, schoolId: school.id, role: "office_staff", status: "active" } as any),
    createMembership({ userId: admin.id, schoolId: school.id, role: "admin", status: "active" } as any),
  ]);

  await inSchool(school.id, async () => {
    student = await createStudent({
      schoolId: school.id,
      firstName: "Privacy",
      lastName: "Student",
      email: `student@${school.domain}`,
      status: "active",
    } as any);
    const [group] = await db
      .insert((await import("../dist/schema/classpilot.js")).groups)
      .values({ schoolId: school.id, teacherId: teacher.id, name: "Privacy Class" })
      .returning();
    assert.ok(group);
    await db.insert((await import("../dist/schema/classpilot.js")).groupStudents).values({
      groupId: group.id,
      studentId: student.id,
    });

    const decision = await createClasspilotAiDecision({
      schoolId: school.id,
      studentId: student.id,
      deviceId: deviceSentinel,
      heartbeatId: heartbeatSentinel,
      url: "https://example.edu/safety-resource",
      title: "Safety resource",
      domain: "example.edu",
      category: "unknown",
      safetyAlert: "violence",
      confidence: 82,
      reasoning: "Classifier flagged the observed URL.",
      matchedRule: "classifier",
      actionTaken: "close-tab",
      teacherIntentSource: null,
      reviewStatus: "confirmed",
      reviewNote: "Reviewed by school staff.",
      reviewedBy: reviewerSentinel,
      reviewedAt: new Date(),
      metadata: {
        deviceId: deviceSentinel,
        nested: { heartbeat_id: heartbeatSentinel, reviewedBy: reviewerSentinel },
      },
    });
    await createStudentTimelineEvent({
      schoolId: school.id,
      studentId: student.id,
      caseId: `${tag}-PRIVATE-CASE`,
      eventType: "browser_safety_alert",
      sourceType: "classpilot_ai",
      sourceId: decision.id,
      title: "Browser safety alert",
      summary: "Observed browser telemetry",
      severity: "high",
      actorUserId: reviewerSentinel,
      metadata: {
        deviceId: deviceSentinel,
        domain: "example.edu",
        actionTaken: "close-tab",
        nested: {
          heartbeat_id: heartbeatSentinel,
          reviewedBy: reviewerSentinel,
          outcome: "closed",
        },
      },
    });
  });

  const { createApp } = await import("../dist/app.js");
  server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  try {
    await asSystem(async () => {
      await db.execute(sql`DELETE FROM student_timeline_events WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM classpilot_ai_decisions WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM group_students WHERE group_id IN (SELECT id FROM groups WHERE school_id = ${school.id})`);
      await db.execute(sql`DELETE FROM groups WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM product_licenses WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM school_memberships WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM students WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM schools WHERE id = ${school.id}`);
      await db.execute(sql`DELETE FROM users WHERE email LIKE ${`%@${tag}.example.edu`}`);
    });
  } finally {
    mock.timers.reset();
    await Promise.allSettled([pool.end(), sessionPool.end()]);
  }
});

describe("ClassPilot AI decision route privacy", () => {
  it("returns the narrow identifier-free decision DTO to teacher and office staff", async () => {
    for (const actor of [teacher, officeStaff]) {
      const response = await getJson(`/classpilot/ai-decisions?studentId=${student.id}`, actor);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.decisions.length, 1);
      assert.deepEqual(Object.keys(response.body.decisions[0]).sort(), [
        "actionTaken",
        "category",
        "confidence",
        "createdAt",
        "domain",
        "id",
        "matchedRule",
        "reasoning",
        "reviewNote",
        "reviewStatus",
        "reviewedAt",
        "safetyAlert",
        "teacherIntentSource",
        "title",
        "url",
      ]);
      assertNoPrivateBindings(response.body);
    }
  });

  it("keeps the school-wide administrator list useful without exposing bindings", async () => {
    const response = await getJson("/classpilot/ai-decisions", admin);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.decisions.length, 1);
    assert.equal(response.body.decisions[0].reviewStatus, "confirmed");
    assertNoPrivateBindings(response.body);
  });

  it("redacts synthetic decision and legacy persisted metadata in the teacher timeline", async () => {
    const response = await getJson(
      `/classpilot/students/${student.id}/timeline?types=ai_decision,browser_safety_alert`,
      teacher
    );
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.events.length, 2);
    for (const event of response.body.events) {
      assert.deepEqual(Object.keys(event).sort(), [
        "eventType",
        "id",
        "metadata",
        "occurredAt",
        "persisted",
        "severity",
        "sourceType",
        "summary",
        "title",
      ]);
      assertNoPrivateBindings(event);
    }
    const persisted = response.body.events.find((event: any) => event.persisted);
    assert.deepEqual(persisted.metadata, {
      domain: "example.edu",
      actionTaken: "close-tab",
    });
  });
});
