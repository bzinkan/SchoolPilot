import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createMyDeskNoteInput, myDeskCsvCell, myDeskDate, myDeskEnabledForSchool, myDeskNotesQuery, updateMyDeskNoteInput } from "../src/services/mydeskValidation.js";

test("notebook rejects authority injection, invalid dates and unbounded inputs", () => {
  assert.equal(createMyDeskNoteInput.safeParse({ clientRequestId: randomUUID(), authorId: randomUUID() }).success, false);
  for (const value of ["2026-02-30", "2026-13-01", "2026-00-01", "0000-01-01", "September 1"]) assert.equal(myDeskDate.safeParse(value).success, false);
  assert.equal(myDeskDate.parse("2024-02-29"), "2024-02-29");
  assert.equal(updateMyDeskNoteInput.safeParse({ body: "changed" }).success, false);
  assert.equal(updateMyDeskNoteInput.safeParse({ revision: 1 }).success, false);
  assert.equal(createMyDeskNoteInput.safeParse({ clientRequestId: randomUUID(), body: "x".repeat(5001) }).success, false);
  assert.equal(myDeskNotesQuery.safeParse({ scope: "class" }).success, false);
  assert.equal(myDeskNotesQuery.safeParse({ from: "2026-09-03", to: "2026-09-02" }).success, false);
  assert.equal(myDeskNotesQuery.safeParse({ limit: 101 }).success, false);
});
test("notebook CSV neutralizes formula cells including whitespace prefixes", () => {
  for (const value of ["=HYPERLINK(\"https://example.test\")", "+cmd", "-2+3", "@SUM(A1)", "   =1+1", "\tvalue", "\nvalue"]) {
    assert.ok(myDeskCsvCell(value).startsWith('"\''));
  }
  assert.equal(myDeskCsvCell('A, "quoted" note'), '"A, ""quoted"" note"');
});
test("school rollout fails closed on malformed lists and production wildcard", () => {
  const original = { list: process.env.MYDESK_ENABLED_SCHOOL_IDS, node: process.env.NODE_ENV, app: process.env.APP_ENV };
  try {
    process.env.MYDESK_ENABLED_SCHOOL_IDS = "school-one, school-two";
    assert.equal(myDeskEnabledForSchool("school-one"), true);
    assert.equal(myDeskEnabledForSchool("other"), false);
    process.env.MYDESK_ENABLED_SCHOOL_IDS = "school-one,,school-two";
    assert.equal(myDeskEnabledForSchool("school-one"), false);
    process.env.MYDESK_ENABLED_SCHOOL_IDS = "*"; process.env.NODE_ENV = "production";
    assert.equal(myDeskEnabledForSchool("school-one"), false);
    process.env.NODE_ENV = "test"; process.env.APP_ENV = "test";
    assert.equal(myDeskEnabledForSchool("school-one"), true);
  } finally {
    for (const [key, value] of [["MYDESK_ENABLED_SCHOOL_IDS", original.list], ["NODE_ENV", original.node], ["APP_ENV", original.app]]) {
      if (key) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  }
});
