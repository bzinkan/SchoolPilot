import { ROSTER_LIMITS, normalizedRosterEmail, normalizedRosterGrade, rosterError, type RosterPackage, type RosterPerson } from "./rosterIntegrationModel.js";

const API = "https://api.clever.com";
type CleverRecord = Record<string, any>;
type Fetcher = typeof fetch;
export type CleverFetchBudget = { bytes: number; rows: number };
function recordId(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 256) throw rosterError("CLEVER_RESPONSE_INVALID", "Clever returned an invalid identifier.");
  return value;
}
async function responseJson(response: Response, budget: CleverFetchBudget): Promise<any> {
  if (!response.body) throw rosterError("CLEVER_RESPONSE_INVALID", "Clever returned an empty response.");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let pageBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      pageBytes += chunk.value.byteLength; budget.bytes += chunk.value.byteLength;
      if (pageBytes > 16 * 1024 * 1024 || budget.bytes > ROSTER_LIMITS.expandedBytes) throw rosterError("CLEVER_RESPONSE_LIMIT", "Clever's response exceeds the safe import size.");
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw rosterError("CLEVER_RESPONSE_INVALID", "Clever returned invalid JSON."); }
}

/** Follow every page, but never send a district credential to a supplied host or another resource. */
export async function fetchCleverCollection(resource: string, token: string, budget: CleverFetchBudget, fetcher: Fetcher = fetch): Promise<CleverRecord[]> {
  if (!/^(districts|schools|users|sections|courses|terms)$/.test(resource)) throw rosterError("CLEVER_RESOURCE_INVALID", "Unsupported Clever resource.");
  const path = `/v3.0/${resource}`; let next: string | null = `${API}${path}?limit=1000`;
  const visited = new Set<string>(); const ids = new Set<string>(); const records: CleverRecord[] = [];
  while (next) {
    const url = new URL(next, API);
    if (url.origin !== API || url.pathname !== path || url.username || url.password || url.hash || visited.has(url.href) || visited.size >= 1000) throw rosterError("CLEVER_PAGING_INVALID", "Clever pagination is invalid or incomplete.");
    visited.add(url.href);
    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { response = await fetcher(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(15_000) }); }
      catch { if (attempt === 2) throw rosterError("CLEVER_UNAVAILABLE", "Clever could not be reached. No roster changes were applied.", 502); }
      if (response && response.status !== 429 && response.status < 500) break;
      if (response?.body) await response.body.cancel().catch(() => {});
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 500));
    }
    if (!response || !response.ok) throw rosterError(response?.status === 401 || response?.status === 403 ? "CLEVER_RECONNECT_REQUIRED" : "CLEVER_UNAVAILABLE", response?.status === 401 || response?.status === 403 ? "Clever authorization expired or sharing access is unavailable. Reconnect the district." : "Clever could not provide a complete roster. No changes were applied.", 502);
    const page = await responseJson(response, budget);
    if (!Array.isArray(page?.data) || !Array.isArray(page?.links)) throw rosterError("CLEVER_RESPONSE_INVALID", "Clever returned an incomplete collection envelope.");
    for (const wrapper of page.data) {
      const row = wrapper?.data; const id = recordId(row?.id);
      if (ids.has(id)) throw rosterError("CLEVER_PAGING_DUPLICATE", "Clever pages repeated a record; the snapshot must be reviewed.");
      if (++budget.rows > ROSTER_LIMITS.rows) throw rosterError("CLEVER_ROWS_LIMIT", "Clever's roster exceeds 250,000 records.");
      ids.add(id); records.push(row);
    }
    const links = page.links.filter((link: any) => link?.rel === "next");
    if (links.length > 1 || (links[0] && (typeof links[0].uri !== "string" || !links[0].uri.trim()))) throw rosterError("CLEVER_PAGING_INVALID", "Clever returned an invalid next page.");
    next = links[0]?.uri || null;
  }
  return records;
}

export async function fetchCleverRoster(districtId: string, token: string, fetcher: Fetcher = fetch): Promise<RosterPackage> {
  recordId(districtId);
  if (!token.trim() || token.length > 4096) throw rosterError("CLEVER_TOKEN_INVALID", "Provide a district data token.");
  const budget = { bytes: 0, rows: 0 };
  const districts = await fetchCleverCollection("districts", token, budget, fetcher);
  if (districts.length !== 1 || districts[0]?.id !== districtId) throw rosterError("CLEVER_DISTRICT_MISMATCH", "The token does not belong to the configured district.");
  const schools = await fetchCleverCollection("schools", token, budget, fetcher);
  const users = await fetchCleverCollection("users", token, budget, fetcher);
  const sections = await fetchCleverCollection("sections", token, budget, fetcher);
  const courses = await fetchCleverCollection("courses", token, budget, fetcher);
  const terms = await fetchCleverCollection("terms", token, budget, fetcher);
  for (const row of [...schools, ...users, ...sections, ...courses, ...terms]) if (row.district !== districtId) throw rosterError("CLEVER_DISTRICT_MISMATCH", "A Clever record belongs to another district.");
  const schoolsById = new Map(schools.map(row => [row.id, row])); const usersById = new Map(users.map(row => [row.id, row]));
  const coursesById = new Map(courses.map(row => [row.id, row])); const termsById = new Map(terms.map(row => [row.id, row]));
  const people: RosterPerson[] = users.map(row => {
    const student = row.roles?.student; const teacher = row.roles?.teacher;
    const roleNames: Array<"student" | "teacher"> = [...(student ? ["student" as const] : []), ...(teacher ? ["teacher" as const] : [])];
    const schoolIds: string[] = [...new Set<string>([...(student?.schools || []), ...(teacher?.schools || []), student?.school, teacher?.school].filter(Boolean))];
    if (schoolIds.some(id => !schoolsById.has(id))) throw rosterError("CLEVER_REFERENCE_INVALID", "A Clever user's school was not included in the complete response.");
    return { id: row.id, firstName: String(row.name?.first || "").trim(), lastName: String(row.name?.last || "").trim(), email: normalizedRosterEmail(row.email), studentNumber: student?.student_number ? String(student.student_number) : null, grade: normalizedRosterGrade(student?.grade), schoolIds, roles: roleNames };
  });
  const peopleById = new Map(people.map(row => [row.id, row]));
  const classes = sections.map(row => {
    if (!schoolsById.has(row.school) || !Array.isArray(row.students) || !Array.isArray(row.teachers)) throw rosterError("CLEVER_REFERENCE_INVALID", "A Clever section is missing its school or roster.");
    const primaryTeacherId = recordId(row.teacher); const teacherIds = [...new Set<string>([primaryTeacherId, ...row.teachers])];
    const studentIds = [...new Set<string>(row.students)];
    for (const id of teacherIds) if (!usersById.has(id) || !peopleById.get(id)?.roles.includes("teacher")) throw rosterError("CLEVER_REFERENCE_INVALID", "A section teacher was missing or did not have a teacher role.");
    for (const id of studentIds) if (!usersById.has(id) || !peopleById.get(id)?.roles.includes("student")) throw rosterError("CLEVER_REFERENCE_INVALID", "A section student was missing or did not have a student role.");
    if ((row.course && !coursesById.has(row.course)) || (row.term_id && !termsById.has(row.term_id))) throw rosterError("CLEVER_REFERENCE_INVALID", "A section course or term was missing from the complete response.");
    return { id: row.id, schoolId: row.school, name: String(row.name || "").trim(), grade: normalizedRosterGrade(row.grade), term: row.term_id ? String(termsById.get(row.term_id)?.name || "") || null : null, primaryTeacherId, coTeacherIds: teacherIds.filter(id => id !== primaryTeacherId), studentIds };
  });
  if (people.some(row => row.roles.length && (!row.firstName || !row.lastName)) || classes.some(row => !row.name)) throw rosterError("CLEVER_REQUIRED_FIELDS", "Clever returned missing required names. Review sharing before importing.");
  return { provider: "clever", version: "3.0", complete: true, organizations: schools.map(row => ({ id: row.id, name: String(row.name || row.id), type: "school" })), people, classes, warnings: [] };
}
