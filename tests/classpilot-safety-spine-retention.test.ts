import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.SCHEDULER_ENABLED = "true";

const { pool } = await import("../dist/db.js");
const { schedulerLockPool, schedulerPool } = await import("../dist/services/schedulerDb.js");
const {
  purgeClasspilotSafetySpineRetentionForSchool,
  retentionPurgeSpineMode,
} = await import("../dist/services/scheduler.js");
const { default: errorMonitor } = await import("../dist/services/errorMonitor.js");

const DAY_MS = 24 * 60 * 60 * 1000;
// The per-school worker takes explicit cutoffs, so the fixture uses a fixed
// clock and nothing depends on the database's now().
const base = Date.UTC(2026, 8, 2, 12, 0, 0);
const daysAgo = (days: number) => new Date(base - days * DAY_MS);
const cutoff = daysAgo(30);
const closedCaseCutoff = daysAgo(90);

const schoolA = randomUUID();
const schoolB = randomUUID();
const studentA = randomUUID();
const studentB = randomUUID();
// Chat deliveries carry a database trigger that requires a same-school chat
// message, teaching session, and student, so each school gets one session.
const sessionA = randomUUID();
const sessionB = randomUUID();

const rows = {
  aiOldA: randomUUID(),
  aiNewA: randomUUID(),
  aiOldB: randomUUID(),
  openOldCase: randomUUID(),
  closedOldCase: randomUUID(),
  recentClosedCase: randomUUID(),
  evidenceCitedCase: randomUUID(),
  closedOldCaseB: randomUUID(),
  openCaseEventOld: randomUUID(),
  openCaseEventNew: randomUUID(),
  closedCaseEventOld: randomUUID(),
  closedCaseEventNew: randomUUID(),
  recentCaseEvent: randomUUID(),
  evidenceCaseEvent: randomUUID(),
  danglingOldEvent: randomUUID(),
  danglingNewEvent: randomUUID(),
  caselessOldEvent: randomUUID(),
  caselessNewEvent: randomUUID(),
  caseEventB: randomUUID(),
  messageOldA: randomUUID(),
  messageNewA: randomUUID(),
  messageOldB: randomUUID(),
  expiredDeliveryA: randomUUID(),
  staleLeaseDeliveryA: randomUUID(),
  liveLeaseDeliveryA: randomUUID(),
  queuedDeliveryA: randomUUID(),
  expiredDeliveryB: randomUUID(),
  artifact: randomUUID(),
};

const TENANT_TABLES = [
  "classpilot_ai_decisions",
  "student_timeline_events",
  "student_safety_cases",
  "messages",
  "classpilot_chat_deliveries",
  "evidence_artifacts",
] as const;

const expectedTotals = {
  aiDecisions: 1,
  timelineEvents: 5,
  closedCases: 1,
  messages: 1,
  chatDeliveries: 2,
};

async function insertCase(input: {
  id: string;
  schoolId: string;
  studentId: string;
  status: "open" | "closed";
  openedDaysAgo: number;
  closedDaysAgo: number | null;
}): Promise<void> {
  await schedulerPool.query(
    `INSERT INTO student_safety_cases (id, school_id, student_id, title, status, opened_at, closed_at)
     VALUES ($1, $2, $3, 'Retention fixture', $4, $5, $6)`,
    [
      input.id,
      input.schoolId,
      input.studentId,
      input.status,
      daysAgo(input.openedDaysAgo),
      input.closedDaysAgo === null ? null : daysAgo(input.closedDaysAgo),
    ]
  );
}

async function insertEvent(input: {
  id: string;
  schoolId: string;
  studentId: string;
  caseId: string | null;
  occurredDaysAgo: number;
}): Promise<void> {
  await schedulerPool.query(
    `INSERT INTO student_timeline_events (
       id, school_id, student_id, case_id, event_type, source_type, title, occurred_at
     ) VALUES ($1, $2, $3, $4, 'note', 'retention-fixture', 'Retention fixture', $5)`,
    [input.id, input.schoolId, input.studentId, input.caseId, daysAgo(input.occurredDaysAgo)]
  );
}

async function insertDecision(id: string, schoolId: string, createdDaysAgo: number): Promise<void> {
  await schedulerPool.query(
    `INSERT INTO classpilot_ai_decisions (id, school_id, category, created_at)
     VALUES ($1, $2, 'retention-fixture', $3)`,
    [id, schoolId, daysAgo(createdDaysAgo)]
  );
}

async function insertMessage(id: string, schoolId: string, sentDaysAgo: number): Promise<void> {
  await schedulerPool.query(
    `INSERT INTO messages (id, school_id, message, "timestamp")
     VALUES ($1, $2, 'Retention fixture', $3)`,
    [id, schoolId, daysAgo(sentDaysAgo)]
  );
}

async function insertDelivery(input: {
  id: string;
  schoolId: string;
  sessionId: string;
  studentId: string;
  state: "queued" | "leased" | "expired";
  expiresAt: Date;
  leaseExpiresAt: Date | null;
}): Promise<void> {
  const chatMessageId = randomUUID();
  await schedulerPool.query(
    `INSERT INTO chat_messages (
       id, school_id, session_id, student_id, sender_id, sender_type, content, message_type
     ) VALUES ($1, $2, $3, $4, 'retention-fixture-teacher', 'teacher', 'Retention fixture', 'text')`,
    [chatMessageId, input.schoolId, input.sessionId, input.studentId]
  );
  await schedulerPool.query(
    `INSERT INTO classpilot_chat_deliveries (
       id, school_id, chat_message_id, teaching_session_id, student_id, state,
       lease_owner, lease_expires_at, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.id,
      input.schoolId,
      chatMessageId,
      input.sessionId,
      input.studentId,
      input.state,
      input.leaseExpiresAt ? "retention-fixture-worker" : null,
      input.leaseExpiresAt,
      input.expiresAt,
    ]
  );
}

async function idsIn(table: (typeof TENANT_TABLES)[number], schoolId: string): Promise<Set<string>> {
  const result = await schedulerPool.query<{ id: string }>(
    `SELECT id FROM ${table} WHERE school_id = $1`,
    [schoolId]
  );
  return new Set(result.rows.map((row) => row.id));
}

async function snapshot(schoolId: string): Promise<Record<string, string[]>> {
  const entries: Record<string, string[]> = {};
  for (const table of TENANT_TABLES) {
    entries[table] = [...(await idsIn(table, schoolId))].sort();
  }
  return entries;
}

describe("ClassPilot safety spine retention purge", () => {
  before(async () => {
    for (const [schoolId, studentId, sessionId, label] of [
      [schoolA, studentA, sessionA, "a"],
      [schoolB, studentB, sessionB, "b"],
    ] as const) {
      await schedulerPool.query(
        `INSERT INTO schools (id, name, domain, slug) VALUES ($1, $2, $3, $4)`,
        [schoolId, `Safety spine retention ${label}`, `${schoolId}.example.test`, `spine-${schoolId}`]
      );
      await schedulerPool.query(
        `INSERT INTO students (id, school_id, first_name, last_name) VALUES ($1, $2, 'Retention', 'Fixture')`,
        [studentId, schoolId]
      );
      await schedulerPool.query(
        `INSERT INTO teaching_sessions (id, school_id, group_id, teacher_id)
         VALUES ($1, $2, 'retention-fixture-group', 'retention-fixture-teacher')`,
        [sessionId, schoolId]
      );
    }

    await insertDecision(rows.aiOldA, schoolA, 40);
    await insertDecision(rows.aiNewA, schoolA, 5);
    await insertDecision(rows.aiOldB, schoolB, 40);

    // Open case: old, never purged, and neither are its rows.
    await insertCase({ id: rows.openOldCase, schoolId: schoolA, studentId: studentA, status: "open", openedDaysAgo: 200, closedDaysAgo: null });
    await insertEvent({ id: rows.openCaseEventOld, schoolId: schoolA, studentId: studentA, caseId: rows.openOldCase, occurredDaysAgo: 150 });
    await insertEvent({ id: rows.openCaseEventNew, schoolId: schoolA, studentId: studentA, caseId: rows.openOldCase, occurredDaysAgo: 3 });

    // Closed 120 days ago: case and every row purge, including a recent row.
    await insertCase({ id: rows.closedOldCase, schoolId: schoolA, studentId: studentA, status: "closed", openedDaysAgo: 200, closedDaysAgo: 120 });
    await insertEvent({ id: rows.closedCaseEventOld, schoolId: schoolA, studentId: studentA, caseId: rows.closedOldCase, occurredDaysAgo: 130 });
    await insertEvent({ id: rows.closedCaseEventNew, schoolId: schoolA, studentId: studentA, caseId: rows.closedOldCase, occurredDaysAgo: 10 });

    // Closed 40 days ago: inside the 90-day floor, so the case and its old row stay.
    await insertCase({ id: rows.recentClosedCase, schoolId: schoolA, studentId: studentA, status: "closed", openedDaysAgo: 100, closedDaysAgo: 40 });
    await insertEvent({ id: rows.recentCaseEvent, schoolId: schoolA, studentId: studentA, caseId: rows.recentClosedCase, occurredDaysAgo: 95 });

    // Closed 150 days ago but cited by an evidence artifact: the case stays,
    // its timeline rows follow the closed-case rule.
    await insertCase({ id: rows.evidenceCitedCase, schoolId: schoolA, studentId: studentA, status: "closed", openedDaysAgo: 200, closedDaysAgo: 150 });
    await insertEvent({ id: rows.evidenceCaseEvent, schoolId: schoolA, studentId: studentA, caseId: rows.evidenceCitedCase, occurredDaysAgo: 160 });
    await schedulerPool.query(
      `INSERT INTO evidence_artifacts (id, school_id, student_id, case_id, source_type, artifact_type, captured_at)
       VALUES ($1, $2, $3, $4, 'retention-fixture', 'note', $5)`,
      [rows.artifact, schoolA, studentA, rows.evidenceCitedCase, daysAgo(150)]
    );

    // School B's closed case: untouched when school A purges.
    await insertCase({ id: rows.closedOldCaseB, schoolId: schoolB, studentId: studentB, status: "closed", openedDaysAgo: 200, closedDaysAgo: 120 });
    await insertEvent({ id: rows.caseEventB, schoolId: schoolB, studentId: studentB, caseId: rows.closedOldCaseB, occurredDaysAgo: 130 });

    // Dangling case references resolve within the tenant only: a school B case
    // id is dangling for school A and purges on the ordinary cutoff.
    await insertEvent({ id: rows.danglingOldEvent, schoolId: schoolA, studentId: studentA, caseId: rows.closedOldCaseB, occurredDaysAgo: 40 });
    await insertEvent({ id: rows.danglingNewEvent, schoolId: schoolA, studentId: studentA, caseId: randomUUID(), occurredDaysAgo: 5 });

    await insertEvent({ id: rows.caselessOldEvent, schoolId: schoolA, studentId: studentA, caseId: null, occurredDaysAgo: 40 });
    await insertEvent({ id: rows.caselessNewEvent, schoolId: schoolA, studentId: studentA, caseId: null, occurredDaysAgo: 5 });

    await insertMessage(rows.messageOldA, schoolA, 40);
    await insertMessage(rows.messageNewA, schoolA, 5);
    await insertMessage(rows.messageOldB, schoolB, 40);

    await insertDelivery({ id: rows.expiredDeliveryA, schoolId: schoolA, sessionId: sessionA, studentId: studentA, state: "expired", expiresAt: daysAgo(40), leaseExpiresAt: null });
    await insertDelivery({ id: rows.staleLeaseDeliveryA, schoolId: schoolA, sessionId: sessionA, studentId: studentA, state: "leased", expiresAt: daysAgo(40), leaseExpiresAt: daysAgo(45) });
    await insertDelivery({ id: rows.liveLeaseDeliveryA, schoolId: schoolA, sessionId: sessionA, studentId: studentA, state: "leased", expiresAt: daysAgo(40), leaseExpiresAt: new Date(base + 60 * 60 * 1000) });
    await insertDelivery({ id: rows.queuedDeliveryA, schoolId: schoolA, sessionId: sessionA, studentId: studentA, state: "queued", expiresAt: daysAgo(-1), leaseExpiresAt: null });
    await insertDelivery({ id: rows.expiredDeliveryB, schoolId: schoolB, sessionId: sessionB, studentId: studentB, state: "expired", expiresAt: daysAgo(40), leaseExpiresAt: null });
  });

  after(async () => {
    try {
      for (const table of [...TENANT_TABLES, "chat_messages", "teaching_sessions", "students"]) {
        await schedulerPool.query(`DELETE FROM ${table} WHERE school_id IN ($1, $2)`, [schoolA, schoolB]);
      }
      await schedulerPool.query("DELETE FROM schools WHERE id IN ($1, $2)", [schoolA, schoolB]);
    } finally {
      errorMonitor.dispose();
      await Promise.allSettled([pool.end(), schedulerPool.end(), schedulerLockPool.end()]);
    }
  });

  it("stays in count mode for anything other than the exact string delete", () => {
    const previous = process.env.CLASSPILOT_RETENTION_PURGE_SPINE_MODE;
    try {
      delete process.env.CLASSPILOT_RETENTION_PURGE_SPINE_MODE;
      assert.equal(retentionPurgeSpineMode(), "count");
      for (const value of ["", "count", "DELETE", " delete", "delete ", "true"]) {
        process.env.CLASSPILOT_RETENTION_PURGE_SPINE_MODE = value;
        assert.equal(retentionPurgeSpineMode(), "count", JSON.stringify(value));
      }
      process.env.CLASSPILOT_RETENTION_PURGE_SPINE_MODE = "delete";
      assert.equal(retentionPurgeSpineMode(), "delete");
    } finally {
      if (previous === undefined) delete process.env.CLASSPILOT_RETENTION_PURGE_SPINE_MODE;
      else process.env.CLASSPILOT_RETENTION_PURGE_SPINE_MODE = previous;
    }
  });

  it("count mode reports what the delete predicates match without deleting anything", async () => {
    const beforeA = await snapshot(schoolA);
    const beforeB = await snapshot(schoolB);

    const totals = await purgeClasspilotSafetySpineRetentionForSchool({
      schoolId: schoolA,
      cutoff,
      closedCaseCutoff,
      mode: "count",
    });

    assert.deepEqual(totals, expectedTotals);
    assert.deepEqual(await snapshot(schoolA), beforeA);
    assert.deepEqual(await snapshot(schoolB), beforeB);
  });

  it("delete mode removes only rows past the tenant window and never touches open cases or other tenants", async () => {
    const beforeB = await snapshot(schoolB);

    const totals = await purgeClasspilotSafetySpineRetentionForSchool({
      schoolId: schoolA,
      cutoff,
      closedCaseCutoff,
      mode: "delete",
    });

    assert.deepEqual(totals, expectedTotals);
    assert.deepEqual(await snapshot(schoolB), beforeB, "school B must be untouched");

    assert.deepEqual(await idsIn("classpilot_ai_decisions", schoolA), new Set([rows.aiNewA]));
    assert.deepEqual(
      await idsIn("student_safety_cases", schoolA),
      new Set([rows.openOldCase, rows.recentClosedCase, rows.evidenceCitedCase])
    );
    assert.deepEqual(
      await idsIn("student_timeline_events", schoolA),
      new Set([
        rows.openCaseEventOld,
        rows.openCaseEventNew,
        rows.recentCaseEvent,
        rows.danglingNewEvent,
        rows.caselessNewEvent,
      ])
    );
    assert.deepEqual(await idsIn("messages", schoolA), new Set([rows.messageNewA]));
    assert.deepEqual(
      await idsIn("classpilot_chat_deliveries", schoolA),
      new Set([rows.liveLeaseDeliveryA, rows.queuedDeliveryA])
    );
    assert.deepEqual(await idsIn("evidence_artifacts", schoolA), new Set([rows.artifact]));
  });

  it("a second delete run finds nothing left to purge", async () => {
    const totals = await purgeClasspilotSafetySpineRetentionForSchool({
      schoolId: schoolA,
      cutoff,
      closedCaseCutoff,
      mode: "delete",
    });
    assert.deepEqual(totals, {
      aiDecisions: 0,
      timelineEvents: 0,
      closedCases: 0,
      messages: 0,
      chatDeliveries: 0,
    });
  });
});
