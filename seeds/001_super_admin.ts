import { eq } from "drizzle-orm";
import db from "../src/db.js";
import { users } from "../src/schema/core.js";
import { hashPassword } from "../src/util/password.js";

export async function seedSuperAdmin() {
  const email = (
    process.env.SUPER_ADMIN_EMAIL || "bzinkan@school-pilot.net"
  ).toLowerCase();

  // Check if already exists
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing) {
    console.log(`  Super admin already exists: ${email}`);
    // Ensure isSuperAdmin is set
    if (!existing.isSuperAdmin) {
      await db
        .update(users)
        .set({ isSuperAdmin: true })
        .where(eq(users.id, existing.id));
      console.log(`  Updated ${email} to super admin`);
    }
    return existing;
  }

  const hashedPassword = await hashPassword("SuperAdmin123!");

  const [superAdmin] = await db
    .insert(users)
    .values({
      email,
      password: hashedPassword,
      firstName: "Ben",
      lastName: "Zinkan",
      displayName: "Ben Zinkan",
      isSuperAdmin: true,
    })
    .returning();

  console.log(`  Created super admin: ${email}`);
  return superAdmin!;
}
