import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { releaseCommand, requireRelease, sha256 } from './frontend-bundle.mjs';

const owner = '135775632425';
const region = 'us-east-1';
const productionDistribution = 'E1TPPJOD7C2CXR';
const invalidationPattern = /^I[A-Z0-9]+$/;

function hasFrontendOrigin(distribution, bucket) {
  const origin = distribution.Origins?.Items?.find(
    ({ Id }) => Id === distribution.DefaultCacheBehavior?.TargetOriginId,
  );
  return origin && !origin.OriginPath && [
    bucket + '.s3.' + region + '.amazonaws.com', bucket + '.s3.amazonaws.com',
  ].includes(origin.DomainName);
}

function s3Error(error, operation) {
  const match = /An error occurred \(([^)]+)\) when calling the (\w+) operation/.exec(error.stderr ?? '');
  if (match?.[2] !== operation) return null;
  return match[1];
}

export async function createAwsFrontendStore(environment, scratch, command = releaseCommand) {
  requireRelease(environment === 'production' || environment === 'staging', 'Invalid frontend environment.');
  const bucket = 'schoolpilot-' + environment + '-frontend';
  const hostname = environment === 'production' ? 'school-pilot.net' : 'staging.school-pilot.net';
  const aws = async (args, timeout) => {
    const output = await command('aws', [
      ...args, '--region', region, '--no-cli-pager', '--output', 'json',
      '--cli-connect-timeout', '5', '--cli-read-timeout', '20',
    ], timeout);
    return output.trim() ? JSON.parse(output) : {};
  };
  let distributionId = productionDistribution;
  if (environment === 'staging') {
    const response = await aws(['cloudfront', 'list-distributions']);
    const matches = (response.DistributionList?.Items ?? []).filter((distribution) =>
      distribution.Id !== productionDistribution && distribution.Aliases?.Items?.includes(hostname) &&
      hasFrontendOrigin(distribution, bucket));
    requireRelease(matches.length === 1, 'Could not resolve a unique staging distribution for the staging bucket.');
    distributionId = matches[0].Id;
  }
  const site = { bucket, distributionId, region, owner, url: 'https://' + hostname };
  const s3 = (action, args = []) => aws([
    's3api', action, '--bucket', bucket, '--expected-bucket-owner', owner, ...args,
  ]);

  return {
    site,
    async checkTarget() {
      const [versioning, { Distribution: distribution }] = await Promise.all([
        s3('get-bucket-versioning'),
        aws(['cloudfront', 'get-distribution', '--id', distributionId]),
      ]);
      const config = distribution?.DistributionConfig;
      requireRelease(versioning.Status === 'Enabled', 'Frontend S3 bucket must have versioning enabled.');
      requireRelease(distribution?.Id === distributionId && distribution.Status === 'Deployed' &&
        distribution.ARN === 'arn:aws:cloudfront::' + owner + ':distribution/' + distributionId &&
        config?.Enabled && config.Aliases?.Items?.includes(hostname) && hasFrontendOrigin(config, bucket),
      'CloudFront frontend origin or hostname does not match the reviewed release target.');
    },
    async get(key, versionId) {
      const file = join(scratch, randomUUID() + '.object');
      try {
        const args = ['--key', key];
        if (versionId) args.push('--version-id', versionId);
        const object = await s3('get-object', [...args, file]);
        return {
          versionId: object.VersionId, etag: object.ETag, contentType: object.ContentType,
          cacheControl: object.CacheControl, metadata: object.Metadata ?? {}, body: await readFile(file),
        };
      } catch (error) {
        if (['NoSuchKey', 'NoSuchVersion', '404', 'NotFound'].includes(s3Error(error, 'GetObject'))) return null;
        throw error;
      } finally {
        await rm(file, { force: true });
      }
    },
    async put(key, { body, contentType, cacheControl, metadata, ifMatch, ifNoneMatch }) {
      const file = join(scratch, randomUUID() + '.object');
      const checksum = Buffer.from(sha256(body), 'hex').toString('base64');
      try {
        await writeFile(file, body, { flag: 'wx' });
        const args = ['--key', key, '--body', file, '--content-type', contentType, '--checksum-sha256', checksum];
        if (cacheControl) args.push('--cache-control', cacheControl);
        if (metadata) args.push('--metadata', JSON.stringify(metadata));
        if (ifMatch) args.push('--if-match', ifMatch);
        if (ifNoneMatch) args.push('--if-none-match', ifNoneMatch);
        const object = await s3('put-object', args);
        requireRelease(object.VersionId && object.VersionId !== 'null' && object.ETag &&
          object.ChecksumSHA256 === checksum, 'S3 did not acknowledge the exact frontend object version: ' + key);
        return { versionId: object.VersionId, etag: object.ETag };
      } catch (error) {
        const code = s3Error(error, 'PutObject');
        if (code === 'PreconditionFailed' || code === '412') error.status = 412;
        if (code === 'ConditionalRequestConflict' || code === '409') error.status = 409;
        throw error;
      } finally {
        await rm(file, { force: true });
      }
    },
    async deleteVersion(key, versionId) {
      await s3('delete-object', ['--key', key, '--version-id', versionId]);
    },
    async invalidate(paths, callerReference) {
      const result = await aws([
        'cloudfront', 'create-invalidation', '--distribution-id', distributionId, '--invalidation-batch',
        JSON.stringify({ Paths: { Quantity: paths.length, Items: paths }, CallerReference: callerReference }),
      ]);
      const id = result.Invalidation?.Id;
      requireRelease(invalidationPattern.test(id ?? ''), 'CloudFront returned no exact invalidation ID.');
      return id;
    },
    async waitInvalidation(id) {
      requireRelease(invalidationPattern.test(id ?? ''), 'Invalid frontend invalidation identity.');
      const args = ['--distribution-id', distributionId, '--id', id];
      await aws(['cloudfront', 'wait', 'invalidation-completed', ...args], 660_000);
      const { Invalidation: invalidation } = await aws(['cloudfront', 'get-invalidation', ...args]);
      requireRelease(invalidation?.Id === id && invalidation.Status === 'Completed',
        'The exact frontend invalidation did not complete.');
    },
  };
}
