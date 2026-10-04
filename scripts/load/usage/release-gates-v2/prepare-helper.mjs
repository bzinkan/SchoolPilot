import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { hash } from './contracts.mjs';
import { patchGeneratorV2, patchProcessV2, patchDrainV2 } from './patch.mjs';
const directory = fileURLToPath(new URL('.', import.meta.url));
const repo = resolve(directory, '../../../..');
const git = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 ** 2 }).trim();
const write = (path, value) => writeFileSync(path, value, { flag: 'wx' });
export function prepareHelper(options) {
  assert.match(options.applicationSource, /^[a-f0-9]{40}$/); assert.match(options.applicationImage, /(?:^sha256:|@sha256:)[a-f0-9]{64}$/);
  assert.match(options.imageBindingSha256, /^[a-f0-9]{64}$/);
  const imageBindingBytes = readFileSync(options.imageBindingFile); assert.equal(hash(imageBindingBytes), options.imageBindingSha256);
  const imageBinding = JSON.parse(imageBindingBytes);
  assert.equal(imageBinding.source, options.applicationSource); assert.equal(imageBinding.image, options.applicationImage);
  assert.equal(imageBinding.verified, true, 'Application image needs independently captured source/digest proof');
  const context = resolve(options.contextDirectory), rel = relative(repo, context);
  assert.ok(isAbsolute(rel) || rel === '..' || rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')), 'Helper context must be outside the checkout');
  assert.equal(existsSync(context), false); mkdirSync(context, { recursive: true });
  const harnessSource = git(['rev-parse', 'HEAD']); assert.equal(git(['status', '--porcelain']), '', 'Commit the harness before creating its exact binding');
  const tracked = git(['ls-files', 'scripts/load/usage']).split('\n').filter(Boolean), overlay = join(context, 'overlay/scripts/load/usage'); mkdirSync(overlay, { recursive: true });
  const files = {};
  for (const path of tracked) {
    const target = join(context, 'overlay', path); mkdirSync(resolve(target, '..'), { recursive: true });
    const bytes = readFileSync(join(repo, path)); write(target, bytes); files[path] = hash(bytes);
  }
  // Overwrites happen only inside this new independently bound build context.
  for (const [name, transform] of [['release-enabled-generator.mjs', patchGeneratorV2], ['release-enabled-process.mjs', patchProcessV2], ['release-enabled-drain.mjs', patchDrainV2]]) {
    const path = join(overlay, name); writeFileSync(path, transform(readFileSync(path, 'utf8')));
  }
  const executed = {};
  function walk(path, prefix = '') { for (const name of readdirSync(path, { withFileTypes: true })) { if (name.isDirectory()) walk(join(path, name.name), prefix + name.name + '/'); else executed[prefix + name.name] = hash(readFileSync(join(path, name.name))); } }
  walk(join(context, 'overlay'));
  const verifier = readFileSync(join(repo, 'scripts/load/usage/roles/verify-runtime.mjs')); write(join(context, 'verify-runtime.mjs'), verifier);
  const dockerfile = `ARG APPLICATION_IMAGE\nFROM \${APPLICATION_IMAGE}\nUSER root\nCOPY verify-runtime.mjs /prototype-tools/verify-runtime.mjs\nRUN node /prototype-tools/verify-runtime.mjs capture /prototype-tools/base-runtime.json\nCOPY --chown=node:node overlay/ /diagnostic/\nRUN ln -s /app/dist /diagnostic/dist && ln -s /app/node_modules /diagnostic/node_modules && ln -s /app/package.json /diagnostic/package.json && ln -s /diagnostic/scripts/load/usage/release-gates-v2 /harness\nRUN node /prototype-tools/verify-runtime.mjs assert-before-source /prototype-tools/base-runtime.json\nUSER node\nWORKDIR /app\nHEALTHCHECK NONE\nENTRYPOINT ["node"]\n`;
  write(join(context, 'Dockerfile'), dockerfile);
  write(join(context, '.dockerignore'), '*\n!Dockerfile\n!verify-runtime.mjs\n!overlay/**\n');
  const preparation = { schemaVersion: 2, applicationSource: options.applicationSource, applicationImage: options.applicationImage,
    imageBindingSha256: options.imageBindingSha256, harnessSource, canonicalFiles: files, executedFiles: executed,
    contractKind: 'release297-new-v2-only', originalContractUnchanged: true, context, capacityAccepted: false };
  write(join(context, 'preparation.json'), JSON.stringify(preparation, null, 2) + '\n'); return preparation;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { const result = prepareHelper(JSON.parse(readFileSync(process.argv[2], 'utf8'))); process.stdout.write(JSON.stringify({ context: result.context, applicationSource: result.applicationSource, preparationSha256: hash(readFileSync(join(result.context, 'preparation.json'))) }) + '\n'); }
  catch { process.stderr.write('V2_HELPER_PREPARATION_FAILED\n'); process.exitCode = 1; }
}
