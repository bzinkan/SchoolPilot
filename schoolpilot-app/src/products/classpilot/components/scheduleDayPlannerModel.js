const EMPTY = [];
const OVERLAP_CODES = new Map([
  ['CLASS_SCHEDULE_CONFLICT', { kind: 'conflict', classes: 2, blocks: 0 }],
  ['SCHEDULE_PROFILE_CONFLICT', { kind: 'conflict', classes: 0, blocks: 2 }],
  ['SCHEDULE_PROFILE_PROCTOR_CLASS_CONFLICT', { kind: 'conflict', classes: 1, blocks: 1 }],
  ['SCHEDULE_DRAFT_TESTING_CLASS_OVERLAP', { kind: 'overlap', classes: 1, blocks: 1 }],
]);
export const plannerGradeKey = value => /^(?:grade\s*)?([1-8])$/i.exec(String(value ?? '').trim())?.[1] || String(value ?? '').trim() || 'unassigned';
export const plannerGradeName = value => !value || value === 'unassigned' ? 'Unassigned grade' : /^grade\s/i.test(value) ? value : `Grade ${value}`;
export const plannerIncluded = (definition, row) => definition.classIds.includes(row.id) || definition.grades.includes(String(row.gradeLevel));
export function plannerValidWindow(value) {
  return Boolean(value && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.startTime) && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.endTime) && value.startTime < value.endTime);
}
export const plannerMinutes = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
export const plannerTime = minutes => `${Math.floor(minutes / 60) % 12 || 12}:${String(minutes % 60).padStart(2, '0')} ${minutes % 1440 < 720 ? 'AM' : 'PM'}`;
export const plannerWindowText = window => window ? `${window.startTime}–${window.endTime}` : 'Does not meet';
const sameWindow = (a, b) => a === null && b === null || plannerValidWindow(a) && plannerValidWindow(b) && a.startTime === b.startTime && a.endTime === b.endTime;
const sortDescriptor = row => ({ start: (row.type === 'class' ? row.regularWindow : row.proposedWindow)?.startTime || '', name: row.name || '', id: row.key });
const compareDescriptors = (a, b) => (a.start || '99:99').localeCompare(b.start || '99:99') || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
export const plannerCompareRows = (a, b) => compareDescriptors(sortDescriptor(a), sortDescriptor(b));

// Capture regular-day chronology once. Name/time edits cannot reorder an open
// draft, while newly loaded windows and newly added rows gain sensible places.
export function capturePlannerRanks(rows, previous = new Map()) {
  let ranks = previous;
  for (const row of rows) {
    const before = ranks.get(row.key), next = sortDescriptor(row);
    if (!before || !before.start && next.start) {
      if (ranks === previous) ranks = new Map(previous);
      ranks.set(row.key, before ? { ...before, start: next.start } : next);
    }
  }
  return ranks;
}

// Only the server evaluates date/period eligibility and conflicts. The browser
// projects current edits onto an available regular meeting for immediate feedback.
export function buildPlannerRows({ definition, catalog, regularSchedule, referenceDate, reviewData, metadata }) {
  const current = reviewData?.referenceDate === referenceDate ? reviewData : null;
  const labels = current || (metadata?.referenceDate === referenceDate ? metadata : null);
  const regular = regularSchedule?.referenceDate === referenceDate ? regularSchedule : null;
  const reviewedClasses = new Map((current?.classes || EMPTY).map(row => [row.classId, row]));
  const labelClasses = new Map((labels?.classes || EMPTY).map(row => [row.classId, row]));
  const regularClasses = new Map((regular?.classes || EMPTY).map(row => [row.classId, row]));
  const rules = new Map(definition.classRules.map(rule => [rule.classId, rule]));
  const sources = [...(catalog.classes || EMPTY)];
  const sourceIds = new Set(sources.map(row => row.id));
  // A class may be created after the profile catalog was loaded. Review rows
  // are authorized independently and include enough labels to expose that duty.
  // Keep their last date-matching labels while a superseding check is pending.
  for (const row of labelClasses.values()) {
    if (sourceIds.has(row.classId)) continue;
    sources.push({ id: row.classId, name: row.name || 'Class details unavailable', gradeLevel: row.gradeLevel ?? null,
      staff: row.staff || EMPTY, ...(row.status === 'schedule_off' ? { scheduleEnabled: false } : {}), detailsUnavailable: !row.name });
    sourceIds.add(row.classId);
  }
  // The lightweight regular projection has no class names or roster labels.
  // Show its window without inventing those details or allowing an unknown
  // class to be included before the review/catalog supplies its identity.
  for (const row of regularClasses.values()) {
    if (sourceIds.has(row.classId)) continue;
    sources.push({ id: row.classId, name: 'Class details unavailable', gradeLevel: null, detailsUnavailable: true });
    sourceIds.add(row.classId);
  }
  for (const id of new Set([...definition.classIds, ...rules.keys()])) {
    if (!sourceIds.has(id)) sources.push({ id, name: 'Unavailable class', gradeLevel: null, scheduleEnabled: false });
  }
  const classes = sources.map(source => {
    const reviewed = reviewedClasses.get(source.id), labeled = labelClasses.get(source.id);
    const baseline = regularClasses.get(source.id);
    const preferReview = Boolean(reviewed && (!baseline || (Number.isSafeInteger(current?.revision) && Number.isSafeInteger(regular?.revision) && current.revision >= regular.revision)));
    const status = (preferReview ? reviewed.status : baseline?.status) || reviewed?.status || 'unavailable';
    const baselineWindow = preferReview ? reviewed.regularWindow : baseline ? baseline.window : reviewed?.regularWindow;
    const regularWindow = plannerValidWindow(baselineWindow) ? baselineWindow : null;
    const included = plannerIncluded(definition, source), rule = rules.get(source.id);
    let proposedWindow = regularWindow, proposedStatus = status;
    if (rule?.action === 'time' && !plannerValidWindow(rule)) { proposedWindow = null; proposedStatus = 'incomplete'; }
    else if (included && regularWindow && source.scheduleEnabled !== false && rule) {
      proposedWindow = rule.action === 'skip' ? null : { startTime: rule.startTime, endTime: rule.endTime };
      proposedStatus = rule.action === 'skip' ? 'skipped' : status;
    }
    return { ...source, key: `class:${source.id}`, type: 'class', classId: source.id,
      grade: plannerGradeKey(source.gradeLevel), included, byGrade: definition.grades.includes(String(source.gradeLevel)), rule,
      status, proposedStatus, regularWindow, proposedWindow, action: rule?.action || 'keep',
      staff: labeled?.staff || source.staff || EMPTY, staffKnown: Boolean(labeled || source.staff),
      message: baseline?.message, issues: [], overlapSpans: [], checked: false };
  });
  const groups = new Map((catalog.supervisionGroups || EMPTY).map(group => [group.id, group]));
  const people = new Map((catalog.staff || EMPTY).map(person => [person.id, person.name]));
  const blocks = new Map((labels?.testingBlocks || EMPTY).map(block => [block.blockId, block]));
  const currentBlocks = new Map((current?.testingBlocks || EMPTY).map(block => [block.blockId, block]));
  const testing = definition.testingBlocks.map((block, index) => {
    const group = groups.get(block.coverageGroupId), previous = blocks.get(block.id);
    const association = previous?.coverageGroupId === block.coverageGroupId ? previous : null;
    const checkedBlock = currentBlocks.get(block.id);
    const checkedStudentCount = checkedBlock?.coverageGroupId === block.coverageGroupId ? checkedBlock.studentCount : undefined;
    const complete = Boolean(block.name.trim() && block.coverageGroupId && block.assignedStaffId && plannerValidWindow(block));
    const checkedAssignment = checkedBlock?.coverageGroupId === block.coverageGroupId && checkedBlock.assignedStaffId === block.assignedStaffId
      && checkedBlock.startTime === block.startTime && checkedBlock.endTime === block.endTime;
    const status = complete ? checkedAssignment && checkedBlock.status || 'ready' : 'incomplete';
    return { ...block, id: block.id, key: `testing:${block.id}`, type: 'testing', blockId: block.id, index,
      name: block.name || 'Untitled testing block', grade: 'testing', groupName: group?.name || association?.groupName,
      staffName: people.get(block.assignedStaffId) || (previous?.assignedStaffId === block.assignedStaffId ? previous.staffName : null),
      studentCount: checkedStudentCount ?? group?.studentCount ?? group?.studentIds?.length ?? association?.studentCount,
      classParticipation: association?.classParticipation || group?.classParticipation || EMPTY,
      participationKnown: Boolean(association || group?.classParticipation),
      regularWindow: null, proposedWindow: plannerValidWindow(block) ? { startTime: block.startTime, endTime: block.endTime } : null,
      action: 'testing', status, proposedStatus: status,
      issues: [], overlapSpans: [], checked: false };
  });
  const rows = [...classes, ...testing], rowsByKey = new Map(rows.map(row => [row.key, row]));
  // The hook also fences superseded requests. Check the displayed projection
  // here because a newer regular-day response can arrive independently.
  const reviewedWindowMatches = row => {
    if (row.type === 'class') {
      const reviewed = reviewedClasses.get(row.id);
      return reviewed ? sameWindow(row.regularWindow, reviewed.regularWindow) && sameWindow(row.proposedWindow, reviewed.proposedWindow)
        && (!reviewed.action || row.action === reviewed.action) && (reviewed.selected === undefined || row.included === reviewed.selected)
        : row.status === 'unavailable';
    }
    const reviewed = currentBlocks.get(row.id);
    return Boolean(reviewed && reviewed.coverageGroupId === row.coverageGroupId && reviewed.assignedStaffId === row.assignedStaffId
      && reviewed.startTime === row.startTime && reviewed.endTime === row.endTime);
  };
  const reviewCurrent = Boolean(current && !(Number.isSafeInteger(regular?.revision) && Number.isSafeInteger(current.revision) && regular.revision > current.revision)
    && rows.every(reviewedWindowMatches) && (current.testingBlocks || EMPTY).length === testing.length);
  const issues = reviewCurrent ? current.issues || EMPTY : EMPTY;
  for (const row of rows) row.checked = reviewCurrent && (row.type === 'testing' ? currentBlocks.has(row.id) : reviewedClasses.has(row.id));
  for (const issue of issues) {
    const classIds = [...new Set(issue.classIds || EMPTY)], blockIds = [...new Set(issue.blockIds || EMPTY)];
    const affected = [...classIds.map(id => rowsByKey.get(`class:${id}`)), ...blockIds.map(id => rowsByKey.get(`testing:${id}`))];
    for (const row of affected.filter(Boolean)) row.issues.push(issue);
    const shape = OVERLAP_CODES.get(issue.code);
    if (!shape || shape.kind !== issue.kind || classIds.length !== shape.classes || blockIds.length !== shape.blocks) continue;
    // Geometric rendering of a server-issued verdict, never a new client check.
    // In particular, monitoring-hours issues do not color an invented interval.
    const windows = [...classIds.map(id => reviewedClasses.get(id)?.proposedWindow), ...blockIds.map(id => currentBlocks.get(id))];
    if (windows.length !== 2 || !windows.every(plannerValidWindow) || affected.some(row => !row)) continue;
    const startTime = windows.map(window => window.startTime).sort().at(-1), endTime = windows.map(window => window.endTime).sort()[0];
    if (startTime >= endTime) continue;
    const span = { issueId: issue.id, kind: issue.kind, code: issue.code, message: issue.message, startTime, endTime };
    for (const row of affected) row.overlapSpans.push(span);
  }
  for (const row of testing) row.relatedClassIds = [...new Set([...row.classParticipation.map(part => part.classId), ...row.issues.flatMap(issue => issue.classIds || EMPTY)])];
  classes.sort((a, b) => a.grade.localeCompare(b.grade, undefined, { numeric: true }) || plannerCompareRows(a, b));
  return { classes, testing, rows: [...classes, ...testing], issues, reviewCurrent };
}

// Display occurrences share one canonical row/editor target. Grade placement is
// based on actual participation only; a shared proctor is not grade membership.
export function buildPlannerOccurrences({ rows, allRows = rows, schoolView = true, ranks = capturePlannerRanks(allRows), activeOccurrence, filters = {} }) {
  const classesById = new Map(allRows.filter(row => row.type === 'class').map(row => [row.id, row]));
  const gradeScope = filters.grade || 'all', classScope = filters.classId || 'all';
  const occurrences = [];
  for (const row of rows) {
    const placements = new Map();
    if (!schoolView) placements.set('all', row.type === 'testing' ? row.classParticipation || EMPTY : EMPTY);
    else if (row.type === 'class') placements.set(row.grade, EMPTY);
    else {
      for (const part of row.classParticipation || EMPTY) {
        const grade = classesById.get(part.classId)?.grade;
        if (gradeScope !== 'all' && grade !== gradeScope || classScope !== 'all' && part.classId !== classScope) continue;
        const groupKey = grade || 'testing';
        placements.set(groupKey, [...(placements.get(groupKey) || EMPTY), part]);
      }
      // Canonical filtering may retain this duty through a staff issue or an
      // unknown association. Keep that duty without inventing grade membership.
      if (!placements.size) placements.set('testing', EMPTY);
    }
    const active = activeOccurrence?.rowKey === row.key && (schoolView ? activeOccurrence.groupKey !== 'all' : activeOccurrence.groupKey === 'all') ? activeOccurrence : null;
    const pinned = Boolean(active && !placements.has(active.groupKey));
    if (pinned) placements.set(active.groupKey, EMPTY);
    for (const [groupKey, participation] of placements) {
      const key = `${row.key}@${encodeURIComponent(groupKey)}`;
      occurrences.push({ key, rowKey: row.key, groupKey, row, linked: row.type === 'testing' && placements.size > 1,
        participation, pinned: pinned && groupKey === active.groupKey,
        rank: active?.key === key && active.rank || ranks.get(row.key) || sortDescriptor(row) });
    }
  }
  return occurrences.sort((a, b) => (a.groupKey === b.groupKey ? 0 : a.groupKey === 'testing' ? 1 : b.groupKey === 'testing' ? -1 : a.groupKey.localeCompare(b.groupKey, undefined, { numeric: true }))
    || compareDescriptors(a.rank, b.rank) || a.key.localeCompare(b.key));
}

export function filterPlannerRows(rows, filters, activeTarget) {
  const grade = filters.grade || 'all', classId = filters.classId || 'all', teacher = filters.teacher || 'all';
  const search = (filters.search || '').trim().toLowerCase();
  const classScope = new Set(rows.filter(row => row.type === 'class' && (grade === 'all' || row.grade === grade) && (classId === 'all' || row.id === classId)).map(row => row.id));
  return rows.filter(row => {
    // Keep the inline editor visible while changing a name/time/assignment that
    // would otherwise stop matching a filter. Explicit navigation closes it.
    if (row.id === (row.type === 'class' ? activeTarget?.classId : activeTarget?.blockId)) return true;
    const conflict = row.issues.some(issue => issue.kind === 'conflict');
    if (filters.conflictsOnly && !conflict) return false;
    if (row.type === 'class') {
      return classScope.has(row.id) && (teacher === 'all' || !row.staffKnown || row.staff.some(person => person.id === teacher))
        && `${row.name} ${row.teacherName || ''} ${row.staff.map(person => person.name).join(' ')}`.toLowerCase().includes(search);
    }
    return (teacher === 'all' || row.assignedStaffId === teacher)
      && ((grade === 'all' && classId === 'all') || !row.participationKnown || (row.relatedClassIds || row.classParticipation.map(part => part.classId)).some(id => classScope.has(id)))
      && `${row.name} ${row.groupName || ''} ${row.staffName || ''}`.toLowerCase().includes(search);
  });
}

export function plannerAxis(rows) {
  const windows = rows.flatMap(row => [row.regularWindow, row.proposedWindow]).filter(plannerValidWindow);
  let start = windows.length ? 1440 : 480, end = windows.length ? 0 : 960;
  for (const window of windows) { start = Math.min(start, plannerMinutes(window.startTime)); end = Math.max(end, plannerMinutes(window.endTime)); }
  start = Math.max(0, Math.floor(start / 60) * 60);
  end = Math.min(1440, Math.ceil(end / 60) * 60);
  if (end - start < 120) end = Math.min(1440, start + 120);
  if (end - start < 120) start = end - 120;
  const step = end - start > 600 ? 120 : 60;
  return { start, end, ticks: Array.from({ length: Math.floor((end - start) / step) + 1 }, (_, index) => start + index * step) };
}

export function plannerStableAxis(rows, previous) {
  if (previous && !rows.some(row => plannerValidWindow(row.regularWindow) || plannerValidWindow(row.proposedWindow))) return previous;
  const next = plannerAxis(rows);
  if (!previous) return next;
  const start = Math.min(previous.start, next.start), end = Math.max(previous.end, next.end);
  if (start === previous.start && end === previous.end) return previous;
  const step = end - start > 600 ? 120 : 60;
  return { start, end, ticks: Array.from({ length: Math.floor((end - start) / step) + 1 }, (_, index) => start + index * step) };
}
