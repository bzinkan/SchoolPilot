// The Dashboard's student order: by the last whitespace-separated word of the
// display name, lower-cased and compared with localeCompare. A one-word name is
// its own last name and a missing name sorts as an empty string. There is no
// tie-break, so a stable sort keeps the incoming order for equal last names.
export function studentLastName(fullName) {
  if (!fullName) return '';
  const nameParts = String(fullName).trim().split(/\s+/);
  if (nameParts.length === 1) return nameParts[0].toLowerCase();
  return nameParts[nameParts.length - 1].toLowerCase();
}

export function compareStudentsByLastName(a, b) {
  return studentLastName(a?.studentName).localeCompare(studentLastName(b?.studentName));
}
