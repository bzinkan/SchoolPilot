import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync,mkdirSync,copyFileSync,existsSync} from 'node:fs';
import {resolve,relative,isAbsolute,join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {hash,patchProfile,patchCoordinator,patchProcess,patchGenerator} from './patch-coordinator.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const write=(path,value)=>writeFileSync(path,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const git=(repo,args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',maxBuffer:16*1024**2,windowsHide:true}).trim();
function distinct(a,b){const r=relative(a,b);assert.ok(r&&r!=='..'&&(r.startsWith(`..`)||isAbsolute(r)),'Source, context and host must be disjoint');}
function clone(repository,target,source){
  execFileSync('git',['init',target],{stdio:'pipe',windowsHide:true});
  git(target,['config','core.autocrlf','false']);git(target,['config','core.longpaths','true']);
  git(target,['fetch','--depth','1','--no-tags',pathToFileURL(repository+'/').href,source]);git(target,['checkout','--detach',source]);
  assert.equal(git(target,['rev-parse','HEAD']),source);assert.equal(git(target,['status','--porcelain']),'');
  assert.equal(existsSync(join(target,'.git/objects/info/alternates')),false);
}
export function createContext({repository,source,candidateImageId,candidateScanReceipt,host,context}){
  repository=resolve(repository);host=resolve(host);context=resolve(context);
  assert.match(source,/^[a-f0-9]{40}$/);assert.match(candidateImageId,/^sha256:[a-f0-9]{64}$/);
  for(const[a,b]of[[repository,host],[host,repository],[repository,context],[context,repository],[host,context],[context,host]])distinct(a,b);
  assert.equal(existsSync(host),false);assert.equal(existsSync(context),false);
  assert.equal(git(repository,['rev-parse','HEAD']),source);assert.equal(git(repository,['status','--porcelain']),'');
  const scanBytes=readFileSync(candidateScanReceipt),scan=JSON.parse(scanBytes);
  assert.equal(scan.passed,true);assert.equal(scan.sourceSha,source);assert.equal(scan.imageId,candidateImageId);
  assert.equal(scan.counts.HIGH,0);assert.equal(scan.counts.CRITICAL,0);
  mkdirSync(context);clone(repository,join(context,'clean-source'),source);clone(repository,host,source);
  const sourcePath=join(context,'clean-source'),overlay=join(context,'overlay/scripts/load/usage');mkdirSync(overlay,{recursive:true});
  const tracked=git(sourcePath,['ls-files','-z','scripts/load/usage']).split('\0').filter(Boolean);
  for(const name of tracked){const tail=name.slice('scripts/load/usage/'.length),target=join(overlay,tail);mkdirSync(dirname(target),{recursive:true});copyFileSync(join(sourcePath,name),target);}
  const canonical=name=>readFileSync(join(sourcePath,'scripts/load/usage',name),'utf8');
  const coordinator=patchCoordinator(canonical('release-enabled-scale.mjs'));
  for(const[name,text]of Object.entries({'release-enabled-scale.mjs':coordinator.text,'release-enabled-profile.mjs':patchProfile(canonical('release-enabled-profile.mjs')),'release-enabled-process.mjs':patchProcess(canonical('release-enabled-process.mjs')),'release-enabled-generator.mjs':patchGenerator(canonical('release-enabled-generator.mjs'))}))writeFileSync(join(overlay,name),text);
  const prototype=join(context,'prototype');mkdirSync(prototype);
  const harnessFiles={};
  for(const name of readdirSync(here).sort().filter(name=>/\.(mjs|ps1)$/.test(name)&&!name.endsWith('.test.mjs'))){
    const raw=readFileSync(join(here,name));write(join(prototype,name),raw.toString('utf8'));harnessFiles[name]=hash(raw);
  }
  const executedHarnessSha256={};
  function walk(dir,prefix=''){for(const name of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const tail=prefix+name.name;if(name.isDirectory())walk(join(dir,name.name),tail+'/');else executedHarnessSha256[tail]=hash(readFileSync(join(dir,name.name)));}}
  walk(overlay);
  const binding={schemaVersion:2,applicationSource:source,candidateImageId,candidateScanReceiptSha256:hash(scanBytes),executedHarnessSha256,roleHarnessSha256:harnessFiles,harnessIdentity:hash(JSON.stringify(harnessFiles)),capacityAccepted:false};
  write(join(context,'overlay/binding.json'),binding);write(join(context,'coordinator-overlay-receipt.json'),coordinator.receipt);
  copyFileSync(join(here,'verify-runtime.mjs'),join(context,'verify-runtime.mjs'));
  copyFileSync(join(here,'Dockerfile.roles'),join(context,'Dockerfile.roles'));
  const exceptions=git(sourcePath,['ls-files']).split('\n').filter(name=>/(^|\/)(dist|node_modules)\/|(^|\/)\.env/.test(name));
  for(const name of exceptions)assert.ok(!/[!#*?\[\]\r\n]/.test(name));
  write(join(context,'.dockerignore'),['*','!Dockerfile.roles','!verify-runtime.mjs','!clean-source/**','!overlay/**','!prototype/**','clean-source/**/node_modules','clean-source/**/node_modules/**','clean-source/**/dist','clean-source/**/dist/**','clean-source/.env*','clean-source/**/.env*',...exceptions.map(name=>'!clean-source/'+name),''].join('\n'));
  const entry=name=>({path:join(host,'scripts/load/usage',name),sha256:hash(readFileSync(join(host,'scripts/load/usage',name)))});
  const preparation={schemaVersion:2,applicationSource:source,candidateImageId,candidateConfigDigest:scan.configDigest,candidateScanReceiptSha256:hash(scanBytes),sourceClone:sourcePath,hostFixture:host,context,harnessIdentity:binding.harnessIdentity,roleHarnessSha256:harnessFiles,
    harnessHashes:{api:executedHarnessSha256['release-enabled-process.mjs'],worker:executedHarnessSha256['release-enabled-process.mjs'],generator:executedHarnessSha256['release-enabled-generator.mjs'],coordinator:executedHarnessSha256['release-enabled-scale.mjs']},
    contractModules:{profile:entry('release-enabled-profile.mjs'),offering:entry('open-loop-heartbeats.mjs'),postgres:entry('release-enabled-postgres-pressure.mjs')},applicationChanges:0,capacityAccepted:false};
  write(join(context,'role-preparation.json'),preparation);return preparation;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){const[repository,source,candidateImageId,candidateScanReceipt,host,context]=process.argv.slice(2);console.log(JSON.stringify(createContext({repository,source,candidateImageId,candidateScanReceipt,host,context})));}
