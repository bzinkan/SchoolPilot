import { test } from "node:test";
import assert from "node:assert/strict";
import { kioskScheduleSchema, standaloneKioskWindows, selectKioskAssignment, type KioskAssignment } from "../src/services/passpilotKioskSchedule.js";

const block = { id: "math", classId: "math", weekdays: [1, 2, 3, 4, 5], startTime: "09:00", endTime: "10:00", startsOn: null, endsOn: null };
const parse = (blocks: unknown[], exceptions: unknown[] = []) => kioskScheduleSchema.parse({ blocks, exceptions });
const windows = (date: string, exceptions: unknown[] = []) => standaloneKioskWindows(parse([block], exceptions), date, "America/New_York", {});
const activity = (id: string, start: string, end: string, kind: KioskAssignment["kind"] = "class"): KioskAssignment => ({
  id, kind, name: id, classId: kind === "class" ? id : null, supervisionContextId: kind === "class" ? null : id,
  startsAt: `2026-09-24T${start}:00Z`, endsAt: `2026-09-24T${end}:00Z`, state: "ready",
});
const select = (candidates: KioskAssignment[], time: string) => selectKioskAssignment(candidates, new Date(`2026-09-24T${time}:00Z`), new Date("2026-09-25T04:00:00Z"));

test("weekly schedules allow adjacent periods and repeated meetings, rejecting overlaps and overnight times", () => {
  assert.equal(parse([block, { ...block, id: "again", startTime: "10:00", endTime: "11:00" }]).blocks.length, 2);
  assert.throws(() => parse([block, { ...block, id: "other", startTime: "09:30" }]), /overlap/);
  assert.throws(() => parse([{ ...block, startTime: "23:00", endTime: "01:00" }]), /same day/);
  assert.throws(() => parse([{ ...block, startTime: "25:00" }]), /HH:MM/);
  assert.throws(() => parse([block, block]), /unique/);
});
test("weekly overlap validation considers effective dates and actual weekdays", () => {
  assert.doesNotThrow(() => parse([{ ...block, endsOn: "2026-09-01" }, { ...block, id: "later", startsOn: "2026-09-02" }]));
  assert.doesNotThrow(() => parse([block, { ...block, id: "weekend", weekdays: [6] }]));
  assert.doesNotThrow(() => parse([{ ...block, weekdays: [1], startsOn: "2026-09-24", endsOn: "2026-09-25" }, { ...block, id: "other" }]));
  assert.throws(() => parse([{ ...block, startsOn: "2026-02-30" }]), /valid date/);
  assert.throws(() => parse([{ ...block, startsOn: "2026-09-25", endsOn: "2026-09-24" }]), /end date/);
});
test("dated replacements replace the full day, support days off and cannot reopen a closure", () => {
  const replacement = { date: "2026-09-24", blocks: [{ id: "later", classId: "reading", startTime: "11:00", endTime: "12:00" }] };
  assert.equal(windows("2026-09-24", [replacement])[0]?.classId, "reading");
  assert.deepEqual(windows("2026-09-24", [{ ...replacement, blocks: [] }]), []);
  assert.deepEqual(standaloneKioskWindows(parse([block], [replacement]), replacement.date, "America/New_York", { "2026-09": { nonInstructionalDates: [replacement.date] } }), []);
  assert.throws(() => parse([block], [replacement, replacement]), /one replacement/);
  assert.throws(() => parse([], [{ ...replacement, blocks: [...replacement.blocks, { ...replacement.blocks[0], id: "overlap" }] }]), /overlap/);
});
test("school timezone preserves wall-clock meetings across DST changes", () => {
  assert.equal(windows("2026-03-06")[0]?.startsAt, "2026-03-06T14:00:00.000Z");
  assert.equal(windows("2026-03-09")[0]?.startsAt, "2026-03-09T13:00:00.000Z");
  assert.equal(windows("2026-10-30")[0]?.startsAt, "2026-10-30T13:00:00.000Z");
  assert.equal(windows("2026-11-02")[0]?.startsAt, "2026-11-02T14:00:00.000Z");
  assert.deepEqual(windows("2026-09-26"), []);
});
test("half-open assignments select the next adjacent period at the bell and preserve gaps", () => {
  const candidates = [activity("first", "13:00", "14:00"), activity("second", "14:00", "15:00"), activity("third", "16:00", "17:00")];
  assert.equal(select(candidates, "13:59").current?.id, "first");
  assert.equal(select(candidates, "14:00").current?.id, "second");
  assert.equal(select(candidates, "15:30").status, "idle");
  assert.equal(select(candidates, "15:30").next?.id, "third");
  assert.equal(select(candidates, "17:00").nextBoundaryAt, "2026-09-25T04:00:00.000Z");
});
test("testing overrides regular classes and the next assignment resumes the remaining ordinary window", () => {
  const candidates = [activity("math", "13:00", "15:00"), activity("test", "13:15", "14:00", "testing")];
  const active = select(candidates, "13:30");
  assert.equal(active.current?.id, "test");
  assert.equal(active.next?.id, "math");
  assert.equal(active.next?.startsAt, "2026-09-24T14:00:00.000Z");
  assert.equal(active.nextBoundaryAt, active.next?.startsAt);
});
test("pending/failed tests block fallback, and genuine ambiguity requires staff selection", () => {
  const regular = activity("math", "13:00", "15:00");
  const testing = activity("test", "13:15", "14:00", "testing");
  assert.equal(select([regular, { ...testing, state: "pending" }], "13:30").status, "pending");
  assert.equal(select([regular, { ...testing, state: "failed" }], "13:30").status, "failed");
  assert.equal(select([regular, { ...regular, id: "other" }], "13:30").status, "conflict");
  assert.equal(select([regular, testing, { ...testing, id: "other" }], "13:30").current, null);
});
test("suppressed class bells do not prematurely end a testing override", () => {
  const candidates = [activity("first", "13:00", "14:00"), activity("second", "14:00", "15:00"), activity("test", "13:15", "14:30", "testing")];
  assert.equal(select(candidates, "13:30").nextBoundaryAt, "2026-09-24T14:30:00.000Z");
});
