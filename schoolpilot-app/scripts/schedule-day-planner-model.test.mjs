import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPlannerRows, filterPlannerRows, plannerAxis, plannerTime, plannerValidWindow } from '../src/products/classpilot/components/scheduleDayPlannerModel.js';

const referenceDate = '2026-09-14';
const definition = { name: 'MAP day', grades: [], classIds: ['homeroom', 'ela'], classRules: [], testingBlocks: [{ id: 'testing', name: 'MAP testing', coverageGroupId: 'map', assignedStaffId: 'zinkan', startTime: '09:00', endTime: '10:45' }] };
const catalog = {
  classes: [{ id: 'homeroom', name: 'Grade 5 Homeroom', gradeLevel: '5', scheduleEnabled: true, teacherName: 'Zinkan' }, { id: 'ela', name: 'Grade 5 ELA', gradeLevel: '5', scheduleEnabled: true, teacherName: 'Burba' }, { id: 'math', name: 'Grade 6 Math', gradeLevel: '6', scheduleEnabled: true, teacherName: 'Zinkan' }, { id: 'ungraded', name: 'Study hall', gradeLevel: null, scheduleEnabled: true }],
  staff: [{ id: 'zinkan', name: 'Zinkan' }, { id: 'burba', name: 'Burba' }],
  supervisionGroups: [{ id: 'map', name: 'MAP', studentCount: 12, staffIds: ['zinkan'] }],
};
const regularSchedule = { referenceDate, classes: [{ classId: 'homeroom', status: 'meets', window: { startTime: '08:30', endTime: '09:10' } }, { classId: 'ela', status: 'meets', window: { startTime: '09:15', endTime: '09:55' } }, { classId: 'math', status: 'meets', window: { startTime: '09:15', endTime: '09:55' } }, { classId: 'ungraded', status: 'not_scheduled', window: null }] };
const metadata = { referenceDate, classes: [{ classId: 'homeroom', staff: [{ id: 'zinkan', name: 'Zinkan' }] }, { classId: 'ela', staff: [{ id: 'burba', name: 'Burba' }, { id: 'zinkan', name: 'Zinkan' }] }, { classId: 'math', staff: [{ id: 'zinkan', name: 'Zinkan' }] }], testingBlocks: [{ blockId: 'testing', coverageGroupId: 'map', assignedStaffId: 'zinkan', classParticipation: [{ classId: 'homeroom', count: 12, total: 23 }, { classId: 'ela', count: 12, total: 23 }] }], issues: [{ id: 'conflict', kind: 'conflict', classIds: ['math'], blockIds: ['testing'] }] };
const model = overrides => buildPlannerRows({ definition, catalog, regularSchedule, referenceDate, metadata, ...overrides });
const all = { grade: 'all', classId: 'all', teacher: 'all', search: '', conflictsOnly: false };

test('Provisional edits shorten only an explicitly included meeting and keep a skipped row visible', () => {
  const result = model({ definition: { ...definition, classRules: [{ classId: 'homeroom', action: 'time', startTime: '08:30', endTime: '09:00' }, { classId: 'ela', action: 'skip' }] } });
  const homeroom = result.classes.find(row => row.id === 'homeroom');
  assert.equal(homeroom.regularWindow.endTime, '09:10');
  assert.equal(homeroom.proposedWindow.endTime, '09:00');
  assert.equal(result.classes.find(row => row.id === 'ela').proposedStatus, 'skipped');
  assert.equal(result.classes.find(row => row.id === 'ela').proposedWindow, null);
  assert.equal(result.classes.find(row => row.id === 'math').included, false);
  assert.equal(result.testing[0].proposedWindow.startTime, homeroom.proposedWindow.endTime);
  assert.deepEqual(result.classes.map(row => row.id), model().classes.map(row => row.id), 'Editing a time never reorders class rows');
});

test('Pending metadata keeps co-teachers and partial-class associations without stale conflict verdicts', () => {
  const pending = model();
  assert.equal(pending.rows.some(row => row.issues.length), false);
  assert.deepEqual(filterPlannerRows(pending.rows, { ...all, teacher: 'zinkan' }).map(row => row.id), ['ela', 'homeroom', 'math', 'ungraded', 'testing']);
  assert.deepEqual(filterPlannerRows(pending.rows, { ...all, classId: 'ela' }).map(row => row.id), ['ela', 'testing']);
  assert.deepEqual(pending.testing[0].classParticipation[0], { classId: 'homeroom', count: 12, total: 23 });
  const checked = model({ reviewData: metadata });
  assert.deepEqual(filterPlannerRows(checked.rows, { ...all, conflictsOnly: true }).map(row => row.id), ['math', 'testing']);
});

test('Date or group changes cannot reuse stale windows or participation as current facts', () => {
  const changedDate = model({ referenceDate: '2026-09-15' });
  assert.equal(changedDate.classes.every(row => !row.regularWindow), true);
  assert.equal(changedDate.testing[0].participationKnown, false);
  const changedGroup = model({ definition: { ...definition, testingBlocks: [{ ...definition.testingBlocks[0], coverageGroupId: 'replacement' }] } });
  assert.equal(changedGroup.testing[0].participationKnown, false);
  const closed = model({ regularSchedule: { referenceDate, classes: regularSchedule.classes.map(row => ({ ...row, status: 'not_scheduled', window: null })) }, reviewData: { ...metadata, classes: [{ ...metadata.classes[0], regularWindow: { startTime: '08:30', endTime: '09:10' } }] } });
  assert.equal(closed.classes.every(row => !row.regularWindow), true, 'Current closed-day projection wins over a previous review window');
});

test('Fresh review windows replace an older cached regular-day projection, while a newer regular revision wins', () => {
  const reviewData = { ...metadata, revision: 8, classes: [{ ...metadata.classes[0], status: 'meets', regularWindow: { startTime: '08:45', endTime: '09:05' } }] };
  const result = model({ regularSchedule: { ...regularSchedule, revision: 7 }, reviewData });
  assert.equal(result.classes.find(row => row.id === 'homeroom').regularWindow.startTime, '08:45');
  const closed = model({ regularSchedule: { referenceDate, revision: 9, classes: regularSchedule.classes.map(row => ({ ...row, status: 'not_scheduled', window: null })) }, reviewData });
  assert.equal(closed.classes.find(row => row.id === 'homeroom').regularWindow, null);
});

test('Unavailable assigned staff stays visibly unavailable in a completed response', () => {
  const result = model({ reviewData: { ...metadata, testingBlocks: [{ ...metadata.testingBlocks[0], status: 'unavailable' }] } });
  assert.equal(result.testing[0].status, 'unavailable');
  assert.equal(result.testing[0].proposedWindow.endTime, '10:45', 'The requested window remains visible for correction');
});

test('Current review participant counts replace stale catalog counts, including a genuinely empty group', () => {
  const reviewData = { ...metadata, testingBlocks: [{ ...metadata.testingBlocks[0], studentCount: 18 }] };
  assert.equal(model({ reviewData }).testing[0].studentCount, 18);
  const emptyReview = { ...reviewData, testingBlocks: [{ ...reviewData.testingBlocks[0], studentCount: 0, status: 'unavailable' }] };
  assert.equal(model({ reviewData: emptyReview }).testing[0].studentCount, 0);
  assert.equal(model({ metadata: reviewData }).testing[0].studentCount, 12, 'Pending checks retain the current catalog fallback rather than treating old review metadata as authoritative');
  const wrongGroup = { ...reviewData, testingBlocks: [{ ...reviewData.testingBlocks[0], coverageGroupId: 'other', studentCount: 99 }] };
  assert.equal(model({ reviewData: wrongGroup }).testing[0].studentCount, 12, 'Counts cannot follow a different group association');
});

test('Incomplete times have no fabricated bars, and ineligible regular meetings stay absent', () => {
  const result = model({ definition: { ...definition, classRules: [{ classId: 'homeroom', action: 'time', startTime: '', endTime: '09:00' }, { classId: 'ungraded', action: 'time', startTime: '10:00', endTime: '11:00' }], testingBlocks: [{ ...definition.testingBlocks[0], endTime: '08:59' }] } });
  assert.equal(result.classes.find(row => row.id === 'homeroom').proposedStatus, 'incomplete');
  assert.equal(result.classes.find(row => row.id === 'homeroom').proposedWindow, null);
  assert.equal(result.classes.find(row => row.id === 'ungraded').proposedWindow, null);
  assert.equal(result.testing[0].proposedWindow, null);
  assert.equal(plannerValidWindow({ startTime: '09:00', endTime: '09:00' }), false);
});

test('Unassigned grade filtering works and an active editor survives its own filter-changing edit', () => {
  const result = model();
  assert.deepEqual(filterPlannerRows(result.rows, { ...all, grade: 'unassigned' }).map(row => row.id), ['ungraded']);
  assert.deepEqual(filterPlannerRows(result.rows, { ...all, search: 'no match' }).map(row => row.id), []);
  assert.deepEqual(filterPlannerRows(result.rows, { ...all, search: 'no match' }, { blockId: 'testing' }).map(row => row.id), ['testing']);
});

test('Missing saved class references remain visible for correction', () => {
  const result = model({ definition: { ...definition, classIds: [...definition.classIds, 'deleted'] } });
  const row = result.classes.find(item => item.id === 'deleted');
  assert.equal(row.name, 'Unavailable class');
  assert.equal(row.included, true);
  assert.equal(row.status, 'unavailable');
  assert.equal(row.proposedWindow, null);
});

test('A newly created outside-selection obligation from review is visible, filterable, and linked to its issue', () => {
  const newClass = { classId: 'new-duty', name: 'Grade 7 Science', gradeLevel: '7', status: 'meets', staff: [{ id: 'zinkan', name: 'Zinkan' }], regularWindow: { startTime: '09:15', endTime: '10:00' } };
  const reviewData = { ...metadata, classes: [...metadata.classes, newClass], issues: [{ id: 'new-conflict', kind: 'conflict', classIds: ['new-duty'], blockIds: ['testing'] }] };
  const result = model({ reviewData });
  const row = result.classes.find(item => item.id === 'new-duty');
  assert.equal(row.name, 'Grade 7 Science');
  assert.equal(row.included, false);
  assert.equal(row.regularWindow.startTime, '09:15');
  assert.equal(row.issues[0].id, 'new-conflict');
  assert.equal(filterPlannerRows(result.rows, { ...all, grade: '7', teacher: 'zinkan', conflictsOnly: true }).some(item => item.id === 'new-duty'), true);
  assert.equal(model({ metadata: reviewData }).classes.find(item => item.id === 'new-duty').name, 'Grade 7 Science', 'A pending follow-up check does not discard the active row identity');
});

test('New regular-projection classes display their window without inventing missing class details', () => {
  const newRegular = { classId: 'new-duty', status: 'meets', window: { startTime: '09:15', endTime: '10:00' } };
  const row = model({ regularSchedule: { ...regularSchedule, classes: [...regularSchedule.classes, newRegular] } }).classes.find(item => item.id === 'new-duty');
  assert.equal(row.name, 'Class details unavailable');
  assert.equal(row.detailsUnavailable, true);
  assert.equal(row.regularWindow.startTime, '09:15');
  assert.deepEqual(row.staff, []);
  assert.equal(row.grade, 'unassigned');
});

test('Axis fits valid full-day windows and labels midnight accurately', () => {
  const axis = plannerAxis([{ regularWindow: { startTime: '00:05', endTime: '23:59' } }]);
  assert.equal(axis.start, 0);
  assert.equal(axis.end, 1440);
  assert.equal(plannerTime(0), '12:00 AM');
  assert.equal(plannerTime(720), '12:00 PM');
  assert.equal(plannerTime(1440), '12:00 AM');
  assert.equal(plannerAxis([]).end - plannerAxis([]).start > 0, true);
});
