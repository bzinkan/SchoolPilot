import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { seatingCreateInput, seatingDuplicateInput, seatingLayout, seatingListQuery, seatingMutationInput, seatingUpdateInput } from "../src/services/mydeskSeatingValidation.js";
import { myDeskSeatingEnabledForSchool } from "../src/services/mydeskValidation.js";

const desk = (x = 0, y = 0) => ({ id: randomUUID(), x, y, studentId: null as string | null, locked: false });
const request = () => ({ clientRequestId: randomUUID(), classId: "grade-five", name: "Everyday", layout: { version: 1 as const, seats: [desk()] }, rosterRevision: "a".repeat(64) });

test("seating accepts bounded geometry including touching paired desks", () => {
  const seats = Array.from({ length: 100 }, (_, i) => desk((i % 10) * 110, Math.floor(i / 10) * 80));
  assert.equal(seatingLayout.parse({ version: 1, seats }).seats.length, 100);
  assert.equal(seatingLayout.safeParse({ version: 1, seats: [desk(), desk(100)] }).success, true);
  assert.equal(seatingLayout.safeParse({ version: 1, seats: [] }).success, true);
});
test("seating rejects overlaps, off-grid desks, invalid IDs and impossible locks", () => {
  const first = { ...desk(), studentId: "student-five" };
  for (const seats of [
    [desk(), desk(90)], [desk(-10)], [desk(1110)], [desk(0, 850)], [desk(3)], [desk(Number.NaN)],
    [first, { ...first, x: 100 }], [first, { ...desk(100), studentId: first.studentId }],
    [{ ...desk(), locked: true }], [{ ...desk(), id: "not-a-uuid" }],
    Array.from({ length: 101 }, (_, i) => desk((i % 10) * 100, Math.floor(i / 10) * 70)),
  ]) assert.equal(seatingLayout.safeParse({ version: 1, seats }).success, false);
  assert.equal(seatingLayout.safeParse({ version: 2, seats: [] }).success, false);
});
test("seating interfaces reject injected authority, labels and missing retry/revision contracts", () => {
  const valid = request();
  assert.equal(seatingCreateInput.safeParse(valid).success, true);
  for (const field of ["schoolId", "authorId", "className", "roster", "isCurrent", "visibility"])
    assert.equal(seatingCreateInput.safeParse({ ...valid, [field]: "injected" }).success, false);
  assert.equal(seatingCreateInput.safeParse({ ...valid, layout: { version: 1, seats: [{ ...desk(), name: "arbitrary label" }] } }).success, false);
  assert.equal(seatingCreateInput.safeParse({ ...valid, name: " " }).success, false);
  assert.equal(seatingCreateInput.safeParse({ ...valid, rosterRevision: "old" }).success, false);
  const update = { requestId: randomUUID(), revision: 1, name: valid.name, layout: valid.layout, rosterRevision: valid.rosterRevision };
  assert.equal(seatingUpdateInput.safeParse(update).success, true);
  assert.equal(seatingUpdateInput.safeParse({ ...update, revision: undefined }).success, false);
  assert.equal(seatingMutationInput.safeParse({ revision: 1 }).success, false);
  assert.equal(seatingDuplicateInput.safeParse({ clientRequestId: randomUUID(), sourceRevision: 1, targetClassId: valid.classId, name: valid.name, mode: "layout", rosterRevision: valid.rosterRevision }).success, true);
  assert.equal(seatingListQuery.safeParse({ limit: 101 }).success, false);
});
test("seating mode enables every school while requiring the base notebook", () => {
  const keys = ["MYDESK_MODE", "MYDESK_SEATING_MODE", "MYDESK_AI_IMPORT_MODE"] as const;
  const original = keys.map(key => process.env[key]);
  try {
    keys.forEach(key => delete process.env[key]);
    process.env.MYDESK_MODE = "on";
    assert.equal(myDeskSeatingEnabledForSchool("school-five"), false);
    process.env.MYDESK_SEATING_MODE = "on";
    assert.equal(myDeskSeatingEnabledForSchool("school-five"), true);
    assert.equal(myDeskSeatingEnabledForSchool("school-six"), true);
    process.env.MYDESK_MODE = "off";
    assert.equal(myDeskSeatingEnabledForSchool("school-five"), false);
    process.env.MYDESK_MODE = "on";
    process.env.MYDESK_SEATING_MODE = "*";
    assert.equal(myDeskSeatingEnabledForSchool("school-five"), false);
  } finally { keys.forEach((key, i) => { if (original[i] === undefined) delete process.env[key]; else process.env[key] = original[i]; }); }
});
