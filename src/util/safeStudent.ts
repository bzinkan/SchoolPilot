export type StudentWithClassPilotPinHash = {
  classpilotPinHash?: string | null;
  classpilotPinEncrypted?: string | null;
};

export function safeStudent<T extends StudentWithClassPilotPinHash>(
  student: T
): Omit<T, "classpilotPinHash" | "classpilotPinEncrypted"> {
  const {
    classpilotPinHash: _classpilotPinHash,
    classpilotPinEncrypted: _classpilotPinEncrypted,
    ...safe
  } = student;
  return safe;
}

export function safeStudents<T extends StudentWithClassPilotPinHash>(
  students: T[]
): Array<Omit<T, "classpilotPinHash" | "classpilotPinEncrypted">> {
  return students.map(safeStudent);
}
