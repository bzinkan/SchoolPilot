import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { seatingCreateInput, seatingDuplicateInput, seatingLayout, seatingListQuery, seatingMutationInput, seatingUpdateInput } from "../src/services/mydeskSeatingValidation.js";
import { myDeskSeatingEnabledForSchool } from "../src/services/mydeskValidation.js";
import { copySeatingGeometry, doorSwingWarnings, type MeasuredLayout, type MeasuredSeat } from "../src/shared/mydeskSeatingGeometry.js";

const desk = (x = 0, y = 0) => ({ id: randomUUID(), x, y, studentId: null as string | null, locked: false });
const request = () => ({ clientRequestId: randomUUID(), classId: "grade-five", name: "Everyday", layout: { version: 1 as const, seats: [desk()] }, rosterRevision: "a".repeat(64) });
function measured(points = [[0, 0], [10000, 0], [10000, 8000], [0, 8000]]): MeasuredLayout {
  const vertices = points.map(([x, y]) => ({ id: randomUUID(), wallId: randomUUID(), x: x!, y: y! }));
  return { version: 2, units: "mm", displayUnit: "imperial", room: { vertices, frontWallId: vertices[0]!.wallId }, seats: [], features: [] };
}
const measuredDesk = (patch: Partial<MeasuredSeat> = {}): MeasuredSeat => ({ id: randomUUID(), x: 1000, y: 1000, width: 600, height: 450, rotation: 0, studentId: null, locked: false, ...patch });

test("measured seating rejects crossings, concave-edge excursions and rotated solid collisions", () => {
  const valid = measured([[0, 0], [9000, 0], [10000, 5000], [7000, 8000], [0, 8000]]);
  valid.seats = [measuredDesk({ rotation: 35.1 })];
  valid.features = [{ id: randomUUID(), kind: "teacherDesk", x: 5000, y: 3000, width: 1200, height: 600, rotation: 25, label: "Teacher" }];
  assert.equal(seatingLayout.safeParse(valid).success, true);
  const crossing = measured([[0, 0], [6000, 6000], [6000, 0], [0, 6000]]);
  assert.equal(seatingLayout.safeParse(crossing).success, false);
  const notch = measured([[0, 0], [6000, 0], [6000, 6000], [3500, 6000], [3500, 3000], [2500, 3000], [2500, 6000], [0, 6000]]);
  // All four corners are inside; the long bottom edge crosses the concave notch.
  notch.seats = [measuredDesk({ x: 1000, y: 2000, width: 4000, height: 3000 })];
  assert.equal(seatingLayout.safeParse(notch).success, false);
  valid.seats.push(measuredDesk({ x: 5100, y: 3100, rotation: 45 }));
  assert.equal(seatingLayout.safeParse(valid).success, false);
});

test("measured bounds, stable IDs, anchored openings, labels, and lock rules fail closed", () => {
  const layout = measured();
  layout.features = [{ id: randomUUID(), kind: "door", wallId: layout.room.frontWallId, offset: 1000, width: 900, hinge: "start", swing: "in" }];
  assert.equal(seatingLayout.safeParse(layout).success, true);
  for (const change of [
    (l: MeasuredLayout) => { l.room.vertices[1]!.x = 50001; },
    (l: MeasuredLayout) => { l.room.frontWallId = randomUUID(); },
    (l: MeasuredLayout) => { l.features.push({ ...l.features[0]!, id: randomUUID() }); },
    (l: MeasuredLayout) => { l.features[0]!.label = "x".repeat(61); },
    (l: MeasuredLayout) => { l.seats = [measuredDesk({ locked: true })]; },
    (l: MeasuredLayout) => { l.seats = [measuredDesk({ id: l.room.vertices[0]!.id })]; },
    (l: MeasuredLayout) => { l.features = Array.from({ length: 101 }, () => ({ ...l.features[0]!, id: randomUUID() })); },
  ]) { const altered = structuredClone(layout); change(altered); assert.equal(seatingLayout.safeParse(altered).success, false); }
});

test("the measured envelope accepts 100 desks and 100 fixtures but bounds its room and opening references", () => {
  const layout = measured([[0, 0], [50000, 0], [50000, 50000], [0, 50000]]);
  layout.seats = Array.from({ length: 100 }, (_, i) => measuredDesk({ x: (i % 10) * 1000, y: Math.floor(i / 10) * 1000 }));
  layout.features = Array.from({ length: 100 }, (_, i) => ({ id: randomUUID(), kind: "cabinet" as const, x: 20000 + (i % 10) * 1000, y: Math.floor(i / 10) * 1000, width: 800, height: 500, rotation: 0 }));
  assert.equal(seatingLayout.safeParse(layout).success, true);
  layout.features[0] = { id: randomUUID(), kind: "window", wallId: randomUUID(), offset: 0, width: 900, hinge: "start", swing: "in" };
  assert.equal(seatingLayout.safeParse(layout).success, false);
});

test("copying a measured room remaps anchored IDs and door clearance remains advisory", () => {
  const layout = measured(); layout.seats = [measuredDesk({ x: 1100, y: 100, studentId: "student-a", locked: true })];
  layout.features = [{ id: randomUUID(), kind: "door", wallId: layout.room.frontWallId, offset: 1000, width: 900, hinge: "start", swing: "in" }];
  assert.equal(seatingLayout.safeParse(layout).success, true);
  assert.equal(doorSwingWarnings(layout).length, 1);
  const copy = copySeatingGeometry(layout, randomUUID, true);
  assert.equal(seatingLayout.safeParse(copy).success, true);
  assert.notEqual(copy.room.frontWallId, layout.room.frontWallId);
  assert.equal(copy.features[0]!.kind === "door" && copy.features[0]!.wallId, copy.room.frontWallId);
  assert.equal(copy.seats[0]!.studentId, null); assert.equal(copy.seats[0]!.locked, false);
  assert.equal(layout.seats[0]!.studentId, "student-a");
});

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
