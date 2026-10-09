import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindingHash, createBuildSecurityPermissionQueue, replayBuildSecurityRawEvidence } from '../scripts/release-source-binding.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helper = path.join(repository, 'scripts/deploy-classpilot-runtime-config.ps1');
const execute = promisify(execFile);
const literal = value => "'" + value.replaceAll("'", "''") + "'";
const decoded = args => Buffer.from(args.at(-1), 'base64').toString('utf16le');
const checks = script => [...script.matchAll(/Assert-PrivateInputPath -Path '((?:[^']|'')*)'/g)].map(value => value[1].replaceAll("''", "'"));
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'sp-permission-batch-'));
  const localHelper = path.join(directory, 'helper.ps1'); writeFileSync(localHelper, '# synthetic helper\n');
  return { directory, helper:localHelper, hashes:[bindingHash(readFileSync(localHelper))],
    file(name, text='{"synthetic":true}\n') { const file=path.join(directory,name);writeFileSync(file,text);return file; },
    clean() { assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir())+path.sep) && path.basename(directory).startsWith('sp-permission-batch-'));rmSync(directory,{recursive:true}); } };
}
const queue = (f,run) => createBuildSecurityPermissionQueue(run,f.helper,repository,f.hashes);

test('ordered evidence groups retain duplicate values and references despite out-of-order completion', async () => {
  const shared={id:'duplicate'},records=[shared,{id:'b'},shared,{id:'d'},{id:'e'}];
  const finished=[];let active=0,peak=0;
  const values=await replayBuildSecurityRawEvidence(records,async(record)=>{
    active++;peak=Math.max(peak,active);
    await new Promise(resolve=>setTimeout(resolve,record.id==='b'?15:1));
    finished.push(record.id);active--;return record;
  });
  assert.deepEqual(values,records);assert.equal(values[0],values[2]);
  assert.equal(finished.length,5);assert.equal(peak,4);assert.equal(active,0);assert.equal(finished[3],'b');
});

test('ordered evidence groups drain all chunks and report the first input failure, including synchronous failures', async () => {
  const first=Error('first input failure'),later=Error('later faster failure'),finished=[];let active=0,peak=0,mutations=0;
  await assert.rejects(replayBuildSecurityRawEvidence(Array.from({length:11},(_,index)=>index),(index)=>{
    if(index===0){finished.push(index);throw first;}
    active++;peak=Math.max(peak,active);
    return new Promise((resolve,reject)=>setTimeout(()=>{active--;finished.push(index);index===2?reject(later):resolve(index);},index===1?15:1));
  }).then(()=>{mutations++;}),error=>error===first);
  assert.deepEqual([...finished].sort((a,b)=>a-b),Array.from({length:11},(_,index)=>index));
  assert.ok(peak<=4);assert.equal(active,0);assert.equal(mutations,0);
});

test('ordered evidence groups batch every permission check and reread repeated evidence without caching', async () => {
  const f=fixture();try {
    const batches=[],check=queue(f,async(_executable,args)=>{batches.push(checks(decoded(args)));return {code:0};});
    const a=f.file('same.json','{"version":1}'),b=f.file('other.json','{"version":2}');
    const load=async filename=>{await check(filename);return JSON.parse(readFileSync(filename));};
    const values=await replayBuildSecurityRawEvidence([a,b,a,b,a],load);
    assert.deepEqual(values.map(value=>value.version),[1,2,1,2,1]);assert.deepEqual(batches,[[a,b,a,b],[a]]);
    writeFileSync(a,'{"version":3}');assert.deepEqual(await replayBuildSecurityRawEvidence([a,a],load),[{version:3},{version:3}]);
    assert.deepEqual(batches.at(-1),[a,a]);
  } finally { f.clean(); }
});

test('permission batches preserve every FIFO request and duplicate, with at most four checks and one command active', async () => {
  const f=fixture();try {
    const batches=[];let active=0,peak=0;
    const check=queue(f,async(executable,args)=>{assert.equal(executable,'pwsh');active++;peak=Math.max(peak,active);batches.push(checks(decoded(args)));await turn();active--;return {code:0};});
    const files=Array.from({length:11},(_,index)=>path.join(f.directory,index===1?'file-0.json':`file-${index}.json`));
    const completed=[];await Promise.all(files.map((file,index)=>check(file).then(()=>completed.push(index))));
    assert.deepEqual(batches.map(batch=>batch.length),[4,4,3]);assert.deepEqual(batches.flat(),files);assert.equal(peak,1);assert.equal(active,0);assert.deepEqual(completed,files.map((_,index)=>index));
  } finally { f.clean(); }
});

test('a rejected batch releases no caller to hash or parse and does not strand later requests', async () => {
  const f=fixture();try {
    let calls=0;const consumed=[];
    const check=queue(f,async()=>({code:++calls===1?1:0}));
    const results=await Promise.allSettled(Array.from({length:9},(_,index)=>check(f.file(`${index}.json`)).then(()=>{consumed.push(index);return JSON.parse(readFileSync(path.join(f.directory,`${index}.json`)));})));
    assert.deepEqual(results.map(result=>result.status),['rejected','rejected','rejected','rejected','fulfilled','fulfilled','fulfilled','fulfilled','fulfilled']);assert.deepEqual(consumed,[4,5,6,7,8]);assert.equal(calls,3);
    await check(path.join(f.directory,'8.json'));assert.equal(calls,4);
  } finally { f.clean(); }
});

test('a thrown command rejects every batch member and the same queue can subsequently make a fresh check', async () => {
  const f=fixture();try {
    let calls=0;const check=queue(f,async()=>{if(++calls===1)throw Error('synthetic transport failure');return {code:0};});
    const results=await Promise.allSettled([check(f.file('a.json')),check(f.file('b.json'))]);assert.ok(results.every(result=>result.status==='rejected'&&result.reason.message==='synthetic transport failure'));
    await check(path.join(f.directory,'a.json'));assert.equal(calls,2);
  } finally { f.clean(); }
});

test('helper mutation before dispatch rejects queued callers before any command or evidence read', async () => {
  const f=fixture();try {
    let calls=0,reads=0;const check=queue(f,async()=>{calls++;return {code:0};});
    const promise=check(f.file('a.json')).then(()=>{reads++;});writeFileSync(f.helper,'# changed helper\n');
    await assert.rejects(promise,/BINDING_PERMISSION_HELPER_CHANGED/);assert.equal(calls,0);assert.equal(reads,0);
  } finally { f.clean(); }
});

test('helper mutation between batches is detected afresh without importing the changed helper', async () => {
  const f=fixture();try {
    let release,calls=0;const gate=new Promise(resolve=>{release=resolve;});
    const check=queue(f,async()=>{calls++;if(calls===1)await gate;return {code:0};});
    const first=check(f.file('a.json'));await turn();const later=check(f.file('b.json'));writeFileSync(f.helper,'# changed while pending\n');release();await first;
    await assert.rejects(later,/BINDING_PERMISSION_HELPER_CHANGED/);assert.equal(calls,1);
    writeFileSync(f.helper,'# synthetic helper\n');await check(path.join(f.directory,'b.json'));assert.equal(calls,2);
  } finally { f.clean(); }
});

test('separate validation invocations never share checks or successful permission results', async () => {
  const f=fixture();try {
    const seen=[];const run=async(_executable,args)=>{seen.push(checks(decoded(args)));return {code:0};};const one=queue(f,run),two=queue(f,run),file=f.file('same.json');
    await Promise.all([one(file),two(file)]);await one(file);assert.deepEqual(seen,[[file],[file],[file]]);
  } finally { f.clean(); }
});

async function powershell(script) {
  try {const result=await execute('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,maxBuffer:2*1024**2});return {code:0,stdout:result.stdout,stderr:result.stderr};}
  catch(error) { return {code:typeof error.code==='number'?error.code:1,stdout:error.stdout??'',stderr:error.stderr??''}; }
}
async function protect(files) {const result=await powershell("$ErrorActionPreference='Stop';. "+literal(helper)+';'+files.map(file=>'Set-PrivatePathPermissions -Path '+literal(file)).join(';'));assert.equal(result.code,0);}
const realRun=(_executable,args)=>powershell(decoded(args));
function realQueue() {return createBuildSecurityPermissionQueue(realRun,helper,repository,[bindingHash(readFileSync(helper))]);}
const windowsOnly={skip:process.platform!=='win32'};

test('real Windows helper accepts every protected file, including repeated paths in a batch', windowsOnly, async () => {
  const f=fixture();try {
    const a=f.file('a.json'),b=f.file("quote's.json");await protect([a,b]);const check=realQueue();
    await Promise.all([a,b,a,b].map(file=>check(file)));assert.equal(JSON.parse(readFileSync(a)).synthetic,true);
  } finally { f.clean(); }
});

test('real Windows ACL failure rejects the whole batch before any evidence is consumed', windowsOnly, async () => {
  const f=fixture();try {
    const good=f.file('good.json'),bad=f.file('shared.json');await protect([good,bad]);
    const result=await powershell("$ErrorActionPreference='Stop';$file="+literal(bad)+";$acl=Get-Acl -LiteralPath $file;$sid=[Security.Principal.SecurityIdentifier]::new('S-1-1-0');[void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::Read,[Security.AccessControl.AccessControlType]::Allow));[IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($file),[Security.AccessControl.FileSecurity]$acl)");assert.equal(result.code,0,result.stderr);
    let consumed=0;const check=realQueue(),results=await Promise.allSettled([good,bad].map(file=>check(file).then(()=>{consumed++;return readFileSync(file);})));assert.ok(results.every(value=>value.status==='rejected'));assert.equal(consumed,0);
    await check(good);
  } finally { f.clean(); }
});

test('a real failed second path still executes all four official checks before rejecting every caller', windowsOnly, async () => {
  const f=fixture();try {
    const files=[f.file('first.json'),path.join(f.directory,'missing.json'),f.file('third.json'),f.file('fourth.json')];await protect(files.filter(file=>!file.endsWith('missing.json')));
    const audit=path.join(f.directory,'attempted-paths.txt');
    writeFileSync(f.helper,". "+literal(helper)+"\n$script:originalPrivateInputCheck=${function:Assert-PrivateInputPath}\nfunction Assert-PrivateInputPath { param([string]$Path,[string]$RepositoryRoot);[IO.File]::AppendAllText("+literal(audit)+",$Path+[Environment]::NewLine); & $script:originalPrivateInputCheck -Path $Path -RepositoryRoot $RepositoryRoot }\n");
    let consumed=0;const check=createBuildSecurityPermissionQueue(realRun,f.helper,repository,[bindingHash(readFileSync(f.helper))]);
    const results=await Promise.allSettled(files.map(file=>check(file).then(()=>{consumed++;return readFileSync(file);})));assert.ok(results.every(value=>value.status==='rejected'));assert.equal(consumed,0);assert.deepEqual(readFileSync(audit,'utf8').trim().split(/\r?\n/),files);
  } finally { f.clean(); }
});

test('real Windows reparse ancestor rejects all queued reads and leaves the queue usable', windowsOnly, async () => {
  const f=fixture();try {
    const target=path.join(f.directory,'target');mkdirSync(target);const file=path.join(target,'fixture.json');writeFileSync(file,'{}');await protect([file]);
    const link=path.join(f.directory,'junction');symlinkSync(target,link,'junction');let consumed=0;const check=realQueue();
    const results=await Promise.allSettled([file,path.join(link,'fixture.json')].map(name=>check(name).then(()=>{consumed++;})));assert.ok(results.every(value=>value.status==='rejected'));assert.equal(consumed,0);await check(file);
  } finally { f.clean(); }
});

test('real permission success never substitutes for the fresh evidence hash or permits parsing tampered JSON', windowsOnly, async () => {
  const f=fixture();try {
    const file=f.file('fixture.json'),expected=bindingHash(readFileSync(file));await protect([file]);let parsed=0;
    const check=createBuildSecurityPermissionQueue(async(executable,args)=>{const result=await realRun(executable,args);if(result.code===0)writeFileSync(file,'{synthetic-tampered');return result;},helper,repository,[bindingHash(readFileSync(helper))]);
    await assert.rejects(check(file).then(()=>{const bytes=readFileSync(file);assert.equal(bindingHash(bytes),expected,'BINDING_RETAINED_BYTES_CHANGED');parsed++;return JSON.parse(bytes);}),/BINDING_RETAINED_BYTES_CHANGED/);assert.equal(parsed,0);
  } finally { f.clean(); }
});
