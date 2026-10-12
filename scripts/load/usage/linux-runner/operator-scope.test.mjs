import test from 'node:test';
import assert from 'node:assert/strict';
import { AMI, tags } from './cloud-plan.mjs';
import { canonicalJson } from './evidence.mjs';
import { renderOperatorScope, validateNativeScopeSnapshot, validateOperatorSession, METADATA_READ_ACTIONS, OWNER_COMMAND_READ_SEPARATE } from './operator-scope.mjs';
const now = Date.parse('2026-10-12T16:01:00Z');
const settings = { runId: 'usage-linux-20261012-a1', accountId: '123456789012', region: 'us-east-1', availabilityZone: 'us-east-1a', ami: AMI, instanceType: 'm7i.4xlarge', ebsKmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/00000000-0000-0000-0000-000000000000', sourceCallerArn: 'arn:aws:iam::123456789012:user/owner', launchNotBeforeUtc: '2026-10-12T16:00:00Z', stopDeadlineUtc: '2026-10-13T00:00:00Z', retentionDeadlineUtc: '2026-10-20T00:00:00Z' };
const scope = renderOperatorScope(settings);
const ref = name => ({ path: `/private/${name}.json`, sha256: 'a'.repeat(64) });
function nativePolicy(arn, document) { return { metadata: { Policy: { Arn: arn, DefaultVersionId: 'v1' } }, versions: { Versions: [{ VersionId: 'v1', IsDefaultVersion: true }] }, version: { PolicyVersion: { VersionId: 'v1', IsDefaultVersion: true, Document: structuredClone(document) } } }; }
function snapshot() { return { schemaVersion: 1, kind: 'usage_linux_native_operator_scope_snapshot', runId: settings.runId, capturedAtUtc: new Date(now).toISOString(), role: { Role: { Arn: scope.names.operatorRoleArn, Tags: scope.tags, MaxSessionDuration: 32400, AssumeRolePolicyDocument: scope.trust, PermissionsBoundary: { PermissionsBoundaryArn: scope.names.operatorBoundaryArn } } }, inlinePolicyNames: { PolicyNames: [] }, attachedPolicies: { AttachedPolicies: scope.identityPolicies.map(x => ({ PolicyArn: x.arn })) }, identityPolicies: scope.identityPolicies.map(x => nativePolicy(x.arn, x.document)), operatorBoundary: nativePolicy(scope.names.operatorBoundaryArn, scope.boundary), instanceBoundary: nativePolicy(scope.names.instanceBoundaryArn, scope.instanceBoundary) }; }

// Exercise the intended IAM grant matrix. Native AWS policy validation/simulation is
// still required: this small evaluator deliberately does not claim to implement IAM.
const array = x => Array.isArray(x) ? x : [x];
const matches = (pattern, value) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`).test(value);
function decision(policy, action, resource, context) {
  const applicable = policy.Statement.filter(s => (s.Action ? array(s.Action).some(a => matches(a, action)) : !array(s.NotAction).some(a => matches(a, action))) && (s.Resource ? array(s.Resource).some(r => matches(r, resource)) : !array(s.NotResource).some(r => matches(r, resource)))).filter(s => Object.entries(s.Condition ?? {}).every(([op, entries]) => Object.entries(entries).every(([key, values]) => {
    const actual = context[key]; if (actual === undefined) return op === 'StringNotEquals' || op === 'BoolIfExists';
    if (op === 'ForAllValues:StringEquals') return array(actual).every(x => array(values).includes(x));
    if (op === 'StringEquals' || op === 'ArnEquals' || op === 'Bool') return array(values).includes(String(actual));
    if (op === 'StringNotEquals') return !array(values).includes(String(actual));
    if (op === 'BoolIfExists') return array(values).includes(String(actual));
    if (op === 'NumericEquals') return array(values).some(x => Number(x) === Number(actual));
    if (op === 'DateGreaterThanEquals') return Date.parse(actual) >= Date.parse(values);
    if (op === 'DateLessThan') return Date.parse(actual) < Date.parse(values);
    throw new Error(`Unsupported test operator ${op}`);
  })));
  if (applicable.some(s => s.Effect === 'Deny')) return false;
  return applicable.some(s => s.Effect === 'Allow');
}
const region = { 'aws:RequestedRegion': 'us-east-1', 'aws:CurrentTime': new Date(now).toISOString() };
const requested = { ...region, ...Object.fromEntries(tags(settings).map(t => [`aws:RequestTag/${t.Key}`, t.Value])), 'aws:TagKeys': tags(settings).map(t => t.Key) };
const owned = { ...region, ...Object.fromEntries(tags(settings).map(t => [`aws:ResourceTag/${t.Key}`, t.Value])) };
const ec2 = type => `arn:aws:ec2:us-east-1:123456789012:${type}/test`;

test('scope fits IAM native limits and leaves billing/count enforcement explicit in the controller', () => {
  assert.ok(scope.identityPolicies.length > 1); assert.ok(scope.identityPolicies.every(x => JSON.stringify(x.document).length <= 6144)); assert.ok(JSON.stringify(scope.boundary).length <= 6144);
  assert.deepEqual(scope.identityPolicies.flatMap(x => x.document.Statement), scope.policy.Statement);
  assert.deepEqual(scope.metadataReadExceptions, METADATA_READ_ACTIONS); assert.equal(scope.commandOutputReadRoute, OWNER_COMMAND_READ_SEPARATE);
  assert.equal(scope.trust.Statement[0].Condition.Bool['aws:MultiFactorAuthPresent'], 'true');
  assert.equal(scope.trust.Statement[0].Principal.AWS, settings.sourceCallerArn);
  assert.ok(!JSON.stringify(scope).includes('ec2:MaxInstanceCount')); // AWS has no such condition.
});

test('scope hash survives canonical private JSON and sorted-settings round trips', () => {
  // Private evidence files recursively sort object keys. Reloading that exact
  // persisted scope must retain its binding and pass native snapshot validation.
  const persisted = JSON.parse(canonicalJson(scope));
  assert.notDeepEqual(Object.keys(persisted.settings), Object.keys(settings));
  assert.equal(persisted.scopeSha256, renderOperatorScope(persisted.settings).scopeSha256);
  assert.deepEqual(persisted, renderOperatorScope(persisted.settings));
  validateNativeScopeSnapshot(JSON.parse(canonicalJson(snapshot())), persisted, now);

  // Normal JSON serialization and a separate settings reorder remain equivalent;
  // an actual source-binding change still invalidates the hash.
  const reversedSettings = Object.fromEntries(Object.entries(settings).reverse());
  assert.equal(renderOperatorScope(JSON.parse(JSON.stringify(reversedSettings))).scopeSha256, scope.scopeSha256);
  assert.notEqual(renderOperatorScope({ ...persisted.settings, sourceCallerArn: 'arn:aws:iam::123456789012:user/different-owner' }).scopeSha256, scope.scopeSha256);
});

test('grant matrix denies production, other runs, secrets, extra tags, and operator self-escalation', () => {
  const allowed = (action, resource, c = region) => decision(scope.policy, action, resource, c) && decision(scope.boundary, action, resource, c);
  assert.equal(allowed('ec2:CreateVpc', ec2('vpc'), requested), true);
  assert.equal(allowed('ec2:StopInstances', ec2('instance'), owned), true);
  assert.equal(allowed('ec2:StopInstances', ec2('instance'), { ...owned, 'aws:ResourceTag/RunId': 'production' }), false);
  assert.equal(allowed('ec2:CreateVpc', ec2('vpc'), { ...requested, 'aws:TagKeys': [...requested['aws:TagKeys'], 'Admin'] }), false);
  assert.equal(allowed('ec2:CreateVpc', ec2('vpc'), { ...requested, 'aws:RequestTag/SpendCapUsd': '100' }), false);
  for (const action of ['ecs:UpdateService', 'secretsmanager:GetSecretValue', 'ssm:GetParameter', 'ssm:GetCommandInvocation', 'ssm:ListCommandInvocations', 'iam:CreatePolicyVersion', 'iam:DeleteRolePermissionsBoundary', 'iam:PutRolePermissionsBoundary', 'iam:UpdateAssumeRolePolicy', 'iam:AttachRolePolicy']) assert.equal(allowed(action, '*'), false, action);
  assert.equal(allowed('iam:PutRolePolicy', scope.names.operatorRoleArn, { 'iam:PermissionsBoundary': scope.names.instanceBoundaryArn }), false);
  assert.equal(allowed('iam:CreateRole', `arn:aws:iam::123456789012:role/${settings.runId}`, requested), false);
  assert.equal(allowed('iam:CreateRole', `arn:aws:iam::123456789012:role/${settings.runId}`, { ...requested, 'iam:PermissionsBoundary': scope.names.instanceBoundaryArn }), true);
  assert.equal(allowed('iam:PassRole', `arn:aws:iam::123456789012:role/${settings.runId}`, { 'iam:PassedToService': 'lambda.amazonaws.com' }), false);
  assert.equal(allowed('ec2:DescribeInstances', '*'), true);
  assert.equal(allowed('ec2:DescribeInstances', '*', { ...region, 'aws:RequestedRegion': 'us-west-2' }), false);
  const kms = { 'kms:CallerAccount': settings.accountId, 'kms:ViaService': 'ec2.us-east-1.amazonaws.com' };
  assert.equal(allowed('kms:Decrypt', settings.ebsKmsKeyArn, kms), true);
  assert.equal(allowed('kms:Decrypt', settings.ebsKmsKeyArn, {}), false);
  assert.equal(allowed('kms:Decrypt', settings.ebsKmsKeyArn.replace('00000000-0000', '11111111-1111'), kms), false);
  assert.equal(allowed('kms:CreateGrant', settings.ebsKmsKeyArn, kms), false);
  assert.equal(allowed('kms:CreateGrant', settings.ebsKmsKeyArn, { ...kms, 'kms:GrantIsForAWSResource': 'true' }), true);
});

test('launch binds time, shape, encryption, quotas and owned network rather than expanding authority', () => {
  const instanceContext = { ...requested, 'ec2:InstanceType': 'm7i.4xlarge', 'ec2:AvailabilityZone': settings.availabilityZone, 'ec2:Tenancy': 'default', 'ec2:MetadataHttpTokens': 'required', 'ec2:MetadataHttpPutResponseHopLimit': '1', 'ec2:InstanceProfile': `arn:aws:iam::123456789012:instance-profile/${settings.runId}` };
  assert.equal(decision(scope.policy, 'ec2:RunInstances', ec2('instance'), instanceContext), true);
  for (const change of [{ 'ec2:InstanceType': 'm7i.8xlarge' }, { 'ec2:MetadataHttpTokens': 'optional' }, { 'ec2:MetadataHttpPutResponseHopLimit': '2' }, { 'aws:CurrentTime': '2026-10-12T16:10:00Z' }, { 'aws:CurrentTime': '2026-10-12T15:59:59Z' }]) assert.equal(decision(scope.policy, 'ec2:RunInstances', ec2('instance'), { ...instanceContext, ...change }), false);
  const volume = { ...requested, 'ec2:VolumeType': 'gp3', 'ec2:VolumeIops': '3000', 'ec2:VolumeThroughput': '125', 'ec2:VolumeSize': '200', 'ec2:Encrypted': 'true' };
  assert.equal(decision(scope.policy, 'ec2:RunInstances', ec2('volume'), volume), true);
  for (const change of [{ 'ec2:Encrypted': 'false' }, { 'ec2:VolumeSize': '201' }, { 'ec2:VolumeSize': '100' }, { 'ec2:VolumeIops': '6000' }]) assert.equal(decision(scope.policy, 'ec2:RunInstances', ec2('volume'), { ...volume, ...change }), false);
});

test('session needs approved fixed SFTP document and document access check, denying default shell', () => {
  assert.equal(decision(scope.policy, 'ssm:StartSession', ec2('instance'), owned), false);
  assert.equal(decision(scope.policy, 'ssm:StartSession', ec2('instance'), { ...owned, 'ssm:SessionDocumentAccessCheck': 'true' }), true);
  assert.equal(decision(scope.policy, 'ssm:StartSession', `arn:aws:ssm:us-east-1:123456789012:document/${settings.runId}-sftp`, region), true);
  for (const name of ['SSM-SessionManagerRunShell', 'AWS-RunShellScript', 'AWS-StartPortForwardingSessionToRemoteHost']) assert.equal(decision(scope.policy, 'ssm:StartSession', `arn:aws:ssm:us-east-1::document/${name}`, region), false);
});

test('native proof rejects additional policies, boundary changes, versions, stale snapshots and forged scope', () => {
  validateNativeScopeSnapshot(snapshot(), scope, now);
  const changes = [s => s.inlinePolicyNames.PolicyNames.push('admin'), s => s.attachedPolicies.AttachedPolicies.push({ PolicyArn: 'arn:aws:iam::aws:policy/AdministratorAccess' }), s => s.operatorBoundary.version.PolicyVersion.Document.Statement.push({ Effect: 'Allow', Action: '*', Resource: '*' }), s => s.identityPolicies[0].versions.Versions.push({ VersionId: 'v2', IsDefaultVersion: false }), s => { s.capturedAtUtc = new Date(now - 600001).toISOString(); }, s => { s.role.Role.MaxSessionDuration = 43200; }];
  for (const change of changes) { const s = structuredClone(snapshot()); change(s); assert.throws(() => validateNativeScopeSnapshot(s, scope, now)); }
  const forged = structuredClone(scope); forged.identityPolicies[0].document.Statement.push({ Effect: 'Allow', Action: '*', Resource: '*' }); assert.throws(() => validateNativeScopeSnapshot(snapshot(), forged, now));
});

test('assumed-operator session stays distinct from broad MFA authentication receipt', () => {
  const p = { ...settings, instanceBoundaryArn: scope.names.instanceBoundaryArn, sessionCallerArn: `arn:aws:sts::123456789012:assumed-role/${scope.names.operatorRoleName}/attended` };
  const s = { schemaVersion: 1, kind: 'usage_linux_assumed_operator_session', runId: p.runId, accountId: p.accountId, callerArn: p.sessionCallerArn, operatorRoleArn: scope.names.operatorRoleArn, mfaSerial: 'arn:aws:iam::123456789012:mfa/owner', effectiveScope: 'runner_only', commandOutputReadRoute: OWNER_COMMAND_READ_SEPARATE, ...Object.fromEntries(['parentMfaSession', 'nativeAssumeRole', 'nativeCaller', 'operatorScope', 'nativeScopeSnapshot'].map(k => [k, ref(k)])) };
  s.acquiredAtUtc = new Date(now).toISOString(); s.expiresUtc = new Date(now + 9 * 3600000).toISOString();
  validateOperatorSession(s, p);
  for (const change of [{ kind: 'usage_linux_mfa_session' }, { callerArn: settings.sourceCallerArn }, { operatorRoleArn: 'arn:aws:iam::123456789012:role/admin' }, { parentMfaSession: undefined }, { nativeAssumeRole: { path: '/private/assume.json', sha256: 'tampered' } }]) assert.throws(() => validateOperatorSession({ ...s, ...change }, p));
});
