import { parse } from "csv-parse/sync";
import { parse as parseStream } from "csv-parse";
import yauzl from "yauzl";
import { ROSTER_LIMITS, normalizedRosterEmail, normalizedRosterGrade, rosterError, type RosterClass, type RosterPackage, type RosterPerson } from "./rosterIntegrationModel.js";

type Row = Record<string, string>;
type CsvDocument = { headers: string[]; rows: Row[] };
const REQUIRED = ["orgs", "users", "academicSessions", "courses", "classes", "enrollments"];
const OPTIONAL = ["demographics", "roles", "userProfiles", "resources", "classResources", "courseResources", "userResources", "categories", "lineItems", "results", "scoreScales", "lineItemScoreScales", "resultScoreScales", "lineItemLearningObjectiveIds", "resultLearningObjectiveIds"];
const HEADERS: Record<string, string[]> = {
  manifest: ["propertyName", "value"],
  orgs: ["sourcedId", "name", "type"], users: ["sourcedId", "enabledUser", "username", "givenName", "familyName"],
  academicSessions: ["sourcedId", "title", "type", "startDate", "endDate", "schoolYear"], courses: ["sourcedId", "title", "orgSourcedId"],
  classes: ["sourcedId", "title", "classType", "schoolSourcedId", "courseSourcedId", "termSourcedIds"],
  enrollments: ["sourcedId", "classSourcedId", "schoolSourcedId", "userSourcedId", "role"],
  roles: ["sourcedId", "userSourcedId", "roleType", "role", "orgSourcedId"],
  userProfiles: ["sourcedId", "userSourcedId", "profileType", "vendorId", "credentialType", "username"],
};
const FOREIGN_COLUMNS: Record<string, string> = { orgSourcedId: "orgs", schoolSourcedId: "orgs", userSourcedId: "users", studentSourcedId: "users", userProfileSourcedId: "userProfiles", classSourcedId: "classes", courseSourcedId: "courses", academicSessionSourcedId: "academicSessions", gradingPeriodSourcedId: "academicSessions", categorySourcedId: "categories", lineItemSourcedId: "lineItems", resultSourcedId: "results", resourceSourcedId: "resources", scoreScaleSourcedId: "scoreScales" };
const RETAINED_COLUMNS = new Set([...Object.values(HEADERS).flat(), ...Object.keys(FOREIGN_COLUMNS), "status", "dateLastModified", "parentSourcedId", "schoolYearSourcedId", "orgSourcedIds", "agentSourcedIds", "primaryOrgSourcedId", "email", "identifier", "grades", "primary", "beginDate", "endDate"]);
function csvOptions(document: CsvDocument, budget: { rows: number }) {
  return {
    bom: true,
    columns: (values: string[]) => {
      if (new Set(values).size !== values.length || values.some(header => !header || header === "__proto__" || header === "constructor")) throw rosterError("ROSTER_CSV_INVALID", "CSV contains duplicate or invalid headers.");
      document.headers = values;
      return values;
    },
    skip_empty_lines: true,
    max_record_size: ROSTER_LIMITS.fieldBytes * 8,
    on_record: (row: Row): Row => {
      if (++budget.rows > ROSTER_LIMITS.rows || Object.values(row).some(value => value.length > ROSTER_LIMITS.fieldBytes)) throw rosterError("ROSTER_ROWS_LIMIT", "CSV contents exceed row or field limits.");
      // Passwords, descriptions and unrelated metadata never enter the retained snapshot.
      return Object.fromEntries(Object.entries(row).filter(([key]) => RETAINED_COLUMNS.has(key)));
    },
  };
}
function csvError(error: unknown, name: string): Error {
  if (error instanceof Error && "code" in error && String(error.code).startsWith("ROSTER_")) return error;
  return rosterError("ROSTER_CSV_INVALID", `${name} contains invalid CSV or duplicate headers.`);
}
// OneRoster 1.1 CSV tables and 1.2.1 CSV binding sections 3 and 4.1.2.
// Custom roles require an explicit mapping feature; ignoring them could remove memberships.
const USER_ROLES_11 = ["administrator", "aide", "guardian", "parent", "proctor", "relative", "student", "teacher"];
const USER_ROLES_12 = ["aide", "counselor", "districtAdministrator", "guardian", "parent", "principal", "proctor", "relative", "siteAdministrator", "student", "systemAdministrator", "teacher"];
const ENROLLMENT_ROLES = ["administrator", "proctor", "student", "teacher"];
function enumValue(value: string | undefined, permitted: readonly string[], label: string, extensions = false, role = false): string {
  if (value && permitted.includes(value)) return value;
  if (extensions && value && /^ext:\S+$/.test(value)) {
    if (role) throw rosterError("ROSTER_ROLE_EXTENSION_UNSUPPORTED", `${label}: custom roles need an explicit mapping that this importer does not support. Export standard teacher/student roles before importing.`);
    return value;
  }
  throw rosterError("ROSTER_ENUM_INVALID", `${label} has a missing or unsupported value.`);
}
function validDate(value: string | undefined): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
}
function optionalDateRange(row: Row, file: string) {
  if ((row.beginDate && !validDate(row.beginDate)) || (row.endDate && !validDate(row.endDate)) || (row.beginDate && row.endDate && row.beginDate >= row.endDate)) {
    throw rosterError("ROSTER_DATE_RANGE_INVALID", `${file}: beginDate/endDate must be real dates in increasing order; endDate is exclusive.`);
  }
}
const list = (value: string | undefined) => String(value || "").split(",").map(part => part.trim()).filter(Boolean);
function requireId(row: Row, field: string, file: string): string {
  const value = row[field]?.trim();
  if (!value || value.length > 256) throw rosterError("ROSTER_ID_INVALID", `${file}: missing or oversized ${field}.`);
  return value;
}
function reference(index: Map<string, Row>, id: string | undefined, label: string, required = true) {
  if ((!id && required) || (id && !index.has(id))) throw rosterError("ROSTER_REFERENCE_INVALID", `${label} references a missing record.`);
}
function assertAcyclicParents(index: Map<string, Row>, label: string) {
  const checked = new Set<string>();
  for (const id of index.keys()) {
    const path = new Set<string>(); let current: string | undefined = id;
    while (current && !checked.has(current)) {
      if (path.has(current)) throw rosterError("ROSTER_REFERENCE_CYCLE", `${label} parents contain a cycle.`);
      path.add(current); current = index.get(current)?.parentSourcedId;
    }
    for (const visited of path) checked.add(visited);
  }
}

/** Parse one streamed entry at a time; never retain expanded ZIP buffers or passwords. */
export async function readOneRosterZip(buffer: Buffer): Promise<RosterPackage> {
  if (!buffer.length || buffer.length > ROSTER_LIMITS.compressedBytes) throw rosterError("ROSTER_ZIP_SIZE", "Upload a ZIP no larger than 25 MiB.");
  const budget = { rows: 0 };
  const files = await new Promise<Map<string, CsvDocument>>((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) return reject(rosterError("ROSTER_ZIP_INVALID", "The ZIP could not be read."));
      const result = new Map<string, CsvDocument>(); let expanded = 0; let count = 0; let done = false;
      let cancelEntry: (() => void) | undefined;
      const fail = (err: unknown) => { if (!done) { done = true; cancelEntry?.(); zip.close(); reject(err); } };
      zip.on("error", () => fail(rosterError("ROSTER_ZIP_INVALID", "The ZIP is corrupt or unsupported.")));
      zip.on("end", () => { if (!done) { done = true; resolve(result); } });
      zip.on("entry", (entry: yauzl.Entry) => {
        const name = entry.fileName;
        if (++count > ROSTER_LIMITS.entries || zip.entryCount > ROSTER_LIMITS.entries) return fail(rosterError("ROSTER_ZIP_ENTRIES", "The ZIP contains more than 100 entries."));
        if (!/^[a-zA-Z]+\.csv$/.test(name) || entry.isEncrypted() || ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) return fail(rosterError("ROSTER_ZIP_ENTRY_INVALID", "Use unencrypted, root-level CSV files without folders or links."));
        if (result.has(name) || [...result.keys()].some(existing => existing.toLowerCase() === name.toLowerCase())) return fail(rosterError("ROSTER_ZIP_DUPLICATE", "The ZIP contains duplicate CSV filenames."));
        if (entry.uncompressedSize + expanded > ROSTER_LIMITS.expandedBytes) return fail(rosterError("ROSTER_ZIP_EXPANDED_SIZE", "Expanded ZIP contents exceed 250 MiB."));
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return fail(rosterError("ROSTER_ZIP_INVALID", "A ZIP entry could not be read."));
          const document: CsvDocument = { headers: [], rows: [] };
          const parser = parseStream(csvOptions(document, budget));
          cancelEntry = () => { stream.destroy(); parser.destroy(); };
          stream.on("error", () => parser.destroy(rosterError("ROSTER_ZIP_INVALID", "A ZIP entry is corrupt.")));
          stream.on("data", (chunk: Buffer) => {
            expanded += chunk.length;
            if (expanded > ROSTER_LIMITS.expandedBytes) fail(rosterError("ROSTER_ZIP_EXPANDED_SIZE", "Expanded ZIP contents exceed 250 MiB."));
          });
          stream.pipe(parser);
          void (async () => {
            try {
              for await (const row of parser) document.rows.push(row as Row);
              if (!done) { cancelEntry = undefined; result.set(name, document); zip.readEntry(); }
            } catch (parseError) { fail(csvError(parseError, name)); }
          })();
        });
      });
      zip.readEntry();
    });
  });
  return parseOneRosterDocuments(files);
}

export function parseOneRosterFiles(files: Map<string, Buffer | string>): RosterPackage {
  const documents = new Map<string, CsvDocument>();
  const budget = { rows: 0 };
  for (const [name, raw] of files) {
    const document: CsvDocument = { headers: [], rows: [] };
    try { document.rows = parse(raw, csvOptions(document, budget)) as Row[]; }
    catch (error) { throw csvError(error, name); }
    documents.set(name, document);
  }
  return parseOneRosterDocuments(documents);
}

function parseOneRosterDocuments(files: Map<string, CsvDocument>): RosterPackage {
  const read = (name: string, additionalRequired: string[] = []): Row[] => {
    const document = files.get(`${name}.csv`);
    if (!document) throw rosterError("ROSTER_FILE_MISSING", `${name}.csv is required.`);
    const requiredHeaders = [...(HEADERS[name] || []), ...additionalRequired];
    if (requiredHeaders.some(header => !document.headers.includes(header))) throw rosterError("ROSTER_HEADERS_INVALID", `${name}.csv is missing required headers.`);
    for (const row of document.rows) for (const field of requiredHeaders) {
      if (!row[field]?.trim()) throw rosterError("ROSTER_FIELD_REQUIRED", `${name}.csv: ${field} must not be blank.`);
    }
    return document.rows;
  };
  const manifestRows = read("manifest");
  const manifest = new Map<string, string>();
  for (const row of manifestRows) {
    if (!row.propertyName || !row.value || manifest.has(row.propertyName)) throw rosterError("ROSTER_MANIFEST_INVALID", "The manifest has missing or duplicate properties.");
    manifest.set(row.propertyName, row.value);
  }
  const version = manifest.get("oneroster.version");
  if (manifest.get("manifest.version") !== "1.0" || !["1.1", "1.2"].includes(version || "")) throw rosterError("ROSTER_VERSION_UNSUPPORTED", "Use a OneRoster 1.1 or 1.2 bulk package with manifest version 1.0.");
  const required = [...REQUIRED, ...(version === "1.2" ? ["roles"] : [])];
  for (const [key, mode] of manifest) if (key.startsWith("file.") && !["bulk", "absent"].includes(mode)) throw rosterError("ROSTER_DELTA_UNSUPPORTED", "Delta and mixed-mode packages are not supported; export a complete bulk package.");
  for (const name of required) if (manifest.get(`file.${name}`) !== "bulk") throw rosterError("ROSTER_MANIFEST_INCOMPLETE", `${name}.csv must be declared bulk in the manifest.`);
  const indexes = new Map<string, Map<string, Row>>();
  for (const file of files.keys()) {
    const name = file.replace(/\.csv$/, "");
    if (name === "manifest") continue;
    if (![...REQUIRED, ...OPTIONAL].includes(name) || manifest.get(`file.${name}`) !== "bulk") throw rosterError("ROSTER_MANIFEST_MISMATCH", `${file} is unsupported or not declared bulk.`);
    const index = new Map<string, Row>();
    for (const row of read(name, name === "users" && version === "1.1" ? ["role", "orgSourcedIds"] : [])) {
      const id = requireId(row, "sourcedId", file);
      if (index.has(id)) throw rosterError("ROSTER_DUPLICATE_ID", `${file} contains duplicate identifiers.`);
      if (row.status?.trim() || row.dateLastModified?.trim()) throw rosterError("ROSTER_BULK_STATUS_INVALID", `${file}: bulk status and dateLastModified must be blank.`);
      index.set(id, row);
    }
    indexes.set(name, index);
    files.delete(file); // The index owns the rows now; release the intermediate array.
  }
  for (const [key, mode] of manifest) if (key.startsWith("file.") && mode === "bulk" && !indexes.has(key.slice(5))) throw rosterError("ROSTER_FILE_MISSING", `${key.slice(5)}.csv is declared but missing.`);
  const rows = (name: string) => indexes.get(name) ?? new Map<string, Row>();
  const organizations = [...rows("orgs")].map(([id, row]) => {
    reference(rows("orgs"), row.parentSourcedId, "Organization parent", false);
    return { id, name: requireId(row, "name", "orgs.csv"), type: enumValue(row.type, ["department", "school", "district", "local", "state", "national"], "orgs.type", version === "1.2") };
  });
  assertAcyclicParents(rows("orgs"), "Organization");
  for (const row of rows("academicSessions").values()) {
    reference(rows("academicSessions"), row.parentSourcedId, "Academic session parent", false);
    if (!validDate(row.startDate) || !validDate(row.endDate) || row.startDate! >= row.endDate!) throw rosterError("ROSTER_TERM_DATE_INVALID", "Academic session dates are invalid.");
    enumValue(row.type, ["gradingPeriod", "semester", "schoolYear", "term"], "academicSessions.type", version === "1.2");
    if (!/^\d{4}$/.test(row.schoolYear!)) throw rosterError("ROSTER_SCHOOL_YEAR_INVALID", "Academic session schoolYear must use YYYY format.");
  }
  assertAcyclicParents(rows("academicSessions"), "Academic session");
  const foreignColumns = Object.entries(FOREIGN_COLUMNS);
  for(const [name,index] of indexes)for(const row of index.values())for(const [column,target] of foreignColumns)if(row[column])reference(rows(target),row[column],`${name}.${column}`,false);
  for (const row of rows("courses").values()) {
    reference(rows("orgs"), row.orgSourcedId, "Course organization"); reference(rows("academicSessions"), row.schoolYearSourcedId, "Course school year", false);
    if (row.schoolYearSourcedId && rows("academicSessions").get(row.schoolYearSourcedId)?.type !== "schoolYear") throw rosterError("ROSTER_COURSE_SCHOOL_YEAR_INVALID", "Course schoolYearSourcedId must reference a schoolYear academic session.");
  }
  for (const id of rows("demographics").keys()) reference(rows("users"), id, "Demographics user");
  for (const row of rows("userProfiles").values()) reference(rows("users"), row.userSourcedId, "User profile user");
  const userRoles = new Map<string, Array<{ role: string; org: string }>>();
  const primaryRoles = new Set<string>();
  if (version === "1.2") for (const row of rows("roles").values()) {
    reference(rows("users"), row.userSourcedId, "Role user"); reference(rows("orgs"), row.orgSourcedId, "Role organization");
    enumValue(row.roleType, ["primary", "secondary"], "roles.roleType");
    enumValue(row.role, USER_ROLES_12, "roles.role", true, true);
    optionalDateRange(row, "roles.csv");
    const primaryKey = JSON.stringify([row.userSourcedId, row.orgSourcedId]);
    if (row.roleType === "primary") {
      if (primaryRoles.has(primaryKey)) throw rosterError("ROSTER_PRIMARY_ROLE_DUPLICATE", "A user may have only one primary role in an organization.");
      primaryRoles.add(primaryKey);
    }
    if (row.userProfileSourcedId && rows("userProfiles").get(row.userProfileSourcedId)?.userSourcedId !== row.userSourcedId) throw rosterError("ROSTER_PROFILE_USER_MISMATCH", "A role's user profile must belong to the same user.");
    const assigned = userRoles.get(row.userSourcedId!) || []; assigned.push({ role: row.role!, org: row.orgSourcedId! }); userRoles.set(row.userSourcedId!, assigned);
  }
  const people: RosterPerson[] = [...rows("users")].map(([id, row]) => {
    enumValue(row.enabledUser, ["true", "false"], "users.enabledUser");
    if (version === "1.1") enumValue(row.role, USER_ROLES_11, "users.role");
    const orgs = version === "1.1" ? list(row.orgSourcedIds) : (userRoles.get(id) || []).map(role => role.org);
    if (version === "1.1" && (!row.role || !orgs.length)) throw rosterError("ROSTER_USER_ROLE_REQUIRED", "OneRoster 1.1 users require role and orgSourcedIds.");
    if (version === "1.2" && !orgs.length) throw rosterError("ROSTER_USER_ROLE_REQUIRED", "OneRoster 1.2 users require an organization role in roles.csv.");
    for (const org of orgs) reference(rows("orgs"), org, "User organization");
    for (const agent of list(row.agentSourcedIds)) reference(rows("users"), agent, "User agent");
    reference(rows("orgs"), row.primaryOrgSourcedId, "User primary organization", false);
    const roles = version === "1.1" ? [row.role!] : (userRoles.get(id) || []).map(role => role.role);
    return { id, firstName: requireId(row, "givenName", "users.csv"), lastName: requireId(row, "familyName", "users.csv"), email: normalizedRosterEmail(row.email), studentNumber: row.identifier?.trim() || null, grade: normalizedRosterGrade(list(row.grades)[0]), schoolIds: [...new Set(orgs)], roles: [...new Set(roles.filter((role): role is "teacher" | "student" => role === "teacher" || role === "student"))] };
  });
  const peopleById = new Map(people.map(person => [person.id, person]));
  const enrollments = new Map<string, Row[]>();
  for (const row of rows("enrollments").values()) {
    reference(rows("classes"), row.classSourcedId, "Enrollment class"); reference(rows("orgs"), row.schoolSourcedId, "Enrollment school"); reference(rows("users"), row.userSourcedId, "Enrollment user");
    if (row.schoolSourcedId !== rows("classes").get(row.classSourcedId!)?.schoolSourcedId) throw rosterError("ROSTER_ENROLLMENT_SCHOOL_MISMATCH", "An enrollment school differs from its class school.");
    enumValue(row.role, ENROLLMENT_ROLES, "enrollments.role", version === "1.2", true);
    optionalDateRange(row, "enrollments.csv");
    if (row.primary && !["true", "false"].includes(row.primary)) throw rosterError("ROSTER_PRIMARY_INVALID", "Enrollment primary must be true, false, or blank.");
    if (row.primary === "true" && row.role !== "teacher") throw rosterError("ROSTER_PRIMARY_INVALID", "Only a teacher enrollment may be primary.");
    if (["teacher", "student"].includes(row.role!) && !peopleById.get(row.userSourcedId!)?.roles.includes(row.role as "teacher" | "student")) throw rosterError("ROSTER_ENROLLMENT_ROLE_MISMATCH", "An enrollment conflicts with the user's role.");
    const group = enrollments.get(row.classSourcedId!) || []; group.push(row); enrollments.set(row.classSourcedId!, group);
  }
  const classes: RosterClass[] = [...rows("classes")].map(([id, row]) => {
    enumValue(row.classType, ["homeroom", "scheduled"], "classes.classType", version === "1.2");
    reference(rows("orgs"), row.schoolSourcedId, "Class school"); reference(rows("courses"), row.courseSourcedId, "Class course");
    if(rows("orgs").get(row.schoolSourcedId!)?.type!=="school")throw rosterError("ROSTER_CLASS_SCHOOL_INVALID","A class must reference a school organization.");
    const terms = list(row.termSourcedIds); if (!terms.length) throw rosterError("ROSTER_CLASS_TERM_REQUIRED", "Classes must reference at least one academic session.");
    for (const term of terms) reference(rows("academicSessions"), term, "Class term");
    const members = enrollments.get(id) || []; const teachers = members.filter(member => member.role === "teacher");
    const termStart = terms.map(term => rows("academicSessions").get(term)!.startDate!).sort()[0]!;
    const termEnd = terms.map(term => rows("academicSessions").get(term)!.endDate!).sort().at(-1)!;
    for (const member of members) {
      if ((member.beginDate && (member.beginDate < termStart || member.beginDate >= termEnd)) || (member.endDate && (member.endDate <= termStart || member.endDate > termEnd))) throw rosterError("ROSTER_ENROLLMENT_TERM_MISMATCH", "Enrollment dates must fall within the class academic sessions.");
    }
    const primary = teachers.filter(member => member.primary === "true");
    if (new Set(primary.map(member => member.userSourcedId)).size > 1 || (!primary.length && new Set(teachers.map(member => member.userSourcedId)).size !== 1)) throw rosterError("ROSTER_PRIMARY_TEACHER_AMBIGUOUS", "Each class needs one unambiguous primary teacher; changing primary teachers across enrollment periods is not supported.");
    const primaryTeacherId = (primary[0] || teachers[0])!.userSourcedId!;
    return { id, schoolId: row.schoolSourcedId!, name: requireId(row, "title", "classes.csv"), grade: normalizedRosterGrade(list(row.grades)[0]), term: terms.map(term => rows("academicSessions").get(term)?.title).join(" / "), primaryTeacherId, coTeacherIds: [...new Set(teachers.map(member => member.userSourcedId!).filter(teacher => teacher !== primaryTeacherId))], studentIds: [...new Set(members.filter(member => member.role === "student").map(member => member.userSourcedId!))] };
  });
  const ignored = [...indexes.keys()].filter(name => !required.includes(name));
  const warnings = ignored.length ? ["Optional non-rostering files were checked for CSV structure and recognized references but are not imported; this is not full gradebook/resource validation."] : [];
  if ([...rows("users").values()].some(row => row.enabledUser === "false")) warnings.push("Source enabledUser flags do not change local student or staff account access. Review disabled source accounts using the school account lifecycle workflow.");
  if ([...rows("roles").values(), ...rows("enrollments").values()].some(row => row.role !== "student" && row.role !== "teacher")) warnings.push("Only student and teacher roles create roster memberships. Other standard roles do not grant SchoolPilot permissions.");
  if ([...rows("roles").values(), ...rows("enrollments").values()].some(row => row.beginDate || row.endDate)) warnings.push("Role and enrollment dates are validated but do not schedule membership activation or removal. Export the intended current roster before applying this bulk snapshot.");
  return { provider: "oneroster", version: version!, complete: true, organizations, people, classes, warnings };
}
