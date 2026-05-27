import { seedSuperAdmin } from "../seeds/001_super_admin.js";
import { pool } from "../src/db.js";

try {
  const u = await seedSuperAdmin();
  console.log("Super-admin ready:", u?.email, "id:", u?.id);
} catch (err) {
  console.error("Super-admin seed failed:", err);
  process.exit(1);
} finally {
  await pool.end();
}
