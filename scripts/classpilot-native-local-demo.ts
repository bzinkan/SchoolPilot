/** Local synthetic integration harness. Uses real application auth and routes. */
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import pg from "pg";
import { hashPassword } from "../src/util/password.js";
import { runSchoolPilotMigrationLedger } from "../src/db/migrationLedger.js";
import { schoolPilot27Migrations } from "../src/db/migrations27.js";

const local = (value: string | undefined) => {
  if (!value) throw new Error("Explicit isolated local DATABASE_URL and ADMIN_DATABASE_URL are required");
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || !/^schoolpilot_redesign_native_demo_[a-z0-9_]+$/.test(url.pathname.slice(1))) {
    throw new Error("The native demo accepts only an isolated local native_demo database");
  }
  return value;
};
if (process.env.NODE_ENV === "production" || process.env.APP_ENV === "production") throw new Error("The synthetic demo cannot run in production");
local(process.env.DATABASE_URL);
const admin = new pg.Pool({ connectionString: local(process.env.ADMIN_DATABASE_URL), max: 2 });
const privateDirectory = path.resolve(process.env.NATIVE_DEMO_PRIVATE_DIR || path.join(os.tmpdir(), `classpilot-native-${randomUUID()}`));
if (privateDirectory.startsWith(path.resolve(process.cwd()) + path.sep)) throw new Error("Private fixture output must stay outside the repository");
await mkdir(privateDirectory, { recursive: true });
await runSchoolPilotMigrationLedger({ pool: admin, migrations: schoolPilot27Migrations });

const staffPassword = randomBytes(24).toString("base64url");
const passwordHash = await hashPassword(staffPassword);
const pin = String(randomInt(1000, 10000));
const pinHash = await hashPassword(pin);
const schools = [0, 1].map(index => ({ id: randomUUID(), domain: `native-${randomUUID()}.example.edu`,
  admin: randomUUID(), teacher: randomUUID(), office: randomUUID(), group: randomUUID(),
  students: [0, 1].map(student => ({ id: randomUUID(), identifier: `native-${index}-${student}`, pin })) }));
process.env.CLASSPILOT_NATIVE_VISIBILITY_MODE = "on";
process.env.CLASSPILOT_NATIVE_VISIBILITY_SCHOOL_IDS = schools.map(school => school.id).join(",");
process.env.CLASSPILOT_MANUAL_SHARED_SESSION_ISSUANCE_ENABLED = "true";
for (const [index, school] of schools.entries()) {
  await admin.query("INSERT INTO schools(id,name,domain,slug,status,plan_status,staff_password_login_enabled) VALUES($1,$2,$3,$4,'active','active',true)",
    [school.id, `Synthetic Desktop School ${index + 1}`, school.domain, `native-${school.id}`]);
  await admin.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')", [school.id]);
  for (const [role, id] of [["admin", school.admin], ["teacher", school.teacher], ["office_staff", school.office]]) {
    await admin.query("INSERT INTO users(id,email,password,first_name,last_name) VALUES($1,$2,$3,'Synthetic',$4)", [id, `${role}@${school.domain}`, passwordHash, role]);
    await admin.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,$3,'active')", [school.id, id, role]);
  }
  await admin.query("INSERT INTO settings(school_id,school_name,ws_shared_key,enable_tracking_hours,tracking_start_time,tracking_end_time,tracking_days,school_timezone,after_hours_mode,ai_safety_emails_enabled) VALUES($1,'Synthetic native classroom',$2,true,'00:00','23:59',ARRAY['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'],'America/New_York','off',false)", [school.id, randomBytes(32).toString("hex")]);
  for (const [studentIndex, student] of school.students.entries()) {
    await admin.query("INSERT INTO students(id,school_id,first_name,last_name,email,email_lc,student_id_number,status,classpilot_pin_hash) VALUES($1,$2,'Synthetic',$3,$4,$4,$5,'active',$6)", [student.id, school.id, studentIndex === 0 ? "Student A" : "Student B", `${student.identifier}@${school.domain}`, student.identifier, pinHash]);
  }
}
const applicationRole = new URL(process.env.DATABASE_URL!).username;
if (!/^native_demo_[a-f0-9]+$/.test(applicationRole)) throw new Error("Use the dedicated restricted native_demo application role");
await admin.query(`GRANT USAGE ON SCHEMA public TO ${applicationRole}; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${applicationRole}; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${applicationRole}`);
const { runWithTenantContext } = await import("../src/middleware/tenantContext.js");
const storage = await import("../src/services/storage.js");
const sessions = [];
for (const school of schools) {
  const session = await runWithTenantContext({ schoolId: school.id }, async () => {
    await storage.createGroup({ id: school.group, schoolId: school.id, teacherId: school.teacher,
      name: "Synthetic Math Workshop", groupType: "admin_class", status: "active" });
    await admin.query("INSERT INTO group_teachers(group_id,teacher_id,role) VALUES($1,$2,'primary') ON CONFLICT DO NOTHING", [school.group, school.teacher]);
    for (const student of school.students) await admin.query("INSERT INTO group_students(group_id,student_id) VALUES($1,$2)", [school.group, student.id]);
    return storage.createTeachingSession({ groupId: school.group, teacherId: school.teacher, sessionMode: "live" });
  });
  sessions.push(session.id);
}
const port = Number(process.env.NATIVE_DEMO_PORT || "4100");
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid local demo port");
const origin = `http://127.0.0.1:${port}`;
const { createApp } = await import("../src/app.js");
const server = createApp().listen(port, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const signIn = async (role: string, schoolIndex = 0) => {
  const response = await fetch(`${origin}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `${role}@${schools[schoolIndex]!.domain}`, password: staffPassword }) });
  if (!response.ok) throw new Error(`Synthetic staff login failed (${response.status})`);
  const body = await response.json() as { token: string };
  return { token: body.token, cookie: response.headers.getSetCookie().map(cookie => cookie.split(";")[0]).join("; ") };
};
const administrator = await signIn("admin");
const teacher = await signIn("teacher");
const enrollmentResponse = await fetch(`${origin}/api/classpilot/native/enrollment-tokens`, { method: "POST", headers: {
  "Content-Type": "application/json", Authorization: `Bearer ${administrator.token}`, "X-School-Id": schools[0]!.id }, body: "{}" });
if (!enrollmentResponse.ok) throw new Error(`Native enrollment issuance failed (${enrollmentResponse.status})`);
const enrollment = await enrollmentResponse.json() as { enrollmentToken: string };
await writeFile(path.join(privateDirectory, "fixture.private.json"), JSON.stringify({ origin, schoolId: schools[0]!.id,
  teacherEmail: `teacher@${schools[0]!.domain}`, staffPassword, teacherToken: teacher.token, teacherCookie: teacher.cookie,
  administratorToken: administrator.token, teachingSessionId: sessions[0], students: schools[0]!.students,
  enrollmentToken: enrollment.enrollmentToken, foreignSchoolId: schools[1]!.id, foreignTeachingSessionId: sessions[1] }, null, 2), { mode: 0o600 });
console.log(`Native synthetic demo ready at ${origin}. Private fixture: ${path.join(privateDirectory, "fixture.private.json")}`);
console.log("No production connection, external messaging or real-student collection is part of this harness.");
process.once("SIGINT", () => server.close(() => process.exit(0)));
process.once("SIGTERM", () => server.close(() => process.exit(0)));
await admin.end();
