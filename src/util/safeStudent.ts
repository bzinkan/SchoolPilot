export type StudentWithClassPilotPinHash = {
  classpilotPinHash?: string | null;
};

export function safeStudent<T extends StudentWithClassPilotPinHash>(
  student: T
): Omit<T, "classpilotPinHash"> {
  const { classpilotPinHash: _classpilotPinHash, ...safe } = student;
  return safe;
}

export function safeStudents<T extends StudentWithClassPilotPinHash>(
  students: T[]
): Array<Omit<T, "classpilotPinHash">> {
  return students.map(safeStudent);
}
