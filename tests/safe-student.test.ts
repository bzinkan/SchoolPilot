import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classPilotStudentDto,
  passPilotStudentDto,
  safeStudent,
  safeStudents,
  sharedSchoolRosterStudentDto,
} from "../src/util/safeStudent.js";

describe("outward student serialization", () => {
  it("removes credentials, device metadata, identity-provider IDs, and retired GoPilot codes", () => {
    const student = {
      id: "student-1",
      firstName: "Safe",
      lastName: "Student",
      classpilotPinHash: "hash",
      classpilotPinEncrypted: "ciphertext",
      deviceId: "device-1",
      googleUserId: "google-1",
      externalId: "sis-1",
      studentCode: "1234",
    };

    const dto = safeStudent(student);
    assert.deepEqual(dto, {
      id: "student-1",
      firstName: "Safe",
      lastName: "Student",
    });
    assert.deepEqual(safeStudents([student]), [dto]);
  });

  it("uses exact product-specific student DTO allowlists", () => {
    const student = {
      id: "student-1",
      schoolId: "school-1",
      firstName: "Safe",
      lastName: "Student",
      email: "safe@example.edu",
      emailLc: "safe@example.edu",
      photoUrl: null,
      gradeLevel: "6",
      studentIdNumber: "P-123",
      gradeId: "passpilot-class",
      homeroomId: "gopilot-homeroom",
      dismissalType: "car",
      afterschoolReason: "Robotics",
      busRoute: "B-1",
      studentStatus: "active",
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-02T00:00:00Z"),
      classpilotPinHash: "hash",
      classpilotPinEncrypted: "ciphertext",
      deviceId: "device-1",
      googleUserId: "google-1",
      externalId: "sis-1",
      studentCode: "1234",
    };

    assert.deepEqual(Object.keys(classPilotStudentDto(student)).sort(), [
      "createdAt", "email", "firstName", "gradeLevel", "id", "lastName",
      "photoUrl", "schoolId", "status", "studentStatus", "updatedAt",
    ].sort());
    assert.deepEqual(Object.keys(passPilotStudentDto(student)).sort(), [
      "createdAt", "email", "firstName", "gradeId", "gradeLevel", "id",
      "lastName", "photoUrl", "schoolId", "status", "studentIdNumber", "updatedAt",
    ].sort());
    assert.deepEqual(Object.keys(sharedSchoolRosterStudentDto(student)).sort(), [
      "createdAt", "email", "firstName", "gradeId", "gradeLevel", "id", "lastName",
      "photoUrl", "schoolId", "status", "studentIdNumber", "studentStatus", "updatedAt",
    ].sort());
  });
});
