import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const file = fileURLToPath(new URL('./run-campaign.sh', import.meta.url));
const shell = readFileSync(file, 'utf8');
const program = shell.split("<<'PY'\n")[1]?.split('\nPY\n')[0];
assert.ok(program, 'actual fixed wrapper Python validator must be exercised');
const bundledPython = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
const python = process.env.SCHOOLPILOT_TEST_PYTHON ?? process.env.USAGE_TEST_PYTHON ?? (process.platform === 'win32' && existsSync(bundledPython) ? bundledPython : 'python3');
const bash = process.env.SCHOOLPILOT_TEST_BASH ?? process.env.USAGE_TEST_BASH ?? (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash');

// Execute the actual validator against an in-memory filesystem. No root files,
// real Node executable, campaign process, Docker or external service is touched.
const setup = String.raw`
import io,json,pathlib,stat,sys,types,hashlib
case=sys.argv[1]
Pure=pathlib.PurePosixPath
nodes={}
def put(name,body,uid=0,mode=0o640):
    raw=(json.dumps(body,separators=(',',':')).encode() if isinstance(body,dict) else body)
    nodes[name]={'raw':raw,'uid':uid,'mode':mode,'link':False,'nlink':1}
    return hashlib.sha256(raw).hexdigest()
runner='/srv/usage/work/runner/scripts/load/usage/linux-runner'
tools={name:put(runner+'/'+name+'.mjs',('tool:'+name).encode(),1000,0o600) for name in ('relocation','preflight','run-campaign','source-checkout')}
intent_sha=put('/srv/usage/work/intent.json',{'kind':'usage_linux_campaign_intent','toolSha256':tools},1000,0o600)
request={'schemaVersion':1,'kind':'usage_linux_campaign_request','campaignIntent':{'path':'/srv/usage/work/intent.json','sha256':intent_sha},'campaignIntentSha256':intent_sha}
request_sha=put('/srv/usage/work/active-request.json',request,1000,0o600)
node='/srv/usage/tools/node/node-v22.23.3-linux-x64/bin/node'
node_sha=put(node,b'exact approved Node binary',0,0o750)
config={'requestPath':'/srv/usage/work/active-request.json','admissionRecordPath':'/srv/usage/control/launch-admission.json'}
admission={'schemaVersion':1,'kind':'usage_linux_controller_admission','requestPath':config['requestPath'],'requestSha256':request_sha}
put('/srv/usage/control/campaign.json',config)
put('/srv/usage/control/launch-admission.json',admission)
put('/srv/usage/control/node-runtime.json',{'schemaVersion':1,'kind':'usage_linux_node_runtime','path':node,'sha256':node_sha,'version':'v22.23.3'})
if case=='missing_admission': del nodes['/srv/usage/control/launch-admission.json']
if case=='old_config': put('/srv/usage/control/campaign.json',{'requestPath':config['requestPath'],'requestSha256':request_sha})
if case=='wrong_owner': nodes['/srv/usage/control/launch-admission.json']['uid']=1000
if case=='bad_mode': nodes['/srv/usage/work/active-request.json']['mode']=0o644
if case=='request_drift': nodes['/srv/usage/work/active-request.json']['raw']+=b' '
if case=='tool_drift': nodes[runner+'/run-campaign.mjs']['raw']+=b' '
if case=='source_tool_drift': nodes[runner+'/source-checkout.mjs']['raw']+=b' '
if case=='source_tool_missing': del nodes[runner+'/source-checkout.mjs']
if case=='node_drift': nodes[node]['raw']+=b' '
if case=='foreign_request': put('/srv/usage/control/launch-admission.json',{**admission,'requestPath':'/srv/usage/work/foreign.json'})
if case=='symlink': nodes['/srv/usage/work/intent.json']['link']=True
if case=='hardlink': nodes['/srv/usage/work/active-request.json']['nlink']=2
class P:
    def __init__(self,value): self.value=str(value)
    def __str__(self): return self.value
    def __truediv__(self,value): return P(str(Pure(self.value)/str(value)))
    @property
    def parts(self): return Pure(self.value).parts
    @property
    def parents(self): return [P(str(p)) for p in Pure(self.value).parents]
    @property
    def suffix(self): return Pure(self.value).suffix
    def is_absolute(self): return Pure(self.value).is_absolute()
    def is_relative_to(self,parent): return Pure(self.value).is_relative_to(parent)
    def is_symlink(self): return nodes.get(self.value,{}).get('link',False)
    def lstat(self):
        n=nodes[self.value]; return types.SimpleNamespace(st_mode=stat.S_IFREG|n['mode'],st_uid=n['uid'],st_nlink=n['nlink'])
    def read_bytes(self): return nodes[self.value]['raw']
    def open(self,mode): assert mode=='rb'; return io.BytesIO(nodes[self.value]['raw'])
pathlib.Path=P
`;
function validate(which) {
  return spawnSync(python, ['-c', `${setup}\n${program}`, which], { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 16384 });
}
test('fixed shell has valid Bash syntax and executes only the pinned runner using admission-provided request hash', () => {
  const result = spawnSync(bash, ['-n', file], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  assert.match(shell, /\[\[ \$# == 1 && \$1 == \/srv\/usage\/control\/campaign\.json && \$\(id -u\) == 1000 \]\]/);
  assert.match(shell, /exec "\$\{launch\[0\]\}" \/srv\/usage\/work\/runner\/scripts\/load\/usage\/linux-runner\/run-campaign\.mjs execute/);
});
test('actual shell validator accepts provision-time static config and later root admission plus exact Node/tools', () => {
  const result = validate('valid'); assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split(/\r?\n/); assert.equal(lines.length, 4);
  assert.equal(lines[0], '/srv/usage/tools/node/node-v22.23.3-linux-x64/bin/node'); assert.equal(lines[1], '/srv/usage/work/active-request.json');
  assert.match(lines[2], /^[a-f0-9]{64}$/); assert.equal(lines[3], 'v22.23.3');
});
test('actual shell validator refuses missing/mutable admission, wrong private ownership, links, and request/Node/tool drift', () => {
  for (const which of ['missing_admission', 'old_config', 'wrong_owner', 'bad_mode', 'request_drift', 'tool_drift', 'source_tool_drift', 'source_tool_missing', 'node_drift', 'foreign_request', 'symlink', 'hardlink']) {
    const result = validate(which); assert.equal(result.status, 1, which); assert.equal(result.stdout, '', which);
    assert.equal(result.stderr.trim(), 'USAGE_LINUX_WRAPPER_BINDING_REFUSED', which);
  }
});
