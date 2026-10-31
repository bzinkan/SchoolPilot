import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTodaySchedulePlan, reciprocalTodayCandidates, signTodayScheduleReview, verifyTodayScheduleReview,
  todayPlanReviewIdentity, todayScheduleDigest, type TodayClass, type TodayMeeting } from "../src/services/classpilotTodayScheduleModel.js";

const date = "2026-11-02";
function meeting(groupId: string, teacherId: string, starts: string, ends: string): TodayMeeting {
  return { groupId, name: groupId, teacherId, teacherName: teacherId, key: groupId, source: "recurring",
    startsAt: `${date}T${starts}:00.000Z`, endsAt: `${date}T${ends}:00.000Z`, state: "future", sessionId: null, scheduledOccurrenceId: null };
}
const first = meeting("v8", "vatter", "09:00", "09:45"), second = meeting("v7", "vatter", "10:00", "11:30");
const otherFirst = meeting("w7", "wendell", "09:00", "09:45"), otherSecond = meeting("w8", "wendell", "10:00", "11:30");
const input = { action: "swap" as const, expectedSchoolDate: date, currentGroupId: first.groupId, selectedGroupId: second.groupId };
const counterpart = { first: otherFirst, second: otherSecond };
function classroom(value: TodayMeeting, studentIds: string[]): TodayClass {
  return { groupId: value.groupId, name: value.name, primaryTeacherId: value.teacherId, primaryTeacherName: value.teacherName,
    studentIds, staffIds: [value.teacherId], rosterValid: true, meetings: [value] };
}
describe("Today period-swap model", () => {
  it("exchanges four existing entries even when the two periods have different durations", () => {
    const plan = buildTodaySchedulePlan({ input, first, second, counterpart, timeZone: "UTC", now: new Date(`${date}T08:00:00Z`) });
    assert.equal(plan.mode, "before_bell");
    assert.deepEqual(plan.after.map(row => [row.groupId, row.startsAt, row.endsAt]), [
      [first.groupId, second.startsAt, second.endsAt], [second.groupId, first.startsAt, first.endsAt],
      [otherFirst.groupId, second.startsAt, second.endsAt], [otherSecond.groupId, first.startsAt, first.endsAt],
    ]);
  });
  it("uses only the remaining current period and does not invent elapsed teaching time", () => {
    const now = new Date(`${date}T09:17:42Z`);
    const plan = buildTodaySchedulePlan({ input, first, second, counterpart, timeZone: "UTC", now });
    assert.equal(plan.mode, "remainder");
    assert.equal(plan.after[1]!.startsAt, now.toISOString());
    assert.equal(plan.after[1]!.endsAt, first.endsAt);
    const laterReview = buildTodaySchedulePlan({ input, first, second, counterpart, timeZone: "UTC", now: new Date(`${date}T09:18:00Z`) });
    assert.equal(todayScheduleDigest(todayPlanReviewIdentity(plan)), todayScheduleDigest(todayPlanReviewIdentity(laterReview)));
  });
  it("requires exact nonempty reciprocal student sets, not matching grade labels", () => {
    const ownFirst = classroom(first, ["x"]), ownSecond = classroom(second, ["y"]);
    const all = [ownFirst, ownSecond, classroom(otherFirst, ["y"]), classroom(otherSecond, ["x"])];
    assert.equal(reciprocalTodayCandidates(all, ownFirst, ownSecond, first, second).length, 1);
    all[3]!.studentIds = ["x", "extra"];
    assert.equal(reciprocalTodayCandidates(all, ownFirst, ownSecond, first, second).length, 0);
    all[3]!.studentIds = [];
    assert.equal(reciprocalTodayCandidates(all, ownFirst, ownSecond, first, second).length, 0);
  });
  it("does not hide duplicate candidate entries by choosing the first match", () => {
    const ownFirst = classroom(first, ["x"]), ownSecond = classroom(second, ["y"]);
    const duplicate = classroom({ ...otherSecond, groupId: "duplicate", key: "duplicate" }, ["x"]);
    assert.equal(reciprocalTodayCandidates([ownFirst, ownSecond, classroom(otherFirst, ["y"]), classroom(otherSecond, ["x"]), duplicate],
      ownFirst, ownSecond, first, second).length, 2);
  });
  it("binds signed reviews to school, author, action purpose and expiry", () => {
    const now = new Date(`${date}T09:00:00Z`);
    const token = signTodayScheduleReview({ v: 1, schoolId: "school-a", actorId: "teacher-a", purpose: "apply",
      scheduledDate: date, expiresAt: now.getTime() + 30_000, input });
    assert.equal(verifyTodayScheduleReview(token, { schoolId: "school-a", actorId: "teacher-a", purpose: "apply", now }).input?.currentGroupId, "v8");
    for (const options of [
      { schoolId: "school-b", actorId: "teacher-a", purpose: "apply" as const, now },
      { schoolId: "school-a", actorId: "teacher-b", purpose: "apply" as const, now },
      { schoolId: "school-a", actorId: "teacher-a", purpose: "accept" as const, now },
      { schoolId: "school-a", actorId: "teacher-a", purpose: "apply" as const, now: new Date(now.getTime() + 30_001) },
    ]) assert.throws(() => verifyTodayScheduleReview(token, options), { code: "TODAY_SCHEDULE_REVIEW_STALE" });
    assert.throws(() => verifyTodayScheduleReview(`${token}x`, { schoolId: "school-a", actorId: "teacher-a", purpose: "apply", now }),
      { code: "TODAY_SCHEDULE_REVIEW_STALE" });
  });
});
