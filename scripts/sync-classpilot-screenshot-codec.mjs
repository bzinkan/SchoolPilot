#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exported = ['SCREENSHOT_DELTA_CODEC', 'MAX_SCREENSHOT_DELTA_BYTES', 'MAX_SCREENSHOT_DELTA_OPERATIONS', 'encodeScreenshotDelta', 'applyScreenshotDelta'];

export function generateScreenshotDeltaCopies(canonicalSource) {
  assert.equal(typeof canonicalSource, 'string');
  const normalized = canonicalSource.replaceAll('\r\n', '\n');
  const sourceSha256 = createHash('sha256').update(normalized).digest('hex');
  const emitted = ts.transpileModule(normalized, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, newLine: ts.NewLineKind.LineFeed,
  }, reportDiagnostics: true });
  assert.equal(emitted.diagnostics?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error).length ?? 0, 0);
  const banner = `// GENERATED from src/services/screenshotDeltaCodec.ts; do not edit.\n// Canonical SHA-256: ${sourceSha256}\n`;
  const frontendSource = banner + emitted.outputText;
  const browserBody = emitted.outputText.replace(/^export (?=(?:const|function) )/gm, '');
  assert.ok(!/^export /m.test(browserBody), 'Unhandled codec export');
  const extensionSource = banner + `(function attachClassPilotScreenshotDeltaCodec(root) {\n'use strict';\n${browserBody}\nroot.ClassPilotScreenshotDeltaCodec = Object.freeze({ ${exported.join(', ')} });\n})(globalThis);\n`;
  return { frontendSource, extensionSource, sourceSha256 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); let classpilotRoot;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--classpilot-root') { classpilotRoot = args[++index]; assert.ok(classpilotRoot, 'Missing ClassPilot root'); }
    else assert.ok(arg === '--check' || arg === '--frontend-only', `Unknown argument: ${arg}`);
  }
  assert.ok(classpilotRoot || args.includes('--frontend-only'), 'Pass --classpilot-root <explicit checkout> or --frontend-only; no sibling checkout is modified implicitly');
  assert.ok(!(classpilotRoot && args.includes('--frontend-only')), 'Choose an explicit ClassPilot root or frontend only');
  const generated = generateScreenshotDeltaCopies(readFileSync(join(repo, 'src/services/screenshotDeltaCodec.ts'), 'utf8'));
  const outputs = [[join(repo, 'schoolpilot-app/src/products/classpilot/lib/screenshotDeltaCodec.js'), generated.frontendSource]];
  if (classpilotRoot) {
    const target = resolve(classpilotRoot);
    assert.ok(existsSync(join(target, 'extension/manifest.json')), 'Explicit ClassPilot checkout requires its extension manifest');
    outputs.push([join(target, 'extension/screenshot-delta-codec.js'), generated.extensionSource]);
  }
  for (const [path, text] of outputs) {
    if (args.includes('--check')) assert.equal(readFileSync(path, 'utf8'), text, `Generated codec differs: ${path}`);
    else writeFileSync(path, text);
  }
  console.log(`Screenshot codec ${args.includes('--check') ? 'parity verified' : 'generated'}: ${outputs.length} copies; canonical ${generated.sourceSha256}`);
}
