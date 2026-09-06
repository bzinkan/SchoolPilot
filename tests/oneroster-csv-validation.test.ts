import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "csv-parse/sync";
import { parseOneRosterFiles, readOneRosterZip } from "../src/services/oneRosterCsv.js";

type Row = Record<string, string>;
function csv(rows: Row[], headers = [...new Set(rows.flatMap(row => Object.keys(row)))]) {
  return [headers, ...rows.map(row => headers.map(header => row[header] ?? ""))]
    .map(row => row.map(value => /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value).join(",")).join("\r\n");
}
function fixture(version = "1.2") {
  const files = new Map<string, string>();
  const users: Row[] = [
    { sourcedId: "t", enabledUser: "true", username: "teach", givenName: "Teach", familyName: "Person", email: "teach@example.edu" },
    { sourcedId: "s", enabledUser: "true", username: "student", givenName: "Stu", familyName: "Person", email: "stu@example.edu" },
  ];
  if (version === "1.1") users.forEach((row, index) => Object.assign(row, { role: index ? "student" : "teacher", orgSourcedIds: "org" }));
  files.set("users.csv", csv(users));
  files.set("orgs.csv", csv([{ sourcedId: "org", name: "Example School", type: "school" }]));
  files.set("academicSessions.csv", csv([{ sourcedId: "term", title: "Fall", type: "term", startDate: "2026-08-01", endDate: "2026-12-20", schoolYear: "2026" }]));
  files.set("courses.csv", csv([{ sourcedId: "course", title: "Math", orgSourcedId: "org" }]));
  files.set("classes.csv", csv([{ sourcedId: "class", title: "Math A", classType: "scheduled", schoolSourcedId: "org", courseSourcedId: "course", termSourcedIds: "term" }]));
  files.set("enrollments.csv", csv([
    { sourcedId: "et", classSourcedId: "class", schoolSourcedId: "org", userSourcedId: "t", role: "teacher" },
    { sourcedId: "es", classSourcedId: "class", schoolSourcedId: "org", userSourcedId: "s", role: "student" },
  ]));
  if (version === "1.2") files.set("roles.csv", csv([
    { sourcedId: "rt", userSourcedId: "t", roleType: "primary", role: "teacher", orgSourcedId: "org" },
    { sourcedId: "rs", userSourcedId: "s", roleType: "primary", role: "student", orgSourcedId: "org" },
  ]));
  declareFiles(files, version);
  return files;
}
function declareFiles(files: Map<string, string>, version = "1.2") {
  files.set("manifest.csv", csv([{ propertyName: "manifest.version", value: "1.0" }, { propertyName: "oneroster.version", value: version },
    ...[...files.keys()].filter(name => name !== "manifest.csv").map(name => ({ propertyName: `file.${name.slice(0, -4)}`, value: "bulk" }))]));
}
function change(files: Map<string, string>, name: string, mutate: (rows: Row[]) => void) {
  const rows = parse(files.get(`${name}.csv`)!, { columns: true }) as Row[];
  mutate(rows);
  files.set(`${name}.csv`, csv(rows));
}
function rejectChange(name: string, mutate: (rows: Row[]) => void, code: string, version = "1.2") {
  const files = fixture(version);
  change(files, name, mutate);
  assert.throws(() => parseOneRosterFiles(files), { code });
}

test("both bulk versions accept optional parent and primary columns being omitted", () => {
  for (const version of ["1.1", "1.2"]) {
    const snapshot = parseOneRosterFiles(fixture(version));
    assert.equal(snapshot.version, version);
    assert.equal(snapshot.classes[0]?.primaryTeacherId, "t");
    assert.deepEqual(snapshot.classes[0]?.studentIds, ["s"]);
  }
});

test("required core headers and values fail before a complete snapshot can be planned", () => {
  for (const [name, field] of [["users", "username"], ["users", "enabledUser"], ["academicSessions", "schoolYear"], ["classes", "classType"], ["roles", "roleType"]]) {
    rejectChange(name!, rows => rows.forEach(row => { delete row[field!]; }), "ROSTER_HEADERS_INVALID");
    rejectChange(name!, rows => { rows[0]![field!] = ""; }, "ROSTER_FIELD_REQUIRED");
  }
  rejectChange("users", rows => rows.forEach(row => { delete row.orgSourcedIds; }), "ROSTER_HEADERS_INVALID", "1.1");
  rejectChange("users", rows => { rows[0]!.enabledUser = "1"; }, "ROSTER_ENUM_INVALID");
  rejectChange("academicSessions", rows => { rows[0]!.schoolYear = "26/27"; }, "ROSTER_SCHOOL_YEAR_INVALID");
});

test("malformed and unmapped custom roster roles reject rather than dropping memberships", () => {
  for (const [name, version] of [["enrollments", "1.1"], ["enrollments", "1.2"], ["users", "1.1"], ["roles", "1.2"]]) {
    rejectChange(name!, rows => { rows[1]!.role = "studnet"; }, "ROSTER_ENUM_INVALID", version);
    rejectChange(name!, rows => { rows[1]!.role = ""; }, "ROSTER_FIELD_REQUIRED", version);
  }
  for (const name of ["enrollments", "roles"]) {
    rejectChange(name, rows => { rows[1]!.role = "ext:learner"; }, "ROSTER_ROLE_EXTENSION_UNSUPPORTED");
    rejectChange(name, rows => { rows[1]!.role = "ext:"; }, "ROSTER_ENUM_INVALID");
  }
  rejectChange("enrollments", rows => { rows[1]!.role = "ext:learner"; }, "ROSTER_ENUM_INVALID", "1.1");
});

test("standard non-teaching roles never grant staff or student memberships", () => {
  const files = fixture();
  change(files, "roles", rows => rows.push({ sourcedId: "ra", userSourcedId: "t", roleType: "secondary", role: "systemAdministrator", orgSourcedId: "org" }));
  change(files, "enrollments", rows => rows.push({ sourcedId: "ea", classSourcedId: "class", schoolSourcedId: "org", userSourcedId: "t", role: "administrator" }));
  const snapshot = parseOneRosterFiles(files);
  assert.deepEqual(snapshot.people.find(person => person.id === "t")?.roles, ["teacher"]);
  assert.deepEqual(snapshot.classes[0]?.studentIds, ["s"]);
  assert(snapshot.warnings.some(warning => warning.includes("do not grant SchoolPilot permissions")));
});

test("primary organization roles and primary teacher flags are unambiguous", () => {
  rejectChange("roles", rows => { rows[0]!.roleType = "main"; }, "ROSTER_ENUM_INVALID");
  rejectChange("roles", rows => rows.push({ ...rows[0]!, sourcedId: "r2", role: "aide" }), "ROSTER_PRIMARY_ROLE_DUPLICATE");
  rejectChange("enrollments", rows => { rows[1]!.primary = "true"; }, "ROSTER_PRIMARY_INVALID");
  rejectChange("enrollments", rows => { rows[0]!.primary = "yes"; }, "ROSTER_PRIMARY_INVALID");
  const files = fixture();
  change(files, "roles", rows => rows.push({ ...rows[0]!, sourcedId: "r2", roleType: "secondary", role: "aide" }));
  change(files, "enrollments", rows => { rows[0]!.primary = "true"; rows.push({ ...rows[0]!, sourcedId: "et2" }); });
  assert.equal(parseOneRosterFiles(files).classes[0]?.primaryTeacherId, "t");
});

test("optional user profiles must exist, have required fields and belong to the role user", () => {
  const withProfile = () => {
    const files = fixture();
    files.set("userProfiles.csv", csv([{ sourcedId: "p", userSourcedId: "s", profileType: "School", vendorId: "vendor", credentialType: "password", username: "profile-user", password: "must-never-persist" }]));
    change(files, "roles", rows => { rows[1]!.userProfileSourcedId = "p"; });
    declareFiles(files);
    return files;
  };
  const valid = withProfile();
  const snapshot = parseOneRosterFiles(valid);
  assert(!JSON.stringify(snapshot).includes("must-never-persist"));
  assert(!JSON.stringify(snapshot).includes("profile-user"));
  const missing = fixture(); change(missing, "roles", rows => { rows[1]!.userProfileSourcedId = "p"; });
  assert.throws(() => parseOneRosterFiles(missing), { code: "ROSTER_REFERENCE_INVALID" });
  const wrong = withProfile(); change(wrong, "userProfiles", rows => { rows[0]!.userSourcedId = "t"; });
  assert.throws(() => parseOneRosterFiles(wrong), { code: "ROSTER_PROFILE_USER_MISMATCH" });
  const noVendor = withProfile(); change(noVendor, "userProfiles", rows => { delete rows[0]!.vendorId; });
  assert.throws(() => parseOneRosterFiles(noVendor), { code: "ROSTER_HEADERS_INVALID" });
});

test("real, ordered role and enrollment dates are checked against class terms", () => {
  for (const name of ["roles", "enrollments"]) {
    rejectChange(name, rows => { rows[0]!.beginDate = "2026-02-30"; }, "ROSTER_DATE_RANGE_INVALID");
    rejectChange(name, rows => Object.assign(rows[0]!, { beginDate: "2026-09-03", endDate: "2026-09-03" }), "ROSTER_DATE_RANGE_INVALID");
  }
  rejectChange("enrollments", rows => { rows[0]!.beginDate = "2026-07-01"; }, "ROSTER_ENROLLMENT_TERM_MISMATCH");
  const files = fixture();
  change(files, "enrollments", rows => Object.assign(rows[0]!, { beginDate: "2026-08-01", endDate: "2026-12-20" }));
  const snapshot = parseOneRosterFiles(files);
  assert.equal(snapshot.classes.length, 1);
  assert(snapshot.warnings.some(warning => warning.includes("do not schedule membership")));
});

test("1.2 extensible non-role enums accept prefixed values and reject bare typos", () => {
  const files = fixture();
  change(files, "classes", rows => { rows[0]!.classType = "ext:lab"; });
  change(files, "academicSessions", rows => { rows[0]!.type = "ext:miniTerm"; });
  assert.equal(parseOneRosterFiles(files).classes.length, 1);
  rejectChange("classes", rows => { rows[0]!.classType = "schedueld"; }, "ROSTER_ENUM_INVALID");
  rejectChange("orgs", rows => { rows[0]!.type = "schoool"; }, "ROSTER_ENUM_INVALID");
  rejectChange("classes", rows => { rows[0]!.classType = "ext:lab"; }, "ROSTER_ENUM_INVALID", "1.1");
});

test("course school-year references and optional demographic identities are checked", () => {
  rejectChange("courses", rows => { rows[0]!.schoolYearSourcedId = "term"; }, "ROSTER_COURSE_SCHOOL_YEAR_INVALID");
  const files = fixture();
  files.set("demographics.csv", csv([{ sourcedId: "missing-user" }])); declareFiles(files);
  assert.throws(() => parseOneRosterFiles(files), { code: "ROSTER_REFERENCE_INVALID" });
});

test("disabled source users remain in reviewed rosters and explicitly preserve local access policy", () => {
  const files = fixture(); change(files, "users", rows => { rows[1]!.enabledUser = "false"; });
  const snapshot = parseOneRosterFiles(files);
  assert.deepEqual(snapshot.classes[0]?.studentIds, ["s"]);
  assert(snapshot.warnings.some(warning => warning.includes("do not change local")));
});

function storedZip(files: Map<string, string>): Buffer {
  const local: Buffer[] = []; const directory: Buffer[] = []; let offset = 0;
  const crc32 = (data: Buffer) => { let crc = 0xffffffff; for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; };
  for (const [name, value] of files) {
    const filename = Buffer.from(name); const content = Buffer.from(value); const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc32(content), 14); header.writeUInt32LE(content.length, 18); header.writeUInt32LE(content.length, 22); header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, content);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc32(content), 16); central.writeUInt32LE(content.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    directory.push(central, filename); offset += header.length + filename.length + content.length;
  }
  const central = Buffer.concat(directory); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, central, end]);
}

test("streamed ZIP handles manifest-last order and discards large credential/metadata fields", async () => {
  const files = fixture();
  change(files, "users", rows => rows.forEach(row => { row.password = "private-password".repeat(1000); row["metadata.unused"] = "irrelevant".repeat(1000); }));
  const snapshot = await readOneRosterZip(storedZip(files));
  assert.deepEqual(snapshot, parseOneRosterFiles(files));
  assert(!JSON.stringify(snapshot).includes("private-password"));
  assert(!JSON.stringify(snapshot).includes("irrelevant"));
});

test("streamed ZIP applies field and CSV limits even to discarded columns", async () => {
  const oversized = fixture(); change(oversized, "users", rows => { rows[0]!["metadata.unused"] = "x".repeat(16_385); });
  await assert.rejects(readOneRosterZip(storedZip(oversized)), { code: "ROSTER_ROWS_LIMIT" });
  const invalid = fixture(); invalid.set("roles.csv", 'sourcedId,userSourcedId,roleType,role,orgSourcedId\n"unclosed');
  await assert.rejects(readOneRosterZip(storedZip(invalid)), { code: "ROSTER_CSV_INVALID" });
});
