import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { rehearsalBuildSteps } from '../scripts/release/rehearsal-build-steps.mjs';

test('candidate build uses only the compiler with no alias configuration', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const tsconfig = JSON.parse(readFileSync(new URL('../tsconfig.json', import.meta.url), 'utf8'));
  assert.equal(manifest.scripts.build, 'tsc');
  assert.equal(manifest.devDependencies['tsc-alias'], undefined);
  assert.equal(tsconfig.compilerOptions.paths, undefined);
  assert.equal(tsconfig.compilerOptions.baseUrl, undefined);
  assert.equal(tsconfig['tsc-alias'], undefined);
  assert.deepEqual(rehearsalBuildSteps(manifest), [
    { name: 'typescript', entrypoint: 'node_modules/typescript/bin/tsc' },
  ]);
});

test('historical baseline and rollback retain the declared alias transform after TypeScript', () => {
  assert.deepEqual(rehearsalBuildSteps({ scripts: { build: 'tsc && tsc-alias' } }), [
    { name: 'typescript', entrypoint: 'node_modules/typescript/bin/tsc' },
    { name: 'aliases', entrypoint: 'node_modules/tsc-alias/dist/bin/index.js' },
  ]);
});

test('unknown, missing and extra build commands fail instead of silently losing transforms', () => {
  for (const build of [undefined, null, '', 'tsc && custom-transform', 'tsc; tsc-alias', 'tsc && tsc-alias && custom-transform']) {
    assert.throws(() => rehearsalBuildSteps({ scripts: { build } }), /Unsupported rehearsal build command/);
  }
  assert.throws(() => rehearsalBuildSteps({}), /Unsupported rehearsal build command/);
});

test('rehearsal compiles each verified checkout using its own declared build', () => {
  const source = readFileSync(new URL('../scripts/release/rehearse-local-upgrade.mjs', import.meta.url), 'utf8');
  assert.match(source, /readFile\(path\.join\(cwd, 'package\.json'\)/);
  assert.match(source, /for \(const step of rehearsalBuildSteps\(manifest\)\)/);
  assert.match(source, /command\(process\.execPath, \[step\.entrypoint\], \{ cwd, env, log:/);
  for (const [target, prefix] of [['baseline', 'baseline'], ['root', 'candidate'], ['rollback', 'rollback']]) {
    assert.ok(source.includes(`await compileTarget(${target}, env, '${prefix}')`));
  }
  assert.doesNotMatch(source, /node_modules\/tsc-alias/);
});
