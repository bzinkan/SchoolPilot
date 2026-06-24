import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import {
  addGroupStudentsDetailed,
  clearClasspilotActiveHandsForSession,
  createGroup,
  createSchool,
  createStudent,
  createTeachingSession,
  createUser,
  endTeachingSession,
  startStudentSession,
} from "../dist/services/storage.js";
import {
  authenticateWsClient,
  registerWsClient,
  removeWsClient,
} from "../dist/realtime/ws-broadcast.js";
import db, { pool } from "../dist/db.js";
import { runWithTenantContext } from "../dist/middleware/tenantContext.js";

const TAG = `fab_lifecycle_${Date.now()}`;
let school: any;
let teacher: any;
let rosterStudent: any;
let otherStudent: any;
let group: any;
let broadcastFabStateToSessionRoster: typeof import("../dist/services/classpilotFab.js").broadcastFabStateToSessionRoster;

function inSchool<T>(schoolId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ schoolId }, fn);
}

function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuper: true }, fn);
}

function fakeStudentSocket(messages: unknown[]) {
  return {
    readyState: 1,
    send: (payload: string) => messages.push(JSON.parse(payload)),
    close: () => undefined,
  } as any;
}

before(async () => {
  delete process.env.REDIS_URL;
  ({ broadcastFabStateToSessionRoster } = await import("../dist/services/classpilotFab.js"));

  await asSystem(async () => {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS classpilot_active_hands (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id TEXT NOT NULL,
        teaching_session_id VARCHAR NOT NULL,
        student_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        raised_at TIMESTAMP NOT NULL DEFAULT now(),
        expires_at TIMESTAMP,
        cleared_at TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS classpilot_active_hands_session_idx
      ON classpilot_active_hands (school_id, teaching_session_id)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS classpilot_active_hands_student_idx
      ON classpilot_active_hands (school_id, student_id)
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS classpilot_active_hands_active_unique
      ON classpilot_active_hands (teaching_session_id, student_id)
      WHERE cleared_at IS NULL
    `);
  });

  school = await createSchool({
    name: `${TAG}_School`,
    domain: `${TAG}.example.edu`,
    slug: TAG,
  } as any);
  teacher = await createUser({
    email: `teacher@${TAG}.example.edu`,
    firstName: "Tara",
    lastName: "Teacher",
  } as any);

  rosterStudent = await inSchool(school.id, () =>
    createStudent({
      schoolId: school.id,
      firstName: "Roster",
      lastName: "Student",
      email: `roster@${TAG}.example.edu`,
      gradeLevel: "8",
    } as any)
  );
  otherStudent = await inSchool(school.id, () =>
    createStudent({
      schoolId: school.id,
      firstName: "Other",
      lastName: "Student",
      email: `other@${TAG}.example.edu`,
      gradeLevel: "8",
    } as any)
  );
  group = await inSchool(school.id, () =>
    createGroup({
      schoolId: school.id,
      teacherId: teacher.id,
      name: `${TAG}_Class`,
      groupType: "admin_class",
      status: "active",
    } as any)
  );
  await inSchool(school.id, () => addGroupStudentsDetailed(group.id, [rosterStudent.id]));
});

after(async () => {
  try {
    await asSystem(async () => {
      await db.execute(sql`DELETE FROM classpilot_active_hands WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM teaching_sessions WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM student_sessions WHERE device_id LIKE ${`${TAG}-%`}`);
      await db.execute(sql`DELETE FROM group_students WHERE group_id = ${group.id}`);
      await db.execute(sql`DELETE FROM groups WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM students WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM schools WHERE id = ${school.id}`);
      await db.execute(sql`DELETE FROM users WHERE email LIKE ${`%@${TAG}.example.edu`}`);
    });
  } catch {
    /* best-effort cleanup */
  }
  await pool.end();
});

describe("ClassPilot FAB lifecycle state broadcasts", () => {
  it("sends session start and end state only to active roster devices", async () => {
    const rosterDeviceId = `${TAG}-roster-device`;
    const otherDeviceId = `${TAG}-other-device`;
    await inSchool(school.id, () => startStudentSession(rosterStudent.id, rosterDeviceId));
    await inSchool(school.id, () => startStudentSession(otherStudent.id, otherDeviceId));

    const rosterMessages: any[] = [];
    const otherMessages: any[] = [];
    const rosterSocket = fakeStudentSocket(rosterMessages);
    const otherSocket = fakeStudentSocket(otherMessages);
    registerWsClient(rosterSocket);
    registerWsClient(otherSocket);
    authenticateWsClient(rosterSocket, { role: "student", schoolId: school.id, deviceId: rosterDeviceId });
    authenticateWsClient(otherSocket, { role: "student", schoolId: school.id, deviceId: otherDeviceId });

    try {
      const session = await inSchool(school.id, () => createTeachingSession({ groupId: group.id, teacherId: teacher.id }));
      await inSchool(school.id, () =>
        broadcastFabStateToSessionRoster({ schoolId: school.id, session, reason: "session-started" })
      );

      assert.equal(rosterMessages.length, 1);
      assert.equal(otherMessages.length, 0);
      assert.equal(rosterMessages[0].type, "remote-control");
      assert.equal(rosterMessages[0].command.type, "fab-state");
      assert.equal(rosterMessages[0].command.data.sessionId, session.id);
      assert.equal(rosterMessages[0].command.data.reason, "session-started");
      assert.equal(rosterMessages[0].command.data.messagingEnabled, true);
      assert.equal(rosterMessages[0].command.data.handRaisingEnabled, true);

      await inSchool(school.id, async () => {
        await endTeachingSession(session.id);
        await clearClasspilotActiveHandsForSession(school.id, session.id);
        await broadcastFabStateToSessionRoster({ schoolId: school.id, session, reason: "session-ended" });
      });

      assert.equal(rosterMessages.length, 2);
      assert.equal(otherMessages.length, 0);
      assert.equal(rosterMessages[1].command.type, "fab-state");
      assert.equal(rosterMessages[1].command.data.reason, "session-ended");
      assert.equal(rosterMessages[1].command.data.messagingEnabled, false);
      assert.equal(rosterMessages[1].command.data.handRaisingEnabled, false);
    } finally {
      removeWsClient(rosterSocket);
      removeWsClient(otherSocket);
    }
  });
});
