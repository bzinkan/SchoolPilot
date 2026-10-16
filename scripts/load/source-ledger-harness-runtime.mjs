// PRIVATE SDK+actual-harness integration, no import-time dispatch. The parent
// creates the producer-owned pending object before emitting owned key Ready.
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {createSourceLedgerSdkBridge} from './source-ledger-sdk-bridge.mjs';
import {createProducerSourceHook} from './producer-source-hook.mjs';
import {createProducerInitialKeyPreparation,sourceInitialAcceptedNotice} from './source-startup-contract.mjs';
import {validateSourceContext} from './producer-source-ledger.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const save=(file,value)=>{const bytes=Buffer.from(JSON.stringify(value));try{fs.writeFileSync(file,bytes,{flag:'wx',mode:0o600});return sha(bytes);}finally{bytes.fill(0);}};
function regular(file){assert.ok(path.isAbsolute(file));for(let item=file;;item=path.dirname(item)){assert.equal(fs.lstatSync(item).isSymbolicLink(),false);if(path.dirname(item)===item)break;}assert.ok(fs.statSync(file).isFile());}
export function validateSourceTaskCredentialEnvironment(env){
 assert.equal(env.AWS_REGION,'us-east-1');assert.match(env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI,/^\/v2\/credentials\/[A-Za-z0-9_-]{1,160}$/);
 for(const key of ['AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','AWS_PROFILE','AWS_SHARED_CREDENTIALS_FILE','AWS_CONTAINER_CREDENTIALS_FULL_URI','AWS_WEB_IDENTITY_TOKEN_FILE','AWS_ROLE_ARN'])assert.ok(!env[key],'Only native task-role credentials allowed');
 return true;
}
export async function prepareParentSourceLedger({context,SDK,taskRoleProvider,configPath,priorityPath,emit,s3}){
 const c=validateSourceContext(context);assert.equal(typeof emit,'function');assert.equal(fs.existsSync(configPath),false);assert.equal(fs.existsSync(priorityPath),false);
 const bridge=createSourceLedgerSdkBridge({SDK,context:c,role:'producer',taskRoleProvider,s3});
 const notices=[],initial=createProducerInitialKeyPreparation({context:c,publishOwnedCopy:bridge.publishOwnedCopy,emit:value=>notices.push(value)});
 let success=false;
 try{await initial.prepare();assert.equal(notices.length,1);await initial.whenSettled();const charge=bridge.summary().chargedWriteBytes;assert.ok(charge>0&&charge<=60000&&!bridge.summary().rawWriteActive);
  save(priorityPath,{version:1,criticalControlPending:true});const configSha256=save(configPath,{version:1,kind:'prepared-native-task-source-hook-v1',context:c,initialNotice:notices[0],initialChargedBytes:charge,priorityPath});
  emit({kind:'owned-source-ledger-initial-write-v1',producerTaskArn:c.producerTaskArn,producerBundleSha256:c.producerBundleSha256,notice:notices[0],applicationRequests:0});
  success=true;return{configSha256,initialChargedBytes:charge,actualInitialAccepted:true,capacityAccepted:false};
 }finally{initial.close();bridge.close();await initial.whenSettled();if(!success){/* Intent is not replayable; caller must retire this campaign. */}}
}
export function createHarnessSourceLedger({configPath,configSha256,measurementContext,publicBindings,SDK,taskRoleProvider,readCausalCapture,capturePulseMarker,now,s3}){
 regular(configPath);assert.match(configSha256,/^[a-f0-9]{64}$/);const bytes=fs.readFileSync(configPath);let config;
 try{assert.ok(bytes.length<=131072);assert.equal(sha(bytes),configSha256);config=JSON.parse(bytes);}finally{bytes.fill(0);}
 assert.deepEqual(Object.keys(config).sort(),['version','kind','context','initialNotice','initialChargedBytes','priorityPath'].sort());assert.equal(config.version,1);assert.equal(config.kind,'prepared-native-task-source-hook-v1');
 const c=validateSourceContext(config.context);assert.equal(c.runId,measurementContext.runId);assert.equal(c.manifestSha256,measurementContext.sourceArtifactSha256);assert.equal(c.cohortSha256,measurementContext.cohortSha256);assert.equal(c.producerBundleSha256,measurementContext.scriptBundleSha256);assert.deepEqual(c.publicBindings,publicBindings);
 assert.deepEqual(config.initialNotice,sourceInitialAcceptedNotice(c));assert.ok(Number.isSafeInteger(config.initialChargedBytes)&&config.initialChargedBytes>0&&config.initialChargedBytes<=60000);assert.equal(path.dirname(config.priorityPath),path.dirname(configPath));
 const bridge=createSourceLedgerSdkBridge({SDK,context:c,role:'producer',taskRoleProvider,s3,now,initialChargedBytes:config.initialChargedBytes});
 const criticalControlPending=()=>{regular(config.priorityPath);const b=fs.readFileSync(config.priorityPath);try{assert.ok(b.length<=128);const value=JSON.parse(b);assert.deepEqual(Object.keys(value).sort(),['version','criticalControlPending'].sort());assert.equal(value.version,1);assert.equal(typeof value.criticalControlPending,'boolean');return value.criticalControlPending;}finally{b.fill(0);}};
 return createProducerSourceHook({context:c,bridge,readCausalCapture,capturePulseMarker,criticalControlPending,emit:()=>{throw Error('Child cannot emit or recreate parent initial notice');},now,initialNotice:config.initialNotice});
}