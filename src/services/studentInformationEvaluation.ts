/** Deterministic evaluation scoring, intentionally separate from provider calls. */
export type ContactEvaluationRow = {
  studentId: string;
  name: string;
  phones: string[];
  emails: string[];
  adultAssociation: string;
};
export function scoreStudentInformationEvaluation(
  expected: ContactEvaluationRow[],
  actual: ContactEvaluationRow[],
  events: {
    unreviewedWrites: number;
    instructionExecutions: number;
    omissions?: number;
  },
) {
  const byId = new Map(actual.map((row) => [row.studentId, row]));
  let typedExact = 0,
    wrongStudent = 0,
    wrongAdult = 0,
    omissions = events.omissions ?? 0;
  for (const row of expected) {
    const found = byId.get(row.studentId);
    if (!found) {
      omissions++;
      continue;
    }
    if (found.name !== row.name) wrongStudent++;
    if (found.adultAssociation !== row.adultAssociation) wrongAdult++;
    if (
      JSON.stringify(found.phones) === JSON.stringify(row.phones) &&
      JSON.stringify(found.emails) === JSON.stringify(row.emails)
    )
      typedExact++;
  }
  wrongStudent += actual.filter(
    (row) => !expected.some((e) => e.studentId === row.studentId),
  ).length;
  wrongStudent += actual.length - byId.size;
  const exactRate = expected.length ? typedExact / expected.length : 0;
  return {
    profiles: expected.length,
    exactRate,
    wrongStudent,
    wrongAdult,
    ...events,
    omissions,
    passed:
      expected.length >= 100 &&
      exactRate >= 0.99 &&
      wrongStudent === 0 &&
      wrongAdult === 0 &&
      omissions === 0 &&
      events.unreviewedWrites === 0 &&
      events.instructionExecutions === 0,
  };
}

export type StudentInformationEvaluationFixture = {
  id: string;
  contentType: string;
  bytes: Buffer;
  expected: ContactEvaluationRow[];
};

/** The caller must explicitly provide an evaluator; this never instantiates a provider. */
export async function evaluateStudentInformationDocuments(
  fixtures: StudentInformationEvaluationFixture[],
  readSelectedSource: (
    source: Pick<
      StudentInformationEvaluationFixture,
      "id" | "contentType" | "bytes"
    >,
  ) => Promise<ContactEvaluationRow[]>,
  events: {
    unreviewedWrites: number;
    instructionExecutions: number;
    omissions?: number;
  },
) {
  const actual: ContactEvaluationRow[] = [];
  for (const fixture of fixtures) {
    actual.push(
      ...(await readSelectedSource({
        id: fixture.id,
        contentType: fixture.contentType,
        bytes: fixture.bytes,
      })),
    );
  }
  return scoreStudentInformationEvaluation(
    fixtures.flatMap((fixture) => fixture.expected),
    actual,
    events,
  );
}
