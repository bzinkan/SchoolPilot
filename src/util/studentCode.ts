import { eq, and, sql } from "drizzle-orm";
import db from "../db.js";
import { students } from "../schema/students.js";
import { schoolMemberships } from "../schema/core.js";
import { familyGroups } from "../schema/gopilot.js";

/**
 * Generates a unique student code (3–4 digit) for parent linking.
 */
export async function generateStudentCode(schoolId: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const min = attempt < 10 ? 100 : 1000;
    const max = attempt < 10 ? 999 : 9999;
    const code = String(Math.floor(Math.random() * (max - min + 1)) + min);

    const [existing] = await db
      .select({ id: students.id })
      .from(students)
      .where(
        and(eq(students.schoolId, schoolId), eq(students.studentCode, code))
      )
      .limit(1);

    if (!existing) return code;
  }
  throw new Error("Unable to generate unique student code");
}

/**
 * Generates a unique car number (2–4 digit) for parent pickups.
 */
export async function generateCarNumber(schoolId: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const min = attempt < 10 ? 10 : 1000;
    const max = attempt < 10 ? 999 : 9999;
    const num = String(Math.floor(Math.random() * (max - min + 1)) + min);

    // Check both memberships and family groups
    const [inMembership] = await db
      .select({ id: schoolMemberships.id })
      .from(schoolMemberships)
      .where(
        and(
          eq(schoolMemberships.schoolId, schoolId),
          eq(schoolMemberships.carNumber, num)
        )
      )
      .limit(1);

    if (inMembership) continue;

    const [inFamily] = await db
      .select({ id: familyGroups.id })
      .from(familyGroups)
      .where(
        and(eq(familyGroups.schoolId, schoolId), eq(familyGroups.carNumber, num))
      )
      .limit(1);

    if (!inFamily) return num;
  }
  throw new Error("Unable to generate unique car number");
}

/**
 * Generates a unique family group number.
 */
export async function generateFamilyGroupNumber(
  schoolId: string
): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const min = attempt < 10 ? 100 : 1000;
    const max = attempt < 10 ? 999 : 9999;
    const num = String(Math.floor(Math.random() * (max - min + 1)) + min);

    const [existing] = await db
      .select({ id: familyGroups.id })
      .from(familyGroups)
      .where(
        and(eq(familyGroups.schoolId, schoolId), eq(familyGroups.carNumber, num))
      )
      .limit(1);

    if (!existing) return num;
  }
  throw new Error("Unable to generate unique family group number");
}
