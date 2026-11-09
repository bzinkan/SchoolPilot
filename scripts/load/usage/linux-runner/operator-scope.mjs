// Pure IAM rendering/validation. This module never acquires credentials or calls AWS.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AMI, CAP, instancePolicy, tags, RUNNER_DOCUMENT_SUFFIXES } from './cloud-plan.mjs';
import { canonicalJson } from './evidence.mjs';

export const METADATA_READ_ACTIONS = Object.freeze(['ec2:DescribeImages', 'ec2:DescribeInstances', 'ec2:DescribeVolumes', 'ec2:DescribeVpcs', 'ec2:DescribeSubnets', 'ec2:DescribeInternetGateways', 'ec2:DescribeRouteTables', 'ec2:DescribeSecurityGroups']);
export const OWNER_COMMAND_READ_SEPARATE = 'exact_runner_command_owner_read';
const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
export function scopeNames(p) {
  assert.match(p.runId, /^usage-linux-[a-z0-9-]{8,40}$/); assert.match(p.accountId, /^\d{12}$/); assert.equal(p.region, 'us-east-1');
  return { operatorRoleName: `${p.runId}-operator`, operatorBoundaryName: `${p.runId}-operator-boundary`, instanceBoundaryName: `${p.runId}-instance-boundary`,
    operatorRoleArn: `arn:aws:iam::${p.accountId}:role/${p.runId}-operator`,
    operatorBoundaryArn: `arn:aws:iam::${p.accountId}:policy/${p.runId}-operator-boundary`,
    instanceBoundaryArn: `arn:aws:iam::${p.accountId}:policy/${p.runId}-instance-boundary` };
}
function validateSettings(p) {
  const n = scopeNames(p); assert.deepEqual(p.ami, AMI); assert.equal(p.instanceType, 'm7i.4xlarge');
  assert.match(p.availabilityZone, /^us-east-1[a-f]$/);
  assert.match(p.ebsKmsKeyArn, new RegExp(`^arn:aws:kms:${p.region}:${p.accountId}:key/[a-f0-9-]{36}$`));
  assert.match(p.sourceCallerArn, new RegExp(`^arn:aws:iam::${p.accountId}:user/[A-Za-z0-9+=,.@_/-]+$`));
  const start = Date.parse(p.launchNotBeforeUtc), stop = Date.parse(p.stopDeadlineUtc), retained = Date.parse(p.retentionDeadlineUtc);
  assert.ok(Number.isFinite(start) && Number.isFinite(stop) && Number.isFinite(retained));
  assert.ok(stop > start && stop - start <= CAP.activeHours * 3600000, 'positive window within the eight-hour maximum required'); assert.equal(retained - stop, 7 * 86400000);
  return n;
}
export function operatorTrust(p) {
  validateSettings(p);
  return { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { AWS: p.sourceCallerArn }, Action: 'sts:AssumeRole',
    Condition: { Bool: { 'aws:MultiFactorAuthPresent': 'true' }, DateLessThan: { 'aws:CurrentTime': p.retentionDeadlineUtc } } }] };
}
export function runnerLifecyclePolicy(p) {
  const n = validateSettings(p), prefix = `arn:aws:ec2:${p.region}:${p.accountId}:`, iam = `arn:aws:iam::${p.accountId}:`;
  const ec2 = types => types.map(type => `${prefix}${type}/*`);
  const own = Object.fromEntries(tags(p).map(t => [`aws:ResourceTag/${t.Key}`, t.Value]));
  const requested = Object.fromEntries(tags(p).map(t => [`aws:RequestTag/${t.Key}`, t.Value]));
  const region = { 'aws:RequestedRegion': p.region };
  const docs = RUNNER_DOCUMENT_SUFFIXES.map(suffix => `arn:aws:ssm:${p.region}:${p.accountId}:document/${p.runId}-${suffix}`);
  const allow = (Action, Resource, equals) => ({ Effect: 'Allow', Action, Resource, ...(equals ? { Condition: { StringEquals: equals,
    ...(Object.keys(equals).some(k => k.startsWith('aws:RequestTag/')) ? { 'ForAllValues:StringEquals': { 'aws:TagKeys': tags(p).map(t => t.Key) } } : {}) } } : {}) });
  const statements = [
    // No instance user data, console output, command output, secrets, or production API reads.
    allow(METADATA_READ_ACTIONS, '*', region),
    allow(['ec2:CreateVpc', 'ec2:CreateInternetGateway'], ec2(['vpc', 'internet-gateway']), { ...requested, ...region }),
    allow(['ec2:CreateSubnet', 'ec2:CreateRouteTable', 'ec2:CreateSecurityGroup'], ec2(['subnet', 'route-table', 'security-group']), { ...requested, ...region }),
    // Parent VPC resources in multi-resource Create* evaluations already exist.
    allow(['ec2:CreateSubnet', 'ec2:CreateRouteTable', 'ec2:CreateSecurityGroup'], ec2(['vpc']), { ...own, ...region }),
    allow('ec2:CreateTags', ec2(['vpc', 'subnet', 'internet-gateway', 'route-table', 'security-group', 'instance', 'volume', 'network-interface']), { ...requested, ...region, 'ec2:CreateAction': ['CreateVpc', 'CreateSubnet', 'CreateInternetGateway', 'CreateRouteTable', 'CreateSecurityGroup', 'RunInstances'] }),
    allow(['ec2:ModifyVpcAttribute', 'ec2:AttachInternetGateway', 'ec2:DetachInternetGateway', 'ec2:CreateRoute', 'ec2:AssociateRouteTable', 'ec2:DisassociateRouteTable', 'ec2:DeleteVpc', 'ec2:DeleteSubnet', 'ec2:DeleteInternetGateway', 'ec2:DeleteRouteTable', 'ec2:DeleteSecurityGroup', 'ec2:DeleteVolume', 'ec2:StopInstances', 'ec2:TerminateInstances'], ec2(['vpc', 'subnet', 'internet-gateway', 'route-table', 'security-group', 'volume', 'instance']), { ...own, ...region }),
    allow('ec2:RunInstances', `arn:aws:ec2:${p.region}::image/${AMI.id}`, region),
    allow('ec2:RunInstances', ec2(['subnet', 'security-group']), { ...own, ...region }),
    { ...allow('ec2:RunInstances', ec2(['instance']), { ...requested, ...region, 'ec2:InstanceType': 'm7i.4xlarge', 'ec2:AvailabilityZone': p.availabilityZone, 'ec2:Tenancy': 'default', 'ec2:MetadataHttpTokens': 'required', 'ec2:MetadataHttpPutResponseHopLimit': '1', 'ec2:InstanceProfile': `${iam}instance-profile/${p.runId}` }),
      Condition: { ...allow('', '', requested).Condition, StringEquals: { ...requested, ...region, 'ec2:InstanceType': 'm7i.4xlarge', 'ec2:AvailabilityZone': p.availabilityZone, 'ec2:Tenancy': 'default', 'ec2:MetadataHttpTokens': 'required' }, ArnEquals: { 'ec2:InstanceProfile': `${iam}instance-profile/${p.runId}` }, NumericEquals: { 'ec2:MetadataHttpPutResponseHopLimit': '1' }, DateGreaterThanEquals: { 'aws:CurrentTime': p.launchNotBeforeUtc }, DateLessThan: { 'aws:CurrentTime': new Date(Math.min(Date.parse(p.launchNotBeforeUtc) + 600000, Date.parse(p.stopDeadlineUtc))).toISOString() } } },
    allow('ec2:RunInstances', ec2(['network-interface']), { ...requested, ...region }),
    { ...allow('ec2:RunInstances', ec2(['volume']), { ...requested, ...region, 'ec2:VolumeType': 'gp3' }), Condition: { ...allow('', '', requested).Condition, StringEquals: { ...requested, ...region, 'ec2:VolumeType': 'gp3' }, Bool: { 'ec2:Encrypted': 'true' }, NumericEquals: { 'ec2:VolumeIops': '3000', 'ec2:VolumeThroughput': '125', 'ec2:VolumeSize': ['30', '200'] } } },
    allow('iam:CreateRole', `${iam}role/${p.runId}`, { ...requested, 'iam:PermissionsBoundary': n.instanceBoundaryArn }),
    allow('iam:TagRole', `${iam}role/${p.runId}`, requested),
    allow('iam:PutRolePolicy', `${iam}role/${p.runId}`, { 'iam:PermissionsBoundary': n.instanceBoundaryArn }),
    allow(['iam:GetRole', 'iam:GetRolePolicy', 'iam:ListRolePolicies', 'iam:ListAttachedRolePolicies', 'iam:DeleteRolePolicy', 'iam:DeleteRole'], `${iam}role/${p.runId}`),
    allow(['iam:CreateInstanceProfile', 'iam:TagInstanceProfile'], `${iam}instance-profile/${p.runId}`, requested),
    allow(['iam:GetInstanceProfile', 'iam:AddRoleToInstanceProfile', 'iam:RemoveRoleFromInstanceProfile', 'iam:DeleteInstanceProfile'], `${iam}instance-profile/${p.runId}`),
    allow('iam:PassRole', `${iam}role/${p.runId}`, { 'iam:PassedToService': 'ec2.amazonaws.com' }),
    allow(['ssm:CreateDocument', 'ssm:AddTagsToResource'], docs, { ...requested, ...region }),
    allow(['ssm:GetDocument', 'ssm:DescribeDocument', 'ssm:ListTagsForResource', 'ssm:DeleteDocument', 'ssm:SendCommand'], docs, region),
    allow('ssm:SendCommand', ec2(['instance']), { ...own, ...region }),
    { ...allow('ssm:StartSession', ec2(['instance']), { ...own, ...region }), Condition: { StringEquals: { ...own, ...region }, Bool: { 'ssm:SessionDocumentAccessCheck': 'true' } } },
    allow('ssm:StartSession', docs.find(d => d.endsWith('-sftp')), region),
    allow(['ssm:ResumeSession', 'ssm:TerminateSession', 'ssmmessages:OpenDataChannel'], `arn:aws:ssm:${p.region}:${p.accountId}:session/\${aws:userid}-*`, region),
    allow(['kms:Decrypt', 'kms:DescribeKey', 'kms:GenerateDataKeyWithoutPlaintext', 'kms:ReEncryptFrom', 'kms:ReEncryptTo'], p.ebsKmsKeyArn, { 'kms:CallerAccount': p.accountId, 'kms:ViaService': `ec2.${p.region}.amazonaws.com` }),
    { Effect: 'Allow', Action: 'kms:CreateGrant', Resource: p.ebsKmsKeyArn, Condition: { StringEquals: { 'kms:CallerAccount': p.accountId, 'kms:ViaService': `ec2.${p.region}.amazonaws.com` }, Bool: { 'kms:GrantIsForAWSResource': 'true' } } },
    { Effect: 'Deny', Action: '*', Resource: '*', Condition: { DateGreaterThanEquals: { 'aws:CurrentTime': p.retentionDeadlineUtc } } },
  ];
  // Resource policies can grant directly to a role session. Explicit denies
  // preserve this ceiling even where an implicit identity/boundary deny would not.
  const permitted = [...new Set(statements.filter(s => s.Effect === 'Allow').flatMap(s => [s.Action].flat()))].sort();
  statements.push({ Effect: 'Deny', NotAction: [...permitted, 'sts:GetCallerIdentity'], Resource: '*' });
  statements.push({ Effect: 'Deny', Action: 'kms:*', NotResource: p.ebsKmsKeyArn });
  statements.push({ Effect: 'Deny', Action: 'kms:*', Resource: '*', Condition: { StringNotEquals: { 'kms:CallerAccount': p.accountId } } });
  statements.push({ Effect: 'Deny', Action: 'kms:*', Resource: '*', Condition: { StringNotEquals: { 'kms:ViaService': `ec2.${p.region}.amazonaws.com` } } });
  statements.push({ Effect: 'Deny', Action: 'kms:CreateGrant', Resource: '*', Condition: { BoolIfExists: { 'kms:GrantIsForAWSResource': 'false' } } });
  return { Version: '2012-10-17', Statement: statements };
}
export function renderOperatorScope(p) {
  const names = validateSettings(p), policy = runnerLifecyclePolicy(p), trust = operatorTrust(p);
  const boundary = operatorBoundaryPolicy(p, policy);
  // Split exact grants into immutable managed policies, each under IAM's 6,144 limit.
  const chunks = []; let current = { Version: '2012-10-17', Statement: [] };
  for (const s of policy.Statement) {
    if (JSON.stringify({ ...current, Statement: [...current.Statement, s] }).length > 6000) { assert.ok(current.Statement.length); chunks.push(current); current = { Version: '2012-10-17', Statement: [] }; }
    current.Statement.push(s);
  }
  if (current.Statement.length) chunks.push(current); assert.ok(chunks.length <= 10);
  const identityPolicies = chunks.map((document, i) => ({ name: `${p.runId}-identity-${i + 1}`, arn: `arn:aws:iam::${p.accountId}:policy/${p.runId}-identity-${i + 1}`, document }));
  assert.ok(JSON.stringify(boundary).length <= 6144, 'operator boundary exceeds IAM managed policy limit');
  return { schemaVersion: 1, kind: 'usage_linux_operator_scope', settings: p, names, policy, identityPolicies, boundary, trust, instanceBoundary: instancePolicy(),
    maxSessionDuration: 32400, tags: tags(p), metadataReadExceptions: [...METADATA_READ_ACTIONS], commandOutputReadRoute: OWNER_COMMAND_READ_SEPARATE,
    scopeSha256: hash({ settings: p, names, policy, identityPolicies, boundary, trust, instanceBoundary: instancePolicy() }) };
}

export function operatorBoundaryPolicy(p, identity = runnerLifecyclePolicy(p)) {
  validateSettings(p);
  const ec2Writes = [...new Set(identity.Statement.filter(s => s.Effect === 'Allow').flatMap(s => [s.Action].flat()).filter(a => a.startsWith('ec2:') && !METADATA_READ_ACTIONS.includes(a)))];
  const existing = { 'aws:RequestedRegion': p.region, ...Object.fromEntries(tags(p).map(t => [`aws:ResourceTag/${t.Key}`, t.Value])) };
  const create = { 'aws:RequestedRegion': p.region, ...Object.fromEntries(tags(p).map(t => [`aws:RequestTag/${t.Key}`, t.Value])) };
  // The exact identity policy is separately checked. This compact boundary prevents any
  // later added identity grant from reaching other runs, policies, roles or services.
  const other = identity.Statement.filter(s => s.Action && ![s.Action].flat().some(a => a.startsWith('ec2:')) && (s.Effect === 'Allow' || s.Action === '*')).map(s => {
    const copy = structuredClone(s);
    if ([s.Action].flat().some(a => a.startsWith('ssm:')) && [s.Resource].flat().some(r => r.includes(':document/'))) copy.Resource = `arn:aws:ssm:${p.region}:${p.accountId}:document/${p.runId}-*`;
    // Exact role/profile/document names provide the boundary's scope ceiling;
    // all four immutable tags remain required by the checked identity policies.
    if (copy.Condition?.StringEquals) for (const k of Object.keys(copy.Condition.StringEquals)) if (k.startsWith('aws:RequestTag/')) delete copy.Condition.StringEquals[k];
    if (copy.Condition) delete copy.Condition['ForAllValues:StringEquals'];
    if (copy.Condition?.StringEquals && !Object.keys(copy.Condition.StringEquals).length) delete copy.Condition.StringEquals;
    if (copy.Condition && !Object.keys(copy.Condition).length) delete copy.Condition;
    return copy;
  });
  return { Version: '2012-10-17', Statement: [identity.Statement[0],
    { Effect: 'Allow', Action: ec2Writes, Resource: `arn:aws:ec2:${p.region}:${p.accountId}:*`, Condition: { StringEquals: existing } },
    { Effect: 'Allow', Action: ec2Writes, Resource: `arn:aws:ec2:${p.region}:${p.accountId}:*`, Condition: { StringEquals: create } },
    { Effect: 'Allow', Action: 'ec2:RunInstances', Resource: `arn:aws:ec2:${p.region}::image/${AMI.id}`, Condition: { StringEquals: { 'aws:RequestedRegion': p.region } } },
    ...other] };
}

export function validateNativeScopeSnapshot(snapshot, scope, now = Date.now()) {
  assert.deepEqual(scope, renderOperatorScope(scope.settings));
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.kind, 'usage_linux_native_operator_scope_snapshot'); assert.equal(snapshot.runId, scope.settings.runId);
  assert.ok(Date.parse(snapshot.capturedAtUtc) <= now && Date.parse(snapshot.capturedAtUtc) >= now - 600000);
  const role = snapshot.role.Role; assert.equal(role.Arn, scope.names.operatorRoleArn); assert.equal(role.MaxSessionDuration, 32400);
  assert.deepEqual(Object.fromEntries(role.Tags.map(t => [t.Key, t.Value])), Object.fromEntries(scope.tags.map(t => [t.Key, t.Value])));
  assert.deepEqual(role.AssumeRolePolicyDocument, scope.trust); assert.equal(role.PermissionsBoundary.PermissionsBoundaryArn, scope.names.operatorBoundaryArn);
  assert.deepEqual(snapshot.inlinePolicyNames.PolicyNames, []);
  assert.deepEqual(snapshot.attachedPolicies.AttachedPolicies.map(x => x.PolicyArn).sort(), scope.identityPolicies.map(x => x.arn).sort());
  assert.equal(snapshot.identityPolicies.length, scope.identityPolicies.length);
  for (const item of scope.identityPolicies) {
    const native = snapshot.identityPolicies.find(x => x.metadata.Policy.Arn === item.arn); assert.ok(native);
    assert.equal(native.metadata.Policy.DefaultVersionId, 'v1'); assert.deepEqual(native.versions.Versions.map(v => ({ VersionId: v.VersionId, IsDefaultVersion: v.IsDefaultVersion })), [{ VersionId: 'v1', IsDefaultVersion: true }]);
    assert.equal(native.version.PolicyVersion.VersionId, 'v1'); assert.equal(native.version.PolicyVersion.IsDefaultVersion, true); assert.deepEqual(native.version.PolicyVersion.Document, item.document);
  }
  for (const [key, arn, policy] of [['operatorBoundary', scope.names.operatorBoundaryArn, scope.boundary], ['instanceBoundary', scope.names.instanceBoundaryArn, scope.instanceBoundary]]) {
    const b = snapshot[key]; assert.equal(b.metadata.Policy.Arn, arn); assert.equal(b.metadata.Policy.DefaultVersionId, 'v1');
    assert.deepEqual(b.versions.Versions.map(v => ({ VersionId: v.VersionId, IsDefaultVersion: v.IsDefaultVersion })), [{ VersionId: 'v1', IsDefaultVersion: true }]);
    assert.equal(b.version.PolicyVersion.VersionId, 'v1'); assert.equal(b.version.PolicyVersion.IsDefaultVersion, true); assert.deepEqual(b.version.PolicyVersion.Document, policy);
  }
  return true;
}

export function validateOperatorSession(session, p) {
  assert.equal(session.schemaVersion, 1); assert.equal(session.kind, 'usage_linux_assumed_operator_session');
  assert.equal(session.runId, p.runId); assert.equal(session.accountId, p.accountId); assert.equal(session.callerArn, p.sessionCallerArn);
  const names = scopeNames(p); assert.equal(session.operatorRoleArn, names.operatorRoleArn); assert.equal(p.instanceBoundaryArn, names.instanceBoundaryArn);
  assert.match(session.callerArn, new RegExp(`^arn:aws:sts::${p.accountId}:assumed-role/${names.operatorRoleName}/[A-Za-z0-9+=,.@_-]{2,64}$`));
  assert.match(session.mfaSerial, new RegExp(`^arn:aws:iam::${p.accountId}:mfa/`));
  for (const key of ['parentMfaSession', 'nativeAssumeRole', 'nativeCaller', 'operatorScope', 'nativeScopeSnapshot']) assert.ok(session[key]?.path && /^[a-f0-9]{64}$/.test(session[key].sha256), key);
  assert.equal(session.effectiveScope, 'runner_only'); assert.equal(session.commandOutputReadRoute, OWNER_COMMAND_READ_SEPARATE);
  assert.ok(Number.isFinite(Date.parse(session.expiresUtc)) && Date.parse(session.expiresUtc) > Date.parse(session.acquiredAtUtc));
}
