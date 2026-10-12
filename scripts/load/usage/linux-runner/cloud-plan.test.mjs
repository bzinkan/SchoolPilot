import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AMI, cost, validatePlan, launchRequest, instancePolicy, operatorPolicy, assertOwnedResource, tags, launchDocument } from './cloud-plan.mjs';
const now = Date.now();
const hash = 'a'.repeat(64);
const bytes = Buffer.from('nonsecret reviewed gzip bootstrap');
function plan() { return { schemaVersion: 1, kind: 'usage_linux_cloud_plan', preparationStage: 'bootstrap_ready', runId: 'usage-linux-test-20261012', accountId: '123456789012', region: 'us-east-1', availabilityZone: 'us-east-1a', instanceType: 'm7i.4xlarge', ami: AMI, activeHours: 8, holdDays: 7, exportGiB: 20, spendCapUsd: 15, instanceCount: 1, productionUsage: 'off/off', acceptanceContract: 'unchanged', rootGiB: 30, dataGiB: 200, userDataSha256: createHash('sha256').update(bytes).digest('hex'), bootstrapSha256: hash, implementationSha256: hash, independentReviewSha256: hash, authorizationSha256: hash, priceEvidenceSha256: hash, sessionReceiptSha256: hash, custodyCanarySha256: hash, toolBindingsSha256: hash, operatorAccessSha256: hash, launchNotBeforeUtc: new Date(now - 1000).toISOString(), stopDeadlineUtc: new Date(now - 1000 + 8 * 3600000).toISOString(), pricesCapturedUtc: new Date(now).toISOString(), measuredTrafficAuthorized: false }; }
test('one bounded attempt reserves custody failure and both contingencies below $15', () => {
  assert.ok(Math.abs(cost(plan()).total - 13.198977777777777) < 1e-9); validatePlan(plan(), now);
  for (const [key, value] of Object.entries({ activeHours: 9, spendCapUsd: 16, instanceCount: 2, exportGiB: 21, dataGiB: 201, rootGiB: 31, holdDays: 8, measuredTrafficAuthorized: true, productionUsage: 'on/off', acceptanceContract: 'relaxed', instanceType: 'm7i.8xlarge', region: 'us-west-2' })) assert.throws(() => validatePlan({ ...plan(), [key]: value }, now), key);
  assert.throws(() => validatePlan(plan(), now + 11 * 60000));
  assert.throws(() => validatePlan({ ...plan(), pricesCapturedUtc: new Date(now - 25 * 3600000).toISOString() }, now));
});
test('launch keeps encrypted state, no public SSH, IMDSv2, stop expiry and exact image', () => {
  const p = plan(); const ids = { subnetId: 'subnet-abc', groupId: 'sg-def', profileArn: 'arn:aws:iam::123456789012:instance-profile/usage-linux-test-20261012' };
  const request = launchRequest(p, ids, bytes.toString('base64'));
  assert.equal(request.MaxCount, 1); assert.equal(request.InstanceInitiatedShutdownBehavior, 'stop');
  assert.ok(request.BlockDeviceMappings.every(x => x.Ebs.Encrypted && !x.Ebs.DeleteOnTermination));
  assert.equal(request.MetadataOptions.HttpPutResponseHopLimit, 1); assert.equal(request.MetadataOptions.HttpTokens, 'required');
  assert.equal(request.KeyName, undefined); assert.equal(request.Placement.Tenancy, 'default');
  assert.throws(() => launchRequest(p, ids, Buffer.from('tampered').toString('base64')));
});
test('role has channels only, operator cannot use remote host forwarding or arbitrary shell document', () => {
  const actions = instancePolicy().Statement.flatMap(x => x.Action); assert.equal(actions.length, 5);
  assert.ok(actions.every(x => /^(ssmmessages:|ssm:UpdateInstanceInformation$)/.test(x)));
  const policy = JSON.stringify(operatorPolicy(plan(), { instanceId: 'i-abc' }));
  assert.ok(!policy.includes('ToRemoteHost')); assert.ok(!policy.includes('AWS-RunShellScript')); assert.ok(!policy.includes('GetParameter'));
  assert.throws(() => launchDocument(plan()));
  assert.equal(launchDocument({ ...plan(), launchAdmissionSha256: hash, controllerConfigSha256: hash }).parameters, undefined);
});
test('destructive operations reject foreign and drifted resources', () => {
  const p = plan(); assertOwnedResource({ Tags: tags(p) }, p);
  assert.throws(() => assertOwnedResource({ Tags: [] }, p));
  assert.throws(() => assertOwnedResource({ Tags: tags({ ...p, runId: 'usage-linux-foreign-20261012' }) }, p));
});
