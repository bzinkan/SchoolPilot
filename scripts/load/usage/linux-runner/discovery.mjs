// Same-instance, read-only preparation. No AWS calls, installation or load admission.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { AMI } from './cloud-plan.mjs';

export const MAX_DISCOVERY_WIRE_BYTES = 20_000;
export const MAX_DISCOVERY_RAW_BYTES = 512 * 1024;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fields = (value, names) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), names.split(' ').sort());
};
const utc = (value) => {
  assert.match(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/);
  const result = Date.parse(value); assert.ok(Number.isFinite(result));
  assert.equal(new Date(result).toISOString(), value.includes('.') ? value : value.replace('Z', '.000Z'));
  return result;
};
function binding(p) {
  fields(p, 'runId accountId region ami instanceId rootVolumeId dataVolumeId launchNotBeforeUtc stopDeadlineUtc');
  assert.match(p.runId, /^usage-linux-[a-z0-9-]{8,40}$/);
  assert.match(p.accountId, /^\d{12}$/); assert.equal(p.region, 'us-east-1'); assert.deepEqual(p.ami, AMI);
  assert.match(p.instanceId, /^i-[0-9a-f]{17}$/);
  for (const key of ['rootVolumeId', 'dataVolumeId']) assert.match(p[key], /^vol-[0-9a-f]{17}$/);
  assert.notEqual(p.rootVolumeId, p.dataVolumeId);
  assert.equal(utc(p.stopDeadlineUtc) - utc(p.launchNotBeforeUtc), 8 * 3600_000);
  assert.equal(utc(p.stopDeadlineUtc) % 1000, 0, 'original stop timer uses whole seconds');
  return p;
}
function deadlineText(p) { return new Date(utc(p.stopDeadlineUtc)).toISOString().replace('.000Z', 'Z'); }
function stopFiles(p) {
  const end = deadlineText(p);
  return {
    deadline: `${end}\n`,
    timer: `[Unit]\nDescription=Absolute Usage runner eight-hour deadline\n[Timer]\nOnCalendar=${end.replace('T', ' ').replace('Z', ' UTC')}\nPersistent=true\nAccuracySec=1s\nUnit=usage-absolute-stop.service\n[Install]\nWantedBy=timers.target\n`,
    service: '[Unit]\nDescription=Absolute Usage runner compute stop\n[Service]\nType=oneshot\nExecStart=/usr/sbin/shutdown -h now\n',
  };
}

export function discoveryDocument(expected) {
  binding(expected);
  const input = Buffer.from(JSON.stringify({ binding: expected, files: stopFiles(expected) })).toString('base64');
  // All caller data is validated and encoded as JSON, never shell/Python source.
  const code = `import base64,datetime,hashlib,json,os,pathlib,re,stat,subprocess,sys,urllib.request,zlib
C=json.loads(base64.b64decode('${input}'))
E=C['binding']
def need(ok, code):
    if not ok: raise RuntimeError(code)
def run(args):
    p=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=15,check=False)
    need(p.returncode==0 and len(p.stdout)<=524288 and len(p.stderr)<=8192,'native-command-failed')
    return p.stdout.decode('utf-8')
def owned(path):
    p=pathlib.Path(path); s=p.lstat()
    need(stat.S_ISREG(s.st_mode) and s.st_uid==0 and not s.st_mode & 0o022 and s.st_size<=65536,'root-file-identity')
    return p.read_bytes()
def sha(value): return hashlib.sha256(value).hexdigest()
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs): raise RuntimeError('imds-redirect-refused')
def main():
    need(os.geteuid()==0,'root-discovery-required')
    now=datetime.datetime.now(datetime.timezone.utc)
    end=datetime.datetime.fromisoformat(E['stopDeadlineUtc'].replace('Z','+00:00'))
    begin=datetime.datetime.fromisoformat(E['launchNotBeforeUtc'].replace('Z','+00:00'))
    need(begin<=now<end and end-begin==datetime.timedelta(hours=8),'absolute-deadline')
    for key,path in [('deadline','/etc/usage-runner-deadline-utc'),('timer','/etc/systemd/system/usage-absolute-stop.timer'),('service','/etc/systemd/system/usage-absolute-stop.service')]:
        need(owned(path)==C['files'][key].encode(),'stop-file-drift')
    need(run(['systemctl','is-active','usage-absolute-stop.timer']).strip()=='active','stop-timer-inactive')
    for name in ['usage-absolute-stop.timer','usage-absolute-stop.service']:
        need(run(['systemctl','show',name,'--property=DropInPaths','--value']).strip()=='','stop-drop-in')
        need(run(['systemctl','show',name,'--property=FragmentPath','--value']).strip()=='/etc/systemd/system/'+name,'stop-fragment-drift')
    next_time=run(['systemctl','show','usage-absolute-stop.timer','--property=NextElapseUSecRealtime','--value']).strip()
    next_epoch=int(run(['date','-u','-d',next_time,'+%s']).strip())
    need(next_epoch==int(end.timestamp()),'next-deadline-drift')
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    def fetch(path,method='GET',headers=None,limit=16384):
        request=urllib.request.Request('http://169.254.169.254/latest/'+path,method=method,headers=headers or {})
        with opener.open(request,timeout=3) as response:
            body=response.read(limit+1); need(response.status==200 and len(body)<=limit,'imds-response')
            return body.decode('utf-8')
    token=fetch('api/token','PUT',{'X-aws-ec2-metadata-token-ttl-seconds':'60'},4096)
    iid=json.loads(fetch('dynamic/instance-identity/document',headers={'X-aws-ec2-metadata-token':token}))
    identity={k:iid[k] for k in ['accountId','architecture','imageId','instanceId','region','pendingTime']}
    need(identity['accountId']==E['accountId'] and identity['instanceId']==E['instanceId'] and identity['imageId']==E['ami']['id'] and identity['region']==E['region'] and identity['architecture']=='x86_64','imds-identity-drift')
    listing=run(['snap','list','amazon-ssm-agent'])
    lines=listing.strip().splitlines(); need(len(lines)==2,'active-snap-listing')
    row=lines[1].split(); need(len(row)>=6 and row[0]=='amazon-ssm-agent' and re.fullmatch(r'\\d+\\.\\d+\\.\\d+\\.\\d+',row[1]) and re.fullmatch(r'[1-9][0-9]*',row[2]),'active-snap-pin')
    current=os.path.realpath('/snap/amazon-ssm-agent/current')
    need(current=='/snap/amazon-ssm-agent/'+row[2],'active-snap-path')
    packages=run(['dpkg-query','-W','-f',r'\${Package}\\t\${Version}\\t\${Architecture}\\t\${db:Status-Abbrev}\\n'])
    rows=[r.split('\\t') for r in packages.splitlines()]
    need(1<=len(rows)<=2000 and all(len(r)==4 for r in rows),'complete-package-inventory')
    audit=run(['dpkg','--audit']); need(audit=='','dpkg-audit-not-empty')
    disks=json.loads(run(['lsblk','--json','--bytes','--output','NAME,PATH,TYPE,SIZE,SERIAL,MOUNTPOINTS']))
    facts={'schemaVersion':1,'kind':'usage_linux_ami_discovery','binding':E,'capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z'),'identity':identity,'stop':{'deadlineUtc':C['files']['deadline'].strip(),'nextDeadlineUtc':datetime.datetime.fromtimestamp(next_epoch,datetime.timezone.utc).isoformat(timespec='seconds').replace('+00:00','Z'),'timerActive':True,'dropInsAbsent':True,'deadlineSha256':sha(C['files']['deadline'].encode()),'timerSha256':sha(C['files']['timer'].encode()),'serviceSha256':sha(C['files']['service'].encode())},'ssmAgent':{'name':row[0],'version':row[1],'snapRevision':row[2],'currentPath':current,'listing':listing,'listingSha256':sha(listing.encode())},'packages':{'raw':packages,'count':len(rows),'installedCount':sum(1 for r in rows if r[3]=='ii '),'sha256':sha(packages.encode())},'dpkgAudit':audit,'disks':disks,'bootstrapReady':False,'measurementReady':False,'capacityAccepted':False,'productionReady':False,'imdsSignatureVerified':False}
    raw=json.dumps(facts,separators=(',',':'),ensure_ascii=True).encode(); need(len(raw)<=524288,'raw-envelope-limit')
    compressed=zlib.compress(raw,9)
    wire=json.dumps({'schemaVersion':1,'kind':'usage_linux_ami_discovery_envelope','encoding':'zlib-base64','rawBytes':len(raw),'rawSha256':sha(raw),'compressedBytes':len(compressed),'compressedSha256':sha(compressed),'payload':base64.b64encode(compressed).decode(),'complete':True,'endMarker':'usage_linux_ami_discovery_complete_v1'},separators=(',',':'))
    need(len(wire.encode())+1<=20000,'wire-envelope-limit')
    need(datetime.datetime.now(datetime.timezone.utc)<end,'deadline-expired-during-discovery')
    print(wire)
try: main()
except Exception:
    print('usage AMI discovery failed; no partial inventory accepted',file=sys.stderr); sys.exit(1)
`;
  return { schemaVersion: '2.2', description: 'Read only exact same-instance AMI pins; no bootstrap or acceptance',
    mainSteps: [{ action: 'aws:runShellScript', name: 'DiscoverExactAmi', inputs: {
      timeoutSeconds: '120', runCommand: ['set -eu', 'export LC_ALL=C PATH=/usr/sbin:/usr/bin:/sbin:/bin', `python3 - <<'PY'\n${code}PY`],
    } }] };
}

export function decodeDiscoveryEnvelope(wireString) {
  assert.equal(typeof wireString, 'string'); assert.ok(Buffer.byteLength(wireString) <= MAX_DISCOVERY_WIRE_BYTES);
  const e = JSON.parse(wireString);
  fields(e, 'schemaVersion kind encoding rawBytes rawSha256 compressedBytes compressedSha256 payload complete endMarker');
  assert.equal(e.schemaVersion, 1); assert.equal(e.kind, 'usage_linux_ami_discovery_envelope');
  assert.equal(e.encoding, 'zlib-base64'); assert.equal(e.complete, true);
  assert.equal(e.endMarker, 'usage_linux_ami_discovery_complete_v1');
  assert.ok(Number.isSafeInteger(e.rawBytes) && e.rawBytes > 0 && e.rawBytes <= MAX_DISCOVERY_RAW_BYTES);
  assert.match(e.rawSha256, /^[a-f0-9]{64}$/); assert.match(e.compressedSha256, /^[a-f0-9]{64}$/);
  assert.match(e.payload, /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
  const compressed = Buffer.from(e.payload, 'base64'); assert.equal(compressed.toString('base64'), e.payload);
  assert.equal(compressed.length, e.compressedBytes); assert.equal(digest(compressed), e.compressedSha256);
  const raw = inflateSync(compressed, { maxOutputLength: MAX_DISCOVERY_RAW_BYTES });
  assert.equal(raw.length, e.rawBytes); assert.equal(digest(raw), e.rawSha256);
  const text = raw.toString('utf8'); assert.ok(Buffer.from(text).equals(raw), 'invalid UTF8');
  return JSON.parse(text);
}

export function validateDiscoveryPins(facts, expected, now = Date.now()) {
  binding(expected);
  fields(facts, 'schemaVersion kind binding capturedAt identity stop ssmAgent packages dpkgAudit disks bootstrapReady measurementReady capacityAccepted productionReady imdsSignatureVerified');
  assert.equal(facts.schemaVersion, 1); assert.equal(facts.kind, 'usage_linux_ami_discovery');
  assert.deepEqual(facts.binding, expected);
  assert.ok(Number.isFinite(now));
  const captured = utc(facts.capturedAt); assert.ok(captured <= now && now - captured <= 10 * 60_000, 'stale/future discovery');
  assert.ok(captured >= utc(expected.launchNotBeforeUtc) && now < utc(expected.stopDeadlineUtc), 'absolute deadline');
  for (const key of ['bootstrapReady', 'measurementReady', 'capacityAccepted', 'productionReady', 'imdsSignatureVerified']) assert.equal(facts[key], false);
  fields(facts.identity, 'accountId architecture imageId instanceId region pendingTime');
  for (const key of ['accountId', 'instanceId', 'region']) assert.equal(facts.identity[key], expected[key]);
  assert.equal(facts.identity.imageId, expected.ami.id); assert.equal(facts.identity.architecture, 'x86_64');
  const pending = utc(facts.identity.pendingTime);
  assert.ok(pending >= utc(expected.launchNotBeforeUtc) && pending <= captured, 'instance launch interval');
  fields(facts.stop, 'deadlineUtc nextDeadlineUtc timerActive dropInsAbsent deadlineSha256 timerSha256 serviceSha256');
  assert.equal(facts.stop.deadlineUtc, deadlineText(expected)); assert.equal(facts.stop.nextDeadlineUtc, deadlineText(expected));
  assert.equal(facts.stop.timerActive, true); assert.equal(facts.stop.dropInsAbsent, true);
  for (const [key, text] of Object.entries(stopFiles(expected))) assert.equal(facts.stop[`${key}Sha256`], digest(text));
  fields(facts.ssmAgent, 'name version snapRevision currentPath listing listingSha256');
  const s = facts.ssmAgent; assert.equal(s.name, 'amazon-ssm-agent'); assert.match(s.version, /^\d+\.\d+\.\d+\.\d+$/);
  assert.match(s.snapRevision, /^[1-9][0-9]*$/); assert.equal(s.currentPath, `/snap/amazon-ssm-agent/${s.snapRevision}`);
  assert.ok(typeof s.listing === 'string' && Buffer.byteLength(s.listing) < 4096); assert.equal(s.listingSha256, digest(s.listing));
  const lines = s.listing.trim().split('\n'); assert.equal(lines.length, 2);
  const row = lines[1].trim().split(/\s+/); assert.ok(row.length >= 6); assert.deepEqual(row.slice(0, 3), [s.name, s.version, s.snapRevision]);
  fields(facts.packages, 'raw count installedCount sha256');
  const p = facts.packages; assert.equal(typeof p.raw, 'string'); assert.ok(p.raw.endsWith('\n') && Buffer.byteLength(p.raw) <= MAX_DISCOVERY_RAW_BYTES);
  assert.equal(p.sha256, digest(p.raw));
  const packages = p.raw.slice(0, -1).split('\n').map((line) => {
    const columns = line.split('\t'); assert.equal(columns.length, 4);
    const [name, version, architecture, status] = columns;
    assert.match(name, /^[a-z0-9][a-z0-9+.-]*$/); assert.match(version, /^[A-Za-z0-9:~+._-]+$/);
    assert.ok(['amd64', 'all'].includes(architecture)); assert.ok(['ii ', 'rc '].includes(status), 'unhealthy package status');
    return { name, version, architecture, status };
  });
  assert.ok(packages.length > 0 && packages.length <= 2000); assert.equal(packages.length, p.count);
  assert.equal(new Set(packages.map((r) => `${r.name}:${r.architecture}`)).size, packages.length, 'duplicate package');
  const installedPackages = packages.filter((r) => r.status === 'ii '); assert.equal(installedPackages.length, p.installedCount); assert.ok(installedPackages.length > 0);
  assert.equal(facts.dpkgAudit, ''); fields(facts.disks, 'blockdevices'); assert.ok(Array.isArray(facts.disks.blockdevices));
  const disks = [];
  function walk(list, depth = 0) {
    assert.ok(depth < 8 && Array.isArray(list) && list.length <= 128);
    for (const device of list) {
      assert.ok(device && typeof device === 'object');
      assert.ok(Object.keys(device).every((k) => ['name', 'path', 'type', 'size', 'serial', 'mountpoints', 'children'].includes(k)), 'unexpected disk fields');
      assert.match(device.name, /^[a-zA-Z0-9_.-]{1,100}$/); assert.equal(device.path, `/dev/${device.name}`);
      assert.ok(Number.isSafeInteger(device.size) && device.size >= 0); assert.ok(Array.isArray(device.mountpoints));
      assert.ok(device.mountpoints.every((m) => m === null || (typeof m === 'string' && m.length <= 1024)));
      if (device.type === 'disk') disks.push(device);
      if (device.children) walk(device.children, depth + 1);
    }
  }
  walk(facts.disks.blockdevices);
  for (const [key, size] of [['rootVolumeId', 30 * 1024 ** 3], ['dataVolumeId', 200 * 1024 ** 3]]) {
    const matches = disks.filter((d) => typeof d.serial === 'string' && d.serial.replaceAll('-', '').trim() === expected[key].replaceAll('-', ''));
    assert.equal(matches.length, 1, 'exact volume identity'); assert.equal(matches[0].size, size, 'exact volume size');
  }
  return { ssmAgent: { version: s.version, snapRevision: s.snapRevision }, packages, installedPackages, binding: expected, capturedAt: facts.capturedAt };
}
