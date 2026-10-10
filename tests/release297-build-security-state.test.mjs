import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {ROOT,INDEX,validateIndex,renderStatus} from '../scripts/release297-current-state.mjs';
import {validateBindingProfile} from '../scripts/release-source-binding.mjs';
import {FALLBACK} from '../scripts/register-compatible-fallback-inactive.mjs';
// Preserve the preparation regressions' dated scope after the active index records deployment.
const current=()=>JSON.parse(readFileSync(join(ROOT,'docs/releases/release297/history/current-release-e22c790a-predeployment-20261010.json'),'utf8'));
function fixture(work){const index=current(),root=mkdtempSync(join(tmpdir(),'release297-build-state-'));try{for(const value of Object.values(index.evidence)){const target=join(root,value.path);mkdirSync(dirname(target),{recursive:true});copyFileSync(join(ROOT,value.path),target);}const change=(id,mutate)=>{const file=join(root,index.evidence[id].path),value=JSON.parse(readFileSync(file,'utf8'));mutate(value);const bytes=JSON.stringify(value,null,2)+'\n';writeFileSync(file,bytes);index.evidence[id].gitBlobSha256=createHash('sha256').update(bytes).digest('hex');};work(index,root,change);}finally{assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(root.includes('release297-build-state-'));rmSync(root,{recursive:true,force:true});}}
test('v5 current state validates exact A3, preserves historical failures and generates accurate authorization scope',()=>{const index=current();validateIndex(index);const text=renderStatus(index);assert.match(text,/A3 is `2001e888`/);assert.match(text,/fix this and deploy/);assert.match(text,/already admits 129/);assert.match(text,/later manual F3 rollback/);assert.equal(index.gates.find(row=>row.id==='cp-protected-build-dependency-audit').status,'failed');assert.equal(index.gates.find(row=>row.id==='fallback-scan-current').status,'failed');});
test('v5 state cannot convert a direct deployment request into runtime activation authority',()=>{const index=current();index.authorization.runtimeActivation=true;assert.throws(()=>validateIndex(index),/INDEX_IS_NOT_OPERATIONAL_AUTHORIZATION/);});
test('v5 state requires direct human request provenance and does not claim human artifact approval',()=>fixture((index,root,change)=>{change('buildSecurityCurrentObservation',value=>value.humanApprovalAsserted=true);assert.throws(()=>validateIndex(index,root),/DIRECT_USER_REQUEST_PROVENANCE_REQUIRED/);}));
test('v5 state rejects a prior application reference and mixed artifact roles',()=>{const index=current();index.artifacts.find(row=>row.id==='backend-current-a3').identity.configDigest=index.artifacts.find(row=>row.id==='fallback-build-security-f3').identity.configDigest;assert.throws(()=>validateIndex(index),/CURRENT_ARTIFACT_ROLE_CHANGED/);});
test('v5 state retains failed historical outcomes without relabeling',()=>{const index=current();index.gates.find(row=>row.id==='fallback-scan-current').status='passed';assert.throws(()=>validateIndex(index),/HISTORICAL_OUTCOME_RELABELLED/);});
test('v5 state preserves exact historical artifact identities as well as outcomes',()=>{const index=current();index.artifacts.find(row=>row.id==='fallback-c578').identity.configDigest='sha256:'+'a'.repeat(64);assert.throws(()=>validateIndex(index),/HISTORICAL_ARTIFACT_IDENTITY_CHANGED/);});
test('v5 state retains exact historical merge identities',()=>{const index=current();index.inclusionMatrix.find(row=>row.number===610&&row.repository==='SchoolPilot').headSha='a'.repeat(40);assert.throws(()=>validateIndex(index),/HISTORICAL_MERGE_CHANGED/);});
test('v5 state rejects a hidden missing required CI check despite a passed summary',()=>fixture((index,root,change)=>{change('buildSecurityCurrentObservation',value=>value.currentMainCi.checks.find(row=>row.name==='RLS-enabled cross-tenant tests').conclusion='skipped');assert.throws(()=>validateIndex(index,root),/BUILD_SECURITY_MAIN_CHECK_COUNTS_CHANGED|BUILD_SECURITY_REQUIRED_MAIN_CHECK_MISSING/);}));
test('v5 state verifies push-main workflow provenance rather than accepting PR checks',()=>fixture((index,root,change)=>{change('buildSecurityCurrentObservation',value=>{const workflow=Object.values(value.currentMainCi.workflowRuns).find(row=>row.event==='push');workflow.event='pull_request';});assert.throws(()=>validateIndex(index,root),/BUILD_SECURITY_MAIN_WORKFLOW_CHANGED/);}));
test('v5 state rejects tampered current evidence before rendering',()=>fixture((index,root)=>{writeFileSync(join(root,index.evidence.buildSecurityCurrentObservation.path),'{}\n');assert.throws(()=>validateIndex(index,root),/EVIDENCE_BYTES_CHANGED/);}));
test('v5 preparation cannot be relabeled as deployed or live accepted',()=>{const index=current();index.stages.find(row=>row.id==='deployment').status='passed';index.stages.find(row=>row.id==='deployment').applicability='preparation_only';assert.throws(()=>validateIndex(index),/PREPARATION_IS_NOT_DEPLOYMENT/);});
test('v5 state requires separate daily-rollup observation and exact PR627 invalidation',()=>{const index=current();index.usageModes.CLASSPILOT_DAILY_USAGE_ROLLUP_MODE.observedValue='off';assert.throws(()=>validateIndex(index),/CURRENT_DAILY_SETTING_CHANGED/);const missing=current();missing.inclusionMatrix=missing.inclusionMatrix.filter(row=>row.number!==627);assert.throws(()=>validateIndex(missing),/CURRENT_MERGE_REQUIRED|PR627_INVALIDATION_REQUIRED/);});
test('v5 gate status follows the hash-pinned binding without inventing preparation or selection',()=>{const index=current();const row=index.gates.find(row=>row.id==='build-security-selection');row.status=row.status==='passed'?'pending':'passed';row.applicability='preparation_only';assert.throws(()=>validateIndex(index),/BUILD_SECURITY_GATE_CHANGED/);});
test('v5 observed preparation and campaign summaries cannot lag or contradict the binding',()=>fixture((index,root,change)=>{change('buildSecurityCurrentObservation',value=>value.preparationStatus=value.preparationStatus==='passed'?'pending':'passed');assert.throws(()=>validateIndex(index,root),/BUILD_SECURITY_OBSERVED_GATE_STATE_CHANGED/);}));

test('v5 current-main observation retains an emitted failure independently of preparation status',()=>fixture((index,root,change)=>{change('buildSecurityCurrentObservation',value=>{const ci=value.currentMainCi,check=ci.checks.find(row=>row.name==='Backend (TypeScript + Build)');check.status='completed';check.conclusion='failure';ci.status='failed';ci.successes=ci.checks.filter(row=>row.conclusion==='success').length;});const gate=index.gates.find(row=>row.id==='build-security-main-ci');gate.status='failed';gate.applicability='candidate_pending';validateIndex(index,root);}));

test('v5 documentation may record pending checks without claiming a passed exact-main gate',()=>fixture((index,root,change)=>{
 change('buildSecurityCurrentObservation',value=>{const ci=value.currentMainCi;for(const row of ci.checks)if(row.status==='completed'&&!['success','skipped'].includes(row.conclusion)){row.status='in_progress';row.conclusion=null;}const check=ci.checks.find(row=>row.name==='Backend (TypeScript + Build)');check.status='in_progress';check.conclusion=null;for(const row of Object.values(ci.workflowRuns))if(row.status==='completed'&&!['success','skipped'].includes(row.conclusion)){row.status='in_progress';row.conclusion='';}ci.status='pending';ci.successes=ci.checks.filter(row=>row.conclusion==='success').length;ci.expectedSkips=ci.checks.filter(row=>row.conclusion==='skipped').length;});
 const gate=index.gates.find(row=>row.id==='build-security-main-ci');gate.status='pending';gate.applicability='candidate_pending';validateIndex(index,root);
}));

test('v5 documentation cannot hide a failed or incomplete workflow behind a passed summary',()=>fixture((index,root,change)=>{
 change('buildSecurityCurrentObservation',value=>{const ci=value.currentMainCi,check=ci.checks.find(row=>row.name==='Backend (TypeScript + Build)');check.status='completed';check.conclusion='failure';ci.status='passed';ci.successes=ci.checks.filter(row=>row.conclusion==='success').length;});const gate=index.gates.find(row=>row.id==='build-security-main-ci');gate.status='passed';gate.applicability='preparation_only';assert.throws(()=>validateIndex(index,root),/BUILD_SECURITY_MAIN_CI_OUTCOME_CHANGED/);
}));

test('v5 state requires the exact PR628 invalidation after the historical A2 freeze',()=>{const index=current();index.inclusionMatrix=index.inclusionMatrix.filter(row=>row.number!==628);assert.throws(()=>validateIndex(index),/CURRENT_MERGE_REQUIRED|PR628_INVALIDATION_REQUIRED/);});

test('v5 candidate artifact table displays the current A3 backend and frontend rather than historical A2',()=>{
  const index=current();index.artifacts.push({id:'backend-current-a2',label:'Historical A2 must stay outside current table',identity:{archiveSha256:'historical-a2-archive'}});
  const table=renderStatus(index).split('### Candidate artifacts')[1].split('### ')[0];
  for(const id of ['backend-current-a3','frontend-current-a3']){const row=index.artifacts.find(value=>value.id===id);assert.ok(table.includes(row.label));assert.ok(table.includes('`2001e888`'));assert.ok(table.includes(row.identity.archiveSha256));if(row.identity.indexDigest)assert.ok(table.includes(row.identity.indexDigest));}
  assert.ok(!table.includes('Historical A2 must stay outside current table'));assert.ok(!table.includes('historical-a2-archive'));
});

test('accepted current evidence keeps original fixed133 and fresh same-binding normal/mixed/headroom distinct',()=>{
 const index=current(),load=id=>JSON.parse(readFileSync(join(ROOT,index.evidence[id].path),'utf8'));
 const binding=load('buildSecurityBinding');
 validateBindingProfile(binding,binding.id,FALLBACK);
 assert.equal(binding.status,'accepted');assert.deepEqual(binding.blockers,[]);
 assert.ok(Object.values(binding.evidence).every(row=>row.status==='passed'));
 const summary=load('buildSecurityOriginalAcceptanceCompletion');
 assert.equal(summary.originalFixed133HarnessSource,'dbf00dbb29945fd316150af047aa55194f59d892');
 for(const key of ['NormalLoadAcceptance','ClassroomAcceptance','HeadroomAcceptance']){
  const record=load('buildSecurityOriginal'+key);
  assert.equal(record.measuredHarnessSource,'f0c8705a0eb2f5ef048b7e65e88afe3213c8a111');
  assert.equal(record.acceptanceSuccessorSha256,'c8fa18369f5aa9f8fde0580bdb1dc773ec84e9cacfdb7abd4c3e315e14689ad5');
  assert.equal(record.measuredHarnessFreeze.sha256,'1d686cf1270e5c271e63d2aaececfb6b464c870fab41c11df7b1dac082f6479a');
  assert.match(record.retainedEvidence.nativeResult.path,/^acceptance-a3-resume-03\//);
 }
 for(const key of ['NormalLoadAcceptance','ClassroomAcceptance']){
  const historical=load('buildSecurityOriginal'+key+'HistoricalDbf00');
  assert.match(historical.retainedEvidence.nativeResult.path,/^acceptance-a3\/original-gates\//);
 }
 const failed=load('buildSecurityHeadroomFailedAttempt');
 assert.equal(failed.status,'failed');assert.equal(failed.run,'21f119c74dbd');assert.equal(failed.remainingAttemptsHeld,2);
 assert.equal(index.gates.find(row=>row.id==='build-security-headroomAcceptance-failed-dbf00').status,'failed');
 assert.equal(summary.historicalFailedHeadroom.reclassified,false);
 for(const stage of ['publication','deployment','activation','live'])assert.equal(index.stages.find(row=>row.id===stage).status,'pending');
});

test('accepted current rendering leads to exact operations while retaining the failed historical attempt',()=>{
 const index=current();validateIndex(index);const output=renderStatus(index);
 assert.match(output,/Fresh A3 preparation and all seven original release gates are complete/);
 assert.match(output,/Exact publication and backend\/frontend deployment remain pending/);
 assert.doesNotMatch(output,/fresh A3 evidence is required/);
 assert.match(output,/Historical first 250-client headroom attempt \| failed/);
 assert.match(output,/managed-device validation|waived_not_passed/);
});
