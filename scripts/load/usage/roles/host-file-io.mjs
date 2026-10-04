import assert from 'node:assert/strict';
import {existsSync,mkdirSync,writeFileSync,renameSync,readFileSync,readdirSync,statSync} from 'node:fs';
import {resolve,join,relative,sep,isAbsolute} from 'node:path';
export function assertDisjointControlAndEvidence(controlDirectory,evidenceDirectory){
 const control=resolve(controlDirectory),evidence=resolve(evidenceDirectory);
 const outside=(parent,child)=>{const path=relative(parent,child);return path==='..'||path.startsWith(`..${sep}`)||isAbsolute(path);};
 assert.ok(outside(evidence,control)&&outside(control,evidence),'Control secrets and shared evidence must be disjoint directory trees');
 return {control,evidence};
}
export function createHostFileIo({controlDirectory,evidenceDirectory}){
 const {control,evidence}=assertDisjointControlAndEvidence(controlDirectory,evidenceDirectory);
 const atomic=(path,value)=>{assert.equal(existsSync(path),false);writeFileSync(`${path}.tmp`,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});renameSync(`${path}.tmp`,path);};
 const read=path=>{try{assert.ok(statSync(path).size<=16384);return JSON.parse(readFileSync(path,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}};
 return {
  async initialize(){assert.equal(existsSync(control),false);assert.equal(statSync(evidence).isDirectory(),true);mkdirSync(control);for(const dir of ['api-secrets','worker-secrets','generator-secrets','coordinator-secrets','host-receipts','coordinator-requests'])mkdirSync(join(control,dir));},
  async writeRegistry(value){atomic(join(control,'coordinator-secrets','registry.json'),value);},
  async writeChildBinding(role,value){assert.ok(['api','worker','generator'].includes(role));atomic(join(control,`${role}-secrets`,'binding.json'),value);},
  async readBridgeReady(){return read(join(control,'coordinator-requests','bridge-ready.json'));},
  async readTerminationRequests(after){const rows=[];for(const name of readdirSync(join(control,'coordinator-requests'))){if(name==='bridge-ready.json'||name.endsWith('.tmp'))continue;const match=/^termination-([1-6])\.json$/.exec(name);assert.ok(match);const sequence=Number(match[1]);if(sequence>after)rows.push({sequence,request:read(join(control,'coordinator-requests',name))});}return rows.sort((a,b)=>a.sequence-b.sequence);},
  async writeResult(value){atomic(join(evidence,'role-host-result.json'),value);},
 };
}
