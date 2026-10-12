import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { AMI, stopUserData } from './cloud-plan.mjs';
import { discoveryDocument, decodeDiscoveryEnvelope, validateDiscoveryPins, MAX_DISCOVERY_RAW_BYTES, MAX_DISCOVERY_WIRE_BYTES } from './discovery.mjs';

const sha = (v) => createHash('sha256').update(v).digest('hex');
const now = Date.parse('2026-10-12T15:00:05Z');
function expected() { return { runId: 'usage-linux-discovery-20261012', accountId: '123456789012', region: 'us-east-1', ami: { ...AMI }, instanceId: 'i-1234567890abcdef0', rootVolumeId: 'vol-1234567890abcdef0', dataVolumeId: 'vol-abcdef12345678900', launchNotBeforeUtc: '2026-10-12T14:00:00Z', stopDeadlineUtc: '2026-10-12T22:00:00Z' }; }
function documentInput(p = expected()) {
  const document = discoveryDocument(p);
  const script = document.mainSteps[0].inputs.runCommand[2];
  const data = JSON.parse(Buffer.from(script.match(/base64\.b64decode\('([A-Za-z0-9+/=]+)'\)/)[1], 'base64'));
  return { document, script, data };
}
function facts() {
  const p = expected(), files = documentInput(p).data.files;
  const listing = 'Name              Version    Rev   Tracking       Publisher  Notes\namazon-ssm-agent  3.3.100.0   1000  latest/stable  aws        classic\n';
  const raw = 'base-files\t13ubuntu10.5\tamd64\tii \nobsolete-package\t1.0\tall\trc \nsnapd\t2.76.3+ubuntu24.04\tamd64\tii \n';
  return { schemaVersion: 1, kind: 'usage_linux_ami_discovery', binding: p, capturedAt: '2026-10-12T15:00:00.000Z',
    identity: { accountId: p.accountId, architecture: 'x86_64', imageId: p.ami.id, instanceId: p.instanceId, region: p.region, pendingTime: '2026-10-12T14:00:01Z' },
    stop: { deadlineUtc: p.stopDeadlineUtc, nextDeadlineUtc: p.stopDeadlineUtc, timerActive: true, dropInsAbsent: true, deadlineSha256: sha(files.deadline), timerSha256: sha(files.timer), serviceSha256: sha(files.service) },
    ssmAgent: { name: 'amazon-ssm-agent', version: '3.3.100.0', snapRevision: '1000', currentPath: '/snap/amazon-ssm-agent/1000', listing, listingSha256: sha(listing) },
    packages: { raw, count: 3, installedCount: 2, sha256: sha(raw) }, dpkgAudit: '',
    disks: { blockdevices: [{ name: 'nvme0n1', path: '/dev/nvme0n1', type: 'disk', size: 30 * 1024 ** 3, serial: p.rootVolumeId.replaceAll('-', ''), mountpoints: [null], children: [{ name: 'nvme0n1p1', path: '/dev/nvme0n1p1', type: 'part', size: 29 * 1024 ** 3, serial: null, mountpoints: ['/'] }] }, { name: 'nvme1n1', path: '/dev/nvme1n1', type: 'disk', size: 200 * 1024 ** 3, serial: p.dataVolumeId.replaceAll('-', ''), mountpoints: [null] }] },
    bootstrapReady: false, measurementReady: false, capacityAccepted: false, productionReady: false, imdsSignatureVerified: false };
}
function envelope(value) {
  const raw = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const compressed = deflateSync(raw);
  return { schemaVersion: 1, kind: 'usage_linux_ami_discovery_envelope', encoding: 'zlib-base64', rawBytes: raw.length, rawSha256: sha(raw), compressedBytes: compressed.length, compressedSha256: sha(compressed), payload: compressed.toString('base64'), complete: true, endMarker: 'usage_linux_ami_discovery_complete_v1' };
}

test('fixed parameter-free discovery reads only native identity, timer, package and disk facts', () => {
  const { document, script, data } = documentInput();
  assert.equal(document.parameters, undefined); assert.equal(document.mainSteps.length, 1);
  assert.equal(document.mainSteps[0].action, 'aws:runShellScript'); assert.equal(document.mainSteps[0].inputs.timeoutSeconds, '120');
  assert.deepEqual(data.binding, expected());
  const initial = stopUserData(expected()).toString();
  for (const file of [data.files.timer, data.files.service]) assert.ok(initial.includes(file), 'same unchanged original stop unit bytes');
  assert.ok(initial.includes(`'${expected().stopDeadlineUtc}'`));
  assert.match(script, /169\.254\.169\.254\/latest\//); assert.match(script, /ProxyHandler\(\{\}\)/); assert.match(script, /NoRedirect/);
  assert.match(script, /'PUT'.*X-aws-ec2-metadata-token-ttl-seconds/);
  assert.match(script, /DropInPaths/); assert.match(script, /NextElapseUSecRealtime/);
  assert.match(script, /\['snap','list','amazon-ssm-agent'\]/); assert.match(script, /\['dpkg','--audit'\]/);
  assert.doesNotMatch(script, /shell=True|os\.environ|print\(token|read_text\(.*(?:credentials|private)|apt-get|snap.*refresh|systemctl.*(?:start|enable|restart)|docker|curl|wget/);
  assert.doesNotMatch(script, /write_bytes|write_text|\.open\([^)]*['"](?:w|a)|chmod|chown|mkdir|unlink/);
});

test('malformed identity, shell injection, substituted AMI and renewed deadline refuse before document creation', () => {
  for (const change of [
    (p) => { p.instanceId += "';touch /tmp/injected"; }, (p) => { p.stopDeadlineUtc += '\nshutdown now'; },
    (p) => { p.runId = 'usage-linux-$(whoami)'; }, (p) => { p.region = 'us-west-2'; },
    (p) => { p.ami.id = 'ami-abcdef12345678900'; }, (p) => { p.stopDeadlineUtc = '2026-10-12T22:00:01Z'; },
    (p) => { p.dataVolumeId = p.rootVolumeId; }, (p) => { p.extraCommand = 'true'; },
  ]) { const p = expected(); change(p); assert.throws(() => discoveryDocument(p)); }
});

test('complete envelope roundtrip returns exact raw facts and installed pins without readiness approval', () => {
  const original = facts(); const decoded = decodeDiscoveryEnvelope(JSON.stringify(envelope(original)) + '\n');
  assert.deepEqual(decoded, original);
  const pins = validateDiscoveryPins(decoded, expected(), now);
  assert.deepEqual(pins.ssmAgent, { version: '3.3.100.0', snapRevision: '1000' });
  assert.equal(pins.packages.length, 3); assert.equal(pins.installedPackages.length, 2);
  assert.equal(decoded.capacityAccepted, false); assert.equal(decoded.imdsSignatureVerified, false);
});

test('truncation, altered payload, missing completion, wrong lengths and expansion bombs refuse', () => {
  const good = envelope(facts());
  for (const change of [
    (e) => { e.rawBytes++; }, (e) => { e.compressedBytes++; }, (e) => { e.rawSha256 = '0'.repeat(64); },
    (e) => { e.compressedSha256 = '0'.repeat(64); }, (e) => { e.complete = false; },
    (e) => { delete e.endMarker; }, (e) => { e.payload = e.payload.slice(0, -4); },
    (e) => { e.payload += '\n'; }, (e) => { e.encoding = 'gzip-base64'; },
  ]) { const e = { ...good }; change(e); assert.throws(() => decodeDiscoveryEnvelope(JSON.stringify(e))); }
  assert.throws(() => decodeDiscoveryEnvelope(JSON.stringify(good).slice(0, -5)));
  assert.throws(() => decodeDiscoveryEnvelope(' '.repeat(MAX_DISCOVERY_WIRE_BYTES + 1)));
  const bomb = envelope(Buffer.alloc(MAX_DISCOVERY_RAW_BYTES + 1, 65)); bomb.rawBytes = 1;
  assert.throws(() => decodeDiscoveryEnvelope(JSON.stringify(bomb)));
});

test('same instance, native IMDS, exact timer and fresh deadline are all mandatory', () => {
  for (const change of [
    (f) => { f.binding.instanceId = 'i-abcdef12345678900'; }, (f) => { f.identity.instanceId = 'i-abcdef12345678900'; },
    (f) => { f.identity.accountId = '111111111111'; }, (f) => { f.identity.imageId = 'ami-abcdef12345678900'; },
    (f) => { f.identity.architecture = 'arm64'; }, (f) => { f.stop.timerActive = false; },
    (f) => { f.stop.dropInsAbsent = false; }, (f) => { f.stop.timerSha256 = '0'.repeat(64); },
    (f) => { f.stop.nextDeadlineUtc = '2026-10-12T22:00:01Z'; }, (f) => { f.capturedAt = '2026-10-12T14:49:00.000Z'; },
    (f) => { f.capturedAt = '2026-10-12T15:00:06.000Z'; }, (f) => { f.bootstrapReady = true; },
    (f) => { f.capacityAccepted = true; }, (f) => { f.imdsSignatureVerified = true; },
  ]) { const f = facts(); change(f); assert.throws(() => validateDiscoveryPins(f, expected(), now)); }
  assert.throws(() => validateDiscoveryPins(facts(), expected(), Date.parse(expected().stopDeadlineUtc)));
});

test('complete package records, healthy audit, active Snap and exact bounded disks are required', () => {
  for (const change of [
    (f) => { f.packages.count--; }, (f) => { f.packages.installedCount++; }, (f) => { f.packages.raw = f.packages.raw.slice(0, -1); f.packages.sha256 = sha(f.packages.raw); },
    (f) => { f.packages.raw += f.packages.raw.split('\n')[0] + '\n'; f.packages.count++; f.packages.installedCount++; f.packages.sha256 = sha(f.packages.raw); },
    (f) => { f.packages.raw = f.packages.raw.replace('ii ', 'iU '); f.packages.sha256 = sha(f.packages.raw); },
    (f) => { f.dpkgAudit = 'unconfigured package'; }, (f) => { f.ssmAgent.snapRevision = '1001'; },
    (f) => { f.ssmAgent.version = '3.3.101.0'; }, (f) => { f.disks.blockdevices[1].serial = 'vol00000000000000000'; },
    (f) => { f.disks.blockdevices[1].size++; }, (f) => { f.disks.blockdevices[1].env = 'forbidden'; },
  ]) { const f = facts(); change(f); assert.throws(() => validateDiscoveryPins(f, expected(), now)); }
});

test('actual generated Python executes against only mocked read-only natives and decodes fully', () => {
  const { script, data } = documentInput();
  const code = script.slice(script.indexOf('\n') + 1, script.lastIndexOf('\nPY'));
  const f = facts();
  const shim = `import datetime,json,os,pathlib,stat,subprocess,sys,types,urllib.request
fixture=json.loads(sys.stdin.read()); facts=fixture['facts']; native=fixture['files']; calls=[]
real_datetime=datetime.datetime
class Clock(real_datetime):
    @classmethod
    def now(cls,tz=None): return cls.fromisoformat(facts['capturedAt'].replace('Z','+00:00'))
datetime.datetime=Clock
os.geteuid=lambda:0
os.path.realpath=lambda p:facts['ssmAgent']['currentPath'] if p=='/snap/amazon-ssm-agent/current' else (_ for _ in ()).throw(AssertionError('unexpected path'))
class File:
    def __init__(self,path): self.path=path
    def read_bytes(self): return native[self.path].encode()
    def lstat(self): return types.SimpleNamespace(st_mode=stat.S_IFREG|0o600,st_uid=0,st_size=len(self.read_bytes()))
pathlib.Path=File
def command(args,**kwargs):
    calls.append(args)
    if args[:2]==['systemctl','is-active']: value='active\\n'
    elif args[:2]==['systemctl','show'] and '--property=DropInPaths' in args: value='\\n'
    elif args[:2]==['systemctl','show'] and '--property=FragmentPath' in args: value='/etc/systemd/system/'+args[2]+'\\n'
    elif args[:2]==['systemctl','show'] and '--property=NextElapseUSecRealtime' in args: value='Mon 2026-10-12 22:00:00 UTC\\n'
    elif args[0]=='date': value=str(int(real_datetime.fromisoformat(facts['binding']['stopDeadlineUtc'].replace('Z','+00:00')).timestamp()))+'\\n'
    elif args==['snap','list','amazon-ssm-agent']: value=facts['ssmAgent']['listing']
    elif args[:3]==['dpkg-query','-W','-f']:
        assert args[3]=='$'+'{Package}\\\\t$'+'{Version}\\\\t$'+'{Architecture}\\\\t$'+'{db:Status-Abbrev}\\\\n'
        value=facts['packages']['raw']
    elif args==['dpkg','--audit']: value=facts['dpkgAudit']
    elif args==['lsblk','--json','--bytes','--output','NAME,PATH,TYPE,SIZE,SERIAL,MOUNTPOINTS']: value=json.dumps(facts['disks'])
    else: raise AssertionError('unexpected native command')
    return types.SimpleNamespace(returncode=0,stdout=value.encode(),stderr=b'')
subprocess.run=command
class Response:
    status=200
    def __init__(self,value): self.value=value.encode()
    def __enter__(self): return self
    def __exit__(self,*args): pass
    def read(self,n): return self.value[:n]
class Opener:
    def open(self,request,timeout):
        assert request.full_url.startswith('http://169.254.169.254/latest/')
        if request.get_method()=='PUT': return Response('synthetic-token-not-output')
        assert request.get_header('X-aws-ec2-metadata-token')=='synthetic-token-not-output'
        return Response(json.dumps(facts['identity']))
urllib.request.build_opener=lambda *args:Opener()
exec(fixture['code'])
`;
  const bundled = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
  const python = process.env.USAGE_TEST_PYTHON ?? (process.platform === 'win32' && existsSync(bundled) ? bundled : 'python3');
  const nativeFiles = { '/etc/usage-runner-deadline-utc': data.files.deadline, '/etc/systemd/system/usage-absolute-stop.timer': data.files.timer, '/etc/systemd/system/usage-absolute-stop.service': data.files.service };
  const execute = (inputFacts, files = nativeFiles) => spawnSync(python, ['-c', shim], { encoding: 'utf8', input: JSON.stringify({ code, facts: inputFacts, files }), timeout: 5000 });
  const result = execute(f);
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /synthetic-token-not-output/);
  const decoded = decodeDiscoveryEnvelope(result.stdout);
  const pins = validateDiscoveryPins(decoded, expected(), now);
  assert.equal(pins.packages.length, f.packages.count); assert.deepEqual(pins.ssmAgent, { version: '3.3.100.0', snapRevision: '1000' });
  for (const change of [
    (bad) => { bad.identity.instanceId = 'i-abcdef12345678900'; },
    (bad) => { bad.dpkgAudit = 'unconfigured package'; },
    (bad) => { bad.ssmAgent.listing += 'unexpected second snap revision\n'; },
  ]) {
    const bad = facts(); change(bad); const failed = execute(bad);
    assert.equal(failed.status, 1); assert.equal(failed.stdout, '');
    assert.equal(failed.stderr.trim(), 'usage AMI discovery failed; no partial inventory accepted');
  }
  const failedTimer = execute(f, { ...nativeFiles, '/etc/systemd/system/usage-absolute-stop.timer': data.files.timer + '# altered\n' });
  assert.equal(failedTimer.status, 1); assert.equal(failedTimer.stdout, '');
});
