import test from 'node:test';
import assert from 'node:assert/strict';
import {verifySnapshotValidityHorizon} from './snapshot-validity-horizon.mjs';
const schools=[{index:0,id:'first'},{index:1,id:'second'}];
const base={observed_at:'2026-10-03 17:00:00+00',required_valid_until:'2026-10-03 17:16:00+00',school_expiries:0,license_expiries:0,control_expiries:0,teaching_expiries:0,manual_session_expiries:0};
test('expiry proof covers the full declared interval with read-only SQL and exact school parameters',async()=>{const calls=[];const client={query:async(sql,params)=>{calls.push({sql,params});return{rows:[base]};}};const proof=await verifySnapshotValidityHorizon(client,schools,960000);assert.equal(proof.passed,true);assert.equal(proof.authorityRefreshed,false);assert.deepEqual(calls.map(c=>c.params),[['first',960000],['second',960000]]);assert.ok(calls.every(c=>!/(?:UPDATE|INSERT|DELETE|set_config)/i.test(c.sql)));});
for(const key of ['school_expiries','license_expiries','control_expiries','teaching_expiries','manual_session_expiries'])test(`expiry proof rejects ${key} without refreshing it`,async()=>{await assert.rejects(()=>verifySnapshotValidityHorizon({query:async()=>({rows:[{...base,[key]:1}]})},schools,960000));});
test('missing expiry proof and undeclared horizons fail closed',async()=>{await assert.rejects(()=>verifySnapshotValidityHorizon({query:async()=>({rows:[{}]})},schools,960000));for(const value of [0,NaN,119999,1200001])await assert.rejects(()=>verifySnapshotValidityHorizon({},schools,value));});
