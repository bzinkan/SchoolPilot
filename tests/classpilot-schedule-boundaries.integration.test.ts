import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { CLASSPILOT_SCHEDULE_BOUNDARY_SQL } from "../src/db/classpilotScheduleBoundaryMigration.js";

let pool: pg.Pool;
let worker: typeof import("../src/services/classpilotScheduleBoundaries.js");
let selectSchedule: typeof import("../src/services/classpilotDashboardSchedule.js")["selectDashboardSchedule"];
const schoolId = randomUUID();
const clock = new Date("1900-01-01T09:11:00Z");

before(async () => {
  const url = process.env.DATABASE_URL;
  assert.ok(url && ["localhost", "127.0.0.1", "::1"].includes(new URL(url).hostname), "Boundary tests require a local fixture");
  process.env.DATABASE_URL_PRIVILEGED = url;
  pool = new pg.Pool({ connectionString: url });
  await pool.query(CLASSPILOT_SCHEDULE_BOUNDARY_SQL);
  worker = await import("../src/services/classpilotScheduleBoundaries.js");
  ({ selectDashboardSchedule: selectSchedule } = await import("../src/services/classpilotDashboardSchedule.js"));
  await pool.query("INSERT INTO schools(id,name,domain) VALUES($1,'Boundary test','boundary.example.edu')", [schoolId]);
  await pool.query("INSERT INTO classpilot_school_schedules(school_id,config,revision) VALUES($1,'{}',7)", [schoolId]);
});

after(async () => {
  await pool.query("DELETE FROM classpilot_school_schedules WHERE school_id=$1", [schoolId]);
  await pool.query("DELETE FROM schools WHERE id=$1", [schoolId]);
  const { schedulerPool, schedulerLockPool } = await import("../src/services/schedulerDb.js");
  const app = await import("../src/db.js");
  await Promise.all([pool.end(), schedulerPool.end(), schedulerLockPool.end(), app.pool.end(), app.sessionPool.end()]);
});

async function due() {
  await pool.query("UPDATE classpilot_school_schedules SET next_boundary_at=$2,boundary_lease_owner=NULL,boundary_lease_until=NULL WHERE school_id=$1", [schoolId, clock]);
}
async function row() {
  return (await pool.query("SELECT * FROM classpilot_school_schedules WHERE school_id=$1", [schoolId])).rows[0];
}

test("shared deadline selects the bell and preserves an unfinished boundary", () => {
  const midnight = new Date("1900-01-02T00:00:00Z");
  assert.equal(worker.nextScheduleBoundary(clock, [new Date("1900-01-01T09:15:00Z"), new Date("1900-01-01T09:10:00Z")], midnight).toISOString(), "1900-01-01T09:15:00.000Z");
  assert.equal(worker.nextScheduleBoundary(clock, [], midnight).getTime(), midnight.getTime());
  assert.equal(worker.nextScheduleBoundary(clock, [], midnight, true).getTime(), clock.getTime() + 2_000);
});

test("idle dashboard knows the testing start, and a waiting activation stays pending", () => {
  const testing = { id: "test", name: "Testing", source: "scheduled_testing" as const,
    startsAt: "1900-01-01T09:11:00.000Z", endsAt: "1900-01-01T09:15:00.000Z", status: "pending" as const };
  const midnight = new Date("1900-01-02T00:00:00Z");
  const before = selectSchedule([testing], null, new Date("1900-01-01T09:10:00Z"), midnight);
  assert.equal(before.next?.name, "Testing");
  assert.equal(before.nextBoundaryAt, testing.startsAt);
  const waiting = selectSchedule([{ ...testing, status: "waiting" }], null, clock, midnight);
  assert.equal(waiting.next?.status, "waiting");
  assert.equal(Date.parse(waiting.nextBoundaryAt) - clock.getTime(), 2_000);
});

test("testing interrupts a longer regular class then resumes its remaining window", () => {
  const testing = { id: "test", name: "Testing", source: "scheduled_testing" as const,
    startsAt: "1900-01-01T09:11:00.000Z", endsAt: "1900-01-01T09:15:00.000Z", status: "pending" as const };
  const regular = { id: "class", name: "Class", source: "scheduled_class" as const,
    startsAt: "1900-01-01T09:00:00.000Z", endsAt: "1900-01-01T09:30:00.000Z", status: "pending" as const };
  const midnight = new Date("1900-01-02T00:00:00Z");
  const first = selectSchedule([testing, regular], regular, new Date("1900-01-01T09:10:00Z"), midnight);
  assert.equal(first.next?.id, testing.id);
  assert.equal(first.next?.startsAt, testing.startsAt);
  const second = selectSchedule([regular], testing, clock, midnight);
  assert.equal(second.next?.id, regular.id);
  assert.equal(second.next?.startsAt, testing.endsAt);
  assert.equal(second.nextBoundaryAt, testing.endsAt);
});

test("adjacent next class is selected at testing end without reviving an ended class", () => {
  const testing = { id: "test", source: "scheduled_testing" as const, endsAt: "1900-01-01T09:15:00.000Z" };
  const choices = [{ id: "homeroom", name: "Homeroom", source: "scheduled_class" as const,
    startsAt: "1900-01-01T08:30:00.000Z", endsAt: "1900-01-01T09:10:00.000Z", status: "pending" as const },
  { id: "specials", name: "Specials", source: "scheduled_class" as const,
    startsAt: "1900-01-01T09:15:00.000Z", endsAt: "1900-01-01T09:55:00.000Z", status: "pending" as const }];
  assert.equal(selectSchedule(choices, testing, clock, new Date("1900-01-02T00:00:00Z")).next?.id, "specials");
});

test("concurrent workers acquire one lease and an unchanged generation accepts its deadline", async () => {
  await due();
  const batches = await Promise.all([worker.claimDueScheduleBoundaries(clock), worker.claimDueScheduleBoundaries(clock)]);
  const leases = batches.flat().filter((lease) => lease.schoolId === schoolId);
  assert.equal(leases.length, 1);
  assert.ok(leases[0]);
  const next = new Date(clock.getTime() + 240_000);
  await worker.completeScheduleBoundary(leases[0], next);
  const state = await row();
  assert.equal(state.next_boundary_at.getTime(), next.getTime());
  assert.equal(state.boundary_lease_owner, null);
  assert.equal(state.revision, 7, "Queue progress never changes the document revision");
});

test("a schedule edit during a lease wins over its stale calculated deadline", async () => {
  await due();
  const lease = (await worker.claimDueScheduleBoundaries(clock)).find((item) => item.schoolId === schoolId)!;
  assert.ok(lease);
  await pool.query("UPDATE classpilot_school_schedules SET config='{\"schemaVersion\":1}' WHERE school_id=$1", [schoolId]);
  const changed = await row();
  assert.equal(changed.boundary_generation, lease.generation + 1);
  await worker.completeScheduleBoundary(lease, new Date("2099-01-01T00:00:00Z"));
  const state = await row();
  assert.ok(state.next_boundary_at.getTime() <= Date.now());
  assert.equal(state.revision, 7);
});

test("a crashed lease is recoverable and its old completion cannot clear a new owner", async () => {
  await due();
  const previous = (await worker.claimDueScheduleBoundaries(clock)).find((item) => item.schoolId === schoolId)!;
  const later = new Date(clock.getTime() + 31_000);
  const replacement = (await worker.claimDueScheduleBoundaries(later)).find((item) => item.schoolId === schoolId)!;
  assert.ok(previous && replacement);
  assert.notEqual(previous.owner, replacement.owner);
  await worker.completeScheduleBoundary(previous, new Date("2099-01-01T00:00:00Z"));
  assert.equal((await row()).boundary_lease_owner, replacement.owner);
  await worker.completeScheduleBoundary(replacement, new Date(clock.getTime() + 300_000));
});

test("wake-up rolls back with its originating schedule mutation", async () => {
  const before = await row();
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    await connection.query("UPDATE classpilot_school_schedules SET config='{\"schemaVersion\":1,\"periods\":[]}' WHERE school_id=$1", [schoolId]);
    await connection.query("ROLLBACK");
  } finally { connection.release(); }
  const state = await row();
  assert.equal(state.boundary_generation, before.boundary_generation);
  assert.equal(state.next_boundary_at.getTime(), before.next_boundary_at.getTime());
});

test("replaying the additive migration retains profiles, revisions and lease state", async () => {
  const before = await row();
  await pool.query(CLASSPILOT_SCHEDULE_BOUNDARY_SQL);
  const state = await row();
  assert.deepEqual(state.config, before.config);
  assert.equal(state.revision, before.revision);
  assert.equal(state.boundary_generation, before.boundary_generation);
});
