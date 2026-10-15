import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/services/storage.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("storage.ts", source, ts.ScriptTarget.ES2022, true);
function declaration(name: string): string {
  const node = parsed.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  assert.ok(node, `missing production function ${name}`);
  return node.getText(parsed);
}
function javascript(text: string): string {
  return ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
}
const plainExports: { isClasspilotPlainOpenTab?: (type: string, payload: unknown) => boolean } = {};
new Function("exports", javascript(declaration("isClasspilotPlainOpenTab")))(plainExports);
assert.ok(plainExports.isClasspilotPlainOpenTab);

type Input = {
  command: { schoolId: string; teacherId: string; teachingSessionId: string | null; supervisionContextId: string | null;
    commandType: string; commandPayload: Record<string, unknown> };
  targets: Array<{ schoolId: string; studentId: string; teachingSessionId: string | null; supervisionContextId: string | null }>;
  options: { authority: { schoolId: string; actorId: string; teachingSessionId?: string; supervisionContextId?: string } };
};
type Trace = { kind: "entitlement" | "serialized" | "cohort"; school: string; transaction: object; ids?: string[]; locked?: boolean };

// Execute the actual production entry through its lock choice, then stop before
// any authority query. Real persistence/authority races live in the DB lane.
function creationPrefix(entitled = true) {
  const production = declaration("createClasspilotCommandWithTargets");
  const boundary = production.indexOf("      if (hasTeachingAuthority) {");
  assert.ok(boundary > 0);
  const prefix = production.slice(0, boundary) + "throw STOP;\n}\nthrow STOP;\n});\n} catch (error) { throw error; }\n}";
  const trace: Trace[] = [], transaction = {}, stop = Symbol("after student locks");
  const exports: { createClasspilotCommandWithTargets?: (command: Input["command"], targets: Input["targets"], options: Input["options"]) => Promise<unknown> } = {};
  new Function("exports", "db", "assertClasspilotEntitled", "lockClasspilotStudentControlAuthorities",
    "lockClasspilotStudentControlAuthorityCohort", "isClasspilotPlainOpenTab", "CLASSPILOT_DELIVERY_BATCH_SIZE", "STOP", javascript(prefix))(
    exports, { transaction: (work: (tx: object) => Promise<unknown>) => work(transaction) },
    async (school: string, tx: object, options: { lock: boolean }) => {
      trace.push({ kind: "entitlement", school, transaction: tx, locked: options.lock });
      if (!entitled) throw Object.assign(new Error("denied"), { code: "CLASSPILOT_NOT_ENTITLED" });
    },
    async (school: string, ids: string[], tx: object) => { trace.push({ kind: "serialized", school, ids: [...ids], transaction: tx }); },
    async (school: string, ids: string[], tx: object) => { trace.push({ kind: "cohort", school, ids: [...ids], transaction: tx }); },
    plainExports.isClasspilotPlainOpenTab, 40, stop,
  );
  assert.ok(exports.createClasspilotCommandWithTargets);
  return { run: exports.createClasspilotCommandWithTargets, trace, transaction, stop };
}

function input(count = 40): Input {
  const schoolId = "synthetic-school", actorId = "synthetic-teacher", teachingSessionId = "synthetic-session";
  return {
    command: { schoolId, teacherId: actorId, teachingSessionId, supervisionContextId: null, commandType: "open-tab", commandPayload: { url: "https://example.invalid/owned" } },
    targets: Array.from({ length: count }, (_, index) => ({ schoolId, studentId: `student-${count - index}`, teachingSessionId, supervisionContextId: null })),
    options: { authority: { schoolId, actorId, teachingSessionId } },
  };
}
async function choice(value: Input, expected: "serialized" | "cohort") {
  const actual = creationPrefix();
  await assert.rejects(actual.run(value.command, value.targets, value.options), error => error === actual.stop);
  assert.deepEqual(actual.trace.map(event => event.kind), ["entitlement", expected]);
  assert.equal(actual.trace[0]!.locked, true);
  assert.ok(actual.trace.every(event => event.transaction === actual.transaction && event.school === value.options.authority.schoolId));
  assert.deepEqual(actual.trace[1]!.ids, [...new Set(value.targets.map(target => target.studentId))]);
}

for (const count of [1, 25, 40]) test(`creation uses the existing owned cohort for ${count} canonical URL-only targets`, () => choice(input(count), "cohort"));
const fallbacks: Array<[string, (value: Input) => void]> = [
  ["41 targets", value => { value.targets = input(41).targets; }],
  ["empty targets", value => { value.targets = []; }],
  ["duplicate student", value => { value.targets[1]!.studentId = value.targets[0]!.studentId; }],
  ["whitespace student", value => { value.targets[0]!.studentId = " padded "; }],
  ["empty student", value => { value.targets[0]!.studentId = ""; }],
  ["foreign target school", value => { value.targets[0]!.schoolId = "foreign"; }],
  ["foreign target class", value => { value.targets[0]!.teachingSessionId = "foreign"; }],
  ["mixed target authority", value => { value.targets[0]!.supervisionContextId = "foreign"; }],
  ["rich open-tab", value => { value.command.commandPayload.focusAfterOpen = false; }],
  ["non-http URL", value => { value.command.commandPayload.url = "javascript:alert(1)"; }],
  ["other command", value => { value.command.commandType = "close-tabs"; }],
];
for (const [label, mutate] of fallbacks) test(`creation retains serialized fallback for ${label}`, async () => {
  const value = input(); mutate(value); await choice(value, "serialized");
});
test("the same canonical supervision scope may use cohort locks", async () => {
  const value = input(25), context = "synthetic-supervision";
  value.command.teachingSessionId = null; value.command.supervisionContextId = context;
  value.options.authority = { schoolId: value.command.schoolId, actorId: value.command.teacherId, supervisionContextId: context };
  for (const target of value.targets) { target.teachingSessionId = null; target.supervisionContextId = context; }
  await choice(value, "cohort");
});
test("a command/actor/parent mismatch fails before entitlement and student locks", async () => {
  const mutations: Array<(value: Input) => void> = [
    value => { value.command.schoolId = "foreign"; },
    value => { value.command.teacherId = "foreign"; },
    value => { value.command.teachingSessionId = "foreign"; },
    value => { value.options.authority.supervisionContextId = "second-parent"; },
  ];
  for (const mutate of mutations) {
    const value = input(), actual = creationPrefix(); mutate(value);
    await assert.rejects(actual.run(value.command, value.targets, value.options), { code: "COMMAND_TARGET_AUTHORITY_MISMATCH" });
    assert.deepEqual(actual.trace, []);
  }
});
test("entitlement refusal prevents both student-lock paths", async () => {
  const value = input(), actual = creationPrefix(false);
  await assert.rejects(actual.run(value.command, value.targets, value.options), { code: "CLASSPILOT_NOT_ENTITLED" });
  assert.deepEqual(actual.trace.map(event => event.kind), ["entitlement"]);
});
