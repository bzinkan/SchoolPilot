import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudController } from './cloud.mjs';
import { AMI, tags } from './cloud-plan.mjs';

const plan = { runId: 'usage-linux-cleanup-test', accountId: '123456789012', region: 'us-east-1', ami: AMI, stopDeadlineUtc: '2026-10-17T02:00:00Z' };
const owned = properties => ({ Tags: tags(plan), ...properties });
const custody = { kind: 'independently_replayed_dual_private_evidence_custody', passed: true, copies: ['/private/a', '/private/b'].map(root => ({ root, independentReplayPassed: true, replayHookInvoked: true })) };

function networkFixture() {
  const table = owned({ RouteTableId: 'rtb-runner', VpcId: 'vpc-runner', Associations: [{ Main: false, RouteTableAssociationId: 'rtbassoc-runner', SubnetId: 'subnet-runner' }] });
  const inventory = {
    Vpcs: [owned({ VpcId: 'vpc-runner' })],
    Subnets: [owned({ SubnetId: 'subnet-runner', VpcId: 'vpc-runner' })],
    InternetGateways: [owned({ InternetGatewayId: 'igw-runner', Attachments: [{ VpcId: 'vpc-runner' }] })],
    RouteTables: [table],
    SecurityGroups: [owned({ GroupId: 'sg-runner' })],
    Volumes: [],
    Instances: [owned({ InstanceId: 'i-runner', ImageId: AMI.id, InstanceType: 'm7i.4xlarge', State: { Name: 'terminated' } })],
  };
  const reads = { 'describe-vpcs': 'Vpcs', 'describe-subnets': 'Subnets', 'describe-internet-gateways': 'InternetGateways', 'describe-route-tables': 'RouteTables', 'describe-security-groups': 'SecurityGroups', 'describe-volumes': 'Volumes' };
  const calls = [], mutations = [];
  const controller = new CloudController(plan, '/not-used', {});
  controller.seal = async () => {};
  controller.aws = async (service, operation, input) => {
    calls.push({ service, operation, input });
    if (reads[operation]) return { [reads[operation]]: structuredClone(inventory[reads[operation]]) };
    if (operation === 'describe-instances') return { Reservations: [{ Instances: structuredClone(inventory.Instances) }] };
    if (['describe-document', 'get-role', 'get-instance-profile'].includes(operation)) return { absent: true };
    mutations.push(operation);
    switch (operation) {
      case 'delete-security-group':
        assert.equal(input.GroupId, 'sg-runner'); inventory.SecurityGroups = []; break;
      case 'disassociate-route-table':
        assert.equal(input.AssociationId, 'rtbassoc-runner');
        // DeleteSubnet removes this association. A later request for its stale ID
        // cannot resolve the owned route table/subnet for resource-tag authorization.
        if (!table.Associations.length) throw new Error('UnauthorizedOperation: association no longer resolves to a tagged resource');
        table.Associations = []; break;
      case 'delete-route-table':
        assert.equal(input.RouteTableId, 'rtb-runner'); assert.deepEqual(table.Associations, []); inventory.RouteTables = []; break;
      case 'delete-subnet':
        assert.equal(input.SubnetId, 'subnet-runner'); inventory.Subnets = []; table.Associations = []; break;
      case 'detach-internet-gateway':
        assert.deepEqual(input, { InternetGatewayId: 'igw-runner', VpcId: 'vpc-runner' }); inventory.InternetGateways[0].Attachments = []; break;
      case 'delete-internet-gateway':
        assert.equal(input.InternetGatewayId, 'igw-runner'); assert.deepEqual(inventory.InternetGateways[0].Attachments, []); inventory.InternetGateways = []; break;
      case 'delete-vpc':
        assert.equal(input.VpcId, 'vpc-runner');
        for (const name of ['RouteTables', 'Subnets', 'InternetGateways', 'SecurityGroups']) assert.deepEqual(inventory[name], []);
        inventory.Vpcs = []; break;
      default: assert.fail(`unexpected cleanup mutation ${service}/${operation}`);
    }
    return {};
  };
  return { controller, inventory, calls, mutations };
}

test('cleanup disassociates the owned route before subnet deletion removes its authorization target', async () => {
  const f = networkFixture();
  await f.controller.cleanup(custody);
  assert.deepEqual(f.mutations, ['delete-security-group', 'disassociate-route-table', 'delete-route-table', 'delete-subnet', 'detach-internet-gateway', 'delete-internet-gateway', 'delete-vpc']);
  assert.equal(f.calls.filter(x => x.operation === 'describe-route-tables').length, 2, 'the original final inventory still proves absence');
  assert.equal(f.controller.state.phase, 'runner_resources_deleted_operator_scope_closeout_and_cost_pending');
});

test('network cleanup still refuses invalid or nonindependent custody before any native read or mutation', async () => {
  for (const value of [null, { ...custody, kind: 'unreviewed' }, { ...custody, passed: false }, { ...custody, copies: [custody.copies[0]] },
    { ...custody, copies: [custody.copies[0], { ...custody.copies[1], independentReplayPassed: false }] },
    { ...custody, copies: [custody.copies[0], { ...custody.copies[1], replayHookInvoked: false }] },
    { ...custody, copies: [custody.copies[0], { ...custody.copies[1], root: custody.copies[0].root }] }]) {
    const f = networkFixture();
    await assert.rejects(() => f.controller.cleanup(value));
    assert.deepEqual(f.calls, []);
  }
});

test('network cleanup still refuses foreign route tables and subnets before any deletion', async () => {
  for (const name of ['RouteTables', 'Subnets']) {
    const f = networkFixture(); f.inventory[name][0].Tags = [];
    await assert.rejects(() => f.controller.cleanup(custody));
    assert.deepEqual(f.mutations, []);
  }
});
