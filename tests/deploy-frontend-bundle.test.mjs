import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const bundleModule = new URL('../scripts/release/frontend-bundle.mjs', import.meta.url);
const identity = { repository: 'bzinkan/SchoolPilot', sourceSha: 'a'.repeat(40), runId: '731', attempt: 2 };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'schoolpilot web bundle '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dist = join(root, 'dist');
  await mkdir(join(dist, 'assets'), { recursive: true });
  await writeFile(join(dist, 'index.html'), '<script type="module" src="/assets/app.js"></script>');
  await writeFile(join(dist, 'assets', 'app.js'), 'hello');
  return { dist, artifact: join(root, 'artifact') };
}

test('the packaged artifact contains the verified standard build and exact CI identity', async (t) => {
  const { dist, artifact } = await fixture(t);
  const { packFrontendBundle, readFrontendBundle } = await import(bundleModule);
  await packFrontendBundle(dist, artifact, identity);
  await writeFile(join(dist, 'assets', 'app.js'), 'later product build');

  const bundle = await readFrontendBundle(artifact, identity);
  assert.equal(bundle.manifestSchema, 1);
  assert.equal(bundle.sourceSha, identity.sourceSha);
  assert.equal(bundle.runId, '731');
  assert.equal(bundle.attempt, 2);
  const script = bundle.files.find((file) => file.path === 'assets/app.js');
  assert.equal(script.body.toString(), 'hello');
  assert.equal(script.sha256, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
});

test('rejects a changed file, extra file, or mismatched build identity', async (t) => {
  const { dist, artifact } = await fixture(t);
  const { packFrontendBundle, readFrontendBundle } = await import(bundleModule);
  await packFrontendBundle(dist, artifact, identity);
  await assert.rejects(readFrontendBundle(artifact, { ...identity, attempt: 3 }), /identity/i);
  await writeFile(join(artifact, 'dist', 'extra.js'), 'unexpected');
  await assert.rejects(readFrontendBundle(artifact, identity), /inventory/i);
  await rm(join(artifact, 'dist', 'extra.js'));
  await writeFile(join(artifact, 'dist', 'assets', 'app.js'), 'other');
  await assert.rejects(readFrontendBundle(artifact, identity), /checksum/i);
});

test('uses the successful frontend attempt when a rerun only ran failed jobs', async () => {
  const { resolveFrontendArtifact } = await import(bundleModule);
  const replies = [
    { expect: ['run', 'list'], value: [{ databaseId: 731, status: 'completed', conclusion: 'success' }] },
    { expect: ['api', 'repos/bzinkan/SchoolPilot/actions/runs/731'], value: {
      id: 731, run_attempt: 3, head_sha: identity.sourceSha, path: '.github/workflows/ci-build.yml',
      head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success',
      head_repository: { full_name: identity.repository },
    } },
    { expect: ['api', 'repos/bzinkan/SchoolPilot/actions/runs/731/attempts/3/jobs?per_page=100'], value: [{ jobs: [] }] },
    { expect: ['api', 'repos/bzinkan/SchoolPilot/actions/runs/731/attempts/2/jobs?per_page=100'], value: [{ jobs: [
      { name: 'Frontend (Vite Build)', status: 'completed', conclusion: 'success', head_sha: identity.sourceSha },
    ] }] },
  ];
  const artifact = await resolveFrontendArtifact(identity.sourceSha, async (args) => {
    const reply = replies.shift();
    assert.deepEqual(args.slice(0, 2), reply.expect);
    return reply.value;
  });
  assert.deepEqual(artifact, { ...identity, name: 'schoolpilot-web-' + identity.sourceSha + '-2' });
  assert.equal(replies.length, 0);
});
