import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const awsModule = new URL('../scripts/release/frontend-aws.mjs', import.meta.url);
const owner = '135775632425';

test('production writes carry S3 checksum, version condition, and expected bucket owner', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'frontend aws boundary '));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const { createAwsFrontendStore } = await import(awsModule);
  const store = await createAwsFrontendStore('production', scratch, async (tool, args) => {
    assert.equal(tool, 'aws');
    assert.deepEqual(args.slice(0, 2), ['s3api', 'put-object']);
    const option = (name) => args[args.indexOf(name) + 1];
    assert.equal(option('--expected-bucket-owner'), owner);
    assert.equal(option('--bucket'), 'schoolpilot-production-frontend');
    assert.equal(option('--key'), 'index.html');
    assert.equal(option('--if-match'), '"prior-etag"');
    assert.equal(option('--checksum-sha256'), 'LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=');
    assert.equal(await readFile(option('--body'), 'utf8'), 'hello');
    return JSON.stringify({
      VersionId: 'index-v2', ETag: '"v2"', ChecksumSHA256: option('--checksum-sha256'),
    });
  });

  const result = await store.put('index.html', {
    body: Buffer.from('hello'), contentType: 'text/html', ifMatch: '"prior-etag"',
  });
  assert.equal(result.versionId, 'index-v2');
});

test('staging refuses a distribution whose default origin is the production bucket', async () => {
  const { createAwsFrontendStore } = await import(awsModule);
  await assert.rejects(createAwsFrontendStore('staging', tmpdir(), async () => JSON.stringify({
    DistributionList: {
      Items: [
        {
          Id: 'E1TPPJOD7C2CXR', Aliases: { Items: ['staging.school-pilot.net'] },
          DefaultCacheBehavior: { TargetOriginId: 'web' },
          Origins: { Items: [{ Id: 'web', DomainName: 'schoolpilot-production-frontend.s3.us-east-1.amazonaws.com' }] },
        },
      ],
    },
  })), /unique staging distribution/i);
});
