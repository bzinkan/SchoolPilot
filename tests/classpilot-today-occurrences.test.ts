import assert from "node:assert/strict";
import { test } from "node:test";
import { latestTodayOccurrenceGenerations, todayOccurrenceWindow, type TodayOccurrence } from "../src/services/classpilotTodayOccurrences.js";

function occurrence(groupId: string, generation: number, options: Partial<TodayOccurrence> = {}): TodayOccurrence {
  return { id: `${groupId}-${generation}`, schoolId: "synthetic-school", groupId, generation,
    changeId: `change-${generation}`, scheduledDate: "2026-11-02", timezoneSnapshot: "America/New_York",
    kind: "meeting", scheduledStartAt: new Date("2026-11-02T13:00:00Z"),
    scheduledEndAt: new Date("2026-11-02T13:45:00Z"), source: {}, primaryTeacherIdSnapshot: "synthetic-teacher",
    classNameSnapshot: "Synthetic class", createdAt: new Date("2026-11-02T12:00:00Z"), ...options };
}

test("a later change supersedes only each affected class's generation", () => {
  const other = occurrence("other", 1), old = occurrence("changed", 1), current = occurrence("changed", 3);
  const sameGeneration = occurrence("changed", 3, { id: "second-meeting", scheduledStartAt: new Date("2026-11-02T15:00:00Z") });
  const resolved = latestTodayOccurrenceGenerations([current, other, sameGeneration, old]);
  assert.deepEqual(resolved.get("other"), [other]);
  assert.deepEqual(resolved.get("changed"), [current, sameGeneration]);
  assert.equal(old.generation, 1);
});

test("an explicit empty generation suppresses the old meeting without changing its history", () => {
  const old = occurrence("class", 1);
  const suppressed = occurrence("class", 2, { kind: "suppression", scheduledStartAt: null, scheduledEndAt: null });
  const resolved = latestTodayOccurrenceGenerations([old, suppressed]);
  assert.deepEqual(resolved.get("class"), [suppressed]);
  assert.equal(todayOccurrenceWindow(suppressed), null);
  assert.equal(todayOccurrenceWindow(old)?.scheduledOccurrenceId, old.id);
});

test("retained live meetings keep their exact original identity across unrelated period edits", () => {
  const original = occurrence("class", 1);
  const copy = occurrence("class", 2, { source: { preservedOccurrenceId: original.id } });
  assert.equal(todayOccurrenceWindow(copy)?.scheduledOccurrenceId, original.id);
  assert.equal(todayOccurrenceWindow(copy)?.scheduledStartAt, copy.scheduledStartAt);
});

test("dated windows use school-local DST offsets and retain exact cutover seconds", () => {
  const row = occurrence("class", 1, { scheduledStartAt: new Date("2026-11-02T13:20:37Z") });
  const window = todayOccurrenceWindow(row);
  assert.equal(window?.blockStartTime, "08:20");
  assert.equal(window?.blockEndTime, "08:45");
  assert.equal(window?.scheduledStartAt.toISOString(), "2026-11-02T13:20:37.000Z");
});
