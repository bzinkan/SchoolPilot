import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { downloadFrontendBundle, readFrontendBundle, requireRelease } from './frontend-bundle.mjs';
import { createAwsFrontendStore } from './frontend-aws.mjs';
import { planFrontend, publishFrontend, rollbackFrontend } from './frontend-release.mjs';

const prefix = 'schoolpilot-frontend-';

async function newScratch() {
  return mkdtemp(join(await realpath(tmpdir()), prefix));
}

async function ownedScratch(path) {
  requireRelease(typeof path === 'string' && path, 'Missing frontend temporary directory.');
  const directory = resolve(path);
  requireRelease(dirname(directory) === await realpath(tmpdir()) &&
    new RegExp('^' + prefix + '[a-zA-Z0-9]{6}$').test(basename(directory)) &&
    (await lstat(directory)).isDirectory() && await realpath(directory) === directory,
  'Invalid frontend temporary directory.');
  return directory;
}

async function main([operation, ...args]) {
  if (operation === 'prepare') {
    const [sourceSha] = args;
    const scratch = await newScratch();
    try {
      const manifestSha256 = await downloadFrontendBundle(sourceSha, join(scratch, 'artifact'));
      await writeFile(join(scratch, 'binding.json'), JSON.stringify({ sourceSha, manifestSha256 }), { flag: 'wx' });
      console.log(scratch);
    } catch (error) {
      await rm(scratch, { recursive: true, force: true });
      throw error;
    }
    return;
  }

  if (operation === 'discard') {
    await rm(await ownedScratch(args[0]), { recursive: true, force: true });
    return;
  }

  if (operation === 'rollback') {
    const [environment, receipt] = args;
    requireRelease(receipt && args.length === 2, 'Frontend rollback requires a release receipt.');
    const scratch = await newScratch();
    try {
      console.log(JSON.stringify(await rollbackFrontend(await createAwsFrontendStore(environment, scratch), receipt), null, 2));
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
    return;
  }

  requireRelease(operation === 'plan' || operation === 'publish', 'Invalid frontend release operation.');
  const [environment, path, sourceSha] = args;
  const scratch = await ownedScratch(path);
  const binding = JSON.parse(await readFile(join(scratch, 'binding.json'), 'utf8'));
  const bundle = await readFrontendBundle(join(scratch, 'artifact'), { sourceSha });
  requireRelease(binding.sourceSha === sourceSha && binding.manifestSha256 === bundle.manifestSha256,
    'The prepared frontend artifact changed.');
  const store = await createAwsFrontendStore(environment, scratch);
  const planPath = join(scratch, 'plan.json');
  if (operation === 'plan') {
    const plan = await planFrontend(store, bundle);
    await writeFile(planPath, JSON.stringify(plan), { flag: 'wx' });
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  requireRelease(plan.sourceSha === sourceSha && plan.manifestSha256 === bundle.manifestSha256 &&
    Object.entries(store.site).every(([key, value]) => plan.site?.[key] === value),
  'The frontend preflight does not match the bundle and release target.');
  const result = await publishFrontend(store, bundle, resolve('soc2-evidence', 'frontend-releases'),
    plan.rollback?.index?.versionId);
  console.log(JSON.stringify(result, null, 2));
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error('Frontend release failed: ' + error.message);
  process.exitCode = 1;
}
