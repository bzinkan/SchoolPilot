/** Match the existing route branch, including mixed or malformed JSON fields. */
export function usesEmailIdStudentSignIn(studentEmail: unknown, studentIdNumber: unknown): boolean {
  return Boolean(studentEmail || studentIdNumber);
}
