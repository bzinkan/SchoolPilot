import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MYDESK_LEGACY_KEYS, MYDESK_MODE_KEYS, parseMyDeskModes, readMyDeskModes } from "../src/config/mydeskModes.js";
import { myDeskImportsEnabledForSchool } from "../src/services/mydeskImportsValidation.js";
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
test("global modes default off and preflight rejects legacy, malformed, and contradictory configuration", () => {
  assert.deepEqual(parseMyDeskModes({}), { mode: "off", seatingMode: "off", aiImportMode: "off" });
  assert.deepEqual(parseMyDeskModes({ MYDESK_MODE: "on", MYDESK_SEATING_MODE: "on", MYDESK_AI_IMPORT_MODE: "on" }),
    { mode: "on", seatingMode: "on", aiImportMode: "on" });
  for (const key of MYDESK_LEGACY_KEYS) for (const value of ["", "school-five", "*"]) {
    const env = { MYDESK_MODE: "on", [key]: value };
    assert.throws(() => parseMyDeskModes(env), { code: "MYDESK_CONFIGURATION" });
    assert.equal(readMyDeskModes(env).mode, "off");
  }
  for (const key of MYDESK_MODE_KEYS) for (const value of ["", "true", "false", "ON", " on", "off ", "*", "school-five"]) {
    assert.throws(() => parseMyDeskModes({ MYDESK_MODE: "on", [key]: value }), { code: "MYDESK_CONFIGURATION" });
  }
  for (const key of ["MYDESK_SEATING_MODE", "MYDESK_AI_IMPORT_MODE"]) {
    assert.throws(() => parseMyDeskModes({ [key]: "on" }), { code: "MYDESK_CONFIGURATION" });
    assert.deepEqual(readMyDeskModes({ MYDESK_MODE: "off", [key]: "on" }), { mode: "off", seatingMode: "off", aiImportMode: "off" });
  }
});
test("enabled modes cover existing and newly entitled schools without any school configuration", () => {
  const keys = [...MYDESK_MODE_KEYS, ...MYDESK_LEGACY_KEYS];
  const original = keys.map(key => process.env[key]);
  try {
    keys.forEach(key => delete process.env[key]);
    process.env.MYDESK_MODE = "on";
    process.env.MYDESK_AI_IMPORT_MODE = "on";
    for (const schoolId of ["school-five", randomUUID()]) {
      assert.equal(myDeskEnabledForSchool(schoolId), true);
      assert.equal(myDeskImportsEnabledForSchool(schoolId), true);
    }
    assert.equal(myDeskEnabledForSchool(""), false);
    assert.equal(myDeskImportsEnabledForSchool(""), false);
    process.env.MYDESK_AI_IMPORT_MODE = "off";
    assert.equal(myDeskEnabledForSchool("school-five"), true);
    assert.equal(myDeskImportsEnabledForSchool("school-five"), false);
  } finally { keys.forEach((key, i) => { if (original[i] === undefined) delete process.env[key]; else process.env[key] = original[i]; }); }
});
