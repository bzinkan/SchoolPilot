import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CloudController, validateCleanupReplayReview, containFailedProvision } from './cloud.mjs';
import { AMI, tags } from './cloud-plan.mjs';
const p = { runId: 'usage-linux-test-20261012', accountId: '123456789012', region: 'us-east-1', ami: AMI, stopDeadlineUtc: '2026-10-12T20:00:00Z' };
const owned = properties => ({ Tags: tags(p), ...properties });
const custody = { kind: 'independently_replayed_dual_private_evidence_custody', passed: true, copies: ['/private/a', '/private/b'].map(root => ({ root, independentReplayPassed: true, replayHookInvoked: true })), receipt: { sha256: 'a'.repeat(64) } };
function controller(transport) { const c = new CloudController(p, '/not-used', {}); c.events = []; c.seal = async (label, value) => { c.events.push({ label, value }); }; c.aws = transport; return c; }
test('cleanup replay review binds the actual tool and both manifests and refuses stale or failed review', () => {
  const replay = { sha256: 'a'.repeat(64) }, copies = [{ manifestCanonicalSha256: 'b'.repeat(64) }, { manifestCanonicalSha256: 'c'.repeat(64) }];
  const now = Date.parse('2026-10-12T12:00:00Z');
  const review = { schemaVersion: 1, kind: 'usage_linux_cleanup_replay_review', subjectSha256: replay.sha256, passed: true, unresolvedFindings: 0, reviewer: 'independent reviewer', reviewedAtUtc: '2026-10-12T11:00:00Z', manifestSha256: copies.map(x => x.manifestCanonicalSha256) };
  validateCleanupReplayReview(review, replay, copies, now);
  for (const change of [{ passed: false }, { unresolvedFindings: 1 }, { subjectSha256: 'd'.repeat(64) }, { reviewedAtUtc: '2026-10-11T11:00:00Z' }, { manifestSha256: ['b'.repeat(64), 'd'.repeat(64)] }]) assert.throws(() => validateCleanupReplayReview({ ...review, ...change }, replay, copies, now));
});
test('containment discovers lost launch response by exact tags and stops only its owned instance', async () => {
  const operations = [];
  const instance = owned({ InstanceId: 'i-abc', ImageId: AMI.id, InstanceType: 'm7i.4xlarge', State: { Name: 'running' } });
  const c = controller(async (service, op, input) => { operations.push({ service, op, input }); if (op === 'describe-instances') return { Reservations: [{ Instances: [instance] }] }; return {}; });
  await c.stop(); assert.equal(operations.filter(x => x.op === 'stop-instances').length, 1); assert.deepEqual(operations.at(-1).input.InstanceIds, ['i-abc']);
  instance.Tags = []; await assert.rejects(() => c.stop());
  assert.equal(operations.filter(x => x.op === 'stop-instances').length, 1);
});
test('failed provisioning immediately discovers ambiguous launch success and retains an unproven foreign refusal', async () => {
  const calls = [];
  const instance = owned({ InstanceId: 'i-abc', ImageId: AMI.id, InstanceType: 'm7i.4xlarge', State: { Name: 'running' } });
  const c = controller(async (_service, op, input) => { calls.push({ op, input }); return op === 'describe-instances' ? { Reservations: [{ Instances: [instance] }] } : {}; });
  await containFailedProvision(c);
  assert.equal(calls.filter(x => x.op === 'stop-instances').length, 1);
  assert.ok(c.events.some(x => x.label === 'provision-failure'));
  const refused = controller(async (_service, op) => op === 'describe-instances' ? { Reservations: [{ Instances: [{ ...instance, Tags: [] }] }] } : assert.fail('must not stop a foreign resource'));
  await containFailedProvision(refused);
  assert.ok(refused.events.some(x => x.label === 'provision-stop-unproven' && x.value.incidentRequired));
});
test('ambiguous launch tolerates bounded EC2 visibility lag without declaring a sole empty lookup absent', async () => {
  let reads = 0, stops = 0;
  const instance = owned({ InstanceId: 'i-abc', ImageId: AMI.id, InstanceType: 'm7i.4xlarge', State: { Name: 'running' } });
  const c = controller(async (_service, op) => {
    if (op === 'describe-instances') return { Reservations: [{ Instances: ++reads < 3 ? [] : [instance] }] };
    assert.equal(op, 'stop-instances'); stops++; return {};
  });
  c.pause = async () => {}; c.state.phase = 'launch_requested'; await containFailedProvision(c);
  assert.equal(stops, 1); assert.ok(reads >= 3);
  const unknown = controller(async () => ({ Reservations: [] })); unknown.pause = async () => {}; unknown.state.phase = 'launch_requested';
  await containFailedProvision(unknown);
  assert.ok(unknown.events.some(x => x.label === 'provision-stop-unproven'));
  assert.ok(!unknown.events.some(x => x.value?.instanceAbsent === true));
});
test('sending a fixed discovery command rechecks immutable document bytes and saves the native command identity', async () => {
  const content = JSON.stringify({ schemaVersion: '2.2', mainSteps: [] });
  const sha256 = createHash('sha256').update(content).digest('hex'); let sends = 0, altered = false;
  const c = controller(async (_service, op, input) => {
    if (op === 'get-document') return { Content: altered ? '{}' : content, DocumentVersion: '1' };
    assert.equal(op, 'send-command'); assert.equal(input.DocumentHash, sha256); assert.equal(input.DocumentVersion, '1'); sends++; return { Command: { CommandId: 'native-command-id' } };
  });
  c.p = { ...p, stopDeadlineUtc: new Date(Date.now() + 3600000).toISOString() }; c.authenticate = async () => {}; c.instance = async () => ({});
  Object.assign(c.state.resources, { instanceId: 'i-abc', discoveryDocument: `${p.runId}-discovery`, discoveryDocumentVersion: '1', discoveryDocumentHash: sha256 });
  await c.sendBoundCommand('discovery', 120); assert.equal(sends, 1); assert.equal(c.state.discoveryCommandId, 'native-command-id');
  altered = true; await assert.rejects(() => c.sendBoundCommand('discovery', 120)); assert.equal(sends, 1);
});
test('bootstrap preparation cannot provision a new instance or extend an expired original deadline', async () => {
  const c = controller(async () => assert.fail('expired preparation must not mutate AWS'));
  c.p = { ...p, preparationStage: 'bootstrap_ready', stopDeadlineUtc: new Date(Date.now() - 1000).toISOString() };
  c.authenticate = async () => {}; c.instance = async () => ({});
  await assert.rejects(() => c.prepareBootstrap(Buffer.from('not executed'), {}));
});
test('partial deletion is recovered by a fresh exact-tag inventory and all resource absence is proven', async () => {
  let volumeFailure = true;
  const volume = id => owned({ VolumeId: id, Size: id === 'vol-root' ? 30 : 200, Encrypted: true, State: 'available', Attachments: [] });
  const inventory = { Vpcs: [], Subnets: [], InternetGateways: [], RouteTables: [], SecurityGroups: [], Volumes: [volume('vol-root'), volume('vol-data')], Instances: [] };
  const map = { 'describe-vpcs': 'Vpcs', 'describe-subnets': 'Subnets', 'describe-internet-gateways': 'InternetGateways', 'describe-route-tables': 'RouteTables', 'describe-security-groups': 'SecurityGroups', 'describe-volumes': 'Volumes' };
  const deleted = [], absence = [];
  const c = controller(async (service, op, input) => {
    if (map[op]) return { [map[op]]: inventory[map[op]].map(x => structuredClone(x)) };
    if (op === 'describe-instances') return { Reservations: [] };
    if (op === 'delete-volume') { if (input.VolumeId === 'vol-data' && volumeFailure) { volumeFailure = false; throw new Error('simulated interrupted API'); } inventory.Volumes = inventory.Volumes.filter(x => x.VolumeId !== input.VolumeId); deleted.push(input.VolumeId); return {}; }
    if (['describe-document', 'get-role', 'get-instance-profile'].includes(op)) { absence.push(op); return { absent: true }; }
    throw new Error(`unexpected operation ${service}/${op}`);
  });
  await assert.rejects(() => c.cleanup(custody)); assert.deepEqual(deleted, ['vol-root']);
  await c.cleanup(custody); assert.deepEqual(deleted, ['vol-root', 'vol-data']);
  assert.equal(c.state.phase, 'resources_deleted_cost_reconciliation_pending');
  assert.ok(absence.filter(x => x === 'describe-document').length >= 6); assert.ok(absence.includes('get-role') && absence.includes('get-instance-profile'));
});
test('cleanup refuses sole-copy custody, running instances and foreign volumes before deletion', async () => {
  const operations = [];
  const c = controller(async (service, op) => { operations.push(op); if (op === 'describe-instances') return { Reservations: [] }; return { [{ 'describe-vpcs': 'Vpcs', 'describe-subnets': 'Subnets', 'describe-internet-gateways': 'InternetGateways', 'describe-route-tables': 'RouteTables', 'describe-security-groups': 'SecurityGroups', 'describe-volumes': 'Volumes' }[op]]: op === 'describe-volumes' ? [{ Tags: [], VolumeId: 'vol-foreign' }] : [] }; });
  await assert.rejects(() => c.cleanup({ ...custody, copies: [custody.copies[0]] })); assert.equal(operations.length, 0);
  await assert.rejects(() => c.cleanup(custody)); assert.ok(!operations.some(op => op.startsWith('delete-')));
});
