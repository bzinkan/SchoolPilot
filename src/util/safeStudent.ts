export type StudentWithPrivateFields = {
  classpilotPinHash?: string | null;
  classpilotPinEncrypted?: string | null;
  deviceId?: string | null;
  googleUserId?: string | null;
  externalId?: string | null;
  studentCode?: string | null;
};

type PrivateStudentField =
  | "classpilotPinHash"
  | "classpilotPinEncrypted"
  | "deviceId"
  | "googleUserId"
  | "externalId"
  | "studentCode";

export function safeStudent<T extends StudentWithPrivateFields>(
  student: T
): Omit<T, PrivateStudentField> {
  const {
    classpilotPinHash: _classpilotPinHash,
    classpilotPinEncrypted: _classpilotPinEncrypted,
    deviceId: _deviceId,
    googleUserId: _googleUserId,
    externalId: _externalId,
    studentCode: _studentCode,
    ...safe
  } = student;
  return safe;
}

export function safeStudents<T extends StudentWithPrivateFields>(
  students: T[]
): Array<Omit<T, PrivateStudentField>> {
  return students.map(safeStudent);
}

/** ClassPilot-facing identity/roster fields only. */
export function classPilotStudentDto(student: any) {
  return {
    id: student.id,
    schoolId: student.schoolId,
    firstName: student.firstName,
    lastName: student.lastName,
    email: student.email,
    photoUrl: student.photoUrl,
    gradeLevel: student.gradeLevel,
    studentStatus: student.studentStatus,
    status: student.status,
    createdAt: student.createdAt,
    updatedAt: student.updatedAt,
  };
}

export function classPilotStudentDtos(students: any[]) {
  return students.map(classPilotStudentDto);
}

/** PassPilot-facing roster fields only. */
export function passPilotStudentDto(student: any) {
  return {
    id: student.id,
    schoolId: student.schoolId,
    firstName: student.firstName,
    lastName: student.lastName,
    email: student.email,
    photoUrl: student.photoUrl,
    gradeLevel: student.gradeLevel,
    studentIdNumber: student.studentIdNumber,
    gradeId: student.gradeId,
    status: student.status,
    createdAt: student.createdAt,
    updatedAt: student.updatedAt,
  };
}

/** Shared ClassPilot/PassPilot school-roster contract; no GoPilot fields. */
export function sharedSchoolRosterStudentDto(student: any) {
  return {
    id: student.id,
    schoolId: student.schoolId,
    firstName: student.firstName,
    lastName: student.lastName,
    email: student.email,
    photoUrl: student.photoUrl,
    gradeLevel: student.gradeLevel,
    studentIdNumber: student.studentIdNumber,
    gradeId: student.gradeId,
    studentStatus: student.studentStatus,
    status: student.status,
    createdAt: student.createdAt,
    updatedAt: student.updatedAt,
  };
}
