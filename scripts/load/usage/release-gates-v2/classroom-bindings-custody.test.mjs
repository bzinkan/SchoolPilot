import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,unlinkSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {PROFILES} from './contracts.mjs';
import {verifyClassroomNativeCustody} from './classroom-bindings.mjs';
const snapshot=Object.fromEntries(['commands','messages','deliveries','threads','schoolSettings','activitySettings','memberships','staff'].map(key=>[key,[]]));
const bytes=JSON.stringify(snapshot)+'\n',digest=createHash('sha256').update(bytes).digest('hex');
function fixture(){const root=mkdtempSync(join(tmpdir(),'release297-classroom-custody-')),observer=join(root,'observer');mkdirSync(observer);const file=join(observer,'classroom-bindings.private.json');writeFileSync(file,bytes);return{root,observer,file};}
test('native smoke normal and continuous receipts retain exact produced-row custody',()=>{
  const {root}=fixture(),proof={passed:true,nativeRowsSha256:digest};
  for(const metrics of [{profile:PROFILES.classroomNative.name,preparationSmoke:true,preparationSmokeResult:{classroomBindings:proof}},
    {profile:PROFILES.classroomNative.name,rounds:[{classroomBindings:proof}]},
    {profile:PROFILES.mixedNative.name,continuous:{classroom:proof},rounds:Array(15).fill({continuousGlobal:{classroom:proof}})}])assert.equal(verifyClassroomNativeCustody(root,metrics).verified,true);
});
test('missing tampered or mismatched native rows cannot keep an accepted receipt',()=>{
  const {root,file}=fixture(),metrics={profile:PROFILES.classroomNative.name,rounds:[{classroomBindings:{passed:true,nativeRowsSha256:digest}}]};
  writeFileSync(file,JSON.stringify({...snapshot,messages:[{}]})+'\n');assert.throws(()=>verifyClassroomNativeCustody(root,metrics));
  writeFileSync(file,bytes);metrics.rounds[0].classroomBindings.nativeRowsSha256='b'.repeat(64);assert.throws(()=>verifyClassroomNativeCustody(root,metrics));
  unlinkSync(file);assert.throws(()=>verifyClassroomNativeCustody(root,metrics));
});
test('native rows through an out-of-root observer junction are rejected',()=>{
  const outside=fixture(),root=mkdtempSync(join(tmpdir(),'release297-classroom-external-'));
  symlinkSync(outside.observer,join(root,'observer'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>verifyClassroomNativeCustody(root,{profile:PROFILES.classroomNative.name,rounds:[{classroomBindings:{passed:true,nativeRowsSha256:digest}}]}),/escaped/);
});
