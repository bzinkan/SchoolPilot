export const emptyCoverageFilters = { search: "", classId: "all", grade: "all" };

export function filterCoverageStudents(students, filters) {
  const query = filters.search.trim().toLowerCase();
  return students.filter(student => {
    const grade = String(student.gradeLevel ?? "").trim();
    if (filters.grade !== "all" && (filters.grade === "none" ? grade !== "" : grade !== filters.grade)) return false;
    if (filters.classId !== "all") {
      if (!Array.isArray(student.classes)) return false;
      if (filters.classId === "none" ? student.classes.length > 0 : !student.classes.some(group => group.id === filters.classId)) return false;
    }
    return !query || `${student.studentName || ""} ${student.studentEmail || ""} ${grade}`.toLowerCase().includes(query);
  });
}
