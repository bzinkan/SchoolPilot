import { defineConfig } from "drizzle-kit";
import { readFileSync, existsSync } from "fs";

const RDS_CA_PATH = "/app/rds-ca.pem";
const url = process.env.DATABASE_URL ?? "";

function buildSsl() {
  if (url.includes("sslmode=verify-full") && existsSync(RDS_CA_PATH)) {
    return { ca: readFileSync(RDS_CA_PATH, "utf8"), rejectUnauthorized: true };
  }
  if (url.includes("sslmode=require") || url.includes("sslmode=no-verify")) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

export default defineConfig({
  schema: [
    "./src/schema/core.ts",
    "./src/schema/students.ts",
    "./src/schema/passpilot.ts",
    "./src/schema/gopilot.ts",
    "./src/schema/classpilot.ts",
    "./src/schema/mailpilot.ts",
    "./src/schema/shared.ts",
  ],
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: url,
    ssl: buildSsl(),
  },
});
