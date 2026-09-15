import { plannerGradeKey, plannerIncluded, plannerValidWindow } from './scheduleDayPlannerModel.js';

// Inactive references belong only in the picker. They must never enlarge the
// planner's class scope or become eligible meetings through stale review data.
export function classPlacementCandidates(classes, inactiveClasses = []) {
  const candidates = new Map(classes.map(row => [row.id, row]));
  for (const source of inactiveClasses) candidates.set(source.id, {
    ...source, id: source.id, classId: source.id, key: `class:${source.id}`, type: 'class',
    name: source.name || 'Unavailable class', grade: plannerGradeKey(source.gradeLevel),
    active: false, scheduleEnabled: false, status: 'unavailable', proposedStatus: 'unavailable',
    regularWindow: null, proposedWindow: null, action: 'keep',
    staff: source.staff || [], studentCount: source.studentCount ?? null,
  });
  return [...candidates.values()];
}

export function classPlacementUnavailable(row, destination = false) {
  if (!row || row.type !== 'class' || row.detailsUnavailable) return 'Class details or schedule unavailable.';
  if (row.active === false) return 'This class is inactive.';
  if (row.scheduleEnabled === false || row.status === 'schedule_off') return 'This class does not have an active schedule.';
  if (row.status === 'unavailable') return 'Class details or schedule unavailable.';
  if (row.status !== 'meets' || !plannerValidWindow(row.regularWindow)) return 'This class does not meet on the preview date.';
  if (destination && !plannerValidWindow(row.proposedWindow)) return 'Set a valid proposed time for this class first.';
  if (!destination && row.action !== 'skip' && !plannerValidWindow(row.proposedWindow)) return 'Finish this class’s proposed time first.';
  return null;
}

// Display filters do not change a placement. Include authoritative roster/staff
// facts because those can change without changing the scheduling revision.
export function classPlacementFingerprint({ definition, classes, referenceDate, revision }) {
  return JSON.stringify({ definition, referenceDate, revision, classes: classes.map(row => ({
    id: row.id, name: row.name, teacherName: row.teacherName, gradeLevel: row.gradeLevel, active: row.active, scheduleEnabled: row.scheduleEnabled,
    detailsUnavailable: row.detailsUnavailable, status: row.status, regularWindow: row.regularWindow, proposedWindow: row.proposedWindow,
    rosterFingerprint: row.rosterFingerprint, studentCount: row.studentCount, staff: row.staff?.map(person => ({ id: person.id, name: person.name })).sort((a, b) => a.id.localeCompare(b.id)),
  })).sort((a, b) => a.id.localeCompare(b.id)) });
}

// A placement is two class-rule changes, never a new meeting or renamed class.
// Return a new definition so the caller can commit it as one Undo snapshot.
export function reviewClassPlacement({ definition, classes, originalId, selectedId, action }) {
  const original = classes.find(row => row.id === originalId), selected = classes.find(row => row.id === selectedId);
  const unavailable = classPlacementUnavailable(original, true) || classPlacementUnavailable(selected);
  if (unavailable) return { error: unavailable };
  if (originalId === selectedId) return { error: 'Choose a different existing class to change this time.' };
  if (!['swap', 'move-skip'].includes(action)) return { error: 'Choose Swap class times or Use selected class; original does not meet.' };
  if (action === 'swap' && !plannerValidWindow(selected.proposedWindow)) return { error: 'A skipped class has no proposed time to swap. Choose Use selected class; original does not meet.' };
  const affected = [original, selected];
  const added = affected.filter(row => !definition.classIds.includes(row.id));
  const classIds = [...new Set([...definition.classIds, ...affected.map(row => row.id)])];
  if (classIds.length > 500) return { error: 'This change would exceed 500 individually included classes. Adjust the profile selection first.' };
  const rules = [action === 'swap' ? { classId: originalId, action: 'time', ...selected.proposedWindow } : { classId: originalId, action: 'skip' },
    { classId: selectedId, action: 'time', ...original.proposedWindow }];
  const replacements = new Map(rules.map(rule => [rule.classId, rule]));
  const classRules = definition.classRules.map(rule => replacements.get(rule.classId) || rule);
  for (const rule of rules) if (!classRules.some(current => current.classId === rule.classId)) classRules.push(rule);
  if (classRules.length > 500) return { error: 'This change would exceed 500 class adjustments. Restore another class before continuing.' };
  return {
    definition: { ...definition, classIds, classRules }, originalId, selectedId, action,
    changes: affected.map(row => ({ classId: row.id, name: row.name, before: row.proposedWindow,
      after: row.id === selectedId ? original.proposedWindow : action === 'swap' ? selected.proposedWindow : null,
      includedBefore: plannerIncluded(definition, row), includedAfter: true })),
    addedClassIds: added.map(row => row.id),
  };
}
