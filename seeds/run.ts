import "dotenv/config";
import { seedSuperAdmin } from "./001_super_admin.js";
import { seedDemoSchool } from "./002_demo_school.js";
import { seedDemoStudents } from "./003_demo_students.js";
import { seedDemoData } from "./004_demo_data.js";
import { seedDemoParents } from "./005_demo_parents.js";
import { pool } from "../src/db.js";

async function main() {
  console.log("Seeding database...\n");

  try {
    if (process.env.ALLOW_DEMO_SEED !== "1") {
      throw new Error(
        "Demo seed data is disabled. Set ALLOW_DEMO_SEED=1 to run seeds/run.ts intentionally."
      );
    }

    // 1. Super admin
    console.log("[1/5] Super admin");
    const superAdmin = await seedSuperAdmin();

    // 2. Demo school
    console.log("[2/5] Demo school");
    const school = await seedDemoSchool(superAdmin!.id);

    // 3. Demo students
    console.log("[3/5] Demo students");
    await seedDemoStudents(school.id);

    // 4. Demo data (teachers, assignments)
    console.log("[4/5] Demo data");
    await seedDemoData(school.id);

    // 5. Demo parents (for iKeepSafe certification / user simulation)
    console.log("[5/5] Demo parents");
    await seedDemoParents(school.id);

    console.log("\nSeeding complete!");
  } catch (err) {
    console.error("Seeding failed:", err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
