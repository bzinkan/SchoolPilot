import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assertRenderedControllerDependencyClosure,
  importRenderedControllerDependency,
  RENDERED_CONTROLLER_DEPENDENCIES,
  RENDERED_CONTROLLER_DEPENDENCY_EVIDENCE,
} from '../scripts/load/run-classpilot-rendered-dashboards.mjs';

const loadRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/load');
const scratch = mkdtempSync(join(tmpdir(), 'classpilot-rendered-closure-'));
const names = Object.keys(RENDERED_CONTROLLER_DEPENDENCIES);
let nextCase = 0;

function freshClosure() {
  const directory = join(scratch, 'case-' + ++nextCase);
  mkdirSync(directory);
  for (const name of names) copyFileSync(join(loadRoot, name), join(directory, name));
  return directory;
}

after(() => {
  // Delete only the exact scratch tree created by this test. Any link targets
  // used below are also owned descendants of this same tree.
  const target = realpathSync(scratch);
  assert.equal(target, resolve(scratch));
  assert.equal(dirname(target), realpathSync(tmpdir()));
  assert.ok(basename(target).startsWith('classpilot-rendered-closure-'));
  rmSync(target, { recursive: true, force: true });
});

test('actual controller accepts exactly nineteen immutable LF dependencies', () => {
  const evidence = assertRenderedControllerDependencyClosure(freshClosure());
  assert.equal(names.length, 19);
  assert.equal(Object.isFrozen(RENDERED_CONTROLLER_DEPENDENCIES), true);
  assert.equal(Object.isFrozen(evidence), true);
  assert.equal(evidence.version, 1);
  assert.equal(evidence.files, 19);
  assert.match(evidence.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(evidence, RENDERED_CONTROLLER_DEPENDENCY_EVIDENCE);
});

for (const name of names) {
  test('actual closure rejects edited ' + name, () => {
    const file = join(freshClosure(), name);
    writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from('\n// changed dependency\n')]));
    assert.throws(() => assertRenderedControllerDependencyClosure(dirname(file)), /Exact rendered controller dependency closure required/);
  });

  test('actual closure rejects missing ' + name, () => {
    const directory = freshClosure();
    renameSync(join(directory, name), join(directory, name + '.saved'));
    assert.throws(() => assertRenderedControllerDependencyClosure(directory), /Exact rendered controller dependency closure required/);
  });

  test('actual closure rejects CRLF identity drift in ' + name, () => {
    const file = join(freshClosure(), name);
    const source = readFileSync(file, 'utf8');
    assert.ok(source.includes('\n') && !source.includes('\r'));
    writeFileSync(file, source.replace('\n', '\r\n'));
    assert.throws(() => assertRenderedControllerDependencyClosure(dirname(file)), /Exact rendered controller dependency closure required/);
  });
}

for (const kind of ['directory', 'empty', 'oversized']) {
  test('actual closure rejects non-bounded regular dependency: ' + kind, () => {
    const directory = freshClosure(), file = join(directory, names[0]);
    renameSync(file, file + '.saved');
    if (kind === 'directory') mkdirSync(file);
    else writeFileSync(file, kind === 'empty' ? '' : Buffer.alloc(2 * 1024 * 1024 + 1));
    assert.throws(() => assertRenderedControllerDependencyClosure(directory), /Exact rendered controller dependency closure required/);
  });
}

test('actual closure rejects a dependency symbolic link or Windows junction', () => {
  const directory = freshClosure(), file = join(directory, names[0]), saved = file + '.saved';
  renameSync(file, saved);
  try {
    symlinkSync(saved, file, 'file');
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
    const target = join(directory, 'owned-link-target');
    mkdirSync(target);
    symlinkSync(target, file, 'junction');
  }
  assert.equal(lstatSync(file).isSymbolicLink(), true);
  assert.throws(() => assertRenderedControllerDependencyClosure(directory), /Exact rendered controller dependency closure required/);
});

for (const name of ['undeclared.mjs', '../session-cookie.mjs', 'constructor']) {
  test('actual importer rejects undeclared dependency ' + name, async () => {
    await assert.rejects(importRenderedControllerDependency(name), /Undeclared rendered controller dependency/);
  });
}

test('actual CHILD controller rejects an edited helper before its side effect executes', () => {
  const directory = freshClosure();
  const controller = join(directory, 'run-classpilot-rendered-dashboards.mjs');
  const marker = join(directory, 'unexpected-helper-side-effect.json');
  copyFileSync(join(loadRoot, basename(controller)), controller);
  writeFileSync(join(directory, 'prepare-classpilot-load-test.mjs'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'unexpected');\n`);
  const runner = join(directory, 'import-actual-controller.mjs');
  writeFileSync(runner, `await import(${JSON.stringify(pathToFileURL(controller).href)});\n`);
  let failure;
  try {
    execFileSync(process.execPath, [runner], { timeout: 5000, stdio: 'pipe' });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, 'Actual altered controller import must fail');
  assert.equal(failure.status, 1);
  assert.equal(failure.signal, null, 'No parent watchdog kill may establish the denial');
  assert.match(failure.stderr.toString(), /Exact rendered controller dependency closure required/);
  assert.doesNotMatch(failure.stderr.toString(), /ERR_MODULE_NOT_FOUND|Cannot find package/);
  assert.equal(existsSync(marker), false, 'Changed helper was never evaluated');
});
