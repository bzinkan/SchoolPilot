import { eq } from "drizzle-orm";
import db from "../src/db.js";
import { users, schoolMemberships } from "../src/schema/core.js";
import { students } from "../src/schema/students.js";
import { parentStudent } from "../src/schema/gopilot.js";
import { hashPassword } from "../src/util/password.js";

/**
 * Demo parent accounts for iKeepSafe FERPA/COPPA certification and user simulation.
 * Each parent is linked to one demo student for GoPilot testing.
 */
export async function seedDemoParents(schoolId: string) {
  const parentData = [
    { firstName: "Mark", lastName: "Johnson", email: "parent1@lincoln.edu", studentFirstName: "Emma", studentLastName: "Johnson" },
    { firstName: "Jessica", lastName: "Brown", email: "parent2@lincoln.edu", studentFirstName: "Olivia", studentLastName: "Brown" },
    { firstName: "Michael", lastName: "Davis", email: "parent3@lincoln.edu", studentFirstName: "Sophia", studentLastName: "Davis" },
  ];

  const [existingParent] = await db
    .select()
    .from(users)
    .where(eq(users.email, parentData[0]!.email))
    .limit(1);

  if (existingParent) {
    console.log(`  Demo parents already exist`);
    return;
  }

  const password = await hashPassword("Parent123!");

  for (const p of parentData) {
    const [parentUser] = await db
      .insert(users)
      .values({
        email: p.email,
        password,
        firstName: p.firstName,
        lastName: p.lastName,
        displayName: `${p.firstName} ${p.lastName}`,
      })
      .returning();

    await db.insert(schoolMemberships).values({
      userId: parentUser!.id,
      schoolId,
      role: "parent",
    });

    // Link to their child
    const [child] = await db
      .select()
      .from(students)
      .where(eq(students.firstName, p.studentFirstName))
      .limit(1);

    if (child) {
      await db.insert(parentStudent).values({
        parentId: parentUser!.id,
        studentId: child.id,
        relationship: "parent",
        isPrimary: true,
        status: "approved",
      });
    }
  }
  console.log(`  Created ${parentData.length} demo parents linked to students`);
}
