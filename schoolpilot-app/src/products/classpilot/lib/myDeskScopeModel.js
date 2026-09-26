export function myDeskScopeFilters(value = {}) {
  return value.classId ? { classId: value.classId } : value.gradeLevel ? { gradeLevel: value.gradeLevel } : {};
}
