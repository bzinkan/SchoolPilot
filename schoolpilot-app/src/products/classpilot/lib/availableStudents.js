import { activeAvailableTestingGroup } from './availableTestingGroup.js';

export const NO_AVAILABLE_CLASS = '__no_class__';
export const NO_AVAILABLE_GRADE = '__no_grade__';

const uniqueStudents = (rows) => [...new Map(rows.map(row => [row.studentId, row])).values()];

// Membership is descriptive roster data. It never establishes permission to
// claim a student, or says which class is currently meeting.
export function buildAvailableRoster(students, scheduledGroups) {
  const scheduledStudents = scheduledGroups.flatMap(group => group.students || []);
  const scheduledIds = new Set(scheduledStudents.map(student => student.studentId));
  const ordinaryStudents = uniqueStudents(students.filter(student => !scheduledIds.has(student.studentId)));
  const allStudents = uniqueStudents([...ordinaryStudents, ...scheduledStudents]);
  const metadataReady = [...students, ...scheduledStudents].every(student => Array.isArray(student.classes)
    && student.classes.every(group => group && typeof group === 'object' && typeof group.id === 'string' && group.id.length > 0
      && typeof group.name === 'string' && group.name.length > 0));
  const classOptions = metadataReady ? [...new Map(allStudents.flatMap(student => student.classes)
    .map(group => [group.id, { id: group.id, name: group.name }])).values()]
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)) : [];
  const grades = [...new Set(allStudents.map(student => String(student.gradeLevel || '')).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  return {
    students: allStudents,
    ordinaryStudents,
    scheduledGroups: scheduledGroups.map(group => ({ ...group, students: uniqueStudents(group.students || []) })),
    metadataReady,
    classOptions,
    grades,
    hasNoClass: metadataReady && allStudents.some(student => student.classes.length === 0),
    hasNoGrade: allStudents.some(student => !student.gradeLevel),
  };
}

export function filterAvailableRoster(roster, { classId = '', grade = '', query = '', nowMs }, compareStudents) {
  if (!roster.metadataReady) return { students: [], ordinaryStudents: [], scheduledGroups: [], sections: [] };
  const normalizedQuery = query.trim().toLowerCase();
  const matches = (student, extraSearch = '') => {
    if (classId === NO_AVAILABLE_CLASS ? student.classes.length !== 0
      : classId && !student.classes.some(group => group.id === classId)) return false;
    const studentGrade = String(student.gradeLevel || '');
    if (grade === NO_AVAILABLE_GRADE ? studentGrade !== '' : grade && studentGrade !== grade) return false;
    return [student.studentName, student.studentEmail, student.studentId, studentGrade,
      ...student.classes.map(group => group.name), extraSearch]
      .some(value => String(value || '').toLowerCase().includes(normalizedQuery));
  };
  const ordinaryStudents = roster.ordinaryStudents.filter(student => matches(student, activeAvailableTestingGroup(student, nowMs)?.name || '')).sort(compareStudents);
  const scheduledGroups = roster.scheduledGroups.map(group => ({
    ...group,
    students: group.students.filter(student => matches(student, `${group.label || ''} ${group.className || ''} ${group.teacherName || ''}`))
      .sort(compareStudents),
  })).filter(group => group.students.length > 0)
    .sort((left, right) => (left.className || left.label || '').localeCompare(right.className || right.label || ''));
  const sections = new Map();
  const testingSections = new Map();
  for (const student of ordinaryStudents) {
    const testingGroup = activeAvailableTestingGroup(student, nowMs);
    if (testingGroup) {
      const key = `testing:${testingGroup.applicationId}:${testingGroup.date}:${testingGroup.blockId}`;
      if (!testingSections.has(key)) testingSections.set(key, {
        id: key, kind: 'group', label: testingGroup.name,
        description: 'Scheduled testing · eligible online students', testingGroup, students: [],
      });
      testingSections.get(key).students.push(student);
      continue;
    }
    const memberships = student.classes.length ? student.classes : [{ id: NO_AVAILABLE_CLASS, name: 'No class assigned' }];
    for (const group of memberships) {
      if (classId && group.id !== classId) continue;
      if (!sections.has(group.id)) sections.set(group.id, {
        id: group.id, label: group.name, students: [],
        description: group.id === NO_AVAILABLE_CLASS ? 'No current class roster membership' : 'Class roster membership',
      });
      const section = sections.get(group.id);
      if (!section.students.some(row => row.studentId === student.studentId)) section.students.push(student);
    }
  }
  return {
    students: uniqueStudents([...scheduledGroups.flatMap(group => group.students), ...ordinaryStudents]).sort(compareStudents),
    ordinaryStudents,
    scheduledGroups,
    sections: [...testingSections.values()].sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id))
      .concat([...sections.values()].sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id))),
  };
}
