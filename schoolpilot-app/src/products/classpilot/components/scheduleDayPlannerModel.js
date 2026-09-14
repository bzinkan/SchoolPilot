const EMPTY = [];
export const plannerGradeKey = value => /^(?:grade\s*)?([1-8])$/i.exec(String(value ?? '').trim())?.[1] || String(value ?? '').trim() || 'unassigned';
export const plannerGradeName = value => !value || value === 'unassigned' ? 'Unassigned grade' : /^grade\s/i.test(value) ? value : `Grade ${value}`;
export const plannerIncluded = (definition, row) => definition.classIds.includes(row.id) || definition.grades.includes(String(row.gradeLevel));
export function plannerValidWindow(value) {
  return Boolean(value && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.startTime) && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.endTime) && value.startTime < value.endTime);
}
export const plannerMinutes = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
export const plannerTime = minutes => `${Math.floor(minutes / 60) % 12 || 12}:${String(minutes % 60).padStart(2, '0')} ${minutes % 1440 < 720 ? 'AM' : 'PM'}`;
export const plannerWindowText = window => window ? `${window.startTime}–${window.endTime}` : 'Does not meet';

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
  const issueIndex = new Map();
  for (const issue of current?.issues || EMPTY) {
    for (const key of [...(issue.classIds || EMPTY).map(id => `class:${id}`), ...(issue.blockIds || EMPTY).map(id => `testing:${id}`)]) {
      issueIndex.set(key, [...(issueIndex.get(key) || EMPTY), issue]);
    }
  }
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
      message: baseline?.message, issues: issueIndex.get(`class:${source.id}`) || EMPTY };
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
    const status = complete ? currentBlocks.get(block.id)?.status || 'ready' : 'incomplete';
    return { ...block, id: block.id, key: `testing:${block.id}`, type: 'testing', blockId: block.id, index,
      name: block.name || 'Untitled testing block', grade: 'testing', groupName: group?.name || association?.groupName,
      staffName: people.get(block.assignedStaffId) || (previous?.assignedStaffId === block.assignedStaffId ? previous.staffName : null),
      studentCount: checkedStudentCount ?? group?.studentCount ?? group?.studentIds?.length ?? association?.studentCount,
      classParticipation: association?.classParticipation || group?.classParticipation || EMPTY,
      participationKnown: Boolean(association || group?.classParticipation),
      regularWindow: null, proposedWindow: plannerValidWindow(block) ? { startTime: block.startTime, endTime: block.endTime } : null,
      action: 'testing', status, proposedStatus: status,
      issues: issueIndex.get(`testing:${block.id}`) || EMPTY };
  });
  // Alphabetical/ID ordering does not jump when an administrator types a time.
  classes.sort((a, b) => a.grade.localeCompare(b.grade, undefined, { numeric: true }) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { classes, testing, rows: [...classes, ...testing] };
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
      && ((grade === 'all' && classId === 'all') || !row.participationKnown || row.classParticipation.some(part => classScope.has(part.classId)))
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
