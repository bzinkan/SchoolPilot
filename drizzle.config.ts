import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: [
    "./src/schema/core.ts",
    "./src/schema/students.ts",
    "./src/schema/passpilot.ts",
    "./src/schema/gopilot.ts",
    "./src/schema/classpilot.ts",
    "./src/schema/shared.ts",
  ],
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
