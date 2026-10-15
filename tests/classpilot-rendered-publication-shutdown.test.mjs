import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import * as driver from '../scripts/load/run-classpilot-rendered-dashboards.mjs';
import {createMeasurementArtifactChannel} from '../scripts/load/run-classpilot-remote-generator.mjs';
import {measurementPlan,CapturePulseController} from '../scripts/load/classpilot-reliability-profile.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const expected={account:'135775632425',bucket:'schoolpilot-staging-load-135775632425',campaign:'classpilot-staging-20261014-aaaaaaaaaaaa',origin:'https://staging.school-pilot.net',runId:'40-'+'b'.repeat(16),primaryDevices:40,candidateApiImage:'135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-staging-api@sha256:'+'a'.repeat(64),sourceArtifactSha256:'a'.repeat(64),scriptBundleSha256:'a'.repeat(64),cohortSha256:'a'.repeat(64),planSha256:sha(JSON.stringify(measurementPlan(40))),maximumPulses:602,maximumNavigationRounds:7};
function channelFixture(failure=null){let rejectPending,calls=0,accepted=false,closed=false;const client={config:{maxAttempts:1,region:'us-east-1'},middlewareStack:{add(){}},send(){calls++;return new Promise((resolve,reject)=>{rejectPending=reject;setTimeout(()=>{if(!closed){if(failure){reject(failure);return;}accepted=true;resolve({$metadata:{httpStatusCode:200}});}},25);});},destroy(){closed=true;if(!accepted)rejectPending?.(Object.assign(Error('SYNTHETIC_TRANSPORT_CLOSED'),{name:'AbortError'}));}};return{channel:createMeasurementArtifactChannel({role:'controller',expected,s3:client}),summary:()=>({calls,accepted,closed})};}
function actualTerminalBody(){const text=fs.readFileSync(fileURLToPath(new URL('../scripts/load/run-classpilot-rendered-dashboards.mjs',import.meta.url)),'utf8'),from=text.indexOf('    httpMetrics.closeWindow();',text.indexOf('// No unlaunched navigation round')),to=text.indexOf('    const measuredDurationMs',from);assert.ok(from>=0&&to>from);return text.slice(from,to);}
test('actual full-window terminal source lets an admitted final PUT settle before closing its SDK',async()=>{
 const f=channelFixture(),pulse=new CapturePulseController(expected,{now:()=>0}).issue();let interrupted=false;
 const publicationLoop=f.channel.publish('measurement-control.json',pulse);publicationLoop.catch(()=>{interrupted=true;});
 while(f.summary().calls===0)await new Promise(resolve=>setImmediate(resolve));
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 const run=new AsyncFunction('httpMetrics','measurementChannel','priorPaint','observerRuntime','publicationLoop','navigationTasks','priorPreparation','capturePhases','drainRenderedPublicationBeforeClose','markInterrupted','let cleanupProof;'+actualTerminalBody()+';return cleanupProof;');
 const cleanup=await run({closeWindow(){}},f.channel,{dispose(){}},{async close({extraDrains}){await Promise.allSettled(extraDrains);return{passed:true};}},publicationLoop,[],null,null,driver.drainRenderedPublicationBeforeClose,()=>{interrupted=true;});
 assert.equal(cleanup.passed,true);assert.equal(interrupted,false,'A normal final PUT must not become a synthetic interrupted campaign');assert.equal(f.summary().accepted,true);assert.equal(f.summary().closed,true);
});
for(const name of['AccessDenied','NoSuchKey','AbortError'])test('actual terminal '+name+' remains a fatal publication interruption even after the full window',async()=>{
 const error=Object.assign(Error('PRIVATE_TEXT_NEVER_RECORDED'),{name}),f=channelFixture(error),pulse=new CapturePulseController(expected,{now:()=>0}).issue();
 const evidence=driver.createRenderedInterruptionEvidence({now:()=>600100,startAt:()=>0,endAt:()=>600000,phase:()=> 'sampling'});let interrupted=false;
 const publicationLoop=f.channel.publish('measurement-control.json',pulse);publicationLoop.catch(cause=>{evidence.record('publication',cause);interrupted=true;});
 await driver.drainRenderedPublicationBeforeClose({publicationLoop,close:()=>f.channel.close(),onFailure:cause=>{evidence.record('publication-drain',cause);interrupted=true;}});
 assert.equal(interrupted,true);assert.equal(f.summary().accepted,false);assert.equal(f.summary().closed,true);assert.equal(evidence.summary().first.source,'publication');assert.equal(evidence.summary().first.afterTimedWindow,true);assert.equal(evidence.summary().first.category,name==='AbortError'?'cancelled':'storage-denied');assert.ok(!JSON.stringify(evidence.summary()).includes('PRIVATE_TEXT'));
});
test('a bounded terminal caller deadline remains a failure and still closes its owned SDK',async()=>{
 let failure=0,closed=0;const hold=setTimeout(()=>{},100);
 try{await driver.drainRenderedPublicationBeforeClose({publicationLoop:new Promise(()=>{}),close:()=>{closed++;},onFailure:()=>{failure++;},timeoutMs:5});}
 finally{clearTimeout(hold);}assert.equal(failure,1);assert.equal(closed,1);
});
test('a closing SDK exception is retained as a fatal failure',async()=>{
 let failure=0;await assert.rejects(driver.drainRenderedPublicationBeforeClose({publicationLoop:Promise.resolve(),close:()=>{throw Error('SYNTHETIC_CLOSE');},onFailure:()=>{failure++;}}),/SYNTHETIC_CLOSE/);assert.equal(failure,1);
});
test('signal/navigation evidence is sticky and uses only fixed labels and relative monotonic metadata',()=>{
 let now=100;const evidence=driver.createRenderedInterruptionEvidence({now:()=>now,startAt:()=>0,endAt:()=>600000,phase:()=> 'sampling'});
 evidence.record('signal');now=700000;evidence.record('navigation',Buffer.from('PRIVATE_TEXT'));assert.deepEqual(evidence.summary().first,{source:'signal',category:'signal',phase:'sampling',elapsedMs:100,afterTimedWindow:false});assert.equal(evidence.summary().counts.navigation,1);
 const unknown=driver.createRenderedInterruptionEvidence({phase:()=> 'PRIVATE_TEXT'});unknown.record('PRIVATE_TEXT',{message:'PRIVATE_TEXT'});assert.equal(unknown.summary().first.source,'other');assert.equal(unknown.summary().first.phase,'other');assert.equal(unknown.summary().first.elapsedMs,null);assert.ok(!JSON.stringify(unknown.summary()).includes('PRIVATE_TEXT'));
});
test('the actual interrupted/early-end gate remains strict and timing diagnostics do not replace it',()=>{
 const text=fs.readFileSync(fileURLToPath(new URL('../scripts/load/run-classpilot-rendered-dashboards.mjs',import.meta.url)),'utf8');
 assert.ok(text.includes("if (interrupted || performance.now() < endMonotonic) failures.push('full-duration campaign interrupted')"));assert.ok(text.includes('finalSummary.timedWindowCompleteBeforeShutdown=timedWindowCompleteBeforeShutdown;'));
});
