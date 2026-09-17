import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

const TAG = `domain_resolution_${Date.now()}`;
const DOMAIN = `${TAG}.example.invalid`;

let db: any;
let pool: any;
let storage: any;
let runWithTenantContext: any;
const schoolIds: string[] = [];

function asSystem<T>(operation: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuper: true }, operation);
}

function inSchool<T>(schoolId: string, operation: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ schoolId }, operation);
}

async function createSchool(name: string): Promise<any> {
  const school = await storage.createSchool({
    name: `${TAG}_${name}`,
    domain: DOMAIN,
    slug: `${TAG}-${name}`.toLowerCase(),
  } as any);
  schoolIds.push(school.id);
  return school;
}

async function setCreatedAt(table: "schools" | "students", id: string, daysAgo: number): Promise<void> {
  await asSystem(() =>
    db.execute(
      table === "schools"
        ? sql`UPDATE schools SET created_at = now() - make_interval(days => ${daysAgo}) WHERE id = ${id}`
        : sql`UPDATE students SET created_at = now() - make_interval(days => ${daysAgo}) WHERE id = ${id}`
    )
  );
}

async function rosterStudent(schoolId: string, email: string, daysAgo: number): Promise<any> {
  const student: any = await inSchool(schoolId, () =>
    storage.createStudent({
      schoolId,
      firstName: "Shared",
      lastName: "Student",
      email,
    } as any)
  );
  await setCreatedAt("students", student.id, daysAgo);
  return student;
}

before(async () => {
  const dbModule = await import("../dist/db.js");
  db = dbModule.default;
  pool = dbModule.pool;
  storage = await import("../dist/services/storage.js");
  ({ runWithTenantContext } = await import("../dist/middleware/tenantContext.js"));
});

after(async () => {
  try {
    await asSystem(async () => {
      if (schoolIds.length > 0) {
        const list = sql.join(schoolIds.map((id) => sql`${id}`), sql`, `);
        await db.execute(sql`DELETE FROM students WHERE school_id IN (${list})`);
        await db.execute(sql`DELETE FROM settings WHERE school_id IN (${list})`);
        await db.execute(sql`DELETE FROM schools WHERE id IN (${list})`);
      }
    });
  } finally {
    await pool.end();
  }
});

describe("school resolution by student email domain", () => {
  let first: any;
  let deleted: any;
  let older: any;

  it("takes the fast path when one live school owns the domain", async () => {
    first = await createSchool("First");
    await setCreatedAt("schools", first.id, 5);
    const resolved = await storage.resolveSchoolForStudent(`anyone@${DOMAIN}`);
    assert.equal(resolved?.school.id, first.id);
    assert.equal(resolved?.isSharedDomain, false);
  });

  it("ignores a soft-deleted sibling so a deleted school holds no domain claim", async () => {
    deleted = await createSchool("Deleted");
    await asSystem(() => db.execute(sql`UPDATE schools SET deleted_at = now() WHERE id = ${deleted.id}`));
    const candidates = await storage.getSchoolsByDomain(DOMAIN);
    assert.deepEqual(candidates.map((school: any) => school.id), [first.id]);
    const resolved = await storage.resolveSchoolForStudent(`anyone@${DOMAIN}`);
    assert.equal(resolved?.school.id, first.id);
    assert.equal(resolved?.isSharedDomain, false);
  });

  it("orders live candidates by creation, oldest first", async () => {
    older = await createSchool("Older");
    await setCreatedAt("schools", older.id, 30);
    const candidates = await storage.getSchoolsByDomain(DOMAIN);
    assert.deepEqual(candidates.map((school: any) => school.id), [older.id, first.id]);
  });

  it("returns nothing for an un-rostered student on a shared domain", async () => {
    const resolved = await storage.resolveSchoolForStudent(`nobody@${DOMAIN}`);
    assert.equal(resolved, undefined);
  });

  it("resolves a student rostered in two live schools to the older roster row", async () => {
    const email = `shared@${DOMAIN}`;
    await rosterStudent(first.id, email, 1);
    await rosterStudent(older.id, email, 10);
    const resolved = await storage.resolveSchoolForStudent(email.toUpperCase());
    assert.equal(resolved?.school.id, older.id, "the oldest roster row wins, not the oldest school");
    assert.equal(resolved?.isSharedDomain, true);
  });

  it("keeps a suspended school in the candidate set so its students are never re-mapped", async () => {
    await asSystem(() => db.execute(sql`UPDATE schools SET status = 'suspended' WHERE id = ${older.id}`));
    const candidates = await storage.getSchoolsByDomain(DOMAIN);
    assert.deepEqual(candidates.map((school: any) => school.id), [older.id, first.id]);
    const email = `suspended-only@${DOMAIN}`;
    await rosterStudent(older.id, email, 2);
    const resolved = await storage.resolveSchoolForStudent(email);
    assert.equal(resolved?.school.id, older.id);
    assert.equal(resolved?.isSharedDomain, true);
  });
});
