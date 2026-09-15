import assert from 'node:assert/strict';
import test from 'node:test';
import { classPlacementCandidates, classPlacementFingerprint, classPlacementUnavailable, reviewClassPlacement } from '../src/products/classpilot/components/scheduleClassPlacement.js';
import { buildPlannerOccurrences, buildPlannerRows, capturePlannerRanks, filterPlannerRows, plannerAxis, plannerClipWindow, plannerOutsideHours, plannerTime, plannerValidWindow } from '../src/products/classpilot/components/scheduleDayPlannerModel.js';

const referenceDate = '2026-09-14';
const definition = { name: 'MAP day', grades: [], classIds: ['homeroom', 'ela'], classRules: [], testingBlocks: [{ id: 'testing', name: 'MAP testing', coverageGroupId: 'map', assignedStaffId: 'zinkan', startTime: '09:00', endTime: '10:45' }] };
const catalog = {
  classes: [{ id: 'homeroom', name: 'Grade 5 Homeroom', gradeLevel: '5', scheduleEnabled: true, teacherName: 'Zinkan' }, { id: 'ela', name: 'Grade 5 ELA', gradeLevel: '5', scheduleEnabled: true, teacherName: 'Burba' }, { id: 'math', name: 'Grade 6 Math', gradeLevel: '6', scheduleEnabled: true, teacherName: 'Zinkan' }, { id: 'ungraded', name: 'Study hall', gradeLevel: null, scheduleEnabled: true }],
  staff: [{ id: 'zinkan', name: 'Zinkan' }, { id: 'burba', name: 'Burba' }],
  supervisionGroups: [{ id: 'map', name: 'MAP', studentCount: 12, staffIds: ['zinkan'] }],
};
const regularSchedule = { referenceDate, classes: [{ classId: 'homeroom', status: 'meets', window: { startTime: '08:30', endTime: '09:10' } }, { classId: 'ela', status: 'meets', window: { startTime: '09:15', endTime: '09:55' } }, { classId: 'math', status: 'meets', window: { startTime: '09:15', endTime: '09:55' } }, { classId: 'ungraded', status: 'not_scheduled', window: null }] };
const metadata = { referenceDate, classes: [{ classId: 'homeroom', staff: [{ id: 'zinkan', name: 'Zinkan' }] }, { classId: 'ela', staff: [{ id: 'burba', name: 'Burba' }, { id: 'zinkan', name: 'Zinkan' }] }, { classId: 'math', staff: [{ id: 'zinkan', name: 'Zinkan' }] }], testingBlocks: [{ blockId: 'testing', coverageGroupId: 'map', assignedStaffId: 'zinkan', classParticipation: [{ classId: 'homeroom', count: 12, total: 23 }, { classId: 'ela', count: 12, total: 23 }] }], issues: [{ id: 'conflict', kind: 'conflict', classIds: ['math'], blockIds: ['testing'] }] };
const checkedReview = {
  ...metadata, revision: 7,
  classes: regularSchedule.classes.map(row => ({ ...catalog.classes.find(item => item.id === row.classId), ...metadata.classes.find(item => item.classId === row.classId),
    classId: row.classId, status: row.status, proposedStatus: row.status, selected: definition.classIds.includes(row.classId), action: 'keep', regularWindow: row.window, proposedWindow: row.window })),
  testingBlocks: [{ ...definition.testingBlocks[0], ...metadata.testingBlocks[0], status: 'ready', studentCount: 12 }],
};
const model = overrides => buildPlannerRows({ definition, catalog, regularSchedule, referenceDate, metadata, ...overrides });
const all = { grade: 'all', classId: 'all', teacher: 'all', search: '', conflictsOnly: false };

test('Class placement swaps the two proposed meetings atomically without renaming or duplicating either class', () => {
  const draft = { ...structuredClone(definition), classRules: [{ classId: 'homeroom', action: 'time', startTime: '10:45', endTime: '11:20' }, { classId: 'ela', action: 'time', startTime: '12:00', endTime: '12:35' }] };
  const before = structuredClone(draft), rows = model({ definition: draft }).classes;
  const plan = reviewClassPlacement({ definition: draft, classes: rows, originalId: 'homeroom', selectedId: 'ela', action: 'swap' });
  assert.equal(plan.error, undefined);
  assert.deepEqual(plan.definition.classRules, [{ classId: 'homeroom', action: 'time', startTime: '12:00', endTime: '12:35' }, { classId: 'ela', action: 'time', startTime: '10:45', endTime: '11:20' }]);
  assert.deepEqual(plan.definition.testingBlocks, draft.testingBlocks);
  assert.deepEqual(plan.addedClassIds, []);
  assert.deepEqual(draft, before, 'Opening/reviewing the placement leaves the current draft untouched');
  const projected = model({ definition: plan.definition });
  assert.deepEqual(projected.classes.map(row => [row.id, row.name]), rows.map(row => [row.id, row.name]));
  assert.equal(projected.classes.filter(row => row.id === 'ela').length, 1);
  assert.deepEqual(plan.changes.map(change => change.after), [{ startTime: '12:00', endTime: '12:35' }, { startTime: '10:45', endTime: '11:20' }]);
});

test('Move and skip restores a skipped eligible class and explicitly includes only affected outside-selection classes', () => {
  const draft = { ...structuredClone(definition), classIds: ['math'], classRules: [{ classId: 'ela', action: 'skip' }, { classId: 'math', action: 'skip' }] };
  // A skipped rule still needs profile inclusion to be a displayed skipped row.
  draft.classIds.push('ela');
  const rows = model({ definition: draft }).classes;
  const plan = reviewClassPlacement({ definition: draft, classes: rows, originalId: 'homeroom', selectedId: 'ela', action: 'move-skip' });
  assert.equal(plan.error, undefined);
  assert.deepEqual(plan.addedClassIds, ['homeroom']);
  assert.deepEqual(plan.definition.classIds, ['math', 'ela', 'homeroom']);
  assert.deepEqual(plan.definition.grades, []);
  assert.deepEqual(plan.definition.classRules, [{ classId: 'ela', action: 'time', startTime: '08:30', endTime: '09:10' }, { classId: 'math', action: 'skip' }, { classId: 'homeroom', action: 'skip' }]);
  assert.deepEqual(plan.changes.map(change => [change.classId, change.includedBefore, change.includedAfter]), [['homeroom', false, true], ['ela', true, true]]);
  assert.equal(model({ definition: plan.definition }).classes.find(row => row.id === 'ela').proposedWindow.startTime, '08:30');
  assert.equal(reviewClassPlacement({ definition: draft, classes: rows, originalId: 'homeroom', selectedId: 'ela', action: 'swap' }).error.includes('skipped'), true);
  const byGrade = { ...structuredClone(definition), grades: ['5'], classIds: [] };
  assert.deepEqual(reviewClassPlacement({ definition: byGrade, classes: model({ definition: byGrade }).classes, originalId: 'homeroom', selectedId: 'ela', action: 'swap' }).definition.classIds, ['homeroom', 'ela'], 'Both affected identities are explicit while the existing grade selection is retained');
});

test('Class placement fails closed on unknown, inactive, ineligible and incomplete meetings and enforces draft limits', () => {
  const rows = model().classes;
  for (const patch of [{ active: false }, { status: 'unavailable' }, { detailsUnavailable: true }, { scheduleEnabled: false }, { status: 'not_scheduled' }, { regularWindow: null }, { proposedWindow: null, action: 'time' }]) {
    const altered = rows.map(row => row.id === 'ela' ? { ...row, ...patch } : row);
    assert.ok(reviewClassPlacement({ definition, classes: altered, originalId: 'homeroom', selectedId: 'ela', action: 'move-skip' }).error, JSON.stringify(patch));
  }
  assert.ok(classPlacementUnavailable({ ...rows[0], proposedWindow: null, action: 'skip' }, true));
  assert.equal(classPlacementUnavailable({ ...rows[0], active: false, status: 'unavailable' }), 'This class is inactive.');
  for (const [selectedId, action] of [['missing', 'swap'], ['homeroom', 'swap'], ['ela', '']]) assert.ok(reviewClassPlacement({ definition, classes: rows, originalId: 'homeroom', selectedId, action }).error);
  const limit = { ...definition, classIds: Array.from({ length: 500 }, (_, index) => 'other-' + index) };
  assert.match(reviewClassPlacement({ definition: limit, classes: rows, originalId: 'homeroom', selectedId: 'ela', action: 'swap' }).error, /500 individually/);
  const ruleLimit = { ...definition, classRules: Array.from({ length: 500 }, (_, index) => ({ classId: 'other-' + index, action: 'skip' })) };
  assert.match(reviewClassPlacement({ definition: ruleLimit, classes: rows, originalId: 'homeroom', selectedId: 'ela', action: 'swap' }).error, /500 class adjustments/);
});

test('Inactive catalog references are disabled picker choices without expanding planner rows or grade inclusion', () => {
  const inactiveClasses = [{ id: 'archived', name: 'Archived ELA', gradeLevel: '5', active: false, staff: [{ id: 'burba', name: 'Burba' }], studentCount: null }];
  const draft = { ...definition, grades: ['5'] }, result = model({ definition: draft, catalog: { ...catalog, inactiveClasses } });
  assert.equal(result.classes.some(row => row.id === 'archived'), false);
  assert.equal(result.classes.filter(row => row.included).length, 2);
  const candidates = classPlacementCandidates(result.classes, inactiveClasses), archived = candidates.find(row => row.id === 'archived');
  assert.equal(archived.name, 'Archived ELA');
  assert.equal(archived.regularWindow, null);
  assert.equal(archived.proposedWindow, null);
  assert.equal(classPlacementUnavailable(archived), 'This class is inactive.');
  assert.ok(reviewClassPlacement({ definition: draft, classes: candidates, originalId: 'homeroom', selectedId: 'archived', action: 'swap' }).error);
  const stale = { ...result.classes[0], id: 'archived' };
  const deduplicated = classPlacementCandidates([...result.classes, stale], inactiveClasses);
  assert.equal(deduplicated.filter(row => row.id === 'archived').length, 1);
  assert.equal(classPlacementUnavailable(deduplicated.find(row => row.id === 'archived')), 'This class is inactive.', 'Fresh inactive metadata overrides a stale reviewed meeting only inside the picker');
  assert.deepEqual(result.classes.map(row => row.id), model({ definition: draft }).classes.map(row => row.id));
});

test('A frozen placement invalidates on changed draft, date, revision, eligibility or roster and staff facts', () => {
  const context = { definition, classes: model().classes, referenceDate, revision: 4 };
  const fingerprint = classPlacementFingerprint(context);
  for (const patch of [{ definition: { ...definition, classIds: [] } }, { referenceDate: '2026-09-15' }, { revision: 5 }, ...[{ status: 'not_scheduled' }, { studentCount: 12 }, { rosterFingerprint: 'same-count-different-roster' }, { staff: [{ id: 'new-teacher', name: 'New teacher' }] }].map(change => ({ classes: context.classes.map(row => row.id === 'ela' ? { ...row, ...change } : row) }))]) assert.notEqual(classPlacementFingerprint({ ...context, ...patch }), fingerprint);
  assert.notEqual(classPlacementFingerprint({ ...context, classes: context.classes.map(row => ({ ...row, name: row.name + ' updated' })) }), fingerprint, 'The reviewed class identity stays tied to its displayed label');
});

test('After testing stays authoritative to the exact current review and never carries forward during a changed draft', () => {
  const afterTesting = { status: 'ready', studentCount: 12, allocations: [{ kind: 'gap', studentCount: 12, classIds: ['homeroom'], blockIds: [], staff: [], at: '11:00' }] };
  const reviewData = { ...checkedReview, testingBlocks: [{ ...checkedReview.testingBlocks[0], afterTesting }] };
  assert.deepEqual(model({ reviewData }).testing[0].afterTesting, afterTesting);
  assert.equal(model({ metadata: reviewData }).testing[0].afterTesting, null);
  const changed = { ...definition, testingBlocks: [{ ...definition.testingBlocks[0], endTime: '10:30' }] };
  assert.equal(model({ definition: changed, reviewData }).testing[0].afterTesting, null);
  assert.equal(model({ reviewData, regularSchedule: { ...regularSchedule, revision: 8 } }).testing[0].afterTesting, null);
  const unknownCount = { ...checkedReview, classes: checkedReview.classes.map(row => ({ ...row, studentCount: null })) };
  assert.equal(model({ reviewData: unknownCount, catalog: { ...catalog, classes: catalog.classes.map(row => ({ ...row, studentCount: 99 })) } }).classes[0].studentCount, null);
});

test('Student conflicts use the exact server interval after testing supervision masks rather than the whole class intersection', () => {
  const issue = { id: 'masked-student-overlap', code: 'SCHEDULE_PROFILE_STUDENT_CLASS_CONFLICT', kind: 'conflict', classIds: ['ela', 'math'], blockIds: [], overlapWindow: { startTime: '09:40', endTime: '09:55' }, studentCount: 2 };
  const result = model({ reviewData: { ...checkedReview, issues: [issue] } });
  assert.deepEqual(result.classes.find(row => row.id === 'ela').overlapSpans.map(span => [span.startTime, span.endTime]), [['09:40', '09:55']]);
  const withoutInterval = model({ reviewData: { ...checkedReview, issues: [{ ...issue, overlapWindow: undefined }] } });
  assert.equal(withoutInterval.classes.find(row => row.id === 'ela').overlapSpans.length, 0, 'A missing server interval must not invent shade');
});

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
  assert.deepEqual(filterPlannerRows(pending.rows, { ...all, teacher: 'zinkan' }).map(row => row.id), ['homeroom', 'ela', 'math', 'ungraded', 'testing']);
  assert.deepEqual(filterPlannerRows(pending.rows, { ...all, classId: 'ela' }).map(row => row.id), ['ela', 'testing']);
  assert.deepEqual(pending.testing[0].classParticipation[0], { classId: 'homeroom', count: 12, total: 23 });
  const checked = model({ reviewData: checkedReview });
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
  const result = model({ reviewData: { ...checkedReview, testingBlocks: [{ ...checkedReview.testingBlocks[0], status: 'unavailable' }] } });
  assert.equal(result.testing[0].status, 'unavailable');
  assert.equal(result.testing[0].proposedWindow.endTime, '10:45', 'The requested window remains visible for correction');
});

test('Current review participant counts replace stale catalog counts, including a genuinely empty group', () => {
  const reviewData = { ...checkedReview, testingBlocks: [{ ...checkedReview.testingBlocks[0], studentCount: 18 }] };
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
  const newClass = { classId: 'new-duty', name: 'Grade 7 Science', gradeLevel: '7', status: 'meets', staff: [{ id: 'zinkan', name: 'Zinkan' }], regularWindow: { startTime: '09:15', endTime: '10:00' }, proposedWindow: { startTime: '09:15', endTime: '10:00' } };
  const reviewData = { ...checkedReview, classes: [...checkedReview.classes, newClass], issues: [{ id: 'new-conflict', kind: 'conflict', classIds: ['new-duty'], blockIds: ['testing'] }] };
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

test('Minute labels preserve midnight and noon without changing chart bounds', () => {
  assert.equal(plannerTime(0), '12:00 AM');
  assert.equal(plannerTime(720), '12:00 PM');
  assert.equal(plannerTime(1440), '12:00 AM');
});

test('Exact spans render only the affected intersections of the four server-issued overlap codes', () => {
  const second = { ...definition.testingBlocks[0], id: 'second', name: 'Second testing', startTime: '10:00', endTime: '11:00' };
  const issues = [
    { id: 'staff', kind: 'conflict', code: 'CLASS_SCHEDULE_CONFLICT', classIds: ['ela', 'math'], blockIds: [] },
    { id: 'proctor', kind: 'conflict', code: 'SCHEDULE_PROFILE_PROCTOR_CLASS_CONFLICT', classIds: ['homeroom'], blockIds: ['testing'] },
    { id: 'students', kind: 'overlap', code: 'SCHEDULE_DRAFT_TESTING_CLASS_OVERLAP', classIds: ['ela'], blockIds: ['testing'] },
    { id: 'testing-pair', kind: 'conflict', code: 'SCHEDULE_PROFILE_CONFLICT', classIds: [], blockIds: ['testing', 'second'] },
  ];
  const reviewData = { ...checkedReview, issues, testingBlocks: [...checkedReview.testingBlocks, { ...second, blockId: 'second', classParticipation: [], status: 'ready' }] };
  const result = model({ definition: { ...definition, testingBlocks: [...definition.testingBlocks, second] }, reviewData });
  assert.equal(result.reviewCurrent, true);
  assert.deepEqual(result.classes.find(row => row.id === 'homeroom').overlapSpans.map(span => [span.issueId, span.startTime, span.endTime]), [['proctor', '09:00', '09:10']]);
  assert.deepEqual(result.classes.find(row => row.id === 'ela').overlapSpans.map(span => [span.issueId, span.startTime, span.endTime]), [['staff', '09:15', '09:55'], ['students', '09:15', '09:55']]);
  assert.deepEqual(result.testing[1].overlapSpans.map(span => [span.issueId, span.startTime, span.endTime]), [['testing-pair', '10:00', '10:45']]);
  assert.equal(result.classes.find(row => row.id === 'homeroom').proposedWindow.endTime, '09:10', 'Highlighting never shortens the class');
  assert.equal(result.testing[0].proposedWindow.endTime, '10:45');
  assert.equal(result.classes.find(row => row.id === 'ungraded').overlapSpans.length, 0);
  assert.equal(model({ reviewData: { ...checkedReview, issues: [] } }).rows.every(row => !row.overlapSpans.length), true, 'Coincident clocks alone never create client verdicts');
});

test('Touching endpoints, unsupported issue codes, and incomplete rows never invent highlighted spans', () => {
  const issue = { id: 'adjacent', kind: 'overlap', code: 'SCHEDULE_DRAFT_TESTING_CLASS_OVERLAP', classIds: ['homeroom'], blockIds: ['testing'] };
  const adjustedDefinition = { ...definition, classRules: [{ classId: 'homeroom', action: 'time', startTime: '08:30', endTime: '09:00' }] };
  const reviewData = { ...checkedReview, classes: checkedReview.classes.map(row => row.classId === 'homeroom' ? { ...row, action: 'time', proposedWindow: { startTime: '08:30', endTime: '09:00' } } : row), issues: [issue] };
  const adjacent = model({ definition: adjustedDefinition, reviewData });
  assert.equal(adjacent.reviewCurrent, true);
  assert.equal(adjacent.rows.every(row => !row.overlapSpans.length), true);
  const unknown = model({ reviewData: { ...checkedReview, issues: [{ ...issue, code: 'FUTURE_REVIEW_RULE' }, { id: 'monitoring', kind: 'conflict', code: 'SCHEDULE_PROFILE_MONITORING_NOT_FULL', classIds: [], blockIds: ['testing'] }] } });
  assert.equal(unknown.issues.length, 2);
  assert.equal(unknown.rows.every(row => !row.overlapSpans.length), true);
  const incomplete = model({ definition: { ...definition, classRules: [{ classId: 'homeroom', action: 'time', startTime: '', endTime: '09:00' }] } });
  assert.equal(incomplete.classes.find(row => row.id === 'homeroom').overlapSpans.length, 0);
});

test('Superseded windows, assignments, dates, and newer regular revisions clear spans and all stale verdicts', () => {
  const issue = { id: 'proctor', kind: 'conflict', code: 'SCHEDULE_PROFILE_PROCTOR_CLASS_CONFLICT', classIds: ['homeroom'], blockIds: ['testing'] };
  const reviewData = { ...checkedReview, issues: [issue] };
  const changedRule = { ...definition, classRules: [{ classId: 'homeroom', action: 'time', startTime: '08:30', endTime: '09:00' }] };
  for (const overrides of [
    { definition: changedRule },
    { definition: { ...definition, testingBlocks: [{ ...definition.testingBlocks[0], endTime: '11:00' }] } },
    { definition: { ...definition, testingBlocks: [{ ...definition.testingBlocks[0], assignedStaffId: 'burba' }] } },
    { referenceDate: '2026-09-15' },
    { regularSchedule: { ...regularSchedule, revision: 8 } },
    { regularSchedule: { ...regularSchedule, classes: regularSchedule.classes.map(row => row.classId === 'homeroom' ? { ...row, window: { startTime: '08:30', endTime: '09:00' } } : row) } },
    { reviewData: null },
  ]) {
    const result = model({ reviewData, ...overrides });
    assert.equal(result.reviewCurrent, false);
    assert.equal(result.issues.length, 0);
    assert.equal(result.rows.every(row => !row.checked && !row.issues.length && !row.overlapSpans.length), true);
  }
  const fresh = model({ regularSchedule: { ...regularSchedule, revision: 6 }, reviewData });
  assert.equal(fresh.reviewCurrent, true);
  assert.equal(fresh.testing[0].overlapSpans[0].endTime, '09:10');
  const changedAssignment = model({ definition: { ...definition, testingBlocks: [{ ...definition.testingBlocks[0], assignedStaffId: 'burba' }] }, reviewData: { ...reviewData, testingBlocks: [{ ...reviewData.testingBlocks[0], status: 'unavailable' }] } });
  assert.equal(changedAssignment.testing[0].status, 'ready', 'An old unavailable verdict cannot follow a changed assignment');
});

test('Linked testing occurrences repeat actual participating grades and keep one canonical block identity', () => {
  const reviewData = { ...checkedReview, testingBlocks: [{ ...checkedReview.testingBlocks[0], classParticipation: [...metadata.testingBlocks[0].classParticipation, { classId: 'math', count: 3, total: 25 }] }] };
  const result = model({ reviewData });
  const occurrences = buildPlannerOccurrences({ rows: result.rows });
  const testing = occurrences.filter(item => item.rowKey === 'testing:testing');
  assert.deepEqual(testing.map(item => item.groupKey), ['5', '6']);
  assert.equal(testing.every(item => item.row === result.testing[0] && item.linked), true);
  assert.notEqual(testing[0].key, testing[1].key);
  assert.equal(testing[0].participation.length, 2, 'Repeated membership across periods is not summed into a false unique-student count');
  assert.deepEqual(testing[1].participation, [{ classId: 'math', count: 3, total: 25 }]);
  assert.equal(new Set(result.rows.map(row => row.key)).size, result.rows.length);
  assert.equal(result.testing.length, 1);
  assert.deepEqual(buildPlannerOccurrences({ rows: result.rows, schoolView: false }).filter(item => item.rowKey === 'testing:testing').map(item => [item.groupKey, item.linked]), [['all', false]]);
});

test('Unknown testing placements remain visible and staff-only conflicts never claim grade participation', () => {
  const result = model({ reviewData: checkedReview });
  assert.equal(result.testing[0].relatedClassIds.includes('math'), true, 'Staff issue links remain available for navigation');
  assert.deepEqual(buildPlannerOccurrences({ rows: result.rows }).filter(item => item.row.type === 'testing').map(item => item.groupKey), ['5']);
  assert.equal(filterPlannerRows(result.rows, { ...all, grade: '6' }).some(row => row.type === 'testing'), true, 'The staff-related testing duty remains discoverable');
  const unknown = model({ metadata: null });
  assert.equal(unknown.testing[0].participationKnown, false);
  assert.deepEqual(buildPlannerOccurrences({ rows: unknown.rows }).filter(item => item.row.type === 'testing').map(item => item.groupKey), ['testing']);
  const unmapped = { ...result.testing[0], classParticipation: [{ classId: 'unloaded-class', count: 2, total: 10 }] };
  assert.deepEqual(buildPlannerOccurrences({ rows: [unmapped] }).map(item => item.groupKey), ['testing']);
});

test('Grade and class filters suppress other linked placements while retaining staff-related and unknown duties', () => {
  const reviewData = { ...checkedReview, testingBlocks: [{ ...checkedReview.testingBlocks[0], classParticipation: [...metadata.testingBlocks[0].classParticipation, { classId: 'math', count: 3, total: 25 }] }] };
  const result = model({ reviewData });
  for (const filters of [{ ...all, grade: '5' }, { ...all, classId: 'ela' }]) {
    const visible = filterPlannerRows(result.rows, filters);
    const occurrences = buildPlannerOccurrences({ rows: visible, allRows: result.rows, filters });
    assert.equal(occurrences.every(item => item.groupKey === '5'), true);
    assert.equal(occurrences.filter(item => item.row.type === 'testing').length, 1);
    if (filters.classId === 'ela') assert.deepEqual(occurrences.find(item => item.row.type === 'testing').participation.map(part => part.classId), ['ela']);
  }
  const staffOnly = model({ reviewData: checkedReview });
  const staffFilters = { ...all, grade: '6' };
  const staffVisible = filterPlannerRows(staffOnly.rows, staffFilters);
  assert.deepEqual(buildPlannerOccurrences({ rows: staffVisible, allRows: staffOnly.rows, filters: staffFilters }).map(item => [item.rowKey, item.groupKey]), [['class:math', '6'], ['testing:testing', 'testing']]);
  const unknown = model({ metadata: null });
  assert.equal(buildPlannerOccurrences({ rows: filterPlannerRows(unknown.rows, staffFilters), allRows: unknown.rows, filters: staffFilters }).some(item => item.row.type === 'testing' && item.groupKey === 'testing'), true);
  const gradeFive = { ...all, grade: '5' };
  const original = buildPlannerOccurrences({ rows: filterPlannerRows(result.rows, gradeFive), allRows: result.rows, filters: gradeFive }).find(item => item.row.type === 'testing');
  const edited = result.rows.map(row => row.type === 'testing' ? { ...row, classParticipation: [{ classId: 'math', count: 3, total: 25 }], relatedClassIds: ['math'] } : row);
  const anchored = buildPlannerOccurrences({ rows: filterPlannerRows(edited, gradeFive, { blockId: 'testing' }), allRows: edited, filters: gradeFive, activeOccurrence: original });
  assert.equal(anchored.find(item => item.key === original.key)?.pinned, true);
  assert.equal(anchored.some(item => item.groupKey === '6'), false, 'Pinning preserves the editor, not unrelated linked grades');
});

test('Chronological ranks survive names and time edits, initialize late windows, and insert new rows', () => {
  const result = model();
  assert.deepEqual(result.classes.slice(0, 2).map(row => row.id), ['homeroom', 'ela']);
  const ranks = capturePlannerRanks(result.rows);
  const before = buildPlannerOccurrences({ rows: result.rows, ranks }).map(item => item.key);
  const edited = result.rows.map(row => row.id === 'testing' ? { ...row, name: 'AAA renamed', proposedWindow: { startTime: '07:00', endTime: '11:00' } }
    : row.id === 'ela' ? { ...row, name: 'AAA class', regularWindow: { startTime: '07:15', endTime: '08:00' }, proposedWindow: { startTime: '07:15', endTime: '08:00' } } : row);
  assert.deepEqual(buildPlannerOccurrences({ rows: edited, ranks: capturePlannerRanks(edited, ranks) }).map(item => item.key), before);
  assert.equal(capturePlannerRanks(edited, ranks), ranks, 'Unchanged captures preserve reference identity for React state');
  const newRow = { ...result.classes[0], id: 'new', key: 'class:new', name: 'New class', regularWindow: { startTime: '08:45', endTime: '09:00' }, proposedWindow: { startTime: '08:45', endTime: '09:00' } };
  const added = [...result.rows, newRow];
  assert.deepEqual(buildPlannerOccurrences({ rows: added, ranks: capturePlannerRanks(added, ranks) }).filter(item => item.groupKey === '5').map(item => item.rowKey), ['class:homeroom', 'class:new', 'testing:testing', 'class:ela']);
  const empty = { ...newRow, regularWindow: null, proposedWindow: null };
  const lateRanks = capturePlannerRanks([newRow], capturePlannerRanks([empty]));
  assert.equal(lateRanks.get(newRow.key).start, '08:45');
  assert.equal(capturePlannerRanks([{ ...newRow, regularWindow: { startTime: '07:00', endTime: '08:00' } }], lateRanks).get(newRow.key).start, '08:45');
});

test('An active linked occurrence stays anchored through association edits and resolves to its canonical row', () => {
  const result = model();
  const ranks = capturePlannerRanks(result.rows);
  const activeOccurrence = buildPlannerOccurrences({ rows: result.rows, ranks }).find(item => item.rowKey === 'testing:testing');
  const edited = result.rows.map(row => row.type === 'testing' ? { ...row, classParticipation: [{ classId: 'math', count: 4, total: 25 }], name: 'Renamed testing', proposedWindow: { startTime: '07:00', endTime: '11:00' } } : row);
  const pinned = buildPlannerOccurrences({ rows: edited, ranks, activeOccurrence });
  const anchor = pinned.find(item => item.key === activeOccurrence.key);
  assert.equal(anchor.pinned, true);
  assert.equal(anchor.groupKey, '5');
  assert.equal(anchor.row, edited.find(row => row.type === 'testing'));
  assert.equal(anchor.rank, activeOccurrence.rank);
  assert.deepEqual(pinned.filter(item => item.row.type === 'testing').map(item => [item.groupKey, item.linked]), [['5', true], ['6', true]]);
  assert.deepEqual(buildPlannerOccurrences({ rows: edited, ranks }).filter(item => item.row.type === 'testing').map(item => item.groupKey), ['6'], 'Closing the editor removes the temporary old placement');
  assert.equal(buildPlannerOccurrences({ rows: edited.filter(row => row.type !== 'testing'), ranks, activeOccurrence }).some(item => item.rowKey === activeOccurrence.rowKey), false, 'Removed canonical blocks never survive as phantom occurrences');
});

test('Configured daytime hours bound the axis exactly with readable interior ticks', () => {
  const settings = { enableTrackingHours: true, trackingStartTime: '08:25', trackingEndTime: '15:05' };
  const before = structuredClone(settings);
  const axis = plannerAxis(settings);
  assert.equal(axis.source, 'configured');
  assert.equal(axis.start, 505);
  assert.equal(axis.end, 905);
  assert.equal(axis.ticks[0], 505);
  assert.equal(axis.ticks.at(-1), 905);
  assert.equal(axis.ticks.includes(900), false, 'A 3:00 label must not collide with the exact 3:05 endpoint');
  assert.equal(axis.ticks.every((tick, index) => tick >= axis.start && tick <= axis.end && (!index || tick - axis.ticks[index - 1] >= (axis.end - axis.start) / 8)), true);
  assert.deepEqual(settings, before);
  for (const [startTime, endTime] of [['08:00', '08:01'], ['08:02', '08:07'], ['10:25', '10:45'], ['00:00', '23:59']]) {
    const short = plannerAxis({ enableTrackingHours: true, trackingStartTime: startTime, trackingEndTime: endTime });
    const minutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
    assert.equal(short.start, minutes(startTime));
    assert.equal(short.end, minutes(endTime));
    assert.equal(short.ticks[0], short.start);
    assert.equal(short.ticks.at(-1), short.end);
    assert.equal(short.ticks.every((tick, index) => tick >= short.start && tick <= short.end && (!index || tick > short.ticks[index - 1])), true);
    assert.equal(short.ticks.length <= 9, true);
  }
});

test('Disabled or absent monitoring hours use an honest fixed default; invalid enabled ranges stay unavailable', () => {
  const fallback = plannerAxis();
  assert.deepEqual(fallback, { start: 480, end: 960, ticks: [480, 540, 600, 660, 720, 780, 840, 900, 960], source: 'default' });
  for (const settings of [null, {}, { enableTrackingHours: false, trackingStartTime: '01:00', trackingEndTime: '23:00' }, { enableTrackingHours: 'true', trackingStartTime: '08:00', trackingEndTime: '15:00' }]) {
    assert.deepEqual(plannerAxis(settings), fallback);
  }
  for (const [trackingStartTime, trackingEndTime] of [[undefined, undefined], ['', '15:00'], ['08:00', ''], ['8:00', '15:00'], ['08:00:00', '15:00'], [' 08:00', '15:00'], ['24:00', '25:00'], ['08:00', '08:00'], ['20:00', '02:00']]) {
    assert.deepEqual(plannerAxis({ enableTrackingHours: true, trackingStartTime, trackingEndTime }), { ...fallback, source: 'unavailable' });
  }
});

test('Transient early times, regular windows and closed-day metadata cannot change the configured axis', () => {
  const settings = { enableTrackingHours: true, trackingStartTime: '08:00', trackingEndTime: '15:00' };
  const axis = plannerAxis(settings);
  for (const startTime of ['01:00', '', '13:00']) {
    const draft = { ...definition, testingBlocks: [{ ...definition.testingBlocks[0], startTime, endTime: '14:00' }] };
    const rows = model({ definition: draft }).rows;
    assert.deepEqual(plannerAxis({ ...settings, rows, referenceDate: '2026-09-14', day: { instructional: true } }), axis);
  }
  const closed = model({ referenceDate: '2026-09-19' });
  assert.equal(closed.classes.every(row => !row.regularWindow), true);
  assert.deepEqual(plannerAxis({ ...settings, rows: closed.rows, referenceDate: '2026-09-19', day: { instructional: false }, afterHoursMode: 'full', trackingDays: ['Monday'] }), axis);
  assert.deepEqual(plannerAxis({ ...settings, rows: [{ regularWindow: { startTime: '00:00', endTime: '23:59' } }], schoolTimezone: 'America/Chicago' }), axis, 'The range contains school-local clock values and is not translated to the browser timezone');
});

test('Clipping draws exact in-bounds geometry while retaining off-hours windows for correction', () => {
  const axis = plannerAxis({ enableTrackingHours: true, trackingStartTime: '08:25', trackingEndTime: '15:05' });
  const windows = [
    [{ startTime: '08:25', endTime: '15:05' }, { start: 505, end: 905, clippedStart: false, clippedEnd: false }, false],
    [{ startTime: '08:00', endTime: '09:00' }, { start: 505, end: 540, clippedStart: true, clippedEnd: false }, true],
    [{ startTime: '14:00', endTime: '16:00' }, { start: 840, end: 905, clippedStart: false, clippedEnd: true }, true],
    [{ startTime: '01:00', endTime: '23:00' }, { start: 505, end: 905, clippedStart: true, clippedEnd: true }, true],
    [{ startTime: '01:00', endTime: '02:00' }, null, true],
    [{ startTime: '18:00', endTime: '19:00' }, null, true],
    [{ startTime: '08:00', endTime: '08:25' }, null, true],
    [{ startTime: '15:05', endTime: '16:00' }, null, true],
    [{ startTime: '', endTime: '09:00' }, null, false],
    [{ startTime: '09:00', endTime: '09:00' }, null, false],
    [null, null, false],
  ];
  for (const [window, geometry, outside] of windows) {
    const original = structuredClone(window);
    assert.deepEqual(plannerClipWindow(window, axis), geometry);
    assert.equal(plannerOutsideHours(window, axis), outside);
    assert.deepEqual(window, original, 'Display clipping never shortens saved/draft times');
  }
  for (const invalidAxis of [undefined, {}, { start: 900, end: 500 }, { start: NaN, end: 900 }, { start: -1, end: 900 }, { start: 0, end: 1441 }]) {
    assert.equal(plannerClipWindow({ startTime: '09:00', endTime: '10:00' }, invalidAxis), null);
    assert.equal(plannerOutsideHours({ startTime: '09:00', endTime: '10:00' }, invalidAxis), false);
  }
});
