import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { disciplineSubmitInput, disciplineCorrectInput, disciplineWithdrawInput, disciplineSearchInput, disciplineAccessInput } from "../src/services/schoolDisciplineValidation.js";
const submit = () => ({ clientRequestId: randomUUID(), noteId: randomUUID(), noteRevision: 1, attachmentIds: [] as string[] });
const correction = () => ({ clientRequestId: randomUUID(), revision: 1, reason: "Corrected date", groupId: randomUUID(), studentId: randomUUID(),
  category: "referral", title: "", body: "Observed action", entryDate: "2026-09-26", attachmentIds: [] });
test("submission rejects ownership/visibility/labels and bounds selected evidence", () => {
  for (const field of ["schoolId", "authorId", "visibility", "studentName", "body"]) assert.equal(disciplineSubmitInput.safeParse({ ...submit(), [field]: "untrusted" }).success, false);
  const id = randomUUID(); assert.equal(disciplineSubmitInput.safeParse({ ...submit(), attachmentIds: [id,id] }).success, false);
  assert.equal(disciplineSubmitInput.safeParse({ ...submit(), attachmentIds: Array.from({length:6},()=>randomUUID()) }).success, false);
  assert.equal(disciplineSubmitInput.safeParse(submit()).success, true);
});
test("correction and withdrawal require an explicit reason and exact revisions", () => {
  assert.equal(disciplineCorrectInput.safeParse(correction()).success, true);
  assert.equal(disciplineCorrectInput.safeParse({ ...correction(), reason:" " }).success, false);
  assert.equal(disciplineCorrectInput.safeParse({ ...correction(), entryDate:"2026-02-30" }).success, false);
  assert.equal(disciplineCorrectInput.safeParse({ ...correction(), sourceNoteId:randomUUID() }).success, false);
  assert.equal(disciplineWithdrawInput.safeParse({clientRequestId:randomUUID(),revision:1,reason:" "}).success,false);
});
test("school searches cannot discover private note links or unbounded pages", () => {
  assert.equal(disciplineSearchInput.safeParse({scope:"school",sourceNoteId:randomUUID()}).success,false);
  assert.equal(disciplineSearchInput.safeParse({scope:"own",sourceNoteId:randomUUID()}).success,true);
  assert.equal(disciplineSearchInput.safeParse({scope:"school",studentName:"Jones",submitterName:"Smith"}).success,true);
  assert.equal(disciplineSearchInput.safeParse({limit:101}).success,false);
  assert.equal(disciplineSearchInput.safeParse({from:"2026-09-26",to:"2026-09-25"}).success,false);
});
test("permission input cannot add editing powers or choose another school", () => {
  const input={clientRequestId:randomUUID(),revision:0,enabled:true};
  assert.equal(disciplineAccessInput.safeParse(input).success,true);
  assert.equal(disciplineAccessInput.safeParse({...input,canEdit:true}).success,false);
  assert.equal(disciplineAccessInput.safeParse({...input,schoolId:randomUUID()}).success,false);
});
