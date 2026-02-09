import { eq, and } from "drizzle-orm";
import db from "../src/db.js";
import { students } from "../src/schema/students.js";
import { grades } from "../src/schema/passpilot.js";

const DEMO_STUDENTS = [
  { firstName: "Emma", lastName: "Johnson", gradeLevel: "K", dismissalType: "car", studentIdNumber: "1001" },
  { firstName: "Liam", lastName: "Williams", gradeLevel: "K", dismissalType: "bus", busRoute: "Route 1", studentIdNumber: "1002" },
  { firstName: "Olivia", lastName: "Brown", gradeLevel: "1", dismissalType: "car", studentIdNumber: "1003" },
  { firstName: "Noah", lastName: "Jones", gradeLevel: "1", dismissalType: "walker", studentIdNumber: "1004" },
  { firstName: "Ava", lastName: "Garcia", gradeLevel: "2", dismissalType: "car", studentIdNumber: "1005" },
  { firstName: "Elijah", lastName: "Miller", gradeLevel: "2", dismissalType: "bus", busRoute: "Route 2", studentIdNumber: "1006" },
  { firstName: "Sophia", lastName: "Davis", gradeLevel: "3", dismissalType: "car", studentIdNumber: "1007" },
  { firstName: "James", lastName: "Rodriguez", gradeLevel: "3", dismissalType: "car", studentIdNumber: "1008" },
  { firstName: "Isabella", lastName: "Martinez", gradeLevel: "3", dismissalType: "bus", busRoute: "Route 1", studentIdNumber: "1009" },
  { firstName: "William", lastName: "Hernandez", gradeLevel: "4", dismissalType: "walker", studentIdNumber: "1010" },
  { firstName: "Mia", lastName: "Lopez", gradeLevel: "4", dismissalType: "car", studentIdNumber: "1011" },
  { firstName: "Benjamin", lastName: "Gonzalez", gradeLevel: "4", dismissalType: "bus", busRoute: "Route 3", studentIdNumber: "1012" },
  { firstName: "Charlotte", lastName: "Wilson", gradeLevel: "5", dismissalType: "car", studentIdNumber: "1013" },
  { firstName: "Lucas", lastName: "Anderson", gradeLevel: "5", dismissalType: "car", studentIdNumber: "1014" },
  { firstName: "Amelia", lastName: "Thomas", gradeLevel: "5", dismissalType: "bus", busRoute: "Route 2", studentIdNumber: "1015" },
  { firstName: "Henry", lastName: "Taylor", gradeLevel: "K", dismissalType: "car", studentIdNumber: "1016" },
  { firstName: "Harper", lastName: "Moore", gradeLevel: "1", dismissalType: "bus", busRoute: "Route 3", studentIdNumber: "1017" },
  { firstName: "Alexander", lastName: "Jackson", gradeLevel: "2", dismissalType: "car", studentIdNumber: "1018" },
  { firstName: "Evelyn", lastName: "Martin", gradeLevel: "3", dismissalType: "walker", studentIdNumber: "1019" },
  { firstName: "Daniel", lastName: "Lee", gradeLevel: "4", dismissalType: "car", studentIdNumber: "1020" },
];

export async function seedDemoStudents(schoolId: string) {
  // Check if students already exist
  const existing = await db
    .select()
    .from(students)
    .where(eq(students.schoolId, schoolId))
    .limit(1);

  if (existing.length > 0) {
    console.log(`  Demo students already exist for school`);
    return;
  }

  // Create grades (classes) for PassPilot
  const gradeNames = ["Mrs. Smith - K", "Mr. Johnson - 1st", "Ms. Davis - 2nd", "Mrs. Brown - 3rd", "Mr. Wilson - 4th", "Ms. Taylor - 5th"];
  const createdGrades: Record<string, string> = {};

  for (let i = 0; i < gradeNames.length; i++) {
    const [grade] = await db
      .insert(grades)
      .values({
        schoolId,
        name: gradeNames[i],
        displayOrder: i,
      })
      .returning();
    // Map grade level to grade ID
    const level = ["K", "1", "2", "3", "4", "5"][i];
    createdGrades[level] = grade!.id;
  }
  console.log(`  Created ${gradeNames.length} grades`);

  // Create students with grade assignments
  const studentData = DEMO_STUDENTS.map((s) => ({
    schoolId,
    firstName: s.firstName,
    lastName: s.lastName,
    gradeLevel: s.gradeLevel,
    gradeId: createdGrades[s.gradeLevel] || null,
    dismissalType: s.dismissalType,
    busRoute: s.busRoute || null,
    studentIdNumber: s.studentIdNumber,
    email: `${s.firstName.toLowerCase()}.${s.lastName.toLowerCase()}@lincoln.edu`,
    emailLc: `${s.firstName.toLowerCase()}.${s.lastName.toLowerCase()}@lincoln.edu`,
    studentCode: s.studentIdNumber, // Use ID as student code for demo
  }));

  await db.insert(students).values(studentData);
  console.log(`  Created ${DEMO_STUDENTS.length} demo students`);
}
