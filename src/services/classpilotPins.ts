import { randomInt } from "crypto";
import type { Student } from "../schema/students.js";
import { hashPassword } from "../util/password.js";

export type GeneratedClassPilotPin = {
  studentId: string;
  studentName: string;
  gradeLevel: string | null;
  pin: string;
};

export function randomFourDigitClassPilotPin(usedPins?: Set<string>): string {
  if (usedPins && usedPins.size >= 10000) {
    throw new Error("No unique PINs available");
  }

  let pin = "";
  do {
    pin = String(randomInt(0, 10000)).padStart(4, "0");
  } while (usedPins?.has(pin));
  usedPins?.add(pin);
  return pin;
}

export async function hashClassPilotPin(pin: string): Promise<string> {
  return hashPassword(pin);
}

export function generatedPinForStudent(
  student: Pick<Student, "id" | "firstName" | "lastName" | "email" | "gradeLevel">,
  pin: string
): GeneratedClassPilotPin {
  return {
    studentId: student.id,
    studentName: `${student.firstName || ""} ${student.lastName || ""}`.trim() || student.email || "Student",
    gradeLevel: student.gradeLevel || null,
    pin,
  };
}
