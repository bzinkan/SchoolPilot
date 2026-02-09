import { eq } from "drizzle-orm";
import db from "../src/db.js";
import { schools, productLicenses, schoolMemberships } from "../src/schema/core.js";

export async function seedDemoSchool(superAdminId: string) {
  const schoolName = "Lincoln Elementary";

  // Check if already exists
  const [existing] = await db
    .select()
    .from(schools)
    .where(eq(schools.name, schoolName))
    .limit(1);

  if (existing) {
    console.log(`  Demo school already exists: ${schoolName}`);
    return existing;
  }

  // Create school
  const [school] = await db
    .insert(schools)
    .values({
      name: schoolName,
      domain: "lincoln.edu",
      slug: "lincoln-elementary",
      address: "123 Main Street, Springfield, IL 62701",
      phone: "(555) 123-4567",
      status: "active",
      isActive: true,
      planTier: "enterprise",
      planStatus: "active",
      maxTeachers: 50,
      maxLicenses: 500,
      schoolTimezone: "America/Chicago",
      dismissalTime: "15:15",
      dismissalMode: "app",
      defaultPassDuration: 5,
      kioskEnabled: true,
    })
    .returning();

  console.log(`  Created demo school: ${schoolName}`);

  // Create all 3 product licenses
  const products = ["PASSPILOT", "GOPILOT", "CLASSPILOT"] as const;
  for (const product of products) {
    await db.insert(productLicenses).values({
      schoolId: school!.id,
      product,
      status: "active",
    });
  }
  console.log(`  Created product licenses: ${products.join(", ")}`);

  // Add super admin as school admin
  await db.insert(schoolMemberships).values({
    userId: superAdminId,
    schoolId: school!.id,
    role: "admin",
  });
  console.log(`  Added super admin as school admin`);

  return school!;
}
