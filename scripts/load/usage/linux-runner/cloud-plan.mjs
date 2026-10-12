// Bounded cloud requests only. This module never calls AWS or admits load.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
export const CAP = Object.freeze({ usd: 15, activeHours: 8, exportGiB: 20, holdDays: 7 });
export const AMI = Object.freeze({ id: 'ami-0fa5967347d08d2df', owner: '099720109477', name: 'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-20261004' });
export const RUNNER_DOCUMENT_SUFFIXES = Object.freeze(['discovery', 'bootstrap', 'sftp', 'launch', 'placement', 'finalize', 'verify', 'export', 'recovery']);
const sha = /^[a-f0-9]{64}$/;
export function cost(p) {
  const base = p.activeHours * (0.8064 + 230 * 0.08 / 720 + 0.005);
  return { base, exportReserve: 2, dataHold: 200 * 0.08 * 24 * p.holdDays / 720,
    rootHold: 30 * 0.08 * 24 * p.holdDays / 720, kmsReserve: 0.1, optionalSsmReserve: 0.11,
    total: base + 2 + 230 * 0.08 * 24 * p.holdDays / 720 + 0.21 };
}
export function validatePlan(p, now = Date.now()) {
  assert.equal(p.schemaVersion, 1); assert.equal(p.kind, 'usage_linux_cloud_plan');
  assert.match(p.runId, /^usage-linux-[a-z0-9-]{8,40}$/);
  assert.match(p.accountId, /^\d{12}$/); assert.equal(p.region, 'us-east-1');
  assert.match(p.availabilityZone, /^us-east-1[a-f]$/);
  assert.equal(p.instanceType, 'm7i.4xlarge'); assert.deepEqual(p.ami, AMI);
  assert.equal(p.activeHours, CAP.activeHours); assert.equal(p.holdDays, CAP.holdDays);
  assert.equal(p.exportGiB, CAP.exportGiB); assert.equal(p.spendCapUsd, CAP.usd);
  assert.equal(p.instanceCount, 1); assert.equal(p.productionUsage, 'off/off');
  assert.ok(['ami_discovery', 'bootstrap_ready'].includes(p.preparationStage));
  assert.equal(p.acceptanceContract, 'unchanged');
  assert.equal(p.rootGiB, 30); assert.equal(p.dataGiB, 200);
  assert.match(p.userDataSha256, sha); assert.match(p.bootstrapSha256, sha);
  assert.match(p.implementationSha256, sha); assert.match(p.independentReviewSha256, sha);
  assert.match(p.authorizationSha256, sha); assert.match(p.priceEvidenceSha256, sha);
  assert.match(p.sessionReceiptSha256, sha); assert.match(p.custodyCanarySha256, sha);
  assert.match(p.toolBindingsSha256, sha);
  assert.match(p.operatorAccessSha256, sha);
  assert.equal(p.instanceBoundaryArn, `arn:aws:iam::${p.accountId}:policy/${p.runId}-instance-boundary`);
  assert.match(p.ownerCallerArn, new RegExp(`^arn:aws:iam::${p.accountId}:user/[A-Za-z0-9+=,.@_/-]+$`));
  assert.match(p.ebsKmsKeyArn, new RegExp(`^arn:aws:kms:${p.region}:${p.accountId}:key/[a-f0-9-]{36}$`)); assert.match(p.ebsKeySha256, sha);
  const start = Date.parse(p.launchNotBeforeUtc), end = Date.parse(p.stopDeadlineUtc);
  assert.ok(Number.isFinite(start) && Number.isFinite(end));
  assert.equal(end - start, CAP.activeHours * 3600000);
  assert.ok(now >= start && now < start + 10 * 60000, 'launch window expired or not begun');
  assert.ok(Date.parse(p.pricesCapturedUtc) >= now - 24 * 3600000 && Date.parse(p.pricesCapturedUtc) <= now);
  assert.ok(cost(p).total < CAP.usd); assert.equal(p.measuredTrafficAuthorized, false);
  return p;
}
export function hashJson(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function stopUserData(p) {
  assert.match(p.stopDeadlineUtc, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.000)?Z$/);
  const deadline = new Date(p.stopDeadlineUtc).toISOString().replace('.000Z', 'Z');
  const calendar = deadline.replace('T', ' ').replace('Z', ' UTC');
  // Install the absolute stop before bootstrap, imports, or SSM preparation.
  return Buffer.from(`#!/bin/bash\nset -eu\numask 077\nprintf '%s\\n' '${deadline}' > /etc/usage-runner-deadline-utc\ncat > /etc/systemd/system/usage-absolute-stop.service <<'UNIT'\n[Unit]\nDescription=Absolute Usage runner compute stop\n[Service]\nType=oneshot\nExecStart=/usr/sbin/shutdown -h now\nUNIT\ncat > /etc/systemd/system/usage-absolute-stop.timer <<'UNIT'\n[Unit]\nDescription=Absolute Usage runner eight-hour deadline\n[Timer]\nOnCalendar=${calendar}\nPersistent=true\nAccuracySec=1s\nUnit=usage-absolute-stop.service\n[Install]\nWantedBy=timers.target\nUNIT\nsystemctl daemon-reload\nsystemctl enable --now usage-absolute-stop.timer\n`);
}
export function instancePolicy() {
  const channels = ['ssmmessages:CreateControlChannel', 'ssmmessages:CreateDataChannel', 'ssmmessages:OpenControlChannel', 'ssmmessages:OpenDataChannel'];
  return { Version: '2012-10-17', Statement: [
    { Effect: 'Allow', Action: ['ssm:UpdateInstanceInformation'], Resource: '*' },
    { Effect: 'Allow', Action: channels, Resource: '*' },
    { Effect: 'Deny', NotAction: ['ssm:UpdateInstanceInformation', ...channels, 'sts:GetCallerIdentity'], Resource: '*' },
  ] };
}
export function tags(p) { return [{ Key: 'Purpose', Value: 'usage-linux-acceptance' }, { Key: 'RunId', Value: p.runId }, { Key: 'StopDeadlineUtc', Value: p.stopDeadlineUtc }, { Key: 'SpendCapUsd', Value: '15' }]; }
export function launchRequest(p, ids, userData) {
  validatePlan(p);
  assert.match(ids.subnetId, /^subnet-[a-f0-9]+$/); assert.match(ids.groupId, /^sg-[a-f0-9]+$/);
  assert.match(ids.profileArn, new RegExp(`^arn:aws:iam::${p.accountId}:instance-profile/${p.runId}$`));
  assert.equal(createHash('sha256').update(Buffer.from(userData, 'base64')).digest('hex'), p.userDataSha256);
  return { ImageId: p.ami.id, InstanceType: p.instanceType, MinCount: 1, MaxCount: 1,
    ClientToken: p.runId, Placement: { AvailabilityZone: p.availabilityZone, Tenancy: 'default' },
    IamInstanceProfile: { Arn: ids.profileArn },
    NetworkInterfaces: [{ DeviceIndex: 0, SubnetId: ids.subnetId, Groups: [ids.groupId], AssociatePublicIpAddress: true, DeleteOnTermination: true }],
    MetadataOptions: { HttpEndpoint: 'enabled', HttpTokens: 'required', HttpPutResponseHopLimit: 1, HttpProtocolIpv6: 'disabled', InstanceMetadataTags: 'disabled' },
    InstanceInitiatedShutdownBehavior: 'stop', EbsOptimized: true, Monitoring: { Enabled: false },
    BlockDeviceMappings: [
      { DeviceName: '/dev/sda1', Ebs: { VolumeSize: 30, VolumeType: 'gp3', Iops: 3000, Throughput: 125, Encrypted: true, KmsKeyId: p.ebsKmsKeyArn, DeleteOnTermination: false } },
      { DeviceName: '/dev/sdf', Ebs: { VolumeSize: 200, VolumeType: 'gp3', Iops: 3000, Throughput: 125, Encrypted: true, KmsKeyId: p.ebsKmsKeyArn, DeleteOnTermination: false } },
    ],
    TagSpecifications: ['instance', 'volume', 'network-interface'].map(ResourceType => ({ ResourceType, Tags: tags(p) })),
    UserData: userData,
  };
}
export function operatorPolicy(p, ids) {
  assert.match(ids.instanceId, /^i-[a-f0-9]+$/);
  const instance = `arn:aws:ec2:${p.region}:${p.accountId}:instance/${ids.instanceId}`;
  const documents = [`arn:aws:ssm:${p.region}:${p.accountId}:document/${p.runId}-sftp`, `arn:aws:ssm:${p.region}:${p.accountId}:document/${p.runId}-launch`];
  return { Version: '2012-10-17', Statement: [
    { Effect: 'Allow', Action: 'ssm:StartSession', Resource: [instance, documents[0]] },
    { Effect: 'Allow', Action: 'ssm:SendCommand', Resource: [instance, documents[1], ...['discovery', 'bootstrap'].map(suffix => `arn:aws:ssm:${p.region}:${p.accountId}:document/${p.runId}-${suffix}`)] },
    { Effect: 'Allow', Action: 'iam:PassRole', Resource: `arn:aws:iam::${p.accountId}:role/${p.runId}`, Condition: { StringEquals: { 'iam:PassedToService': 'ec2.amazonaws.com' } } },
  ] };
}
export function sftpDocument() {
  // Same SSM Port session transport as AWS-StartPortForwardingSession, with fixed ports.
  return { schemaVersion: '1.0', description: 'Loopback SFTP only; no arbitrary remote host or port', sessionType: 'Port', properties: { portNumber: '22', type: 'LocalPortForwarding', localPortNumber: '2222' } };
}
export function launchDocument(p) {
  // No arbitrary command or path parameter. Staging and measurement admission are separate.
  assert.match(p.bootstrapSha256, sha);
  assert.match(p.launchAdmissionSha256, sha); assert.match(p.controllerConfigSha256, sha);
  return { schemaVersion: '2.2', description: 'Start the exact reviewed durable Usage controller; admission remains mandatory',
    mainSteps: [{ action: 'aws:runShellScript', name: 'StartBoundController', inputs: { timeoutSeconds: '60', runCommand: [
      'set -eu', 'umask 077',
      `test "$(sha256sum /opt/usage/bootstrap.sh | cut -d\" \" -f1)" = '${p.bootstrapSha256}'`,
      `test "$(sha256sum /srv/usage/control/campaign.json | cut -d\" \" -f1)" = '${p.controllerConfigSha256}'`,
      `test "$(sha256sum /srv/usage/control/launch-admission.json | cut -d\" \" -f1)" = '${p.launchAdmissionSha256}'`,
      `test "$(date -u +%s)" -lt "$(date -u -d '${p.stopDeadlineUtc}' +%s)"`,
      'systemctl start usage-campaign.service',
    ] } }] };
}
export function assertOwnedResource(resource, p) {
  const own = Object.fromEntries((resource.Tags ?? []).map(t => [t.Key, t.Value]));
  assert.equal(own.Purpose, 'usage-linux-acceptance'); assert.equal(own.RunId, p.runId);
  assert.equal(own.StopDeadlineUtc, p.stopDeadlineUtc); assert.equal(own.SpendCapUsd, '15');
}
