import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scoreStudentInformationEvaluation,
  evaluateStudentInformationDocuments,
  type ContactEvaluationRow,
} from "../src/services/studentInformationEvaluation.js";
import { buildStudentInformationEvaluationFixtures } from "./helpers/studentInformationEvaluationFixtures.js";
import { parseInformationOffice } from "../src/services/studentInformationOffice.js";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
const fixture: ContactEvaluationRow[] = Array.from({ length: 100 }, (_, n) => ({
  studentId: `synthetic-${n}`,
  name: `Synthetic Child ${n}`,
  phones: [`00${String(n).padStart(8, "0")}`],
  emails: [`guardian.${n}@example.invalid`],
  adultAssociation: `Synthetic Guardian ${n}`,
}));
test("100-profile synthetic release scorer requires exact identifiers and rejects all unsafe outcomes", () => {
  const events = { unreviewedWrites: 0, instructionExecutions: 0 };
  assert.equal(
    scoreStudentInformationEvaluation(fixture, structuredClone(fixture), events)
      .passed,
    true,
  );
  const missing = fixture.slice(1);
  assert.equal(
    scoreStudentInformationEvaluation(fixture, missing, events).passed,
    false,
  );
  const wrong = structuredClone(fixture);
  wrong[0]!.adultAssociation = wrong[1]!.adultAssociation;
  assert.equal(
    scoreStudentInformationEvaluation(fixture, wrong, events).passed,
    false,
  );
  assert.equal(
    scoreStudentInformationEvaluation(fixture, fixture, {
      ...events,
      instructionExecutions: 1,
    }).passed,
    false,
  );
  assert.equal(
    scoreStudentInformationEvaluation(fixture, fixture, {
      ...events,
      unreviewedWrites: 1,
    }).passed,
    false,
  );
  const one = structuredClone(fixture);
  one[0]!.phones = ["123"];
  assert.equal(
    scoreStudentInformationEvaluation(fixture, one, events).passed,
    true,
  );
  one[1]!.emails = ["wrong@example.invalid"];
  assert.equal(
    scoreStudentInformationEvaluation(fixture, one, events).passed,
    false,
  );
});
test("100 invented profiles span actual supported formats and the evaluation runner excludes answer keys from source input", async () => {
  const fixtures = await buildStudentInformationEvaluationFixtures();
  assert.equal(fixtures.flatMap((f) => f.expected).length, 100);
  assert.equal(new Set(fixtures.map((f) => f.contentType)).size, 7);
  for (const fixture of fixtures) {
    assert.ok(
      fixture.bytes.length > 0 && fixture.bytes.length < 10 * 1024 * 1024,
    );
    if (fixture.contentType === "application/pdf")
      assert.equal((await PDFDocument.load(fixture.bytes)).getPageCount(), 1);
    else if (fixture.contentType.startsWith("image/"))
      assert.equal((await sharp(fixture.bytes).metadata()).width, 1400);
    else {
      const source = await parseInformationOffice(
        fixture.bytes,
        fixture.contentType,
      );
      for (const expected of fixture.expected)
        assert.ok(
          source.sections.some((section) =>
            section.text.includes(expected.phones[0]!),
          ),
        );
    }
  }
  // This tests the harness and fixture transport, not real-provider accuracy.
  const score = await evaluateStudentInformationDocuments(
    fixtures,
    async (source) => {
      assert.deepEqual(Object.keys(source).sort(), [
        "bytes",
        "contentType",
        "id",
      ]);
      return structuredClone(
        fixtures.find((f) => f.id === source.id)!.expected,
      );
    },
    { unreviewedWrites: 0, instructionExecutions: 0 },
  );
  assert.equal(score.passed, true);
  assert.equal(
    scoreStudentInformationEvaluation(fixture, [...fixture, fixture[0]!], {
      unreviewedWrites: 0,
      instructionExecutions: 0,
    }).passed,
    false,
  );
});
