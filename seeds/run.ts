import "dotenv/config";
import { seedSuperAdmin } from "./001_super_admin.js";
import { seedDemoSchool } from "./002_demo_school.js";
import { seedDemoStudents } from "./003_demo_students.js";
import { seedDemoData } from "./004_demo_data.js";
import { pool } from "../src/db.js";

async function main() {
  console.log("Seeding database...\n");

  try {
    // 1. Super admin
    console.log("[1/4] Super admin");
    const superAdmin = await seedSuperAdmin();

    // 2. Demo school
    console.log("[2/4] Demo school");
    const school = await seedDemoSchool(superAdmin!.id);

    // 3. Demo students
    console.log("[3/4] Demo students");
    await seedDemoStudents(school.id);

    // 4. Demo data (teachers, assignments)
    console.log("[4/4] Demo data");
    await seedDemoData(school.id);

    console.log("\nSeeding complete!");
  } catch (err) {
    console.error("Seeding failed:", err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
