#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(root, "tsconfig.tests.json");
const baselinePath = join(root, "tests", "typecheck-debt-baseline.json");

function loadProgram() {
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root, undefined, configPath);
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((diagnostic) => (
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
    )).join("\n"));
  }
  return ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
}

function displayDiagnostic(diagnostic) {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  if (!diagnostic.file || diagnostic.start === undefined) return `TS${diagnostic.code}: ${message}`;
  const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  const file = relative(root, diagnostic.file.fileName).replaceAll("\\", "/");
  return `${file}:${position.line + 1}:${position.character + 1} TS${diagnostic.code}: ${message}`;
}

function debtKey(diagnostic) {
  const file = relative(root, diagnostic.file.fileName).replaceAll("\\", "/");
  return `${file}#TS${diagnostic.code}`;
}

function summarize(diagnostics) {
  const byFileAndCode = {};
  for (const diagnostic of diagnostics) {
    const key = debtKey(diagnostic);
    byFileAndCode[key] = (byFileAndCode[key] || 0) + 1;
  }
  return {
    total: diagnostics.length,
    byFileAndCode: Object.fromEntries(Object.entries(byFileAndCode).sort(([a], [b]) => a.localeCompare(b))),
  };
}

const program = loadProgram();
const immediate = [
  ...program.getConfigFileParsingDiagnostics(),
  ...program.getOptionsDiagnostics(),
  ...program.getGlobalDiagnostics(),
  ...program.getSyntacticDiagnostics(),
];
if (immediate.length > 0) {
  process.stderr.write(`${immediate.map(displayDiagnostic).join("\n")}\n`);
  process.exit(1);
}

const semantic = program.getSemanticDiagnostics();
const sourceErrors = semantic.filter((diagnostic) => {
  if (!diagnostic.file) return true;
  const file = relative(root, diagnostic.file.fileName).replaceAll("\\", "/");
  return !file.startsWith("tests/");
});
if (sourceErrors.length > 0) {
  process.stderr.write(`Test typecheck found ${sourceErrors.length} non-test diagnostic(s):\n`);
  process.stderr.write(`${sourceErrors.map(displayDiagnostic).join("\n")}\n`);
  process.exit(1);
}

const testErrors = semantic.filter((diagnostic) => diagnostic.file && (
  relative(root, diagnostic.file.fileName).replaceAll("\\", "/").startsWith("tests/")
));
const current = summarize(testErrors);

if (process.argv.includes("--print-baseline")) {
  process.stdout.write(`${JSON.stringify(current, null, 2)}\n`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const regressions = [];
for (const [key, count] of Object.entries(current.byFileAndCode)) {
  const allowed = Number(baseline.byFileAndCode?.[key] || 0);
  if (count > allowed) regressions.push(`${key}: ${allowed} -> ${count}`);
}
if (current.total > Number(baseline.total)) {
  regressions.push(`total: ${baseline.total} -> ${current.total}`);
}
if (regressions.length > 0) {
  process.stderr.write("Test TypeScript debt increased:\n");
  process.stderr.write(`${regressions.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(
  `Test TypeScript no-emit ratchet OK: ${current.total}/${baseline.total} existing test-only diagnostics; ` +
  "syntax and application source remain zero-error.\n"
);
