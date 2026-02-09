import { eq } from "drizzle-orm";
import db from "../src/db.js";
import { users, schoolMemberships } from "../src/schema/core.js";
import { teacherGrades, grades } from "../src/schema/passpilot.js";
import { hashPassword } from "../src/util/password.js";

export async function seedDemoData(schoolId: string) {
  // Create demo teachers
  const teacherData = [
    { firstName: "Sarah", lastName: "Smith", email: "ssmith@lincoln.edu" },
    { firstName: "Mike", lastName: "Johnson", email: "mjohnson@lincoln.edu" },
    { firstName: "Lisa", lastName: "Davis", email: "ldavis@lincoln.edu" },
    { firstName: "Robert", lastName: "Brown", email: "rbrown@lincoln.edu" },
    { firstName: "Jennifer", lastName: "Wilson", email: "jwilson@lincoln.edu" },
    { firstName: "David", lastName: "Taylor", email: "dtaylor@lincoln.edu" },
  ];

  // Check if teachers already exist
  const [existingTeacher] = await db
    .select()
    .from(users)
    .where(eq(users.email, teacherData[0].email))
    .limit(1);

  if (existingTeacher) {
    console.log(`  Demo teachers already exist`);
    return;
  }

  const password = await hashPassword("Teacher123!");
  const createdTeachers: string[] = [];

  for (const t of teacherData) {
    const [user] = await db
      .insert(users)
      .values({
        email: t.email,
        password,
        firstName: t.firstName,
        lastName: t.lastName,
        displayName: `${t.firstName} ${t.lastName}`,
      })
      .returning();

    // Create membership
    await db.insert(schoolMemberships).values({
      userId: user!.id,
      schoolId,
      role: "teacher",
    });

    createdTeachers.push(user!.id);
  }
  console.log(`  Created ${teacherData.length} demo teachers`);

  // Assign teachers to grades
  const schoolGrades = await db
    .select()
    .from(grades)
    .where(eq(grades.schoolId, schoolId))
    .orderBy(grades.displayOrder);

  for (let i = 0; i < Math.min(createdTeachers.length, schoolGrades.length); i++) {
    await db.insert(teacherGrades).values({
      teacherId: createdTeachers[i],
      gradeId: schoolGrades[i].id,
    });
  }
  console.log(`  Assigned teachers to grades`);

  // Create an office staff member
  const [officeUser] = await db
    .insert(users)
    .values({
      email: "front.desk@lincoln.edu",
      password,
      firstName: "Mary",
      lastName: "Office",
      displayName: "Mary Office",
    })
    .returning();

  await db.insert(schoolMemberships).values({
    userId: officeUser!.id,
    schoolId,
    role: "office_staff",
  });
  console.log(`  Created office staff member`);
}
