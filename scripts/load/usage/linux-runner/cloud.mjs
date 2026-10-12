import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { validatePlan, launchRequest, instancePolicy, tags, assertOwnedResource, launchDocument, sftpDocument, stopUserData, RUNNER_DOCUMENT_SUFFIXES } from './cloud-plan.mjs';
import { assertPrivatePath, ensurePrivateDirectory, writePrivateJsonExclusive, writePrivateBytesExclusive, hashFile, sealDualCopyCustody, verifyManifest } from './evidence.mjs';
import { discoveryDocument, decodeDiscoveryEnvelope, validateDiscoveryPins } from './discovery.mjs';
import { renderOperatorScope, validateNativeScopeSnapshot, validateOperatorSession, METADATA_READ_ACTIONS, OWNER_COMMAND_READ_SEPARATE } from './operator-scope.mjs';
import { FREEZE_SHA256 } from './relocation.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function pinned(ref) {
  assert.ok(ref && path.isAbsolute(ref.path) && /^[a-f0-9]{64}$/.test(ref.sha256));
  await assertPrivatePath(ref.path); assert.equal((await hashFile(ref.path)).sha256, ref.sha256);
  return fs.readFile(ref.path);
}
async function privateBytes(file, bytes) {
  await writePrivateBytesExclusive(file, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
}
export async function pinnedExecutable(ref) {
  assert.ok(ref && path.isAbsolute(ref.path) && /^[a-f0-9]{64}$/.test(ref.sha256));
  const actual = await fs.realpath(ref.path); const fold = x => process.platform === 'win32' ? x.toLowerCase() : x;
  assert.equal(fold(actual), fold(path.resolve(ref.path)), 'tool path traverses a link');
  const info = await fs.lstat(ref.path); assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1);
  assert.equal(digest(await fs.readFile(ref.path)), ref.sha256, 'reviewed executable changed');
}
export async function verifyOwnerTools(owner, { platform = process.platform, verify = pinnedExecutable } = {}) {
  const required = ['aws', 'node', 'age', 'ageKeygen', 'ssh', 'sftp', 'sessionManagerPlugin'];
  if (platform === 'win32') required.push('pwsh');
  for (const name of required) { assert.ok(owner?.[name], `owner tool ${name} is not ready`); await verify(owner[name]); }
  assert.equal(path.resolve(owner.node.path), process.execPath);
}
export function validateCleanupReplayReview(review, replay, copies, now = Date.now()) {
  assert.equal(review.schemaVersion, 1); assert.equal(review.kind, 'usage_linux_cleanup_replay_review');
  assert.equal(review.subjectSha256, replay.sha256); assert.equal(review.passed, true);
  assert.equal(review.unresolvedFindings, 0); assert.ok(review.reviewer?.trim());
  assert.ok(Date.parse(review.reviewedAtUtc) <= now && Date.parse(review.reviewedAtUtc) >= now - 86400000);
  assert.equal(copies.length, 2);
  assert.deepEqual([...review.manifestSha256].sort(), copies.map(x => x.manifestCanonicalSha256).sort());
}
export async function containFailedProvision(controller) {
  await controller.seal('provision-failure', { phase: controller.state.phase, resources: controller.state.resources, recoveryRequired: true });
  // RunInstances may have succeeded even when its response did not reach this process.
  try { await controller.stop(); }
  catch { await controller.seal('provision-stop-unproven', { stoppedProven: false, incidentRequired: true }); }
}
export async function waitForDeadlineMonitor(ready, expected, { read = fs.readFile, now = Date.now, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const until = now() + 45000; let handshake;
  while (now() < until) {
    let bytes;
    try { bytes = await read(ready); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    // The private writer creates the file before checking its ACL and writing
    // the complete, newline-terminated JSON. Existence alone is not readiness.
    if (bytes?.at(-1) === 10) {
      assert.ok(now() < until, 'deadline monitor handshake timed out');
      handshake = JSON.parse(bytes); break;
    }
    await pause(Math.min(250, Math.max(0, until - now())));
  }
  assert.equal(handshake?.pid, expected.pid);
  assert.equal(handshake?.requestSha256, expected.requestSha256);
  assert.equal(handshake?.stopDeadlineUtc, expected.stopDeadlineUtc);
  return handshake;
}
export function discoveryBinding(p, state) {
  return { runId: p.runId, accountId: p.accountId, region: p.region, ami: p.ami,
    instanceId: state.resources.instanceId, rootVolumeId: state.resources.rootVolumeId,
    dataVolumeId: state.resources.dataVolumeId, launchNotBeforeUtc: p.launchNotBeforeUtc,
    stopDeadlineUtc: p.stopDeadlineUtc };
}
export function validateOwnerCommandCapture(capture, request, caller, invocation, review, p, state, kind, now = Date.now()) {
  assert.equal(capture.schemaVersion, 1); assert.equal(capture.kind, 'usage_linux_owner_command_capture');
  assert.equal(capture.runId, p.runId); assert.equal(capture.accountId, p.accountId); assert.equal(capture.region, p.region);
  assert.equal(capture.readRoute, OWNER_COMMAND_READ_SEPARATE); assert.equal(capture.ownerCallerArn, p.ownerCallerArn);
  assert.ok(Date.parse(capture.capturedAtUtc) <= now && Date.parse(capture.capturedAtUtc) >= now - 600000);
  assert.equal(caller.Arn, p.ownerCallerArn); assert.equal(caller.Account, p.accountId);
  const commandId = state[`${kind}CommandId`], instanceId = state.resources.instanceId;
  assert.ok(commandId && instanceId); assert.deepEqual(request, { CommandId: commandId, InstanceId: instanceId });
  assert.equal(invocation.CommandId, commandId); assert.equal(invocation.InstanceId, instanceId);
  assert.equal(invocation.DocumentName, state.resources[`${kind}Document`]); assert.equal(invocation.DocumentVersion, state.resources[`${kind}DocumentVersion`]);
  assert.equal(invocation.Status, 'Success'); assert.equal(invocation.ResponseCode, 0); assert.equal(invocation.StandardErrorContent, '');
  assert.equal(review.kind, 'usage_linux_owner_command_capture_review'); assert.equal(review.runId, p.runId);
  assert.equal(review.subjectSha256, capture.invocation.sha256); assert.equal(review.nativeRequestSha256, capture.nativeRequest.sha256); assert.equal(review.nativeCallerSha256, capture.nativeCaller.sha256);
  assert.equal(review.documentSha256, state.resources[`${kind}DocumentHash`]);
  assert.equal(review.passed, true); assert.equal(review.unresolvedFindings, 0); assert.ok(review.reviewer?.trim());
  assert.ok(Date.parse(review.reviewedAtUtc) <= now && Date.parse(review.reviewedAtUtc) >= now - 600000);
}
export async function verifyPacket(p) {
  const read = async ref => JSON.parse(await pinned(ref));
  const implementation = await read(p.implementation), review = await read(p.independentReview), authority = await read(p.authorization), quote = await read(p.priceEvidence), tools = await read(p.toolBindings), canary = await read(p.custodyCanary);
  const access = await read(p.operatorAccess);
  assert.equal(p.ebsKey.sha256, p.ebsKeySha256); const ebsKey = (await read(p.ebsKey)).KeyMetadata;
  assert.equal(ebsKey.Arn, p.ebsKmsKeyArn); assert.equal(ebsKey.KeyManager, 'AWS'); assert.equal(ebsKey.KeyState, 'Enabled'); assert.equal(ebsKey.KeyUsage, 'ENCRYPT_DECRYPT');
  const ebsAliases = await read(p.ebsAliases); assert.equal(ebsAliases.Aliases.filter(a => a.AliasName === 'alias/aws/ebs' && a.TargetKeyId === ebsKey.KeyId).length, 1);
  assert.equal(access.kind, 'usage_linux_scoped_operator_access'); assert.equal(access.runId, p.runId); assert.equal(access.callerArn, p.sessionCallerArn);
  assert.equal(access.effectiveScope, 'runner_only'); assert.equal(access.passed, true); assert.equal(access.unresolvedFindings, 0); assert.ok(access.reviewer?.trim());
  assert.ok(Date.parse(access.capturedAtUtc) <= Date.now() && Date.parse(access.capturedAtUtc) >= Date.now() - 600000);
  assert.ok(access.nativePolicyInputs.length > 0); for (const ref of access.nativePolicyInputs) await pinned(ref);
  const scope = await read(access.operatorScope); assert.deepEqual(scope, renderOperatorScope(scope.settings));
  for (const key of ['runId', 'accountId', 'region', 'availabilityZone', 'instanceType', 'launchNotBeforeUtc', 'stopDeadlineUtc']) assert.equal(scope.settings[key], p[key]);
  assert.equal(scope.settings.sourceCallerArn, p.ownerCallerArn);
  assert.deepEqual(scope.settings.ami, p.ami); assert.equal(scope.names.instanceBoundaryArn, p.instanceBoundaryArn);
  assert.equal(scope.settings.ebsKmsKeyArn, p.ebsKmsKeyArn);
  assert.deepEqual(access.metadataReadExceptions, METADATA_READ_ACTIONS); assert.equal(access.commandOutputReadRoute, OWNER_COMMAND_READ_SEPARATE);
  validateNativeScopeSnapshot(await read(access.nativeScopeSnapshot), scope);
  assert.equal(implementation.schemaVersion, 1); assert.equal(implementation.kind, 'usage_linux_implementation_manifest'); assert.equal(implementation.runId, p.runId);
  assert.equal(implementation.freezeSha256, FREEZE_SHA256);
  const required = ['acquire-session.ps1', 'bootstrap.sh', 'cloud-plan.mjs', 'cloud.mjs', 'discovery.mjs', 'evidence.mjs', 'operator-scope.mjs', 'preflight.mjs', 'relocation.mjs', 'run-campaign.mjs', 'run-campaign.sh', 'stage-input.mjs', 'canary.mjs', 'canary-replay.mjs', 'prepare-fixture.mjs', 'source-checkout.mjs'];
  assert.deepEqual(implementation.scriptBindings.map(x => x.name).sort(), required.sort());
  for (const ref of implementation.scriptBindings) { assert.equal(path.resolve(ref.path), path.join(path.dirname(fileURLToPath(import.meta.url)), ref.name)); await pinnedExecutable(ref); }
  assert.equal(implementation.scriptBindings.find(x => x.name === 'bootstrap.sh').sha256, p.bootstrapSha256);
  assert.equal(review.kind, 'usage_linux_implementation_review'); assert.equal(review.subjectSha256, p.implementationSha256);
  assert.equal(review.unresolvedFindings, 0); assert.equal(review.passed, true); assert.ok(review.reviewer?.trim());
  assert.ok(Date.parse(review.reviewedAtUtc) <= Date.now() && Date.parse(review.reviewedAtUtc) >= Date.now() - 86400000);
  assert.equal(authority.kind, 'owner_runner_scope_authorization'); assert.equal(authority.pretaxCapUsd, 15); assert.equal(authority.maximumActiveHours, 8); assert.equal(authority.maximumExportGiB, 20); assert.equal(authority.failureHoldDays, 7);
  assert.equal(authority.runId, p.runId); assert.equal(authority.implementationSha256, p.implementationSha256); assert.equal(authority.maximumAttempts, 1);
  assert.equal(authority.productionUsage, 'off/off'); assert.equal(authority.acceptanceThresholds, 'unchanged'); assert.equal(authority.productionMutationAuthorized, false);
  assert.equal(quote.readOnly, true); assert.equal(quote.capturedAt, p.pricesCapturedUtc); assert.equal(quote.costs.pretaxCap, 15);
  assert.equal(quote.plannedRates.computeUsdPerHour, 0.8064); assert.equal(quote.plannedRates.gp3UsdPerGbMonth, 0.08); assert.equal(quote.plannedRates.ipv4UsdPerHour, 0.005); assert.equal(quote.plannedRates.chargedEgressUsdPerDecimalGb, 0.09);
  assert.ok(Math.abs(quote.costs.worst8hWithReserves - 13.198977777777777) < 1e-8);
  for (const ref of quote.publicSnapshots) await pinned({ path: ref.file, sha256: ref.sha256 });
  assert.equal(tools.kind, 'usage_linux_tool_bindings'); assert.equal(tools.runId, p.runId);
  assert.deepEqual(tools.owner.aws, p.aws); await verifyOwnerTools(tools.owner);
  await pinned(implementation.controllerConfig);
  if (p.preparationStage === 'ami_discovery') {
    assert.equal(tools.linux.phase, 'pending_native_ami_discovery'); assert.equal(tools.linux.ssmAgent, null);
    assert.deepEqual([...tools.linux.unresolvedPins].sort(), ['ssmAgent', 'ubuntuDebClosure'].sort());
    assert.equal(p.bootstrapTemplate, undefined, 'discovery cannot carry an unproven bootstrap packet');
  } else {
    const template = await read(p.bootstrapTemplate); assert.equal(template.runId, p.runId); assert.deepEqual(template.artifacts, tools.linux.artifacts); assert.deepEqual(template.ssmAgent, tools.linux.ssmAgent);
    assert.equal(template.controller.sha256, implementation.scriptBindings.find(x => x.name === 'run-campaign.sh').sha256);
    assert.equal(template.controller.configSha256, implementation.controllerConfig.sha256);
    assert.equal(tools.linux.phase, 'bootstrap_ready'); assert.deepEqual(tools.linux.unresolvedPins, []);
    const state = await read(p.state), invocation = await read(p.amiDiscovery);
    assert.equal(state.runId, p.runId); assert.equal(invocation.InstanceId, state.resources.instanceId); assert.equal(invocation.CommandId, state.discoveryCommandId); assert.equal(invocation.Status, 'Success');
    assert.equal(invocation.StandardErrorContent, '');
    const pins = validateDiscoveryPins(decodeDiscoveryEnvelope(invocation.StandardOutputContent), discoveryBinding(p, state));
    assert.deepEqual(pins.ssmAgent, tools.linux.ssmAgent);
  }
  // Re-read both retained canary copies; failed or unrelated ciphertext receipts cannot admit launch.
  assert.equal(canary.kind, 'independently_replayed_dual_private_evidence_custody'); assert.equal(canary.passed, true); assert.equal(canary.copies.length, 2);
  for (const copy of canary.copies) { assert.equal(copy.independentReplayPassed, true); await pinned({ path: copy.replayReceipt.file, sha256: copy.replayReceipt.sha256 }); }
  assert.notEqual(path.resolve(canary.copies[0].root), path.resolve(canary.copies[1].root));
  assert.equal(implementation.canaryManifestSha256, canary.copies[0].manifestSha256);
  for (const copy of implementation.canaryCopies) await verifyManifest({ root: copy.root, manifest: await read(copy.manifest), expectedManifestSha256: implementation.canaryManifestSha256 });
  assert.deepEqual(implementation.canaryCopies.map(x => x.root).sort(), canary.copies.map(x => x.root).sort());
  const roundtrip = await read(implementation.canaryRoundtrip);
  assert.equal(roundtrip.kind, 'usage_owner_custody_canary_result'); assert.equal(roundtrip.passed, true);
  assert.deepEqual(roundtrip.realAgeRoundtrips, ['input', 'return']); assert.equal(roundtrip.linuxHostAdmitted, false); assert.equal(roundtrip.custodyReceipt.sha256, p.custodyCanarySha256);
  assert.notEqual(roundtrip.recipients.input, roundtrip.recipients.return);
  for (const direction of ['input', 'return']) {
    const chain = roundtrip.chains[direction]; const encrypted = await read(chain.encryptionReceipt);
    assert.equal(encrypted.direction, direction); assert.equal(encrypted.ageToolSha256, tools.owner.age.sha256);
    assert.equal(encrypted.recipient, roundtrip.recipients[direction]);
    await pinned({ path: encrypted.ciphertext.file, sha256: encrypted.ciphertext.sha256 });
    await pinned(chain.plaintext); await pinned(chain.decrypted);
    assert.equal(chain.plaintext.sha256, chain.decrypted.sha256);
    assert.equal(chain.plaintext.sha256, encrypted.plaintext.sha256);
    assert.equal(chain.ageKeygenSha256, tools.owner.ageKeygen.sha256);
  }
  return { implementation, review, authority, quote, tools };
}
export class CloudController {
  constructor(p, root, credentials, transport) { this.p = p; this.root = root; this.credentials = credentials; this.transport = transport; this.state = { schemaVersion: 1, runId: p.runId, resources: {}, phase: 'prepared' }; }
  async pause(ms) { await new Promise(resolve => setTimeout(resolve, ms)); }
  async seal(label, value) { const out = path.join(this.root, `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}-${label}.json`); await writePrivateJsonExclusive(out, value); return out; }
  async save() { await this.seal('state', this.state); }
  async aws(service, operation, input = {}, missingCodes = []) {
    const token = randomUUID(); const inputPath = path.join(this.root, `${token}-request.json`);
    await writePrivateJsonExclusive(inputPath, input);
    if (this.transport) return this.transport(service, operation, input);
    const args = [service, operation, '--region', this.p.region, '--cli-input-json', `file://${inputPath}`, '--output', 'json', '--no-cli-pager', '--cli-connect-timeout', '15', '--cli-read-timeout', '60'];
    const env = { ...process.env, AWS_ACCESS_KEY_ID: this.credentials.AccessKeyId, AWS_SECRET_ACCESS_KEY: this.credentials.SecretAccessKey, AWS_SESSION_TOKEN: this.credentials.SessionToken, AWS_EC2_METADATA_DISABLED: 'true', AWS_PAGER: '', AWS_CONFIG_FILE: path.join(this.root, 'no-global-config'), AWS_SHARED_CREDENTIALS_FILE: path.join(this.root, 'no-global-credentials') };
    delete env.AWS_PROFILE; delete env.AWS_DEFAULT_PROFILE; delete env.AWS_ENDPOINT_URL;
    for (const key of Object.keys(env)) if (key.startsWith('AWS_ENDPOINT_URL_')) delete env[key];
    const result = spawnSync(this.p.aws.path, args, { env, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 90000 });
    await privateBytes(path.join(this.root, `${token}-stdout.json`), result.stdout ?? '');
    await privateBytes(path.join(this.root, `${token}-stderr.txt`), result.stderr ?? '');
    await this.seal('aws-result', { service, operation, request: inputPath, exitCode: result.status, signal: result.signal, failed: !!result.error });
    if (result.status !== 0) {
      const code = /An error occurred \(([A-Za-z0-9._]+)\)/.exec(result.stderr ?? '')?.[1];
      if (missingCodes.includes(code)) return { absent: true, absenceCode: code };
      throw new Error(`AWS ${service}/${operation} failed; private receipt retained`);
    }
    return result.stdout?.trim() ? JSON.parse(result.stdout) : {};
  }
  async authenticate() {
    const caller = await this.aws('sts', 'get-caller-identity'); assert.equal(caller.Account, this.p.accountId);
    assert.equal(caller.Arn, this.p.sessionCallerArn);
    assert.match(this.credentials.AccessKeyId, /^ASIA/); assert.ok(this.credentials.SessionToken?.length > 20);
    assert.ok(Date.parse(this.credentials.Expiration) > Date.parse(this.p.stopDeadlineUtc) + 15 * 60000, 'session expires before stop and cleanup margin');
    await this.seal('identity', { accountId: caller.Account, arn: caller.Arn, expiresUtc: this.credentials.Expiration, mfaReceipt: this.p.sessionReceiptSha256 });
  }
  async provision(userData) {
    const p = validatePlan(this.p); await this.authenticate();
    assert.equal(p.preparationStage, 'ami_discovery', 'one launch precedes native pins; bootstrap uses the same instance');
    assert.ok(userData.equals(stopUserData(p)), 'user-data must be the fixed absolute stop timer');
    const image = (await this.aws('ec2', 'describe-images', { ImageIds: [p.ami.id] })).Images;
    assert.equal(image.length, 1); assert.equal(image[0].OwnerId, p.ami.owner); assert.equal(image[0].Name, p.ami.name); assert.equal(image[0].Architecture, 'x86_64'); assert.equal(image[0].State, 'available');
    const existing = await this.aws('ec2', 'describe-instances', { Filters: [{ Name: 'tag:RunId', Values: [p.runId] }, { Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'stopped'] }] });
    assert.equal(existing.Reservations.flatMap(r => r.Instances).length, 0, 'run already owns an instance; inspect instead of provisioning again');
    const t = ResourceType => [{ ResourceType, Tags: tags(p) }];
    const r = this.state.resources;
    r.vpcId = (await this.aws('ec2', 'create-vpc', { CidrBlock: '10.247.0.0/24', TagSpecifications: t('vpc') })).Vpc.VpcId; await this.save();
    await this.aws('ec2', 'modify-vpc-attribute', { VpcId: r.vpcId, EnableDnsSupport: { Value: true } });
    r.subnetId = (await this.aws('ec2', 'create-subnet', { VpcId: r.vpcId, CidrBlock: '10.247.0.0/24', AvailabilityZone: p.availabilityZone, TagSpecifications: t('subnet') })).Subnet.SubnetId; await this.save();
    r.internetGatewayId = (await this.aws('ec2', 'create-internet-gateway', { TagSpecifications: t('internet-gateway') })).InternetGateway.InternetGatewayId; await this.save();
    await this.aws('ec2', 'attach-internet-gateway', { InternetGatewayId: r.internetGatewayId, VpcId: r.vpcId });
    r.routeTableId = (await this.aws('ec2', 'create-route-table', { VpcId: r.vpcId, TagSpecifications: t('route-table') })).RouteTable.RouteTableId; await this.save();
    await this.aws('ec2', 'create-route', { RouteTableId: r.routeTableId, DestinationCidrBlock: '0.0.0.0/0', GatewayId: r.internetGatewayId });
    r.routeAssociationId = (await this.aws('ec2', 'associate-route-table', { SubnetId: r.subnetId, RouteTableId: r.routeTableId })).AssociationId; await this.save();
    r.groupId = (await this.aws('ec2', 'create-security-group', { VpcId: r.vpcId, GroupName: p.runId, Description: 'No inbound access; isolated Usage acceptance runner', TagSpecifications: t('security-group') })).GroupId; await this.save();
    // No ingress rule is added. Bootstrap has outbound access; host policy closes it before load.
    const trust = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }] };
    await this.aws('iam', 'create-role', { RoleName: p.runId, AssumeRolePolicyDocument: JSON.stringify(trust), Tags: tags(p), MaxSessionDuration: 3600, PermissionsBoundary: p.instanceBoundaryArn }); r.roleName = p.runId; await this.save();
    await this.aws('iam', 'put-role-policy', { RoleName: p.runId, PolicyName: 'ssm-channels-only', PolicyDocument: JSON.stringify(instancePolicy()) });
    r.profileArn = (await this.aws('iam', 'create-instance-profile', { InstanceProfileName: p.runId, Tags: tags(p) })).InstanceProfile.Arn; await this.save();
    await this.aws('iam', 'add-role-to-instance-profile', { InstanceProfileName: p.runId, RoleName: p.runId });
    await this.verifyInstanceRole(trust);
    // No automatic second instance attempt. ClientToken also fences an uncertain result.
    assert.ok(Date.now() < Date.parse(p.launchNotBeforeUtc) + 10 * 60000);
    this.state.phase = 'launch_requested'; await this.save();
    const result = await this.aws('ec2', 'run-instances', launchRequest(p, r, userData.toString('base64')));
    assert.equal(result.Instances.length, 1); r.instanceId = result.Instances[0].InstanceId;
    this.state.launchTimeUtc = result.Instances[0].LaunchTime; this.state.phase = 'provisioned'; await this.save();
    // Resolve exact owned volumes from the instance, never a size-based disk guess.
    const instance = await this.instance();
    const volumes = (await this.aws('ec2', 'describe-volumes', { VolumeIds: instance.BlockDeviceMappings.map(x => x.Ebs.VolumeId) })).Volumes;
    assert.equal(volumes.length, 2);
    for (const volume of volumes) { assertOwnedResource(volume, p); assert.equal(volume.Encrypted, true); assert.equal(volume.KmsKeyId, p.ebsKmsKeyArn); assert.equal(volume.VolumeType, 'gp3'); assert.equal(volume.Iops, 3000); assert.equal(volume.Throughput, 125); }
    const root = instance.BlockDeviceMappings.find(x => x.DeviceName === instance.RootDeviceName); const data = instance.BlockDeviceMappings.find(x => x.DeviceName === '/dev/sdf');
    assert.ok(root && data); r.rootVolumeId = root.Ebs.VolumeId; r.dataVolumeId = data.Ebs.VolumeId;
    assert.equal(volumes.find(x => x.VolumeId === r.rootVolumeId).Size, 30); assert.equal(volumes.find(x => x.VolumeId === r.dataVolumeId).Size, 200);
    assert.ok(instance.BlockDeviceMappings.every(x => x.Ebs.DeleteOnTermination === false)); await this.save();
    const doc = discoveryDocument(discoveryBinding(p, this.state));
    r.discoveryDocument = `${p.runId}-discovery`;
    const bound = (await this.aws('ssm', 'create-document', { Name: r.discoveryDocument, DocumentType: 'Command', DocumentFormat: 'JSON', Content: JSON.stringify(doc), Tags: tags(p) })).DocumentDescription;
    r.discoveryDocumentHash = bound.Hash; r.discoveryDocumentVersion = bound.DocumentVersion; assert.equal(bound.HashType, 'Sha256');
    this.state.phase = 'awaiting_ami_discovery'; await this.save(); return this.state;
  }
  async verifyInstanceRole(trust) {
    const p = this.p, role = (await this.aws('iam', 'get-role', { RoleName: p.runId })).Role;
    assert.equal(role.Arn, `arn:aws:iam::${p.accountId}:role/${p.runId}`); assertOwnedResource(role, p);
    assert.equal(role.PermissionsBoundary?.PermissionsBoundaryArn, p.instanceBoundaryArn); assert.deepEqual(role.AssumeRolePolicyDocument, trust);
    const inline = await this.aws('iam', 'get-role-policy', { RoleName: p.runId, PolicyName: 'ssm-channels-only' });
    assert.deepEqual(inline.PolicyDocument, instancePolicy());
    assert.deepEqual((await this.aws('iam', 'list-attached-role-policies', { RoleName: p.runId })).AttachedPolicies, []);
    assert.deepEqual((await this.aws('iam', 'list-role-policies', { RoleName: p.runId })).PolicyNames, ['ssm-channels-only']);
    const profile = (await this.aws('iam', 'get-instance-profile', { InstanceProfileName: p.runId })).InstanceProfile;
    assertOwnedResource(profile, p); assert.equal(profile.Roles.length, 1); assert.equal(profile.Roles[0].Arn, role.Arn);
  }
  async prepareBootstrap(bootstrap, bootstrapTemplate) {
    const p = this.p, r = this.state.resources;
    assert.equal(p.preparationStage, 'bootstrap_ready'); await this.authenticate(); await this.instance();
    assert.ok(Date.now() < Date.parse(p.stopDeadlineUtc), 'the original deadline cannot be extended');
    const config = { ...bootstrapTemplate, instance: { instanceId: r.instanceId, region: p.region, launchTimeUtc: new Date(this.state.launchTimeUtc).toISOString().replace(/\.\d{3}Z$/, 'Z'), deadlineUtc: new Date(p.stopDeadlineUtc).toISOString().replace(/\.\d{3}Z$/, 'Z'), dataVolumeId: r.dataVolumeId, rootVolumeId: r.rootVolumeId, rootGiB: 30, dataGiB: 200 } };
    const configBytes = Buffer.from(JSON.stringify(config)); await this.seal('actual-bootstrap-config', config);
    const command = ['set -eu', 'umask 077', 'install -d -m 700 /opt/usage', 'test ! -e /opt/usage/bootstrap.sh', `printf '%s' '${bootstrap.toString('base64')}' | base64 -d > /opt/usage/bootstrap.sh`, `printf '%s' '${configBytes.toString('base64')}' | base64 -d > /opt/usage/bootstrap.json`, `test "$(sha256sum /opt/usage/bootstrap.sh | cut -d\" \" -f1)" = '${p.bootstrapSha256}'`, `test "$(sha256sum /opt/usage/bootstrap.json | cut -d\" \" -f1)" = '${digest(configBytes)}'`, 'chmod 600 /opt/usage/bootstrap.json', 'chmod 700 /opt/usage/bootstrap.sh', '/opt/usage/bootstrap.sh --install /opt/usage/bootstrap.json'];
    const doc = { schemaVersion: '2.2', description: 'Exact nonsecret Usage runner bootstrap; no parameters', mainSteps: [{ action: 'aws:runShellScript', name: 'Bootstrap', inputs: { timeoutSeconds: '3600', runCommand: command } }] };
    r.bootstrapDocument = `${p.runId}-bootstrap`; const bound = (await this.aws('ssm', 'create-document', { Name: r.bootstrapDocument, DocumentType: 'Command', DocumentFormat: 'JSON', Content: JSON.stringify(doc), Tags: tags(p) })).DocumentDescription;
    r.bootstrapDocumentHash = bound.Hash; r.bootstrapDocumentVersion = bound.DocumentVersion; assert.equal(bound.HashType, 'Sha256'); await this.save();
    // A launch document requires fresh host/window admission and is bound separately after preparation.
    r.sftpDocument = `${p.runId}-sftp`; await this.aws('ssm', 'create-document', { Name: r.sftpDocument, DocumentType: 'Session', DocumentFormat: 'JSON', Content: JSON.stringify(sftpDocument()), Tags: tags(p) }); await this.save();
    // Operator explicitly sends the fixed bootstrap document after SSM registration.
    this.state.phase = 'awaiting_bootstrap'; await this.save(); return this.state;
  }
  async sendBoundCommand(kind, timeoutSeconds) {
    assert.ok(['discovery', 'bootstrap'].includes(kind)); await this.authenticate(); await this.instance();
    assert.ok(Date.now() < Date.parse(this.p.stopDeadlineUtc)); const r = this.state.resources;
    const name = r[`${kind}Document`], version = r[`${kind}DocumentVersion`], hash = r[`${kind}DocumentHash`];
    assert.ok(name && version && /^[a-f0-9]{64}$/.test(hash));
    const doc = await this.aws('ssm', 'get-document', { Name: name, DocumentVersion: version, DocumentFormat: 'JSON' });
    assert.equal(digest(Buffer.from(doc.Content)), hash); assert.equal(doc.DocumentVersion, version);
    const receipt = await this.aws('ssm', 'send-command', { DocumentName: name, DocumentVersion: version, DocumentHash: hash, DocumentHashType: 'Sha256', InstanceIds: [r.instanceId], TimeoutSeconds: timeoutSeconds, CloudWatchOutputConfig: { CloudWatchOutputEnabled: false } });
    this.state[`${kind}CommandId`] = receipt.Command.CommandId; await this.seal(`${kind}-command`, receipt); await this.save(); return receipt;
  }
  async instance() {
    const id = this.state.resources.instanceId; assert.match(id, /^i-[a-f0-9]+$/);
    const all = (await this.aws('ec2', 'describe-instances', { InstanceIds: [id] })).Reservations.flatMap(x => x.Instances);
    assert.equal(all.length, 1); assert.equal(all[0].InstanceId, id); assertOwnedResource(all[0], this.p);
    assert.equal(all[0].InstanceType, 'm7i.4xlarge'); assert.equal(all[0].ImageId, this.p.ami.id); return all[0];
  }
  async discover() {
    // Reconcile an uncertain Create* response using the exact unique run tags, never account-wide deletion.
    const p = this.p, filters = [{ Name: 'tag:RunId', Values: [p.runId] }, { Name: 'tag:Purpose', Values: ['usage-linux-acceptance'] }];
    const inventory = {};
    for (const [operation, collection] of [['describe-vpcs', 'Vpcs'], ['describe-subnets', 'Subnets'], ['describe-internet-gateways', 'InternetGateways'], ['describe-route-tables', 'RouteTables'], ['describe-security-groups', 'SecurityGroups'], ['describe-volumes', 'Volumes']]) {
      const list = (await this.aws('ec2', operation, { Filters: filters }))[collection];
      for (const item of list) assertOwnedResource(item, p);
      assert.ok(list.length <= (collection === 'Volumes' ? 2 : 1), 'unexpected duplicate owned resources'); inventory[collection] = list;
    }
    inventory.Instances = (await this.aws('ec2', 'describe-instances', { Filters: filters })).Reservations.flatMap(x => x.Instances);
    for (const item of inventory.Instances) assertOwnedResource(item, p); assert.ok(inventory.Instances.length <= 1);
    await this.seal('owned-inventory', inventory); return inventory;
  }
  async stop() {
    if (!this.state.resources.instanceId) {
      let matches = [];
      const uncertainLaunch = this.state.phase === 'launch_requested';
      for (let attempt = 0; attempt < (uncertainLaunch ? 6 : 1); attempt++) {
        matches = (await this.aws('ec2', 'describe-instances', { Filters: [{ Name: 'tag:RunId', Values: [this.p.runId] }, { Name: 'tag:Purpose', Values: ['usage-linux-acceptance'] }] })).Reservations.flatMap(x => x.Instances);
        assert.ok(matches.length <= 1); for (const item of matches) assertOwnedResource(item, this.p);
        if (matches.length) break;
        if (uncertainLaunch) await this.pause(5000);
      }
      if (!matches.length) {
        await this.seal('stop-result', { instanceAbsent: !uncertainLaunch, launchOutcomeUnproven: uncertainLaunch, incidentRequired: uncertainLaunch });
        assert.ok(!uncertainLaunch, 'ambiguous launch remains unproven; deadline monitor retained'); return;
      }
      this.state.resources.instanceId = matches[0].InstanceId;
    }
    const instance = await this.instance(); if (!['stopped', 'terminated', 'stopping'].includes(instance.State.Name)) await this.aws('ec2', 'stop-instances', { InstanceIds: [instance.InstanceId] }); this.state.phase = 'stop_requested'; await this.save();
  }
  async cleanup(custody) {
    assert.equal(custody?.kind, 'independently_replayed_dual_private_evidence_custody');
    assert.equal(custody.passed, true); assert.equal(custody.copies?.length, 2);
    assert.ok(custody.copies.every(x => x.independentReplayPassed && x.replayHookInvoked));
    assert.notEqual(path.resolve(custody.copies[0].root), path.resolve(custody.copies[1].root));
    const inventory = await this.discover(), instance = inventory.Instances[0];
    if (instance) {
      assert.equal(instance.ImageId, this.p.ami.id); assert.equal(instance.InstanceType, 'm7i.4xlarge');
      assert.ok(['stopped', 'terminated'].includes(instance.State.Name));
      if (instance.State.Name !== 'terminated') {
        await this.aws('ec2', 'terminate-instances', { InstanceIds: [instance.InstanceId] }); this.state.phase = 'termination_requested'; await this.save();
        await this.seal('cleanup-pending', { instanceId: instance.InstanceId, custody: custody.receipt, reason: 'Termination and volume detachment must be proven before deletion; rerun exact cleanup.' }); return;
      }
    }
    const deleted = async (service, operation, input) => { await this.aws(service, operation, input); await this.seal('resource-deletion', { service, operation, input, completedUtc: new Date().toISOString() }); };
    for (const volume of inventory.Volumes) {
      assert.ok(volume.State === 'available' && volume.Attachments.length === 0);
      assert.equal(volume.Encrypted, true); assert.ok([30, 200].includes(volume.Size));
      await deleted('ec2', 'delete-volume', { VolumeId: volume.VolumeId });
    }
    for (const group of inventory.SecurityGroups) await deleted('ec2', 'delete-security-group', { GroupId: group.GroupId });
    for (const subnet of inventory.Subnets) await deleted('ec2', 'delete-subnet', { SubnetId: subnet.SubnetId });
    for (const table of inventory.RouteTables) { for (const association of table.Associations ?? []) if (!association.Main) await this.aws('ec2', 'disassociate-route-table', { AssociationId: association.RouteTableAssociationId }, ['InvalidAssociationID.NotFound']); await deleted('ec2', 'delete-route-table', { RouteTableId: table.RouteTableId }); }
    for (const gateway of inventory.InternetGateways) { for (const attachment of gateway.Attachments) { assert.ok(inventory.Vpcs.some(x => x.VpcId === attachment.VpcId)); await this.aws('ec2', 'detach-internet-gateway', { InternetGatewayId: gateway.InternetGatewayId, VpcId: attachment.VpcId }); } await deleted('ec2', 'delete-internet-gateway', { InternetGatewayId: gateway.InternetGatewayId }); }
    for (const vpc of inventory.Vpcs) await deleted('ec2', 'delete-vpc', { VpcId: vpc.VpcId });
    const documents = RUNNER_DOCUMENT_SUFFIXES.map(suffix => `${this.p.runId}-${suffix}`);
    for (const name of documents) {
      const found = await this.aws('ssm', 'describe-document', { Name: name }, ['InvalidDocument']);
      if (!found.absent) { const list = await this.aws('ssm', 'list-tags-for-resource', { ResourceType: 'Document', ResourceId: name }); assertOwnedResource({ Tags: list.TagList }, this.p); await deleted('ssm', 'delete-document', { Name: name }); }
    }
    const role = await this.aws('iam', 'get-role', { RoleName: this.p.runId }, ['NoSuchEntity']);
    const profile = await this.aws('iam', 'get-instance-profile', { InstanceProfileName: this.p.runId }, ['NoSuchEntity']);
    if (!profile.absent) {
      assertOwnedResource(profile.InstanceProfile, this.p); assert.ok(profile.InstanceProfile.Roles.every(x => x.RoleName === this.p.runId));
      if (profile.InstanceProfile.Roles.length) await this.aws('iam', 'remove-role-from-instance-profile', { InstanceProfileName: this.p.runId, RoleName: this.p.runId });
      await deleted('iam', 'delete-instance-profile', { InstanceProfileName: this.p.runId });
    }
    if (!role.absent) { assertOwnedResource(role.Role, this.p); await this.aws('iam', 'delete-role-policy', { RoleName: this.p.runId, PolicyName: 'ssm-channels-only' }, ['NoSuchEntity']); await deleted('iam', 'delete-role', { RoleName: this.p.runId }); }
    const remaining = await this.discover();
    assert.ok(Object.entries(remaining).every(([name, list]) => name === 'Instances' ? list.every(x => x.State.Name === 'terminated') : list.length === 0));
    for (const name of documents) assert.equal((await this.aws('ssm', 'describe-document', { Name: name }, ['InvalidDocument'])).absent, true);
    assert.equal((await this.aws('iam', 'get-role', { RoleName: this.p.runId }, ['NoSuchEntity'])).absent, true);
    assert.equal((await this.aws('iam', 'get-instance-profile', { InstanceProfileName: this.p.runId }, ['NoSuchEntity'])).absent, true);
    // The scoped principal cannot delete or edit its own IAM grants. The attended
    // owner must close out those exact bootstrap-created policies/role separately.
    this.state.phase = 'runner_resources_deleted_operator_scope_closeout_and_cost_pending'; await this.save();
  }
}

async function main() {
  const [action, requestPath, flag, expected] = process.argv.slice(2);
  assert.ok(['validate', 'provision', 'discover-ami', 'collect-discovery', 'prepare-bootstrap', 'inspect', 'bootstrap', 'stop', 'cleanup', 'watch-deadline'].includes(action));
  assert.equal(flag, '--request-sha256'); const raw = await pinned({ path: requestPath, sha256: expected }); const p = JSON.parse(raw);
  validatePlan(p, action === 'provision' ? Date.now() : Date.parse(p.launchNotBeforeUtc));
  try { await ensurePrivateDirectory(p.outputRoot); } catch (e) { if (e.code !== 'ENOENT') throw e; await ensurePrivateDirectory(p.outputRoot, { create: true }); }
  await pinnedExecutable(p.aws);
  const session = JSON.parse(await pinned(p.session)); assert.equal(p.session.sha256, p.sessionReceiptSha256);
  validateOperatorSession(session, p);
  const parent = JSON.parse(await pinned(session.parentMfaSession)); assert.equal(parent.kind, 'usage_linux_mfa_session'); assert.equal(parent.accountId, p.accountId); assert.equal(parent.mfaSerial, session.mfaSerial); assert.equal(parent.callerArn, p.ownerCallerArn);
  const scope = JSON.parse(await pinned(session.operatorScope)); assert.deepEqual(scope, renderOperatorScope(scope.settings)); assert.equal(scope.settings.sourceCallerArn, parent.callerArn);
  const nativeCaller = JSON.parse(await pinned(session.nativeCaller)); assert.equal(nativeCaller.Arn, p.sessionCallerArn); assert.equal(nativeCaller.Account, p.accountId);
  assert.ok(Date.parse(session.acquiredAtUtc) <= Date.now() && Number.isFinite(Date.parse(session.acquiredAtUtc)));
  validateNativeScopeSnapshot(JSON.parse(await pinned(session.nativeScopeSnapshot)), scope, Date.parse(session.acquiredAtUtc));
  const assumed = JSON.parse(await pinned(session.nativeAssumeRole)); assert.equal(assumed.AssumedRoleUser.Arn, p.sessionCallerArn);
  assert.equal(nativeCaller.UserId, assumed.AssumedRoleUser.AssumedRoleId);
  assert.deepEqual(session.credentials, session.nativeAssumeRole);
  const credentials = JSON.parse(await pinned(session.credentials)).Credentials;
  assert.equal(Date.parse(session.expiresUtc), Date.parse(credentials.Expiration));
  if (['validate', 'provision', 'discover-ami', 'prepare-bootstrap', 'bootstrap'].includes(action)) {
    await pinned(p.userData); await pinnedExecutable(p.bootstrap);
    assert.equal(p.bootstrap.sha256, p.bootstrapSha256); assert.equal(p.userData.sha256, p.userDataSha256);
    for (const name of ['implementation', 'independentReview', 'authorization', 'priceEvidence', 'custodyCanary', 'toolBindings', 'operatorAccess']) assert.equal(p[name].sha256, p[`${name}Sha256`]);
    await verifyPacket(p);
  }
  const c = new CloudController(p, p.outputRoot, credentials);
  if (p.state) { c.state = JSON.parse(await pinned(p.state)); assert.equal(c.state.runId, p.runId); }
  if (action === 'validate') { console.log('Validated bounded provisioning packet; measured traffic remains unadmitted.'); return; }
  if (action === 'provision') {
    assert.equal(p.state, undefined);
    // Start the independent owner monitor BEFORE any paid launch. It survives terminal closure.
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'watch-deadline', requestPath, '--request-sha256', expected], { detached: true, windowsHide: true, stdio: 'ignore' }); child.unref();
    const ready = path.join(p.outputRoot, `monitor-ready-${expected}.json`);
    await waitForDeadlineMonitor(ready, { pid: child.pid, requestSha256: expected, stopDeadlineUtc: p.stopDeadlineUtc });
    await c.seal('deadline-monitor', { pid: child.pid, stopDeadlineUtc: p.stopDeadlineUtc });
    try { await c.provision(await pinned(p.userData)); }
    catch { await containFailedProvision(c); throw new Error('Provisioning failed; private receipts and exact cleanup inventory retained.'); }
  } else if (action === 'inspect') { await c.authenticate(); await c.seal('inspection', await c.instance()); }
  else if (action === 'stop') { await c.authenticate(); await c.stop(); }
  else if (action === 'discover-ami') { assert.equal(p.preparationStage, 'ami_discovery'); await c.sendBoundCommand('discovery', 120); }
  else if (action === 'collect-discovery') {
    await c.authenticate(); await c.instance(); assert.ok(c.state.discoveryCommandId);
    // AWS cannot resource-scope GetCommandInvocation. The runner role never gets it.
    // A separate attended owner read binds the exact native request/caller/output.
    const capture = JSON.parse(await pinned(p.ownerCommandCapture));
    const request = JSON.parse(await pinned(capture.nativeRequest)), caller = JSON.parse(await pinned(capture.nativeCaller));
    const invocation = JSON.parse(await pinned(capture.invocation)), review = JSON.parse(await pinned(capture.independentReview));
    const doc = await c.aws('ssm', 'get-document', { Name: c.state.resources.discoveryDocument, DocumentVersion: c.state.resources.discoveryDocumentVersion, DocumentFormat: 'JSON' });
    assert.equal(doc.DocumentVersion, c.state.resources.discoveryDocumentVersion); assert.equal(digest(Buffer.from(doc.Content)), c.state.resources.discoveryDocumentHash);
    validateOwnerCommandCapture(capture, request, caller, invocation, review, p, c.state, 'discovery');
    const rawPath = await c.seal('ami-discovery-invocation', invocation);
    assert.equal(invocation.Status, 'Success'); assert.equal(invocation.StandardErrorContent, '');
    const facts = decodeDiscoveryEnvelope(invocation.StandardOutputContent); validateDiscoveryPins(facts, discoveryBinding(p, c.state));
    await c.seal('ami-discovery-facts', facts); c.state.phase = 'native_ami_pins_captured'; c.state.amiDiscovery = { path: rawPath, ...(await hashFile(rawPath)) }; await c.save();
  }
  else if (action === 'prepare-bootstrap') { await c.prepareBootstrap(await fs.readFile(p.bootstrap.path), JSON.parse(await pinned(p.bootstrapTemplate))); }
  else if (action === 'bootstrap') { assert.equal(p.preparationStage, 'bootstrap_ready'); await c.sendBoundCommand('bootstrap', 3600); }
  else if (action === 'cleanup') {
    await c.authenticate();
    const replayTool = p.custody.replay; await pinnedExecutable(replayTool);
    validateCleanupReplayReview(JSON.parse(await pinned(p.custody.replayReview)), replayTool, p.custody.copies);
    const copies = [];
    for (const copy of p.custody.copies) {
      const manifest = JSON.parse(await pinned(copy.manifest));
      copies.push({ root: copy.root, manifest, expectedManifestSha256: copy.manifestCanonicalSha256, replay: async facts => {
        const input = await c.seal('replay-input', facts);
        const output = path.join(p.outputRoot, `${randomUUID()}-replay-receipt.json`);
        await pinnedExecutable(replayTool);
        const run = spawnSync(process.execPath, [replayTool.path, input, output], { windowsHide: true, stdio: 'ignore', timeout: 300000, env: { ...process.env } });
        await pinnedExecutable(replayTool);
        assert.equal(run.status, 0, 'independent replay failed');
        const record = JSON.parse(await fs.readFile(output)); const receipt = await hashFile(output);
        return { passed: record.passed, reviewer: record.reviewer, receipt: { file: output, ...receipt } };
      } });
    }
    const receiptPath = path.join(p.outputRoot, `${randomUUID()}-dual-custody.json`);
    await c.cleanup(await sealDualCopyCustody({ copies, receiptPath }));
  }
  else {
    await c.authenticate();
    await writePrivateJsonExclusive(path.join(p.outputRoot, `monitor-ready-${expected}.json`), { pid: process.pid, requestSha256: expected, stopDeadlineUtc: p.stopDeadlineUtc, readyAtUtc: new Date().toISOString() });
    while (Date.now() < Date.parse(p.stopDeadlineUtc)) await new Promise(resolve => setTimeout(resolve, Math.min(30000, Date.parse(p.stopDeadlineUtc) - Date.now())));
    // Discover uncertain launch by the exact tag and enforce stop, including lost RunInstances response.
    let result;
    for (let attempt = 0; attempt < 10; attempt++) {
      try { result = await c.aws('ec2', 'describe-instances', { Filters: [{ Name: 'tag:RunId', Values: [p.runId] }, { Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'stopped'] }] }); break; }
      catch { await c.seal('deadline-discovery-failure', { attempt, stoppedProven: false, incidentRequired: true }); await new Promise(resolve => setTimeout(resolve, 15000)); }
    }
    assert.ok(result, 'deadline discovery unproven; incident response required');
    const instances = result.Reservations.flatMap(x => x.Instances); assert.ok(instances.length <= 1);
    if (instances.length) {
      assertOwnedResource(instances[0], p); c.state.resources.instanceId = instances[0].InstanceId;
      let stopped = false;
      for (let attempt = 0; attempt < 10; attempt++) {
        try { await c.stop(); const observed = await c.instance(); if (['stopped', 'terminated'].includes(observed.State.Name)) { stopped = true; break; } }
        catch { await c.seal('deadline-stop-failure', { attempt, stoppedProven: false, incidentRequired: true }); }
        await new Promise(resolve => setTimeout(resolve, 15000));
      }
      await c.seal('deadline-result', { stoppedProven: stopped, incidentRequired: !stopped, instanceId: instances[0].InstanceId, checkedUtc: new Date().toISOString() });
      assert.ok(stopped, 'deadline stop unproven; incident response required');
    } else await c.seal('deadline-result', { stoppedProven: true, instanceCount: 0, checkedUtc: new Date().toISOString() });
  }
  console.log('Operation recorded privately. Usage and acceptance policy unchanged.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error('Runner operation refused or failed; inspect private receipts.'); process.exitCode = 1; });
